"""The farm's browser: its screen over the UI's WebSocket (login and origin checked), its on/off state, the CLI, and
the `browser` MCP server every Claude gets. Chromium itself runs in the image (docs/browser.md), not in these tests."""
import base64
import json
import os
import socket
import threading

import pytest

from clodfarm import auth, browser, prompts
from clodfarm.config import load
from clodfarm.store import Store
from clodfarm.web import FarmUI, make_handler
from test_web import client, login


@pytest.fixture
def farm(env, backend, monkeypatch, tmp_path):
    if backend != "sqlite":
        pytest.skip("the browser is per box; one store backend is enough")
    from http.server import ThreadingHTTPServer
    monkeypatch.setenv("FARM_UI_PASSWORD", "correct horse")
    monkeypatch.setenv("FARM_BROWSER_BIN", "no-such-chromium")  # no browser here, unless a test gives one
    novnc = tmp_path / "novnc"
    (novnc / "core").mkdir(parents=True)
    (novnc / "core" / "rfb.js").write_text("export default class RFB {}\n")
    monkeypatch.setenv("FARM_NOVNC_DIR", str(novnc))
    cfg = load()
    store = Store.from_config(cfg)
    store.ensure_table()
    ui = FarmUI(cfg, store)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(ui))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"127.0.0.1:{srv.server_address[1]}", ui
    srv.shutdown()
    ui.manager.shutdown()


@pytest.fixture
def vnc(monkeypatch):
    """A stand-in VNC server: it greets like one, then echoes what it gets."""
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(4)
    monkeypatch.setenv("FARM_BROWSER_VNC_PORT", str(srv.getsockname()[1]))

    def serve():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            threading.Thread(target=echo, args=(c,), daemon=True).start()

    def echo(c):
        with c:
            c.sendall(b"RFB 003.008\n")
            while data := c.recv(65536):
                c.sendall(data)
    threading.Thread(target=serve, daemon=True).start()
    yield
    srv.close()


def cookie(host) -> str:
    call = client()
    _, _, headers = call(f"http://{host}/api/login", {"password": "correct horse"})
    return headers["Set-Cookie"].split(";", 1)[0]


def upgrade(host, headers: dict, profile: str = ""):
    h, port = host.split(":")
    s = socket.create_connection((h, int(port)), timeout=5)
    lines = [f"GET /api/browser/screen{'?profile=' + profile if profile else ''} HTTP/1.1", f"Host: {host}", "Upgrade: websocket", "Connection: Upgrade",
             "Sec-WebSocket-Key: " + base64.b64encode(os.urandom(16)).decode(), "Sec-WebSocket-Version: 13",
             "Sec-WebSocket-Protocol: binary"] + [f"{k}: {v}" for k, v in headers.items()]
    s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    f = s.makefile("rb")
    status = int(f.readline().split()[1])
    head = {}
    while (line := f.readline().strip()):
        k, v = line.decode().split(":", 1)
        head[k.strip().lower()] = v.strip()
    return s, f, status, head


def test_the_screen_needs_the_login_and_a_farm_page(farm, vnc):
    host, _ = farm
    ok_origin = {"Origin": f"http://{host}"}
    s, _, status, _ = upgrade(host, ok_origin)
    s.close()
    assert status == 401  # no session cookie
    c = cookie(host)
    s, _, status, _ = upgrade(host, {"Origin": "https://evil.example", "Cookie": c})
    s.close()
    assert status == 403  # another site can't open it with your cookie
    s, _, status, _ = upgrade(host, {"Cookie": c})
    s.close()
    assert status == 403  # nor a client that sends no Origin


