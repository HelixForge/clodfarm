"""farm-helpers patch (local, not upstream clodfarm): tokens by model, for the farm's token counter.

clodfarm's own counter adds up each run's main `usage` when the run ends, so it can't tell the Opus leads from the
Haiku/Sonnet helpers they start, and it never sees the local model. This reads the Claude Code transcripts instead
(~/.claude/projects/**/*.jsonl, sub-agent ones included). Every assistant message there carries its model and usage,
so in-flight runs count too. The local model's tokens come from tools/local-llm/ask.py's log.

"This session" is the current 5-hour usage window (the same one the 5H bar shows).
Reapply after an image rebuild or `clodfarm upgrade`: /srv/docker/ai/clodfarm-game/ui-patch/apply.sh
"""
import glob
import json
import os
import threading
import time
from datetime import datetime, timezone

PROJECTS = os.path.expanduser("~/.claude/projects")
KINDS = ("input", "output", "cache_write", "cache_read")
TIERS = ("opus", "sonnet", "haiku", "qwen")
REFRESH = 15.0
_lock = threading.Lock()
_files: dict = {}  # path -> {"pos": bytes read, "msgs": {message id: (ts, tier, counts)}}
_last: tuple = (0.0, None, None)


def _ts(at: str) -> float:
    try:
        return datetime.strptime(at[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _tier(model: str) -> str:
    m = (model or "").lower()
    return next((t for t in ("opus", "sonnet", "haiku") if t in m), "")


def _read(path: str):
    """Read what's new in one transcript (they only grow; a smaller file means it was replaced)."""
    f = _files.setdefault(path, {"pos": 0, "msgs": {}})
    try:
        size = os.path.getsize(path)
        if size < f["pos"]:
            f.update(pos=0, msgs={})
        if size == f["pos"]:
            return
        with open(path, "rb") as fh:
            fh.seek(f["pos"])
            data = fh.read()
    except OSError:
        return
    end = data.rfind(b"\n") + 1  # only whole lines; the rest is read next time
    f["pos"] += end
    for line in data[:end].splitlines():
        if b'"assistant"' not in line or b'"usage"' not in line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        m = r.get("message") or {}
        u, tier = m.get("usage") or {}, _tier(m.get("model"))
        if r.get("type") != "assistant" or not u or not tier:
            continue
        # a message is written once per content block with the same usage: the last copy wins
        f["msgs"][m.get("id") or r.get("uuid")] = (_ts(r.get("timestamp", "")), tier, (
            int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0),
            int(u.get("cache_creation_input_tokens") or 0), int(u.get("cache_read_input_tokens") or 0)))


def _qwen(workspace: str):
    try:
        for line in open(os.path.join(workspace, ".farm", "local-llm.jsonl")):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("outcome") == "ok":
                yield _ts(r.get("at", "")), (int(r.get("prompt_tokens") or 0), int(r.get("tokens") or 0), 0, 0)
    except OSError:
        return


def collect(workspace: str, resets_at) -> dict:
    """{"since": session start, "resets": its end, "tiers": {tier: {"session": {...}, "total": {...}}}}: token counts
    (input, output, cache_write, cache_read, total) per model family. Recomputed at most every 15 s."""
    global _last
    now = time.time()
    with _lock:
        if now - _last[0] < REFRESH and _last[1] == resets_at:
            return _last[2]
        since = float(resets_at) - 5 * 3600 if resets_at else now - 5 * 3600
        zero = lambda: dict.fromkeys(KINDS + ("total",), 0)  # noqa: E731
        out = {t: {"session": zero(), "total": zero()} for t in TIERS}

        def add(tier, ts, counts):
            for scope in ("total", "session") if ts >= since else ("total",):
                b = out[tier][scope]
                for k, v in zip(KINDS, counts):
                    b[k] += v
                b["total"] += sum(counts)
        try:
            for path in glob.glob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True):
                _read(path)
            seen: dict = {}  # a resumed session copies its history into a new file: count each message once
            for f in _files.values():
                seen.update(f["msgs"])
            for ts, tier, counts in seen.values():
                add(tier, ts, counts)
            for ts, counts in _qwen(workspace):
                add("qwen", ts, counts)
        except Exception as e:  # never break the farm's state over the counter
            print(f"farm-usage: {e!r}", flush=True)
        res = {"since": since, "resets": resets_at, "tiers": out, "at": now}
        _last = (now, resets_at, res)
        return res
