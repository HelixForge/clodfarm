"""farm-helpers patch (local, not upstream clodfarm): the helpers each running sub-agent has going on inside its own
session, so the farm scene can draw them as minis next to it. Two kinds:

- local: a pseudocode brief being typed by the local model (tools/local-llm/ask.py logs a start line to
  <workspace>/.farm/local-llm-starts.jsonl and an end line to local-llm.jsonl)
- agent: a Claude Code subagent started with the Agent tool (gd-coder, gd-tester, runner, reviewer...): its transcript
  is ~/.claude/projects/-workspace--worktrees-<task id>/<session>/subagents/agent-<id>.jsonl, with a .meta.json beside
  it; it's still working until its last line is an assistant turn that ended (stop_reason end_turn)

Reapply after an image rebuild or `clodfarm upgrade`: /srv/docker/ai/clodfarm-game/ui-patch/apply.sh
"""
import glob
import json
import os
import re
import time
from datetime import datetime, timezone

PROJECTS = os.path.expanduser("~/.claude/projects")
LOCAL_STALE, AGENT_STALE = 900, 600  # past this with no end / no write, it died: don't draw it
_cache: tuple = (0.0, [])


def _jsonl(path: str, tail: int = 262144) -> list:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - tail))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []
    if size > tail:
        lines = lines[1:]  # the first one is cut
    out = []
    for x in lines:
        try:
            out.append(json.loads(x))
        except ValueError:
            pass
    return out


