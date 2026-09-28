"""The farm's browser: Chromium on this box that you drive from the farm UI (BROWSER, or B) and every Claude drives
with its browser MCP tools. Log in to a site in it once (LinkedIn, a dashboard, an admin panel) and the Claudes work
in that login, in the same window you watch.

It has profiles: each one its own Chromium with its own logins (``default``, ``linkedin-work``, ...), shared by
everyone on the box. Any Claude can use any of them: the ``default`` profile's tools are ``mcp__browser__*``, another
profile's ``mcp__browser-<name>__*``.

    clodfarm browser [status] | start [PROFILE] | stop [PROFILE] | open URL [--profile P] | add NAME | remove NAME

Xvfb draws each profile's Chromium on its own virtual screen; x11vnc shares that screen on 127.0.0.1 only, and the
farm UI bridges it to your browser over its own password-protected WebSocket (noVNC draws it). Chromium's DevTools
port is 127.0.0.1 only too: the Claudes reach it through Playwright's MCP server (``playwright-mcp --cdp-endpoint``).
Profile slot N uses DevTools port 9222+N, VNC port 5900+N and display :99+N. Logins are kept in the workspace volume
(``.farm/browser`` for ``default``, ``.farm/browsers/<name>`` for the others), so a new container is still logged in.

The profiles and which are on are a file (``.farm/browsers.json``): START in the UI or ``clodfarm browser start``
turns one on, and it stays on across restarts until someone stops it. The farm UI's process keeps them running.
"""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import threading
import time
import urllib.parse
import urllib.request

DEFAULT = "default"
MCP_NAME = "browser"  # the default profile's MCP server in each Claude's config (mcp__browser__*); others browser-<name>
MCP_BIN = "playwright-mcp"
MAX_PROFILES = 8
NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,23}")
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 1 << 20  # a client (keyboard, mouse, clipboard) never needs a bigger WebSocket frame
BROWSERS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable")


def _env(name: str, default: str) -> str:
    return os.environ.get(name) or default


def enabled() -> bool:
    return _env("FARM_BROWSER", "1").lower() not in ("0", "false", "no", "off")


def chromium_bin() -> str | None:
    if os.environ.get("FARM_BROWSER_BIN"):
        return shutil.which(os.environ["FARM_BROWSER_BIN"])
    return next((p for p in map(shutil.which, BROWSERS) if p), None)


def cdp_port(slot: int = 0) -> int:
    return int(_env("FARM_BROWSER_CDP_PORT", "9222")) + slot


def vnc_port(slot: int = 0) -> int:
    return int(_env("FARM_BROWSER_VNC_PORT", "5900")) + slot


def cdp_url(slot: int = 0) -> str:
    return f"http://127.0.0.1:{cdp_port(slot)}"


def novnc_dir() -> str:
    return _env("FARM_NOVNC_DIR", "/opt/novnc")


def size() -> tuple[int, int]:
    try:
        w, h = (int(x) for x in _env("FARM_BROWSER_SIZE", "1280x800").lower().split("x"))
        return max(640, min(w, 3840)), max(480, min(h, 2160))
    except ValueError:
        return 1280, 800


def missing() -> list[str]:
    """What this image lacks to run the browser (empty: it has everything)."""
    out = [] if chromium_bin() else ["chromium"]
    out += [b for b in ("Xvfb", "x11vnc") if not shutil.which(b)]
    if not os.path.isfile(os.path.join(novnc_dir(), "core", "rfb.js")):
        out.append("noVNC")
    return out


def available() -> bool:
    return enabled() and not missing()


def mcp_name(profile: str) -> str:
    return MCP_NAME if profile == DEFAULT else f"{MCP_NAME}-{profile}"


def _get(port: int, path: str, method: str = "GET", timeout: float = 2.0):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def cdp_up(slot: int = 0) -> bool:
    try:
        return bool(_get(cdp_port(slot), "/json/version", timeout=1.0))
    except (OSError, ValueError):
        return False


def tabs(slot: int = 0) -> list[dict]:
    """The pages open in a profile's browser: what you and the Claudes are looking at."""
    try:
        return [{"id": t.get("id"), "title": (t.get("title") or "")[:200], "url": (t.get("url") or "")[:500]}
                for t in _get(cdp_port(slot), "/json/list") or [] if t.get("type") == "page"]
    except (OSError, ValueError):
        return []


