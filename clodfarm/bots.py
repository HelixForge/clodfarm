"""Bots: farm members that run another model (a free or a local one) through Claude Code.

A bot is added like any other Claude (the farm UI's + NEW CLAUDE, or ``clodfarm bot add``): its own Claude config
dir, its own ``clodfarm run``. Instead of a Claude login it has a provider that speaks Anthropic's Messages API
(OpenRouter, a local Ollama, a LiteLLM gateway...), and Claude Code talks to it through ``ANTHROPIC_BASE_URL``. It is
still Claude Code, so everything the farm does works the same: sub-agents, resume, messages, hooks, the browser
tools. Only the model differs.

- It runs no Remote Control (that needs a Claude login): nobody talks to it, it takes sub-agents.
- It takes only the sub-agents sent to it (``clodfarm spawn --on <bot>``), unless it was added to take any. Its own
  sub-agents stay on it, so a bot never spends a Claude account's usage.
- It is paced like API key mode (no subscription windows), and pauses when its provider rate-limits it or can't be
  reached (a local model on a computer that is off): its sub-agents wait, and nothing counts as a failed run.
- Its runs are lean by default: only the tools a bot needs (``LEAN_TOOLS``), no MCP servers or skills, and a short
  guide instead of the farm's. That is about 5k tokens of Claude Code's prompt instead of about 20k, so a small local
  model has room to work. A sub-agent can narrow its tools further (``clodfarm spawn --tools``).
- It knows its model's context window (asked from Ollama, or set by hand), and Claude Code is told it
  (``CLAUDE_CODE_MAX_CONTEXT_TOKENS``, with a reply cap small enough to leave room: see ``context_env``), so it
  compacts in time instead of the provider cutting the prompt.
- Its person says what it is good for (``about``); the Claudes that send it work see that in ``clodfarm agents``.
- Its API key is kept in its own config dir (``bot.json``, readable by the farm's user only) and never shown again.
"""

from __future__ import annotations

import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request

PROVIDERS = {
    "openrouter": {"label": "OpenRouter", "url": "https://openrouter.ai/api", "key": True,
                   "example": "qwen/qwen3-coder:free"},
    # the farm runs in a container: Ollama on the host is host.docker.internal, not localhost
    "ollama": {"label": "Ollama", "url": "http://host.docker.internal:11434", "key": False, "example": "qwen3-coder"},
    "custom": {"label": "Anthropic-compatible", "url": "", "key": False, "example": ""},
}
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}")
KEY_FILE = "bot.json"
MAX_WORKERS = 4
ABOUT_MAX = 160
# what a lean bot's runs get: enough to read, change, run and commit code
LEAN_TOOLS = ("Bash", "Read", "Edit", "Write", "Glob", "Grep")
# what a sub-agent sent to a bot may ask for instead (`clodfarm spawn --tools`)
TOOL_CHOICES = LEAN_TOOLS + ("WebFetch", "WebSearch", "NotebookEdit", "TodoWrite")
# Claude Code compacts when a conversation comes within its auto-compact buffer of the window: its reply cap (at most
# 20k) plus a fixed 13k (as Claude Code 2.1 reports in /context). A small window needs a small reply cap, or the buffer
# is bigger than the window and it compacts on every turn until it gives up ("Autocompact is thrashing").
COMPACT_BUFFER = 13000
REPLY_CAP_MAX = 20000
# what a job needs before Claude Code compacts, on top of its own prompt (about 5k to 8k tokens, lean)
ROOM_MIN = 12000
SMALL_OUTPUT_CHARS = "12000"  # a small window's cap on one command's output (BASH_MAX_OUTPUT_LENGTH; default 30000)