def _epoch(at: str) -> float:
    try:
        return datetime.strptime(at[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except (TypeError, ValueError):
        return time.time()


def _local(workspace: str, running: set, now: float) -> list:
    farm = os.path.join(workspace, ".farm")
    ended = {r.get("id") for r in _jsonl(os.path.join(farm, "local-llm.jsonl"), 65536) if r.get("id")}
    out = []
    for r in _jsonl(os.path.join(farm, "local-llm-starts.jsonl"), 65536):
        since = _epoch(r.get("at", ""))
        if r.get("id") in ended or now - since > LOCAL_STALE or r.get("task") not in running:
            continue
        out.append({"id": "llm-" + str(r["id"]), "task": r["task"], "kind": "local", "who": "qwen",
                    "model": r.get("model") or "local model", "label": r.get("out") or "a brief", "since": since})
    return out


def _agents(running: set, now: float) -> list:
    out = []
    for tid in running:
        for path in glob.glob(os.path.join(PROJECTS, f"-workspace--worktrees-{tid}", "*", "subagents", "agent-*.jsonl")):
            try:
                if now - os.path.getmtime(path) > AGENT_STALE:
                    continue
            except OSError:
                continue
            rows = _jsonl(path)
            if not rows:
                continue
            last = rows[-1]
            if last.get("type") == "assistant" and (last.get("message") or {}).get("stop_reason") == "end_turn":
                continue  # finished (a SendMessage later appends a user line and it's working again)
            model = next(((r.get("message") or {}).get("model") for r in reversed(rows)
                          if r.get("type") == "assistant" and (r.get("message") or {}).get("model")), "")
            try:
                meta = json.load(open(path[:-len(".jsonl")] + ".meta.json"))
            except (OSError, ValueError):
                meta = {}
            first = rows[0] if rows else {}
            out.append({"id": "agent-" + os.path.basename(path)[len("agent-"):-len(".jsonl")], "task": tid,
                        "kind": "agent", "who": meta.get("agentType") or "agent", "model": model,
                        "label": (meta.get("description") or "")[:120], "since": _epoch(first.get("timestamp", ""))})
    return out


def collect(workspace: str, subs: list) -> list:
    """Helpers at work under the running sub-agents in ``subs``. Cached for 2 s (the state is built once a second)."""
    global _cache
    now = time.time()
    if now - _cache[0] < 2.0:
        return _cache[1]
    running = {t["id"] for t in subs if t.get("status") == "running" and t.get("id")}
    try:
        out = _local(workspace, running, now) + _agents(running, now) if running else []
    except Exception as e:  # never break the farm's state over a drawing nicety
        print(f"farm-helpers: {e!r}", flush=True)
        out = []
    out.sort(key=lambda h: h["since"])
    _cache = (now, out)
    return out


# ----------------------------------------------------------- the session view: one log per agent
def _turns(path: str, limit: int = 400) -> list:
    """A helper's conversation, shaped like the farm's session turns. Its transcript is all sidechain lines, which
    the farm's own reader skips, so it's read here."""
    from .sessions import MAX_TEXT, _blocks, _clip
    out = []
    for d in _jsonl(path, 4 * 1024 * 1024):
        t = d.get("type")
        if t not in ("user", "assistant") or d.get("isMeta"):
            continue
        msg = d.get("message") or {}
        role = msg.get("role") or t
        for kind, text in _blocks(msg.get("content")):
            if kind == "text" and role == "user" and text.lstrip().startswith(("<command-", "<local-command", "<system-reminder")):
                continue
            out.append({"role": role, "kind": kind, "text": _clip(text, MAX_TEXT), "at": d.get("timestamp")})
    return out[-limit:]


def _model(rows: list) -> str:
    return next(((r.get("message") or {}).get("model") for r in reversed(rows)
                 if r.get("type") == "assistant" and (r.get("message") or {}).get("model")), "")


def session_view(store, s: dict, workspace: str) -> dict:
    """Who's talking in a session: its own agent (named by its farm job and model), each Agent-tool helper with its
    own conversation, and the local-model briefs its job sent. For /api/sessions/<id>."""
    try:
        path = s.get("transcript") or ""
        name = ""
        if s.get("task"):
            title = (store.get_task(s["task"]) or {}).get("title") or ""
            name = title.split(":")[0] if title.startswith("Planner cycle") else title[:48]
        out = {"name": name or ("Conversation" if s.get("kind") == "conversation" else ""),
               "model": _model(_jsonl(path, 262144)) if path else "", "helpers": [], "briefs": []}
        for hp in sorted(glob.glob(os.path.join(path[:-len(".jsonl")], "subagents", "agent-*.jsonl"))) if path else []:
            rows = _jsonl(hp, 4 * 1024 * 1024)
            try:
                meta = json.load(open(hp[:-len(".jsonl")] + ".meta.json"))
            except (OSError, ValueError):
                meta = {}
            last = rows[-1] if rows else {}
            out["helpers"].append({
                "id": os.path.basename(hp)[len("agent-"):-len(".jsonl")], "who": meta.get("agentType") or "agent",
                "label": meta.get("description") or "", "model": _model(rows),
                "started": _epoch(rows[0].get("timestamp", "")) if rows else 0,
                "done": last.get("type") == "assistant" and (last.get("message") or {}).get("stop_reason") == "end_turn",
                "conversation": _turns(hp)})
        out["helpers"].sort(key=lambda x: x["started"])
        if s.get("task"):
            farm = os.path.join(workspace, ".farm")
            key = lambda r: r.get("id") or (r.get("at"), r.get("out"))  # noqa: E731 (older log lines have no id)
            ends = {key(r): r for r in _jsonl(os.path.join(farm, "local-llm.jsonl"), 1024 * 1024)}
            seen = set()
            for r in _jsonl(os.path.join(farm, "local-llm-starts.jsonl"), 1024 * 1024) + list(ends.values()):
                if r.get("task") != s["task"] or key(r) in seen:
                    continue
                seen.add(key(r))
                e = ends.get(key(r)) or (r if r.get("outcome") else {})
                out["briefs"].append({"id": r.get("id") or "", "at": _epoch(r.get("at", "")), "out": r.get("out") or "(stdout)",
                                      "model": r.get("model") or "", "outcome": e.get("outcome") or "running",
                                      "secs": e.get("secs") or 0, "lines": e.get("lines") or 0})
            out["briefs"].sort(key=lambda b: b["at"])
            _brief_details(out["briefs"], s, farm)
        return out
    except Exception as e:  # never break the session view over the extras
        print(f"farm-helpers: session view: {e!r}", flush=True)
        return {}


def _brief_details(briefs: list, s: dict, farm: str):
    """What each brief said and what came back. ask.py saves both (<workspace>/.farm/local-llm/<id>.json); for briefs
    from before it did, the brief is found in the lead's transcript (the heredoc it wrote and the ask.py call that used
    it) and the answer is the file as it is now."""
    import re
    from .sessions import MAX_TEXT, _clip
    writes, calls = {}, {}
    if any(not os.path.exists(os.path.join(farm, "local-llm", f"{b['id']}.json")) for b in briefs) and s.get("transcript"):
        for d in _jsonl(s["transcript"], 16 * 1024 * 1024):
            for blk in ((d.get("message") or {}).get("content") or []) if d.get("type") == "assistant" else []:
                if not isinstance(blk, dict) or blk.get("type") != "tool_use":
                    continue
                inp = blk.get("input") or {}
                if inp.get("file_path") and "content" in inp:  # the Write tool
                    writes[inp["file_path"]] = inp["content"]
                cmd = inp.get("command") or ""
                for m in re.finditer(r"cat\s+>\s*(\S+)\s*<<-?\s*['\"]?(\w+)['\"]?\n(.*?)\n\2\n", cmd + "\n", re.S):
                    writes[m.group(1)] = m.group(3)
                for m in re.finditer(r"ask\.py\s+(\S+)([^\n]*)", cmd):
                    o = re.search(r"--out\s+(\S+)", m.group(2))
                    c = re.search(r"--context\s+(.*?)(?=\s+--|\s*[>;&|)]|$)", m.group(2))
                    calls[o.group(1) if o else "(stdout)"] = (m.group(1), c.group(1).split() if c else [])
    cwd = s.get("cwd") or ""
    for b in briefs:
        saved = os.path.join(farm, "local-llm", f"{b['id']}.json")
        try:
            rec = json.load(open(saved)) if b["id"] and os.path.exists(saved) else None
        except (OSError, ValueError):
            rec = None
        if rec:
            b.update(brief=_clip(rec.get("brief") or "", MAX_TEXT), context=rec.get("context") or [],
                     answer=_clip(rec.get("answer") or rec.get("error") or "", MAX_TEXT), answer_note="")
            continue
        spec, ctx = calls.get(b["out"], ("", []))
        text = writes.get(spec)
        if text is None and spec:
            try:
                text = open(spec if os.path.isabs(spec) else os.path.join(cwd, spec)).read()
            except OSError:
                text = None
        now = ""
        for base in (cwd, "/workspace/repo"):
            try:
                now = open(os.path.join(base, b["out"])).read()
                break
            except OSError:
                continue
        b.update(brief=_clip(text, MAX_TEXT) if text else "", context=ctx, answer=_clip(now, MAX_TEXT),
                 answer_note="Qwen's exact answer wasn't saved for briefs before 2026-10-05 4:50 PM: this is the file "
                             "as it is now, so the lead may have edited it since." if now else "")


# ----------------------------------------------------------- live sessions
# The farm copies a session's turns into its store only on start, stop, end and mail, so a farm job (one long prompt)
# shows 0 turns until it finishes. These read what a running session has written since then, only when someone looks.
_live: dict = {}  # transcript path -> (size, offset, turns)


def is_live(s: dict) -> bool:
    return s.get("busy") in (True, "True", "true", 1, "1")


def live_turns(s: dict) -> list:
    """Turns written to a session's transcript after the farm last copied them (shaped like the farm's turns)."""
    path = s.get("transcript") or ""
    try:
        size, off = os.path.getsize(path), int(float(s.get("offset") or 0))
    except (OSError, ValueError):
        return []
    if size <= off:
        return []
    hit = _live.get(path)
    if hit and hit[0] == size and hit[1] == off:
        return hit[2]
    try:
        from .sessions import read_transcript
        turns = read_transcript(path, off)[0]
    except Exception as e:  # never break the session view over the live part
        print(f"farm-helpers: live turns: {e!r}", flush=True)
        return []
    if len(_live) > 200:
        _live.clear()
    _live[path] = (size, off, turns)
    return turns


def live_list(store, rows: list, keep: tuple) -> list:
    """/api/sessions: a running session gets its live turn count and last write; an untitled farm job its job's title."""
    out = []
    for s in rows:
        r = {k: s.get(k) for k in keep}
        extra = live_turns(s) if is_live(s) else []
        if is_live(s):
            r["live"] = True
            r["turns"] = int(float(s.get("turns") or 0)) + len(extra)
            try:
                r["last_at"] = os.path.getmtime(s["transcript"])
            except (OSError, KeyError):
                pass
        if not r.get("title") and s.get("task"):
            try:
                r["title"] = (store.get_task(s["task"]) or {}).get("title") or ""
            except Exception:
                pass
        out.append(r)
    return out


# ----------------------------------------------------------- the session tree (farm UI: a Claude's SESSIONS)
_tree: tuple = (0.0, None, None)


def _now_line(path: str) -> str:
    """What a running session is doing, from its latest transcript entries."""
    import shlex
    for r in reversed(_jsonl(path, 65536)):
        m = r.get("message") or {}
        if r.get("type") != "assistant":
            continue
        for b in reversed(m.get("content") or []):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text", "").strip():
                return "writing its reply"
            if b.get("type") != "tool_use":
                continue
            n, i = b.get("name"), b.get("input") or {}
            f = os.path.basename(i.get("file_path") or i.get("path") or "")
            if n in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
                return f"editing {f}" if f else "editing a file"
            if n == "Read":
                return f"reading {f}" if f else "reading"
            if n in ("Grep", "Glob"):
                return "searching the code"
            if n in ("Agent", "Task"):
                return f"started a helper: {(i.get('description') or i.get('subagent_type') or '')[:50]}"
            if n == "SendMessage":
                return "messaging a helper"
            if n == "Bash":
                c = i.get("command") or ""
                if "verify-longhaul" in c:
                    return "running the full check"
                if "run_tests.gd" in c:
                    return "running the tests"
                if "ask.py" in c:
                    return "sending a brief to the local model"
                if re.search(r"\bgit (commit|merge)", c):
                    return "committing"
                if "clodfarm spawn" in c:
                    return "starting a farm job"
                if "clodfarm result" in c or re.search(r"\bsleep\b", c):
                    return "waiting on its jobs"
                try:
                    first = shlex.split(c.splitlines()[0])[:3]
                except ValueError:
                    first = c.split()[:3]
                return "running " + " ".join(first)[:48]
            return f"using {n}"
    return ""


def session_tree(store, rows: list, workspace: str) -> dict:
    """/api/session-tree: sessions as planner cycle -> farm jobs -> in-session helpers, each with a status, a short
    name, what it's doing now (running ones) or its outcome (finished ones), and the milestone progress."""
    global _tree
    key = tuple(sorted((s.get("id"), str(s.get("last_at")), str(s.get("busy"))) for s in rows))
    if _tree[1] == key and time.time() - _tree[0] < 4:
        return _tree[2]
    nodes, by_task = [], {}
    for s in sorted(rows, key=lambda r: float(r.get("last_at") or 0), reverse=True):
        tid = s.get("task") or ""
        if tid and tid in by_task:
            continue  # a task resumed in the same or a new session: keep the latest
        t = (store.get_task(tid) if tid else None) or {}
        title = t.get("title") or s.get("title") or "(untitled)"
        plan = t.get("kind") == "plan" or title.startswith("Planner cycle")
        live = is_live(s)
        status = (t.get("status") or ("working" if live else "done")) if tid else ("working" if live else "done")
        status = {"running": "working"}.get(status, status)
        path = s.get("transcript") or ""
        n = {"session": s.get("id"), "task": tid, "parent": t.get("parent") or "", "kind": s.get("kind"),
             "name": title.split(":")[0] if plan else title[:64], "plan": plan, "status": status,
             "turns": int(float(s.get("turns") or 0)) + (len(live_turns(s)) if live else 0),
             "started": float(t.get("started") or s.get("started") or 0), "last_at": float(s.get("last_at") or 0),
             "finished": float(t.get("finished") or 0), "now": "", "outcome": "", "model": "", "helpers": [],
             "jobs_open": int(float(t.get("children_open") or 0)), "children": []}
        if (live or status == "working") and path:
            try:
                n["last_at"] = max(n["last_at"], os.path.getmtime(path))
            except OSError:
                pass
            n["model"] = _model(_jsonl(path, 65536))
            n["now"] = _now_line(path)
        if status == "waiting":
            n["now"] = f"waiting for {n['jobs_open']} job{'s' if n['jobs_open'] != 1 else ''}"
        if t.get("result") and status in ("done", "failed", "cancelled"):
            first = re.sub(r"[*`#]", "", t["result"].strip().split("\n")[0])
            n["outcome"] = first[:110] + ("…" if len(first) > 110 else "")
        if path and (live or status in ("working", "waiting")):
            for hp in sorted(glob.glob(os.path.join(path[:-len(".jsonl")], "subagents", "agent-*.jsonl"))):
                hrows = _jsonl(hp, 65536)
                if not hrows:
                    continue
                last = hrows[-1]
                done = last.get("type") == "assistant" and (last.get("message") or {}).get("stop_reason") == "end_turn"
                try:
                    meta = json.load(open(hp[:-len(".jsonl")] + ".meta.json"))
                except (OSError, ValueError):
                    meta = {}
                n["helpers"].append({"who": meta.get("agentType") or "agent", "model": _model(hrows),
                                     "label": (meta.get("description") or "")[:60], "done": done,
                                     "now": "" if done else _now_line(hp)})
        nodes.append(n)
        if tid:
            by_task[tid] = n
    roots = []
    for n in nodes:
        p = by_task.get(n["parent"])
        (p["children"] if p else roots).append(n)
    milestone = {}
    try:
        prog = open(os.path.join(workspace, "repo", "PROGRESS.md")).read()
        for sec in re.split(r"^## ", prog, flags=re.M)[1:]:  # the latest milestone with anything ticked
            boxes = re.findall(r"^- \[( |x)\]", sec, re.M)
            name = sec.split("\n")[0].split(" ")[0]
            if re.fullmatch(r"M\d+", name) and "x" in boxes:
                milestone = {"name": name, "done": boxes.count("x"), "total": len(boxes)}
    except OSError:
        pass
    out = {"milestone": milestone, "roots": roots, "at": time.time()}
    _tree = (time.time(), key, out)
    return out


# ----------------------------------------------------------- names in the event feed
# Every agent runs on the one Claude account, so the farm logs a message between two sub-agents as
# "chrisfurman86 -> 261006044540d13628: ...". This shows "M5 Track H → M5 Track X: ..." instead (the message record
# keeps the sender's job id as its reply-to). Display only: the farm's own records are untouched.
_TASK = re.compile(r"\b\d{12}[0-9a-f]{6}\b")
_names: dict = {}


def short_name(store, tid: str) -> str:
    if tid not in _names:
        try:
            title = (store.get_task(tid) or {}).get("title") or ""
        except Exception:
            title = ""
        name = re.sub(r"^Long Haul\s+", "", title.split(":")[0]).strip()[:40]
        _names[tid] = name or tid[-6:]
        if len(_names) > 500:
            _names.clear()
    return _names[tid]


def name_events(store, events: list) -> list:
    out = []
    for e in events:
        msg, typ = e.get("msg") or "", e.get("type") or ""
        try:
            if typ == "msg.sent":
                m = re.match(r"^(\S+) -> (\S+): (.*)$", msg, re.S)
                if m:
                    frm, to, text = m.groups()
                    sender = short_name(store, frm) if _TASK.fullmatch(frm) else frm
                    if _TASK.fullmatch(to) and not _TASK.fullmatch(frm):
                        for r in reversed(store.b.query(f"MSG#{to}")[-30:]):  # who sent it: the record's reply-to
                            if (r.get("text") or "").startswith(text[:60].rstrip(" (live)")) and r.get("reply"):
                                sender = short_name(store, r["reply"]) if _TASK.fullmatch(r["reply"]) else r["reply"]
                                break
                    rcpt = short_name(store, to) if _TASK.fullmatch(to) else to
                    msg = f"{sender} → {rcpt}: {text}"
            elif typ.startswith("msg."):
                msg = _TASK.sub(lambda x: short_name(store, x.group(0)), msg)
        except Exception:
            pass
        out.append({**e, "msg": msg})
    return out