def normalize_url(url: str) -> str:
    """An address to open: http(s) only (``linkedin.com`` becomes ``https://linkedin.com``), or about:blank."""
    url = (url or "").strip()
    if url == "about:blank":
        return url
    if re.match(r"[A-Za-z][A-Za-z0-9+.-]*:(?!\d)", url) and "://" not in url:
        raise ValueError("open an http(s) address")  # javascript:, data:, mailto: ...
    if url and "://" not in url:
        url = "https://" + url
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("http", "https") or not u.netloc or any(c in url for c in " \r\n\t"):
        raise ValueError("open an http(s) address")
    return url


def open_url(url: str, slot: int = 0) -> dict:
    """Open ``url`` in a new tab of a running profile's browser."""
    t = _get(cdp_port(slot), "/json/new?" + urllib.parse.quote(normalize_url(url), safe=":/?&=%#@+,;~"),
             method="PUT", timeout=10)
    return {"id": t.get("id"), "url": t.get("url")}


# ------------------------------------------------------------ the profiles
class Registry:
    """``.farm/browsers.json``: every profile, its slot (its ports and screen) and whether it should run. Written by
    the farm UI and by `clodfarm browser` (a CLI in the same container), so every change holds a file lock."""

    def __init__(self, workspace: str):
        self.farm = os.path.join(workspace, ".farm")
        self.path = os.path.join(self.farm, "browsers.json")

    @contextlib.contextmanager
    def _locked(self):
        os.makedirs(self.farm, exist_ok=True)
        with open(self.path + ".lock", "a") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lk, fcntl.LOCK_UN)

    def _read(self) -> list[dict]:
        try:
            profiles = json.load(open(self.path)).get("profiles") or []
        except (OSError, ValueError):
            profiles = []
        if not any(p.get("name") == DEFAULT for p in profiles):
            try:  # the one browser of 0.7's first build: its on/off becomes the default profile's
                on = bool(json.load(open(os.path.join(self.farm, "browser.json"))).get("on"))
            except (OSError, ValueError):
                on = False
            profiles.insert(0, {"name": DEFAULT, "slot": 0, "on": on, "created": 0})
        return profiles

    def _write(self, profiles: list[dict]):
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"profiles": profiles}, f, indent=1)
        os.replace(tmp, self.path)

    def all(self) -> list[dict]:
        return self._read()

    def get(self, name: str) -> dict | None:
        return next((p for p in self._read() if p["name"] == name), None)

    def dir(self, name: str) -> str:
        if name == DEFAULT:
            return _env("FARM_BROWSER_PROFILE", os.path.join(self.farm, "browser"))
        return os.path.join(self.farm, "browsers", name)

    def add(self, name: str, by: str = "") -> dict:
        name = (name or "").strip().lower()
        if not NAME_RE.fullmatch(name):
            raise ValueError("a profile name is up to 24 lowercase letters, digits or -")
        with self._locked():
            profiles = self._read()
            if any(p["name"] == name for p in profiles):
                raise ValueError(f"there is already a profile named {name}")
            if len(profiles) >= MAX_PROFILES:
                raise ValueError(f"at most {MAX_PROFILES} profiles; remove one first")
            used = {int(p["slot"]) for p in profiles}
            p = {"name": name, "slot": min(set(range(MAX_PROFILES)) - used), "on": False, "created": time.time(),
                 "by": by}
            self._write(profiles + [p])
        return p

    def remove(self, name: str) -> bool:
        """Forget a profile and delete its logins (the default profile stays)."""
        if name == DEFAULT:
            raise ValueError("the default profile can't be removed (stop it, or log out of its sites)")
        with self._locked():
            profiles = self._read()
            if not any(p["name"] == name for p in profiles):
                return False
            self._write([p for p in profiles if p["name"] != name])
        shutil.rmtree(self.dir(name), ignore_errors=True)
        return True

    def want(self, name: str, on: bool, by: str = "") -> bool:
        """Turn a profile on or off; returns whether that changed anything."""
        with self._locked():
            profiles = self._read()
            p = next((x for x in profiles if x["name"] == name), None)
            if not p:
                raise ValueError(f"no browser profile named {name}")
            if bool(p.get("on")) == on:
                return False
            p.update(on=on, by=by, at=time.time())
            self._write(profiles)
        return True


