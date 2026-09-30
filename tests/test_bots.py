"""Bots: Claude Code on another model, through a provider that speaks Anthropic's Messages API."""
import json
import os
import socket
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import cli
from clodfarm import bots
from clodfarm.agents import AgentManager
from clodfarm.config import load
from clodfarm.runner import build_cmd
from clodfarm.store import Store
from test_farm import calls, repo_files, start_farm, stop_farm, wait_for


@pytest.fixture
def provider():
    """A stand-in for OpenRouter: key `good` works; model `missing` is unknown, `busy` is rate limited and
    `chat` answers in another API's format."""
    seen = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
            model, auth = body.get("model"), self.headers.get("Authorization")
            code, out = 200, {"type": "message", "role": "assistant", "content": [{"type": "text", "text": "ok"}]}
            if self.path != "/api/v1/messages":
                code, out = 404, {"error": {"message": "no route"}}
            elif auth not in ("Bearer good", None) or (auth is None and model != "local"):
                code, out = 401, {"error": {"message": "No auth credentials found"}}
            elif model == "missing":
                code, out = 404, {"error": {"message": "model not found"}}
            elif model == "busy":
                code, out = 429, {"error": {"message": "slow down"}}
            elif model == "chat":
                out = {"choices": [{"message": {"content": "ok"}}]}
            data = json.dumps(out).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/api", seen
    srv.shutdown()


def test_a_bot_is_parsed_the_way_providers_write_it():
    b = bots.parse({"provider": "openrouter", "model": "qwen/qwen3-coder:free"})
    assert b == {"provider": "openrouter", "url": "https://openrouter.ai/api", "model": "qwen/qwen3-coder:free",
                 "takes": "sent", "workers": 1, "about": "", "lean": True, "context": 0}
    assert bots.parse({"provider": "custom", "url": "https://gw.example.com/v1/", "model": "m"})["url"] == \
        "https://gw.example.com", "Claude Code adds /v1/messages itself"
    assert bots.parse({"provider": "ollama", "model": "qwen3-coder", "takes": "any"})["takes"] == "any"
    small = bots.parse({"provider": "ollama", "model": "qwen3.5-9b", "about": " tiny jobs:\n one function ",
                        "context": "32k", "lean": False})
    assert small["about"] == "tiny jobs: one function" and small["context"] == 32768 and small["lean"] is False
    assert bots.parse({"provider": "ollama", "model": "m", "context": 131072})["context"] == 131072
    for bad in ({"provider": "gpt", "model": "m"}, {"provider": "custom", "model": "m"},
                {"provider": "custom", "url": "https://user:pw@gw.example.com", "model": "m"},
                {"provider": "custom", "url": "ftp://gw.example.com", "model": "m"},
                {"provider": "openrouter", "model": ""}, {"provider": "openrouter", "model": "a b"},
                {"provider": "openrouter", "model": "m", "workers": 9},
                {"provider": "ollama", "model": "m", "context": "12"}, {"provider": "ollama", "model": "m", "context": "x"},
                {"provider": "ollama", "model": "m", "about": "x" * 161}):
        with pytest.raises(ValueError):
            bots.parse(bad)
    with pytest.raises(ValueError, match="needs an API key"):
        bots.check_key("openrouter", "")
    assert bots.check_key("ollama", "") == ""
    with pytest.raises(ValueError):
        bots.check_key("custom", "two words")


def test_a_lean_bots_runs_get_only_the_tools_it_needs():
    assert bots.run_tools(None) == ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]
    assert bots.parse_tools("Read, Grep Glob,Read") == ["Read", "Grep", "Glob"]
    assert bots.run_tools(["Read", "Rm"]) == ["Read"], "only built-in tools a bot may be given"
    for bad in ("Read,Rm", ""):
        with pytest.raises(ValueError, match="the tools are some of"):
            bots.parse_tools(bad)
    cfg = type("C", (), {"claude_bin": "claude", "model": "m", "permission_mode": "bypassPermissions", "effort": "",
                         "task_budget_usd": 0})()
    lean = build_cmd(cfg, "guide", name="job", tools=["Read", "Grep"])
    assert lean[lean.index("--tools") + 1] == "Read,Grep" and "--strict-mcp-config" in lean \
        and "--disable-slash-commands" in lean, "no MCP servers or skills: Claude Code's prompt stays small"
    assert "--tools" not in build_cmd(cfg, "guide", name="job"), "a Claude's runs keep every tool"