def parse(data: dict) -> dict:
    """A bot's settings from what the UI or the CLI sent: ``provider``, ``url``, ``model``, ``takes`` ("sent": only
    the sub-agents sent to it; "any": any sub-agent), ``workers``, ``about`` (what it is good for), ``lean`` (its runs
    get only the tools a bot needs; default on) and ``context`` (its model's context window in tokens, 0: unknown).
    Raises ValueError with what is wrong."""
    provider = str(data.get("provider") or "custom").strip().lower()
    if provider not in PROVIDERS:
        raise ValueError(f"the provider is one of {', '.join(PROVIDERS)}")
    url = str(data.get("url") or PROVIDERS[provider]["url"]).strip().rstrip("/")
    url = re.sub(r"/v1(/messages)?$", "", url)  # Claude Code adds /v1/messages itself
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password or u.query or u.fragment \
            or any(c.isspace() for c in url):
        raise ValueError("the address is the provider's base URL, like https://openrouter.ai/api")
    model = str(data.get("model") or "").strip()
    if not MODEL_RE.fullmatch(model):
        raise ValueError("name the model it runs, like " + (PROVIDERS[provider]["example"] or "the provider calls it"))
    takes = "any" if str(data.get("takes") or "sent") == "any" else "sent"
    try:
        workers = int(data.get("workers") or 1)
    except (TypeError, ValueError):
        raise ValueError("workers is a number") from None
    if not 1 <= workers <= MAX_WORKERS:
        raise ValueError(f"a bot runs 1 to {MAX_WORKERS} sub-agents at a time")
    return {"provider": provider, "url": url, "model": model, "takes": takes, "workers": workers,
            "about": parse_about(data.get("about")), "lean": data.get("lean") not in (False, "0", "false", "off"),
            "context": parse_context(data.get("context"))}


def parse_about(text) -> str:
    """What a bot is good for, in one short line (it is shown to every Claude that may send it work)."""
    about = " ".join("".join(c for c in str(text or "") if c.isprintable()).split())
    if len(about) > ABOUT_MAX:
        raise ValueError(f"say what it is good for in at most {ABOUT_MAX} characters")
    return about


def parse_context(value) -> int:
    """A context window in tokens: 0 (unknown), a number, or one written like 32k."""
    text = str(value if value is not None else "").strip().lower()
    if text in ("", "0", "auto"):
        return 0
    m = re.fullmatch(r"(\d+)(k?)", text)
    n = int(m.group(1)) * (1024 if m.group(2) else 1) if m else -1
    if not 2048 <= n <= 10_000_000:
        raise ValueError("the context window is a number of tokens, like 32768 or 32k")
    return n


def parse_tools(text: str) -> list[str]:
    """The tools a sub-agent sent to a bot asks for (``--tools Read,Grep,Glob``), in the order given."""
    names = [t for t in re.split(r"[,\s]+", str(text or "").strip()) if t]
    wrong = [t for t in names if t not in TOOL_CHOICES]
    if wrong or not names:
        raise ValueError(f"the tools are some of {', '.join(TOOL_CHOICES)}"
                         + (f" (not {', '.join(wrong)})" if wrong else ""))
    return list(dict.fromkeys(names))


def run_tools(asked: list | None) -> list[str]:
    """The tools a lean bot's run gets: what its sub-agent asked for (of TOOL_CHOICES), or LEAN_TOOLS."""
    picked = [t for t in (asked or []) if t in TOOL_CHOICES]
    return list(dict.fromkeys(picked)) or list(LEAN_TOOLS)


def reply_cap(context: int) -> int:
    """The reply cap (CLAUDE_CODE_MAX_OUTPUT_TOKENS) for a window: small for a small one, Claude Code's own (0) for a
    big one."""
    return 4096 if context <= 49152 else 8192 if context <= 98304 else 0


def compacts_at(context: int) -> int:
    """How full a conversation gets before Claude Code compacts it, in a window of ``context`` tokens."""
    return context - min(reply_cap(context) or REPLY_CAP_MAX, REPLY_CAP_MAX) - COMPACT_BUFFER