class Browser:
    """One profile's Chromium: keeps its Xvfb, x11vnc and Chromium running while it is on."""

    ORDER = ("xvfb", "vnc", "chromium")

    def __init__(self, name: str, slot: int, profile: str, log_path: str):
        self.name, self.slot, self.profile, self.log_path = name, slot, profile, log_path
        self.display = f":{int(_env('FARM_BROWSER_DISPLAY', ':99').lstrip(':').split('.')[0]) + slot}"
        self.procs: dict[str, subprocess.Popen] = {}
        self.started: dict[str, list[float]] = {}  # recent start times per process, for the crash back-off
        self.error = ""
        self.hold_until = 0.0
        self.since = 0.0
        self._lock = threading.RLock()

    def alive(self, name: str) -> bool:
        p = self.procs.get(name)
        return bool(p and p.poll() is None)

    def running(self) -> bool:
        return all(self.alive(n) for n in self.ORDER)

    def fresh(self):
        self.error, self.hold_until, self.started = "", 0.0, {}  # a new START gets a fresh try

    def sync(self, on: bool):
        with self._lock:
            if not (on and available()):
                if self.procs:
                    self.shutdown()
                return
            if time.time() < self.hold_until:
                return
            if not self.alive("xvfb"):
                self.shutdown()  # everything draws on it
                self._start("xvfb")
            for name in self.ORDER[1:]:
                if self.alive("xvfb") and not self.alive(name):
                    self._start(name)
            if self.running() and cdp_up(self.slot):
                self.error = ""
                self.since = self.since or time.time()

    def _start(self, name: str):
        old = self.procs.pop(name, None)
        if old is not None and old.poll() not in (None, 0, -signal.SIGTERM):
            self.error = f"{name} exited with code {old.returncode}: {self._tail()}"
        recent = [t for t in self.started.get(name, []) if t > time.time() - 60]
        if len(recent) >= 3:  # three starts in a minute: wait instead of spinning
            self.error = self.error or f"{name} keeps exiting: {self._tail()}"
            self.hold_until = time.time() + 60
            self.started[name] = []
            return
        self.started[name] = recent + [time.time()]
        if name == "xvfb":
            self._clear_display()
        if name == "chromium":
            self._prepare_profile()
        cmd = self._cmd(name)
        env = {**os.environ, "DISPLAY": self.display}
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        self._rotate_log()
        with open(self.log_path, "ab") as log:
            log.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} starting {name}: {' '.join(cmd)}\n".encode())
            log.flush()
            p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env,
                                 start_new_session=True)
        self.procs[name] = p
        if name == "xvfb":
            self.since = 0.0
            self._wait(lambda: os.path.exists(self._socket()), p, 10)
        elif name == "chromium":
            self._wait(lambda: cdp_up(self.slot), p, 30)

    def _socket(self) -> str:
        return f"/tmp/.X11-unix/X{self.display.lstrip(':')}"

    def _clear_display(self):
        """An X lock and socket left by a previous container (or a killed Xvfb) would stop Xvfb from starting."""
        for f in (f"/tmp/.X{self.display.lstrip(':')}-lock", self._socket()):
            try:
                os.remove(f)
            except OSError:
                pass

    def _cmd(self, name: str) -> list[str]:
        w, h = size()
        if name == "xvfb":
            return ["Xvfb", self.display, "-screen", "0", f"{w}x{h}x24", "-nolisten", "tcp", "-dpi", "96"]
        if name == "vnc":
            # localhost only: the farm UI is the one way in, behind its password. CLIPBOARD (not every selection)
            # goes to the viewer, so what you copy in the farm's browser lands on your own clipboard.
            return ["x11vnc", "-display", self.display, "-rfbport", str(vnc_port(self.slot)), "-localhost",
                    "-forever", "-shared", "-nopw", "-quiet", "-xkb", "-noprimary", "-noxrecord"]
        return [chromium_bin() or "chromium", f"--user-data-dir={self.profile}",
                f"--remote-debugging-port={cdp_port(self.slot)}", "--remote-debugging-address=127.0.0.1",
                "--no-first-run", "--no-default-browser-check", "--password-store=basic",
                "--disable-dev-shm-usage",  # Docker's /dev/shm is 64 MB
                "--no-sandbox",  # the container is the sandbox (docs/security.md); Chromium's needs user namespaces
                "--test-type",  # no "unsupported command-line flag" bar for --no-sandbox over every page
                f"--window-size={w},{h}", "--window-position=0,0", "--start-maximized",
                "--disable-features=Translate,MediaRouter", "--lang=" + _env("FARM_BROWSER_LANG", "en-US"),
                *_env("FARM_BROWSER_ARGS", "").split(), _env("FARM_BROWSER_HOME", "about:blank")]

    def _prepare_profile(self):
        """A restart is a crash to Chromium: clear its lock from the old container and its "Restore pages?" bubble."""
        os.makedirs(self.profile, mode=0o700, exist_ok=True)
        for f in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            try:
                os.remove(os.path.join(self.profile, f))
            except OSError:
                pass
        prefs = os.path.join(self.profile, "Default", "Preferences")
        try:
            d = json.load(open(prefs))
        except (OSError, ValueError):
            return
        prof = d.setdefault("profile", {})
        if prof.get("exit_type") != "Normal" or not prof.get("exited_cleanly"):
            prof.update(exit_type="Normal", exited_cleanly=True)
            with open(prefs + ".tmp", "w") as f:
                json.dump(d, f)
            os.replace(prefs + ".tmp", prefs)

    @staticmethod
    def _wait(ready, p: subprocess.Popen, seconds: float):
        end = time.time() + seconds
        while time.time() < end and p.poll() is None and not ready():
            time.sleep(0.2)

    def _tail(self, n: int = 400) -> str:
        try:
            with open(self.log_path, "rb") as f:
                f.seek(max(0, os.path.getsize(self.log_path) - n))
                return f.read().decode(errors="replace").strip().replace("\n", " | ")[-n:]
        except OSError:
            return ""

    def _rotate_log(self):
        try:
            if os.path.getsize(self.log_path) > 2 << 20:
                os.replace(self.log_path, self.log_path + ".1")
        except OSError:
            pass

    def shutdown(self):
        """Stop Chromium first (so it saves its cookies), then the screen."""
        with self._lock:
            for name in reversed(self.ORDER):
                p = self.procs.pop(name, None)
                if not p or p.poll() is not None:
                    continue
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            self.since = 0.0