def test_a_bots_context_window_comes_from_ollama():
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, out):
            data = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):  # /api/show: the model's parameters, as its Modelfile set them
            model = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))["model"]
            self.reply({"parameters": {"small": "temperature 0.7\nnum_ctx                        32768"}.get(model, "top_k 20")})

        def do_GET(self):  # /api/ps: the models loaded right now, with the context they were loaded with
            self.reply({"models": [{"name": "big:latest", "model": "big:latest", "context_length": 131072}]})

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        assert bots.detect_context({"provider": "ollama", "url": url, "model": "small"}) == 32768
        assert bots.detect_context({"provider": "ollama", "url": url, "model": "big"}) == 131072, "the loaded model's"
        assert bots.detect_context({"provider": "ollama", "url": url, "model": "other"}) == 0, "unknown"
        assert bots.detect_context({"provider": "openrouter", "url": url, "model": "small"}) == 0
        assert bots.detect_context({"provider": "ollama", "url": "http://127.0.0.1:9", "model": "small"}) == 0
    finally:
        srv.shutdown()
    assert "unknown" in bots.context_note(0) and "too small" in bots.context_note(8192) and bots.context_note(32768) == ""


def test_a_lean_bot_keeps_the_farm_guide_out_of_its_context(tmp_path):
    from clodfarm.auth import install_guide
    from clodfarm.prompts import task_system_prompt
    md = tmp_path / "bot" / "CLAUDE.md"
    install_guide(str(md.parent))
    assert "## Dashboards" in md.read_text(), "what a bot added before lean runs had"
    md.write_text(md.read_text() + "\n## Notes its person wrote\nkeep me\n")
    install_guide(str(md.parent), lean_bot=True)
    assert "## Dashboards" not in md.read_text() and "come with each job" in md.read_text()
    assert "keep me" in md.read_text(), "only the farm's own block changes"
    cfg = type("C", (), {"bot": "qwen3.5-9b", "bot_lean": True, "bot_context": 32768, "name": "qwen-small",
                         "max_depth": 3})()
    lean = task_system_prompt(cfg, {"id": "t1", "owner": "gil"}, "/w/t1", "farm/t1")
    assert lean.startswith("# You are a bot on a clodfarm farm") and "qwen3.5-9b" in lean and "32k tokens" in lean
    assert "## Dashboards" not in lean and "FARM_TASK_ID=t1" in lean and len(lean) < 2500
    cfg.bot_lean = False
    assert "## Dashboards" in task_system_prompt(cfg, {"id": "t1", "owner": "gil"}, "/w/t1", "farm/t1")


def test_bots_first_reaches_the_claudes_and_never_a_bot(tmp_path):
    from clodfarm.auth import install_guide
    from clodfarm.prompts import farm_guide, task_system_prompt
    assert "BOTS FIRST is on" in farm_guide(True) and "BOTS FIRST is on" not in farm_guide()
    assert "the bots draft, you review" in farm_guide("draft") and "the bots draft" not in farm_guide("plan")
    assert "Don't study the specs or the code first" in farm_guide("draft"), "its thinking is what costs usage"
    new = lambda **kw: type("C", (), {"bot": "", "bot_lean": False, "bot_context": 0, "name": "gil",  # noqa: E731
                                      "max_depth": 3, **kw})()
    t = {"id": "t1", "owner": "gil"}
    assert "BOTS FIRST is on" in task_system_prompt(new(), t, "/w/t1", "farm/t1", bots_first=True)
    assert "the bots draft, you review" in task_system_prompt(new(), t, "/w/t1", "farm/t1", bots_first="draft")
    assert "BOTS FIRST is on" not in task_system_prompt(new(), t, "/w/t1", "farm/t1")
    for bot in (new(bot="qwen3-coder", bot_lean=True, bot_context=32768), new(bot="big-model", bot_lean=False)):
        assert "BOTS FIRST" not in task_system_prompt(bot, t, "/w/t1", "farm/t1", bots_first=True), "it gets the work"
    md = tmp_path / "claude" / "CLAUDE.md"
    install_guide(str(md.parent), bots_first=True)
    assert "BOTS FIRST is on" in md.read_text()
    install_guide(str(md.parent))
    assert "BOTS FIRST is on" not in md.read_text(), "turned off, it leaves the guide"


