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


def upgrade(host, headers: dict):
    s = socket.create_connection(tuple(host.split(":")[0:1]) + (int(host.split(":")[1]),), timeout=5)
    lines = ["GET /api/browser/screen HTTP/1.1", f"Host: {host}", "Upgrade: websocket", "Connection: Upgrade",
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
    assert code == 200 and not st["available"] and "chromium" in st["missing"] and not st["on"]
    code, body, _ = call(base + "/api/browser/start", {})
    assert code == 400 and "no browser" in body["error"]
    monkeypatch.setattr(browser, "missing", lambda: [])  # as in the image
    monkeypatch.setattr(ui.browser, "sync", lambda: None)
    code, st, _ = call(base + "/api/browser/start", {})
    assert code == 200 and st["on"] and ui.browser.wanted()
    assert any(e["type"] == "browser.started" for e in ui.store.events(0, 50))
    code, st, _ = call(base + "/api/browser/stop", {})
    assert code == 200 and not st["on"] and not ui.browser.wanted()
    assert call(base + "/api/browser/open", {"url": "javascript:alert(1)"})[0] == 400


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


def test_the_wanted_state_survives_and_nothing_starts_without_a_browser(tmp_path, monkeypatch):
    monkeypatch.setenv("FARM_BROWSER_BIN", "no-such-chromium")
    b = browser.Browser(str(tmp_path))
    assert not b.wanted()
    b.want(True, by="test")
    assert browser.Browser(str(tmp_path)).wanted()  # a restarted farm starts it again
    b.sync()
    assert not b.procs  # this box has no chromium: nothing is started
    b.want(False)
    assert not b.wanted()


def test_the_mcp_server_keeps_its_files_out_of_the_repo(env, monkeypatch):
    monkeypatch.setattr(browser.shutil, "which", lambda b: f"/usr/bin/{b}")
    s = browser.mcp_server()
    assert s["args"][:2] == ["--cdp-endpoint", "http://127.0.0.1:9222"] and browser.is_ours(s)
    assert s["args"][s["args"].index("--output-dir") + 1] == os.path.join(os.environ["FARM_WORKSPACE"], ".farm",
                                                                          "browser-files")
    monkeypatch.setenv("FARM_BROWSER", "0")
    assert browser.mcp_server() is None


def test_urls():
    assert browser.normalize_url("linkedin.com/login") == "https://linkedin.com/login"
    assert browser.normalize_url("http://localhost:3000/x") == "http://localhost:3000/x"
    assert browser.normalize_url("about:blank") == "about:blank"
    for bad in ("javascript:alert(1)", "file:///etc/passwd", "", "https://a b"):
        with pytest.raises(ValueError):
            browser.normalize_url(bad)


def test_every_claude_gets_the_browser_mcp_server(env, monkeypatch):
    path = auth.claude_json_path()
    server = {"type": "stdio", "command": "/usr/local/bin/playwright-mcp",
              "args": ["--cdp-endpoint", "http://127.0.0.1:9222"], "env": {}}
    monkeypatch.setattr(browser, "mcp_server", lambda: server)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump({"mcpServers": {"github": {"command": "gh-mcp"}}, "keep": 1}, open(path, "w"))
    assert auth.install_browser_mcp()
    cfg = json.load(open(path))
    assert cfg["mcpServers"]["browser"] == server and cfg["mcpServers"]["github"] and cfg["keep"] == 1
    assert not auth.install_browser_mcp()  # already there
    assert "## The farm's browser" in prompts.farm_guide()
    monkeypatch.setattr(browser, "mcp_server", lambda: None)  # an image without the browser
    assert auth.install_browser_mcp()
    assert "browser" not in json.load(open(path))["mcpServers"]
    assert "## The farm's browser" not in prompts.farm_guide()


def test_a_browser_server_set_up_by_hand_is_kept(env, monkeypatch):
    path = auth.claude_json_path()
    mine = {"command": "npx", "args": ["@playwright/mcp@latest"]}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump({"mcpServers": {"browser": mine}}, open(path, "w"))
    monkeypatch.setattr(browser, "mcp_server", lambda: {"command": "playwright-mcp",
                                                        "args": ["--cdp-endpoint", "x"]})
    assert not auth.install_browser_mcp()
    assert json.load(open(path))["mcpServers"]["browser"] == mine


def test_the_cli(env, monkeypatch, capsys):
    from clodfarm import cli
    monkeypatch.setenv("FARM_BROWSER_BIN", "no-such-chromium")
    assert cli.main(["browser", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["available"] is False
    assert cli.main(["browser", "start"]) == 1
    assert "no browser" in capsys.readouterr().err