def test_the_screen_is_bridged_to_vnc(farm, vnc):
    host, _ = farm
    s, f, status, head = upgrade(host, {"Origin": f"http://{host}", "Cookie": cookie(host)})
    assert status == 101 and head["sec-websocket-protocol"] == "binary"
    op, data = browser.ws_read(f, masked=False)
    assert (op, data) == (2, b"RFB 003.008\n")
    s.sendall(browser.ws_frame(2, b"hello", mask=os.urandom(4)))
    assert browser.ws_read(f, masked=False) == (2, b"hello")
    big = os.urandom(70000)  # a 64-bit length frame, split by the bridge as it arrives
    s.sendall(browser.ws_frame(2, big, mask=os.urandom(4)))
    got = b""
    while len(got) < len(big):
        got += browser.ws_read(f, masked=False)[1]
    assert got == big
    s.sendall(browser.ws_frame(9, b"hi", mask=os.urandom(4)))
    assert browser.ws_read(f, masked=False) == (0xA, b"hi")  # ping, pong
    s.sendall(browser.ws_frame(8, b"\x03\xe8", mask=os.urandom(4)))
    assert browser.ws_read(f, masked=False)[0] == 8
    s.close()


def test_an_unmasked_client_frame_ends_the_bridge(farm, vnc):
    host, _ = farm
    s, f, status, _ = upgrade(host, {"Origin": f"http://{host}", "Cookie": cookie(host)})
    assert status == 101
    browser.ws_read(f, masked=False)
    s.sendall(browser.ws_frame(2, b"x"))
    assert browser.ws_read(f, masked=False)[0] == 8
    s.close()


def test_the_screen_says_when_the_browser_is_off(farm, monkeypatch):
    host, _ = farm
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    monkeypatch.setenv("FARM_BROWSER_VNC_PORT", str(s.getsockname()[1]))  # nothing listens there
    s.close()
    ws, _, status, _ = upgrade(host, {"Origin": f"http://{host}", "Cookie": cookie(host)})
    ws.close()
    assert status == 503


def test_status_start_and_stop(farm, monkeypatch):
    host, ui = farm
    base, call = f"http://{host}", client()
    assert call(base + "/api/browser")[0] == 401
    login(call, base)
    code, st, _ = call(base + "/api/browser")
    assert code == 200 and not st["available"] and "chromium" in st["missing"]
    assert [(p["name"], p["on"], p["tools"]) for p in st["profiles"]] == [("default", False, "mcp__browser__*")]
    code, body, _ = call(base + "/api/browser/start", {})
    assert code == 400 and "no browser" in body["error"]
    monkeypatch.setattr(browser, "missing", lambda: [])  # as in the image
    monkeypatch.setattr(ui.browsers, "sync", lambda: None)
    code, st, _ = call(base + "/api/browser/start", {})
    assert code == 200 and st["profiles"][0]["on"] and ui.browsers.registry.get("default")["on"]
    assert any(e["type"] == "browser.started" for e in ui.store.events(0, 50))
    code, st, _ = call(base + "/api/browser/stop", {"profile": "default"})
    assert code == 200 and not st["profiles"][0]["on"]
    assert call(base + "/api/browser/open", {"url": "javascript:alert(1)"})[0] == 400
    assert call(base + "/api/browser/start", {"profile": "nope"})[0] == 400


def test_profiles_from_the_ui(farm, monkeypatch):
    host, ui = farm
    base, call = f"http://{host}", client()
    login(call, base)
    given = []
    monkeypatch.setattr(ui.manager, "share_browser_tools", lambda: given.append(1))
    monkeypatch.setattr(ui.browsers, "sync", lambda: None)
    code, st, _ = call(base + "/api/browser/add", {"profile": "linkedin-work"})
    assert code == 200 and [p["name"] for p in st["profiles"]] == ["default", "linkedin-work"] and given
    assert st["profiles"][1]["tools"] == "mcp__browser-linkedin-work__*"
    assert ui.browsers.slot("linkedin-work") == 1  # its own ports and screen
    assert call(base + "/api/browser/add", {"profile": "linkedin-work"})[0] == 400  # taken
    assert call(base + "/api/browser/add", {"profile": "Bad Name"})[0] == 400
    assert call(base + "/api/browser/remove", {"profile": "default"})[0] == 400  # the default one stays
    os.makedirs(ui.browsers.registry.dir("linkedin-work"))
    code, st, _ = call(base + "/api/browser/remove", {"profile": "linkedin-work"})
    assert code == 200 and [p["name"] for p in st["profiles"]] == ["default"]
    assert not os.path.exists(ui.browsers.registry.dir("linkedin-work"))  # its logins are gone with it
    assert any(e["type"] == "browser.removed" for e in ui.store.events(0, 50))