def context_env(context: int) -> dict:
    """What Claude Code is told about a bot's window: its size, so it compacts in time instead of the provider cutting
    the prompt, and for a small one a reply cap and a cap on command output. Nothing when the window is unknown, or so
    small that compacting would leave no room for a job (it then runs as it did before)."""
    if not context or compacts_at(context) < ROOM_MIN:
        return {}
    env = {"CLAUDE_CODE_MAX_CONTEXT_TOKENS": str(context)}
    if reply_cap(context):
        env.update(CLAUDE_CODE_MAX_OUTPUT_TOKENS=str(reply_cap(context)), BASH_MAX_OUTPUT_LENGTH=SMALL_OUTPUT_CHARS)
    return env


def context_note(context: int) -> str:
    """What to tell a person about a bot's context window, or "" when it is fine."""
    if not context:
        return ("its context window is unknown: set it with `clodfarm bot set <name> --context <tokens>` so Claude "
                "Code compacts in time")
    if not context_env(context):
        need = ROOM_MIN + COMPACT_BUFFER + reply_cap(context)
        return (f"its context window ({context} tokens) is too small for Claude Code to compact in (it keeps "
                f"{COMPACT_BUFFER + reply_cap(context)} free for that): it runs without a window, like before, so give "
                f"it tiny jobs, or use a model with at least {need} tokens")
    return ""


def outgrew_context(error: str) -> bool:
    """Whether a failed run ended because the job didn't fit the model's context window (Claude Code gave up
    compacting, or the provider refused a prompt that long): a retry on the same bot won't fit it either."""
    e = (error or "").lower()
    return "autocompact is thrashing" in e or "prompt is too long" in e


def reachable(url: str, timeout: float = 3.0) -> bool:
    """Whether anything answers at the provider's address (a TCP connection; no request is sent), e.g. whether the
    computer that runs a local Ollama is on."""
    u = urllib.parse.urlsplit(url)
    port = u.port or (443 if u.scheme == "https" else 80)
    try:
        with socket.create_connection((u.hostname, port), timeout=timeout):
            return True
    except (OSError, ValueError):
        return False