def test_the_bots_first_switch_reaches_the_next_claude_run(env):
    farm, t = start_farm()
    try:
        assert "bots first ON" in cli("farm", "bots-first").stdout and farm.store.settings()["bots_first"]
        on = json.loads(cli("spawn", "with it on", "--prompt", "COMMIT on", "--json").stdout)["id"]
        wait_for(lambda: farm.store.get_task(on)["status"] == "done", timeout=60)
        assert "bots first off" in cli("farm", "bots-first-off").stdout
        off = json.loads(cli("spawn", "with it off", "--prompt", "COMMIT off", "--json").stdout)["id"]
        wait_for(lambda: farm.store.get_task(off)["status"] == "done", timeout=60)

        def guide(tid):
            argv = next(c["argv"] for c in calls(env) if c["cmd"] == "print" and c["task"] == tid)
            return argv[argv.index("--append-system-prompt") + 1]
        assert "BOTS FIRST is on" in guide(on) and "BOTS FIRST is on" not in guide(off), "read at each new run"
        assert "ON (draft)" in cli("farm", "bots-first", "draft").stdout and farm.store.bots_first() == "draft"
        drafted = json.loads(cli("spawn", "draft style", "--prompt", "COMMIT draft", "--json").stdout)["id"]
        wait_for(lambda: farm.store.get_task(drafted)["status"] == "done", timeout=60)
        assert "the bots draft, you review" in guide(drafted)
        assert cli("farm", "bots-first", "loud", check=False).returncode == 2
        assert [e for e in farm.store.events(time.time() - 60) if e["type"] == "farm.settings"]
    finally:
        stop_farm(farm, t)


def test_a_bot_is_kept_only_once_its_model_answers(provider):
    url, seen = provider
    bot = bots.parse({"provider": "custom", "url": url, "model": "qwen/qwen3-coder:free"})
    assert bots.check(bot, "good") == "ok"
    assert seen[-1]["auth"] == "Bearer good", "the way Claude Code sends ANTHROPIC_AUTH_TOKEN"
    assert seen[-1]["body"]["model"] == "qwen/qwen3-coder:free"
    assert bots.check({**bot, "model": "local"}, "") == "ok", "a provider without keys (Ollama)"
    with pytest.raises(ValueError, match="refused the key.*No auth credentials"):
        bots.check(bot, "wrong")
    with pytest.raises(ValueError, match="no such model"):
        bots.check({**bot, "model": "missing"}, "good")
    with pytest.raises(ValueError, match="not with Anthropic's Messages API"):
        bots.check({**bot, "model": "chat"}, "good")
    assert "the key works" in bots.check({**bot, "model": "busy"}, "good"), "a free tier that's busy right now is fine"
    with pytest.raises(ValueError, match="can't reach"):
        bots.check({**bot, "url": "http://127.0.0.1:9"}, "good")