def test_the_screen_of_another_profile(farm, vnc, monkeypatch):
    host, ui = farm
    ui.browsers.registry.add("second")
    port = int(os.environ["FARM_BROWSER_VNC_PORT"])
    monkeypatch.setenv("FARM_BROWSER_VNC_PORT", str(port - 1))  # slot 1 is the stand-in's port
    s, f, status, _ = upgrade(host, {"Origin": f"http://{host}", "Cookie": cookie(host)}, "second")
    assert status == 101 and browser.ws_read(f, masked=False) == (2, b"RFB 003.008\n")
    s.close()
    s, _, status, _ = upgrade(host, {"Origin": f"http://{host}", "Cookie": cookie(host)}, "nope")
    s.close()
    assert status == 404


def test_the_page_and_novnc_are_served(farm):
    host, _ = farm
    import urllib.request
    import urllib.error
    with urllib.request.urlopen(f"http://{host}/browser") as r:
        page, csp = r.read().decode(), r.headers["Content-Security-Policy"]
    assert 'src="/browser.js"' in page and f"ws://{host}" in csp and "frame-ancestors 'none'" in csp
    with urllib.request.urlopen(f"http://{host}/browser/novnc/core/rfb.js") as r:
        assert b"class RFB" in r.read()
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(f"http://{host}/browser/novnc/../../../etc/passwd")
    assert e.value.code == 404