class Browsers:
    """Every profile on this box: the registry, and one keeper per profile (run by the farm UI's process)."""

    def __init__(self, workspace: str):
        self.workspace = workspace
        self.registry = Registry(workspace)
        self.running: dict[str, Browser] = {}
        self._lock = threading.RLock()

    def _browser(self, p: dict) -> Browser:
        b = self.running.get(p["name"])
        if b is None or b.slot != int(p["slot"]):
            if b:
                b.shutdown()
            log = os.path.join(self.registry.farm, "browser.log" if p["name"] == DEFAULT else f"browsers/{p['name']}.log")
            b = self.running[p["name"]] = Browser(p["name"], int(p["slot"]), self.registry.dir(p["name"]), log)
        return b

    def slot(self, name: str) -> int:
        p = self.registry.get(name)
        if not p:
            raise ValueError(f"no browser profile named {name}")
        return int(p["slot"])

    def want(self, name: str, on: bool, by: str = "") -> bool:
        changed = self.registry.want(name, on, by)
        if on:
            with self._lock:
                p = self.registry.get(name)
                if p:
                    self._browser(p).fresh()
        return changed

    def sync(self):
        with self._lock:
            profiles = self.registry.all()
            for p in profiles:
                self._browser(p).sync(bool(p.get("on")))
            for name in set(self.running) - {p["name"] for p in profiles}:  # removed: stop it
                self.running.pop(name).shutdown()

    def keep(self, stop: threading.Event, every: float = 2.0):
        while True:
            try:
                self.sync()
            except Exception as e:  # noqa: BLE001 - the browser must never take the farm down
                print(f"browser: {type(e).__name__}: {str(e)[:200]}", flush=True)
            if stop.wait(every):
                break
        self.shutdown()

    def shutdown(self):
        with self._lock:
            for b in self.running.values():
                b.shutdown()

    def status(self) -> dict:
        lack = missing() if enabled() else ["FARM_BROWSER=0"]
        w, h = size()
        out = []
        for p in self.registry.all():
            b = self.running.get(p["name"])
            up = not lack and cdp_up(int(p["slot"]))
            out.append({"name": p["name"], "on": bool(p.get("on")), "ready": up,
                        "running": bool(b and b.running()) or up, "tabs": tabs(int(p["slot"])) if up else [],
                        "error": b.error if b else "", "since": (b.since or None) if b else None,
                        "tools": f"mcp__{mcp_name(p['name'])}__*"})
        return {"available": not lack, "missing": lack, "size": f"{w}x{h}", "profiles": out,
                "max": MAX_PROFILES}