def detect_context(bot: dict, timeout: float = 10) -> int:
    """The context window its provider runs the model with, when the provider says (Ollama's ``num_ctx``, from the
    model's parameters or from the loaded model); 0 when it doesn't."""
    if bot.get("provider") == "openrouter":
        return 0
    base = bot["url"]
    try:
        req = urllib.request.Request(base + "/api/show", data=json.dumps({"model": bot["model"]}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            info = json.loads(r.read(1 << 22) or b"{}")
        m = re.search(r"(?m)^\s*num_ctx\s+(\d+)\s*$", str(info.get("parameters") or ""))
        if m:
            return int(m.group(1))
        with urllib.request.urlopen(base + "/api/ps", timeout=timeout) as r:
            loaded = json.loads(r.read(1 << 20) or b"{}").get("models") or []
        want = {bot["model"], bot["model"] + ":latest"}
        return next((int(x.get("context_length") or 0) for x in loaded if x.get("name") in want
                     or x.get("model") in want), 0)
    except (OSError, ValueError, AttributeError, TypeError):
        return 0


def check_key(provider: str, key: str) -> str:
    key = (key or "").strip()
    if len(key) > 500 or any(c.isspace() or ord(c) < 32 for c in key):
        raise ValueError("that doesn't look like an API key")
    if PROVIDERS[provider]["key"] and not key:
        raise ValueError(f"{PROVIDERS[provider]['label']} needs an API key")
    return key


def check(bot: dict, key: str, timeout: float = 45) -> str:
    """Ask the model for one word, the way Claude Code will (``Authorization: Bearer``), so a bot is kept only once
    its provider answers. Returns what it said. Raises ValueError with what went wrong."""
    body = json.dumps({"model": bot["model"], "max_tokens": 16,
                       "messages": [{"role": "user", "content": "Reply with the one word: ok"}]}).encode()
    headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(bot["url"] + "/v1/messages", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            got = json.loads(r.read(1 << 20) or b"{}")
    except urllib.error.HTTPError as e:
        detail = _error_text(e)
        if e.code == 429:
            return "(rate limited right now: the key works)"
        if e.code in (401, 403):
            raise ValueError(f"the provider refused the key ({e.code}{': ' + detail if detail else ''})") from None
        if e.code == 404:
            raise ValueError(f"no such model, or {bot['url']} doesn't speak Anthropic's Messages API "
                             f"(404{': ' + detail if detail else ''})") from None
        raise ValueError(f"the provider answered {e.code}{': ' + detail if detail else ''}") from None
    except (urllib.error.URLError, OSError) as e:
        raise ValueError(f"can't reach {bot['url']} ({getattr(e, 'reason', e)})") from None
    except ValueError:
        raise ValueError(f"{bot['url']} answered, but not with Anthropic's Messages API") from None
    if not isinstance(got, dict) or not isinstance(got.get("content"), list):
        raise ValueError(f"{bot['url']} answered, but not with Anthropic's Messages API")
    text = "".join(b.get("text", "") for b in got["content"] if isinstance(b, dict)).strip()
    return text[:80] or "(an empty answer)"


def _error_text(e: urllib.error.HTTPError) -> str:
    try:
        d = json.loads(e.read(1 << 16) or b"{}")
    except (OSError, ValueError):
        return ""
    err = d.get("error") if isinstance(d, dict) else None
    msg = err.get("message") if isinstance(err, dict) else err if isinstance(err, str) else ""
    return str(msg or "")[:200]


def save_key(config_dir: str, key: str):
    """Keep the bot's API key in its own config dir, readable by the farm's user only."""
    os.makedirs(config_dir, mode=0o700, exist_ok=True)
    path = os.path.join(config_dir, KEY_FILE)
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"key": key}, f)
    os.replace(path + ".tmp", path)


def load_key(config_dir: str) -> str:
    try:
        return str(json.load(open(os.path.join(config_dir, KEY_FILE))).get("key") or "")
    except (OSError, ValueError, AttributeError):
        return ""


def label(bot: dict) -> str:
    return PROVIDERS.get(bot.get("provider") or "", PROVIDERS["custom"])["label"]


def env(agent: dict) -> dict:
    """What a bot's ``clodfarm run`` (and every Claude Code it starts) gets: its provider in place of a Claude login,
    its model for every model Claude Code picks, and the farm settings of a bot."""
    bot, m = agent["bot"], agent["bot"]["model"]
    return {
        "ANTHROPIC_BASE_URL": bot["url"],
        # Claude Code sends this as a Bearer token; a provider without keys (Ollama) takes any
        "ANTHROPIC_AUTH_TOKEN": load_key(agent["config_dir"]) or "none",
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_MODEL": m, "ANTHROPIC_DEFAULT_OPUS_MODEL": m, "ANTHROPIC_DEFAULT_SONNET_MODEL": m,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": m, "ANTHROPIC_SMALL_FAST_MODEL": m, "CLAUDE_CODE_SUBAGENT_MODEL": m,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "FARM_BOT": m, "FARM_BOT_VIA": label(bot), "FARM_BOT_TAKES": bot.get("takes") or "sent",
        "FARM_BOT_ABOUT": bot.get("about") or "", "FARM_BOT_LEAN": "0" if bot.get("lean") is False else "1",
        "FARM_BOT_CONTEXT": str(int(bot.get("context") or 0)),
        # the model's real window: Claude Code compacts within it instead of assuming a Claude model's
        **context_env(int(bot.get("context") or 0)),
        "FARM_MODEL": m, "FARM_EFFORT": "", "FARM_REMOTE_CONTROL": "0", "FARM_USAGE_REFRESH": "0",
        "FARM_MAX_WORKERS": str(bot.get("workers") or 1), "FARM_SEAT": f"bot-{agent['id']}",
        # Claude Code prices every run as if it were a Claude model: that is no bot's real cost
        "FARM_DAILY_BUDGET_USD": "0", "FARM_TASK_BUDGET_USD": "0",
    }