def test_profiles_survive_and_nothing_starts_without_a_browser(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_BROWSER_BIN", "no-such-chromium")
    bs = browser.Browsers(str(tmp_path))
    assert [p["name"] for p in bs.registry.all()] == ["default"] and not bs.registry.get("default")["on"]
    assert bs.want("default", True, by="test") and not bs.want("default", True)
    bs.registry.add("b")
    bs.registry.add("c")
    bs.registry.remove("b")
    assert bs.registry.add("d")["slot"] == 1  # a freed slot is reused
    again = browser.Browsers(str(tmp_path))  # a restarted farm
    assert again.registry.get("default")["on"] and [p["name"] for p in again.registry.all()] == ["default", "c", "d"]
    again.sync()
    assert not any(b.procs for b in again.running.values())  # this box has no chromium: nothing is started
    for i in range(browser.MAX_PROFILES - 3):
        again.registry.add(f"x{i}")
    with pytest.raises(ValueError):
        again.registry.add("one-too-many")


def test_the_first_build_s_browser_is_the_default_profile(tmp_path):
    os.makedirs(tmp_path / ".farm")
    json.dump({"on": True}, open(tmp_path / ".farm" / "browser.json", "w"))
    reg = browser.Registry(str(tmp_path))
    assert reg.get("default")["on"] and reg.dir("default") == str(tmp_path / ".farm" / "browser")


def test_each_profile_has_its_own_ports_screen_and_files(env, monkeypatch):
    monkeypatch.setattr(browser.shutil, "which", lambda b: f"/usr/bin/{b}")
    reg = browser.Registry(os.environ["FARM_WORKSPACE"])
    reg.add("work")
    servers = browser.mcp_servers()
    assert list(servers) == ["browser", "browser-work"]
    assert servers["browser-work"]["args"][:2] == ["--cdp-endpoint", "http://127.0.0.1:9223"]
    out = servers["browser-work"]["args"][servers["browser-work"]["args"].index("--output-dir") + 1]
    assert out == os.path.join(os.environ["FARM_WORKSPACE"], ".farm", "browser-files", "work")  # not the worktree
    b = browser.Browser("work", 1, reg.dir("work"), "/dev/null")
    assert b.display == ":100" and "5901" in b._cmd("vnc") and "--remote-debugging-port=9223" in b._cmd("chromium")
    monkeypatch.setenv("FARM_BROWSER", "0")
    assert browser.mcp_servers() == {}


def test_urls():
    assert browser.normalize_url("linkedin.com/login") == "https://linkedin.com/login"
    assert browser.normalize_url("http://localhost:3000/x") == "http://localhost:3000/x"
    assert browser.normalize_url("about:blank") == "about:blank"
    for bad in ("javascript:alert(1)", "file:///etc/passwd", "", "https://a b"):
        with pytest.raises(ValueError):
            browser.normalize_url(bad)


def server(port):
    return {"type": "stdio", "command": "/usr/local/bin/playwright-mcp", "env": {},
            "args": ["--cdp-endpoint", f"http://127.0.0.1:{port}"]}


def test_every_claude_gets_a_server_per_profile(env, monkeypatch):
    path = auth.claude_json_path()
    want = {"browser": server(9222), "browser-work": server(9223)}
    monkeypatch.setattr(browser, "mcp_servers", lambda workspace=None: dict(want))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump({"mcpServers": {"github": {"command": "gh-mcp"}}, "keep": 1}, open(path, "w"))
    assert auth.install_browser_mcp()
    cfg = json.load(open(path))
    assert cfg["mcpServers"]["browser-work"] == want["browser-work"] and cfg["mcpServers"]["github"] and cfg["keep"] == 1
    assert not auth.install_browser_mcp()  # already there
    assert "## The farm's browser" in prompts.farm_guide()
    del want["browser-work"]  # the profile was removed
    assert auth.install_browser_mcp()
    assert set(json.load(open(path))["mcpServers"]) == {"github", "browser"}
    want.clear()  # an image without the browser
    assert auth.install_browser_mcp()
    assert set(json.load(open(path))["mcpServers"]) == {"github"}
    assert "## The farm's browser" not in prompts.farm_guide()


def test_every_claude_on_the_box_gets_them(farm, monkeypatch, tmp_path):
    _, ui = farm
    monkeypatch.setattr(browser, "mcp_servers", lambda workspace=None: {"browser": server(9222)})
    other = tmp_path / "gil"
    other.mkdir()
    monkeypatch.setattr(ui.manager, "_load", lambda: [{"id": "gil", "name": "gil", "config_dir": str(other)}])
    ui.manager.share_browser_tools()
    for p in (auth.claude_json_path(), other / ".claude.json"):
        assert json.load(open(p))["mcpServers"]["browser"] == server(9222)


def test_a_browser_server_set_up_by_hand_is_kept(env, monkeypatch):
    path = auth.claude_json_path()
    mine = {"command": "npx", "args": ["@playwright/mcp@latest"]}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump({"mcpServers": {"browser": mine}}, open(path, "w"))
    monkeypatch.setattr(browser, "mcp_servers", lambda workspace=None: {"browser": server(9222)})
    assert not auth.install_browser_mcp()
    assert json.load(open(path))["mcpServers"]["browser"] == mine


def test_the_cli(env, monkeypatch, capsys):
    from clodfarm import cli
    monkeypatch.setenv("FARM_BROWSER_BIN", "no-such-chromium")
    assert cli.main(["browser", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["available"] is False
    assert cli.main(["browser", "start"]) == 1
    assert "no browser" in capsys.readouterr().err
    assert cli.main(["browser", "add", "work"]) == 0
    assert "mcp__browser-work__*" in capsys.readouterr().out
    assert cli.main(["browser", "--json"]) == 0
    assert [p["name"] for p in json.loads(capsys.readouterr().out)["profiles"]] == ["default", "work"]
    assert cli.main(["browser", "open", "x.com", "--profile", "work"]) == 1  # it's off
    assert cli.main(["browser", "remove", "work"]) == 0
    assert cli.main(["browser", "remove", "work"]) == 1  # gone already