# ------------------------------------------------------- the Claudes' tools
def mcp_servers(workspace: str | None = None) -> dict[str, dict]:
    """The MCP servers every Claude gets, one per profile: Playwright attached to that profile's Chromium over
    DevTools, so it works in the logins made from the farm UI. Empty when this image has no browser."""
    exe = shutil.which(MCP_BIN)
    if not (enabled() and exe and chromium_bin()):
        return {}
    workspace = workspace or _env("FARM_WORKSPACE", "/workspace")
    out = {}
    for p in Registry(workspace).all():
        # its screenshots and logs go to the farm's folder, not into the Claude's worktree (where they'd be committed)
        files = os.path.join(workspace, ".farm", "browser-files", p["name"])
        out[mcp_name(p["name"])] = {"type": "stdio", "command": exe, "env": {},
                                    "args": ["--cdp-endpoint", cdp_url(int(p["slot"])), "--output-dir", files]}
    return out


def is_ours(server: dict) -> bool:
    return os.path.basename(str(server.get("command", ""))) == MCP_BIN and "--cdp-endpoint" in (server.get("args") or [])


# ------------------------------------------------------------ the VNC bridge
def ws_accept(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


def ws_frame(op: int, payload: bytes = b"", mask: bytes | None = None) -> bytes:
    """One WebSocket frame; the server sends them unmasked, a client (``mask``) masked."""
    n = len(payload)
    head = bytes([0x80 | op])
    bit = 0x80 if mask else 0
    if n < 126:
        head += bytes([bit | n])
    elif n < 1 << 16:
        head += bytes([bit | 126]) + struct.pack(">H", n)
    else:
        head += bytes([bit | 127]) + struct.pack(">Q", n)
    if mask:
        return head + mask + _xor(payload, mask)
    return head + payload


def _xor(data: bytes, mask: bytes) -> bytes:
    n = len(data)
    if not n:
        return data
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def _exact(r, n: int) -> bytes:
    b = r.read(n)
    if len(b) < n:
        raise EOFError
    return b


def ws_read(r, masked: bool = True) -> tuple[int, bytes]:
    """One frame. From a browser it must be masked (RFC 6455); ``masked=False`` reads the server's side (tests)."""
    b1, b2 = _exact(r, 2)
    op, n = b1 & 0x0F, b2 & 0x7F
    if bool(b2 & 0x80) != masked:
        raise ValueError("unmasked client frame" if masked else "masked server frame")
    if n == 126:
        n = struct.unpack(">H", _exact(r, 2))[0]
    elif n == 127:
        n = struct.unpack(">Q", _exact(r, 8))[0]
    if n > (MAX_FRAME if masked else 1 << 26):
        raise ValueError("frame too large")
    mask = _exact(r, 4) if masked else b""
    data = _exact(r, n)
    return op, _xor(data, mask) if masked else data


def bridge(rfile, wfile, conn: socket.socket, vnc: socket.socket, idle_ping: float = 25.0):
    """Pipe an open WebSocket (the handler's rfile/wfile) to the VNC server until either side closes."""
    vnc.settimeout(idle_ping)
    lock, done = threading.Lock(), threading.Event()

    def send(op: int, payload: bytes = b""):
        with lock:
            wfile.write(ws_frame(op, payload))

    def down():  # VNC -> browser; a ping now and then keeps proxies from closing an idle screen
        try:
            while not done.is_set():
                try:
                    data = vnc.recv(1 << 16)
                except socket.timeout:
                    send(0x9)
                    continue
                if not data:
                    break
                send(0x2, data)
        except OSError:
            pass
        finally:
            if not done.is_set():  # VNC went away first: tell the browser, and stop reading from it
                done.set()
                try:
                    send(0x8, struct.pack(">H", 1000))
                except OSError:
                    pass
                try:
                    conn.shutdown(socket.SHUT_RD)
                except OSError:
                    pass

    t = threading.Thread(target=down, name="vnc-down", daemon=True)
    t.start()
    try:
        while not done.is_set():
            op, data = ws_read(rfile)
            if op in (0x0, 0x1, 0x2):
                vnc.sendall(data)
            elif op == 0x9:
                send(0xA, data)
            elif op == 0x8:
                break
    except (OSError, EOFError, ValueError):
        pass
    finally:
        if not done.is_set():
            done.set()
            try:
                send(0x8, struct.pack(">H", 1000))
            except OSError:
                pass
        try:
            vnc.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        vnc.close()
        t.join(5)