def test_a_bot_runs_on_its_provider_never_on_a_claude_login(env, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "the-farms-own-token")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "the-farms-own-key")
    mgr = AgentManager(load())
    mgr.stopping.set()  # no child process in this test
    bot = bots.parse({"provider": "openrouter", "model": "qwen/qwen3-coder:free", "workers": 2,
                      "about": "first drafts", "context": "128k"})
    a = mgr.create("Qwen", bot=bot, key="sk-or-secret")
    assert a["id"] == "qwen" and a["bot"] == bot
    path = os.path.join(a["config_dir"], "bot.json")
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert "sk-or-secret" not in open(mgr.registry).read(), "the key stays in the bot's own config dir"
    e = mgr.env_for(mgr.get("qwen"))
    assert e["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api" and e["ANTHROPIC_AUTH_TOKEN"] == "sk-or-secret"
    assert e["ANTHROPIC_API_KEY"] == "" and "CLAUDE_CODE_OAUTH_TOKEN" not in e, "never the farm's own login"
    assert e["ANTHROPIC_MODEL"] == e["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == e["FARM_MODEL"] == "qwen/qwen3-coder:free"
    assert e["FARM_BOT"] == "qwen/qwen3-coder:free" and e["FARM_REMOTE_CONTROL"] == "0" and e["FARM_SEAT"] == "bot-qwen"
    assert e["FARM_MAX_WORKERS"] == "2" and e["FARM_DAILY_BUDGET_USD"] == "0"
    assert e["FARM_BOT_ABOUT"] == "first drafts" and e["FARM_BOT_LEAN"] == "1" and e["FARM_BOT_CONTEXT"] == "131072"
    assert e["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] == "131072", "Claude Code compacts within the model's real window"
    assert "CLAUDE_CODE_MAX_OUTPUT_TOKENS" not in e, "a big window keeps Claude Code's own reply cap"
    assert "CLAUDE_CODE_MAX_CONTEXT_TOKENS" not in bots.env({**a, "bot": {**bot, "context": 0}}), "unknown: not set"
    assert mgr.auth(mgr.get("qwen"))["loggedIn"], "no `claude auth status`: its provider answered when it was added"
    with pytest.raises(ValueError, match="no Claude login"):
        mgr.start_login("qwen")
    mgr.remove("qwen")
    assert not os.path.exists(a["config_dir"]), "its key goes with it"


def test_a_small_window_leaves_claude_code_room_to_work_before_it_compacts():
    # Claude Code compacts once a conversation is within (reply cap, at most 20k) + 13k of the window: told only a 32k
    # window, it compacts on every turn and gives up ("Autocompact is thrashing"), as a real 32k Qwen did
    small = bots.context_env(32768)
    assert small == {"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "32768", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4096",
                     "BASH_MAX_OUTPUT_LENGTH": "12000"}
    assert bots.compacts_at(32768) == 32768 - 4096 - 13000
    assert bots.context_env(65536)["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "8192"
    for window in (29096, 32768, 49152, 65536, 98304, 131072, 1048576):
        e = bots.context_env(window)
        cap = int(e.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS") or bots.REPLY_CAP_MAX)
        assert window - min(cap, bots.REPLY_CAP_MAX) - bots.COMPACT_BUFFER >= bots.ROOM_MIN, window
    assert bots.context_env(24576) == {} and "too small" in bots.context_note(24576), "it runs as before, and says so"
    assert bots.context_note(32768) == ""


def test_a_bot_takes_only_what_is_sent_to_it_and_keeps_its_own_sub_agents(env, monkeypatch, provider):
    url, _ = provider
    mgr = AgentManager(load())
    mgr.stopping.set()
    bot = bots.parse({"provider": "custom", "url": url, "model": "qwen3-coder", "about": "tiny jobs: one function",
                      "context": "32k"})
    agent = mgr.create("qwen", bot=bot, key="k")
    for k, v in mgr.env_for(agent).items():  # this test's farm is that bot's `clodfarm run`
        monkeypatch.setenv(k, v)
    farm, t = start_farm()
    try:
        assert farm.cfg.bot == "qwen3-coder" and farm.cfg.policy.api_mode and farm.seat == "bot-qwen"
        nobody = cli("spawn", "anyone's job", "--prompt", "COMMIT free", check=False)
        assert nobody.returncode == 2 and "nobody would start this" in nobody.stderr, "only a bot is up to take it"
        free = json.loads(cli("spawn", "anyone's job", "--prompt", "COMMIT free", "--force", "--json").stdout)["id"]
        wait_for(lambda: "qwen" in cli("agents").stdout)
        sent = json.loads(cli("spawn", "for the bot", "--prompt", "SPAWN 1", "--on", "qwen", "--json").stdout)["id"]
        wait_for(lambda: farm.store.get_task(sent)["status"] == "done", timeout=60)
        kid = farm.store.get_task(farm.store.get_task(sent)["children"][0])
        assert kid["to"] == "qwen" and kid["status"] == "done", "a bot's own sub-agents stay on it"
        assert farm.store.get_task(free)["status"] == "queued", "not sent to it: it waits for a Claude"
        runs = [c for c in calls(env) if c["cmd"] == "print"]
        assert runs and all(c["base_url"] == url and c["model"] == "qwen3-coder" and c["token"] == "k"
                            and c["max_context"] == "32768" for c in runs)
        for c in runs:  # lean: only the tools a bot needs, no MCP servers or skills, and the short guide
            argv = c["argv"]
            assert argv[argv.index("--tools") + 1] == "Bash,Read,Edit,Write,Glob,Grep"
            assert "--strict-mcp-config" in argv and "--disable-slash-commands" in argv
            guide = argv[argv.index("--append-system-prompt") + 1]
            assert guide.startswith("# You are a bot on a clodfarm farm") and "## Dashboards" not in guide
        md = os.path.join(agent["config_dir"], "CLAUDE.md")
        assert not os.path.exists(md) or "## Dashboards" not in open(md).read(), "nor the farm guide in its CLAUDE.md"
        ro = json.loads(cli("spawn", "read only", "--prompt", "COMMIT ro", "--on", "qwen", "--tools", "Read,Grep",
                            "--json").stdout)["id"]
        wait_for(lambda: farm.store.get_task(ro)["status"] == "done", timeout=60)
        argv = next(c["argv"] for c in calls(env) if c["cmd"] == "print" and c["task"] == ro)
        assert argv[argv.index("--tools") + 1] == "Read,Grep", "a sub-agent narrows a bot's tools"
        assert "bots first ON" in cli("farm", "bots-first").stdout
        assert "BOTS FIRST is on" in cli("agents").stdout, "the Claudes see it where they look for the bots"
        lean = json.loads(cli("spawn", "still lean", "--prompt", "COMMIT lean", "--on", "qwen", "--json").stdout)["id"]
        wait_for(lambda: farm.store.get_task(lean)["status"] == "done", timeout=60)
        argv = next(c["argv"] for c in calls(env) if c["cmd"] == "print" and c["task"] == lean)
        assert "BOTS FIRST" not in argv[argv.index("--append-system-prompt") + 1], "a bot is who the work goes to"
        cli("farm", "bots-first-off")
        big = json.loads(cli("spawn", "too big", "--prompt", "THRASH", "--on", "qwen", "--json").stdout)["id"]
        wait_for(lambda: farm.store.get_task(big)["status"] == "failed", timeout=60)
        assert len([c for c in calls(env) if c["cmd"] == "print" and c["task"] == big]) == 1, "no retry: it won't fit"
        assert farm.store.get_task(big)["result"].startswith("Too big for bot qwen: the job outgrew its 32k context")
        assert int((farm.store.b.get("CONTROL", "HEALTH") or {}).get("failures", 0)) == 0, "not a broken farm"
        assert not [c for c in calls(env) if c["cmd"] == "remote-control"], "a bot has no Claude login to talk through"
        assert "child0.txt" in repo_files(env)
        out = cli("agents").stdout
        assert "BOT on qwen3-coder via Anthropic-compatible · 32k context" in out and "--on qwen" in out
        assert "good for: tiny jobs: one function" in out
        assert "a bot on another model" in cli("budget").stdout
        cli("spawn", "too much", "--prompt", "REJECT", "--on", "qwen")  # its provider says 429
        wait_for(lambda: [e for e in farm.store.events(time.time() - 60) if e["type"] == "budget.rejected"
                          and "rate-limited bot qwen" in e["msg"]])
        assert "API rate limited" in cli("agents").stdout, "it rests until its provider lets it go on"
    finally:
        stop_farm(farm, t)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _answer_on(port: int) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", port), BaseHTTPRequestHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_a_bot_that_cant_reach_its_model_waits_and_never_trips_the_circuit_breaker(env, monkeypatch):
    from clodfarm import supervisor
    monkeypatch.setattr(supervisor, "PROVIDER_CHECK", 0.5)
    monkeypatch.setenv("FARM_STALL_THRESHOLD", "1")  # one failed run would pause the farm
    port = _free_port()
    mgr = AgentManager(load())
    mgr.stopping.set()
    agent = mgr.create("qwen", bot=bots.parse({"provider": "custom", "url": f"http://127.0.0.1:{port}/api",
                                               "model": "qwen3-coder"}), key="k")
    for k, v in mgr.env_for(agent).items():
        monkeypatch.setenv(k, v)
    farm, t = start_farm()
    srv = None
    try:
        wait_for(lambda: "CAN'T REACH ITS MODEL (127.0.0.1:" in cli("agents").stdout)
        sent = cli("spawn", "for the bot", "--prompt", "COMMIT late", "--on", "qwen", "--json")
        assert "can't reach its model" in sent.stderr, "whoever sends it work hears it will wait"
        tid = json.loads(sent.stdout)["id"]
        time.sleep(2)
        assert farm.store.get_task(tid)["status"] == "queued" and not calls(env), "nothing runs while it can't reach it"
        assert [e for e in farm.store.events(time.time() - 60) if e["type"] == "bot.unreachable"]
        srv = _answer_on(port)  # its computer is on again
        wait_for(lambda: farm.store.get_task(tid)["status"] == "done", timeout=60)
        assert [e for e in farm.store.events(time.time() - 60) if e["type"] == "bot.reachable"]
        # its model goes away while it works: the run fails, and the task waits for it again, as a rate limit does
        mid = json.loads(cli("spawn", "cut off", "--prompt", "SLOW 5 FAIL", "--on", "qwen", "--json").stdout)["id"]
        wait_for(lambda: farm.store.get_task(mid)["status"] == "running")
        srv.shutdown()
        srv.server_close()
        srv = None
        wait_for(lambda: "stopped answering" in (farm.store.get_task(mid).get("result") or ""), timeout=60)
        task = farm.store.get_task(mid)
        assert task["status"] == "queued" and int(task.get("attempts", 0)) == 0, "the attempt is given back"
        assert not farm.store.control().get("paused"), "not a failed run: the circuit breaker isn't touched"
    finally:
        stop_farm(farm, t)
        if srv:
            srv.shutdown()
            srv.server_close()


def test_bot_set_says_what_a_bot_is_good_for_and_how_big_its_context_is(env, provider):
    url, _ = provider
    store = Store.from_config(load())
    store.ensure_table()
    mgr = AgentManager(load())
    mgr.stopping.set()
    mgr.create("qwen", bot=bots.parse({"provider": "custom", "url": url, "model": "m"}), key="", start=False)
    out = cli("bot", "set", "qwen", "--about", "tiny jobs: one function", "--context", "32k")
    assert out.returncode == 0 and "restarts with them" in out.stdout
    b = AgentManager(load()).get("qwen")["bot"]
    assert b["about"] == "tiny jobs: one function" and b["context"] == 32768 and b["lean"] is True
    assert cli("bot", "set", "qwen", "--full").returncode == 0
    assert AgentManager(load()).get("qwen")["bot"]["lean"] is False
    assert "too small" in cli("bot", "set", "qwen", "--context", "8k").stdout, "a context too small for Claude Code"
    assert cli("bot", "set", "qwen", "--context", "12", check=False).returncode == 1
    assert cli("bot", "set", "nobody", "--about", "x", check=False).returncode == 1
    assert [e for e in store.events(time.time() - 60) if e["type"] == "agent.changed"]


def test_clodfarm_bot_add_checks_it_first(env, provider):
    url, seen = provider
    run = lambda *args, key: subprocess.run([sys.executable, "-m", "clodfarm", "bot", "add", *args],  # noqa: E731
                                            input=key + "\n", capture_output=True, text=True)
    bad = run("nightbot", "--provider", "custom", "--url", url, "--model", "m", key="wrong")
    assert bad.returncode == 1 and "refused the key" in bad.stderr
    assert not AgentManager(load()).get("nightbot"), "nothing is kept until its model answers"
    ok = run("nightbot", "--provider", "custom", "--url", url, "--model", "m", "--any", key="good")
    assert ok.returncode == 0, ok.stderr
    assert "answered \"ok\"" in ok.stdout and "--on nightbot" in ok.stdout
    a = AgentManager(load()).get("nightbot")
    assert a["bot"]["takes"] == "any" and bots.load_key(a["config_dir"]) == "good"
    assert not os.path.exists(os.path.join(str(env / "workspace"), ".farm", "agents", "nightbot.log")), \
        "the command only registers it: the farm UI's process starts it, once"


def test_the_farm_ui_adds_a_bot(env, backend, monkeypatch, provider):
    if backend != "sqlite":
        pytest.skip("the UI reads the same Store API on both backends; one is enough")
    from test_web import client, login
    from clodfarm.store import Store
    from clodfarm.web import FarmUI, make_handler
    url, _ = provider
    monkeypatch.setenv("FARM_UI_PASSWORD", "correct horse")
    cfg = load()
    store = Store.from_config(cfg)
    store.ensure_table()
    farm_ui = FarmUI(cfg, store)
    farm_ui.manager.stopping.set()  # its `clodfarm run` isn't needed here
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(farm_ui))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        call = client()
        login(call, base)
        code, body, _ = call(base + "/api/agents", {"name": "Qwen", "bot": {"provider": "custom", "url": url,
                                                                            "model": "m", "key": "wrong"}})
        assert code == 400 and "refused the key" in body["error"]
        code, a, _ = call(base + "/api/agents", {"name": "Qwen", "bot": {"provider": "custom", "url": url,
                                                                         "model": "m", "key": "good"}})
        assert code == 200 and a["id"] == "qwen" and a["said"] == "ok"
        farm_ui._state_cache = None
        st = call(base + "/api/state")[1]
        v = next(x for x in st["agents"] if x["id"] == "qwen")
        assert v["bot"] == {"model": "m", "via": "Anthropic-compatible", "takes": "sent", "about": "", "context": 0,
                            "reachable": True} and v["loggedIn"]
        assert "good" not in json.dumps(st), "the key is never shown again"
        assert [e for e in store.events(time.time() - 60) if e["type"] == "agent.added" and "a bot on m" in e["msg"]]
    finally:
        srv.shutdown()
        farm_ui.manager.shutdown()
