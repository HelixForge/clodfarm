"""Dashboards the Claudes build and keep up to date: each one a page at FARM_UI_BASE/dashboards/<slug>.

A dashboard is a JSON spec of widgets that the farm UI draws (no agent-written HTML runs in your browser):

    {"title": "Test suite", "description": "Is the suite getting faster and greener?",
     "widgets": [
       {"type": "stat", "key": "pass_rate", "label": "Pass rate", "value": 97.2, "unit": "%", "good": "up"},
       {"type": "chart", "label": "Pass rate", "from": ["pass_rate"]},
       {"type": "chart", "label": "Build time", "unit": "s", "series": [{"name": "p50", "points": [["2026-09-01", 12.3]]}]},
       {"type": "bars", "label": "Slowest tests", "unit": "s", "items": [{"label": "test_x", "value": 3.2}]},
       {"type": "table", "label": "Flaky", "columns": ["test", "fails"], "rows": [["test_y", 3]]},
       {"type": "progress", "label": "Migration", "value": 42, "max": 100},
       {"type": "text", "label": "Notes", "text": "**Next:** split the slow suite. See [the PR](https://...)."}]}

Every push records the value of each stat (by its key) in the dashboard's history, one point per hour, so stats show
how they moved (the improvement) without the agent keeping any history itself. A dashboard can also be *live*: give
it a command (code in the repo, e.g. `python3 dashboards/tests.py`) and an interval, and the farm runs it in the repo
and pushes what it prints. The code lives in git, so the Claudes maintain it like any other code.

Items (PK / SK):

    DASH           / <slug>              the dashboard: title, widgets, owner, refresh command and its last outcome
    DASHH#<slug>   / <yyyy-mm-ddThh>     the stats' values in that hour (expire after 400 days)
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import time
from datetime import datetime, timezone

from .store import Store, now

SLUG = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?")
KEY = re.compile(r"[A-Za-z0-9_.-]{1,48}")
TYPES = ("stat", "chart", "bars", "table", "text", "progress")
MAX_SPEC = 256 * 1024
HISTORY_TTL = 400 * 86400
MIN_EVERY = 300


class SpecError(ValueError):
    pass


# ------------------------------------------------------------------ the spec
def _s(v, n: int) -> str:
    return "" if v is None else str(v).strip()[:n]


def _num(v, what: str, required: bool = False) -> float | None:
    if v is None or v == "":
        if required:
            raise SpecError(f"{what}: a number is required")
        return None
    if isinstance(v, bool):
        raise SpecError(f"{what}: {v!r} is not a number")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise SpecError(f"{what}: {v!r} is not a number") from None
    if not math.isfinite(f):
        raise SpecError(f"{what}: {v!r} is not a finite number")
    return int(f) if f.is_integer() and abs(f) < 2 ** 53 else f


def _href(v) -> str | None:
    v = _s(v, 1000)
    return v if re.match(r"https?://", v) else None


def parse_time(x, what: str = "time") -> float:
    """A point's time: unix seconds (or milliseconds), or an ISO date / date-time (UTC unless it says otherwise)."""
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        return float(x) / 1000 if x > 1e11 else float(x)
    s = _s(x, 40)
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        raise SpecError(f"{what}: {x!r} is not a time (use unix seconds or an ISO date like 2026-09-27T14:00)") from None
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()


def _widget(w, i: int) -> dict:
    where = f"widget {i + 1}"
    if not isinstance(w, dict):
        raise SpecError(f"{where}: expected an object")
    t = w.get("type")
    if t not in TYPES:
        raise SpecError(f"{where}: type must be one of {', '.join(TYPES)} (got {t!r})")
    out = {"type": t, "label": _s(w.get("label"), 120)}
    where += f" ({out['label'] or t})"
    if w.get("note"):
        out["note"] = _s(w["note"], 300)
    if w.get("width") in ("full", "half"):
        out["width"] = w["width"]
    if t in ("stat", "chart", "bars", "progress") and w.get("unit"):
        out["unit"] = _s(w["unit"], 12)
    if t == "stat":
        key = _s(w.get("key"), 48) or re.sub(r"[^a-z0-9]+", "_", out["label"].lower()).strip("_")[:48]
        if not KEY.fullmatch(key or ""):
            raise SpecError(f"{where}: give it a key (letters, digits, _ . -), used for its history")
        out.update(key=key, value=_num(w.get("value"), where))
        if w.get("good") in ("up", "down"):
            out["good"] = w["good"]
        if w.get("target") is not None:
            out["target"] = _num(w["target"], where + " target")
    elif t == "chart":
        if w.get("from"):
            keys = w["from"] if isinstance(w["from"], list) else [w["from"]]
            out["from"] = [k for k in (_s(k, 48) for k in keys[:5]) if KEY.fullmatch(k)]
            if not out["from"]:
                raise SpecError(f"{where}: `from` lists the stat keys to chart")
        else:
            series = w.get("series")
            if not isinstance(series, list) or not series:
                raise SpecError(f"{where}: give `series` ([{{name, points: [[time, value], ...]}}]) or `from` (stat keys)")
            out["series"] = []
            for j, s in enumerate(series[:5]):  # five colors, never cycled
                if not isinstance(s, dict) or not isinstance(s.get("points"), list):
                    raise SpecError(f"{where}: series {j + 1} needs `points`: [[time, value], ...]")
                pts = []
                for p in s["points"][:2000]:
                    if not isinstance(p, (list, tuple)) or len(p) != 2:
                        raise SpecError(f"{where}: a point is [time, value], got {p!r}")
                    pts.append([parse_time(p[0], where), _num(p[1], where)])
                out["series"].append({"name": _s(s.get("name"), 60) or f"series {j + 1}",
                                      "points": sorted((p for p in pts if p[1] is not None), key=lambda p: p[0])})
        if w.get("good") in ("up", "down"):
            out["good"] = w["good"]
    elif t == "bars":
        items = w.get("items")
        if not isinstance(items, list):
            raise SpecError(f"{where}: `items` is a list of {{label, value}}")
        out["items"] = [{k: v for k, v in {"label": _s(it.get("label"), 120), "value": _num(it.get("value"), where, True),
                                            "href": _href(it.get("href"))}.items() if v is not None}
                        for it in items[:50] if isinstance(it, dict)]
    elif t == "table":
        cols, rows = w.get("columns"), w.get("rows")
        if not isinstance(cols, list) or not isinstance(rows, list):
            raise SpecError(f"{where}: `columns` is a list of names and `rows` a list of lists")
        out["columns"] = [_s(c, 60) for c in cols[:12]]

        def cell(c):
            if isinstance(c, dict):
                return {k: v for k, v in {"text": _s(c.get("text"), 300), "href": _href(c.get("href"))}.items() if v}
            if isinstance(c, (int, float)) and not isinstance(c, bool):
                return _num(c, where)
            return None if c is None else _s(c, 300)
        out["rows"] = [[cell(c) for c in (r if isinstance(r, list) else [r])[:12]] for r in rows[:200]]
    elif t == "text":
        out["text"] = _s(w.get("text"), 5000)
    elif t == "progress":
        out.update(value=_num(w.get("value"), where, True), max=_num(w.get("max", 100), where) or 100)
    return out


def normalize(spec) -> dict:
    """Check a pushed spec and return the clean version (raises SpecError with a message an agent can act on)."""
    if isinstance(spec, (str, bytes)):
        try:
            spec = json.loads(spec)
        except ValueError as e:
            raise SpecError(f"not JSON: {e}") from None
    if not isinstance(spec, dict):
        raise SpecError("a dashboard is a JSON object: {title, description, widgets: [...]}")
    if len(json.dumps(spec, default=str)) > MAX_SPEC:
        raise SpecError(f"too big (over {MAX_SPEC // 1024} KB): keep the points to what the charts need")
    widgets = spec.get("widgets", [])
    if not isinstance(widgets, list):
        raise SpecError("`widgets` is a list")
    if len(widgets) > 40:
        raise SpecError("at most 40 widgets")
    out = {"widgets": [_widget(w, i) for i, w in enumerate(widgets)]}
    keys = [w["key"] for w in out["widgets"] if w["type"] == "stat"]
    if len(keys) != len(set(keys)):
        raise SpecError("two stats have the same key")
    for k in ("title", "description"):
        if spec.get(k):
            out[k] = _s(spec[k], 120 if k == "title" else 500)
    return out


def _slug(slug: str) -> str:
    slug = (slug or "").strip().lower()
    if not SLUG.fullmatch(slug):
        raise SpecError(f"bad name {slug!r}: lowercase letters, digits and dashes (it becomes /dashboards/<name>)")
    return slug


# ----------------------------------------------------------------- the store
def get(store: Store, slug: str) -> dict | None:
    return store.b.get("DASH", slug)


def all_(store: Store) -> list[dict]:
    return sorted(store.b.query("DASH"), key=lambda d: -float(d.get("updated", 0)))


def _record(store: Store, slug: str, widgets: list[dict], t: float):
    vals = {w["key"]: w["value"] for w in widgets if w["type"] == "stat" and w.get("value") is not None}
    if vals:
        hour = time.strftime("%Y-%m-%dT%H", time.gmtime(t))
        store._update(f"DASHH#{slug}", hour, lambda x: {**x, "values": {**(x.get("values") or {}), **vals}, "at": t,
                                                         "expires_at": int(t + HISTORY_TTL)}, create=True)


def push(store: Store, slug: str, spec, by: str = "human", owner: str | None = None) -> dict:
    """Create or replace a dashboard's widgets (keeping its refresh command), and record its stats."""
    slug, clean, t = _slug(slug), normalize(spec), now()

    def fn(x):
        new = not x
        x.update(slug=slug, title=clean.get("title") or x.get("title") or slug, widgets=clean["widgets"], updated=t,
                 updated_by=by, pushes=int(x.get("pushes", 0)) + 1)
        x["description"] = clean.get("description", x.get("description", ""))
        if new:
            x.update(created=t, owner=owner or by)
        return x
    it = store._update("DASH", slug, fn, create=True)
    _record(store, slug, it["widgets"], t)
    if it["pushes"] == 1:
        store.event("dashboard.added", f"{slug} {it['title'][:100]}", by=by)
    return it


def set_metric(store: Store, slug: str, key: str, value, label: str | None = None, unit: str | None = None,
               good: str | None = None, by: str = "human", owner: str | None = None) -> dict:
    """Set one stat (adding it, and the dashboard, when new): the quick way to log a number after a change."""
    slug = _slug(slug)
    d = get(store, slug) or {}
    widgets = list(d.get("widgets") or [])
    w = next((w for w in widgets if w["type"] == "stat" and w.get("key") == key), None)
    if not w:
        w = {"type": "stat", "key": key}
        widgets.insert(sum(x["type"] == "stat" for x in widgets), w)
    w.update(value=value, **{k: v for k, v in {"label": label or w.get("label") or key, "unit": unit, "good": good}.items() if v})
    return push(store, slug, {"title": d.get("title") or slug, "description": d.get("description", ""), "widgets": widgets},
                by=by, owner=owner)


def set_refresh(store: Store, slug: str, cmd: str | None, every: int | None = None, by: str = "human") -> dict:
    """Make a dashboard live (the farm runs ``cmd`` in the repo every ``every`` seconds) or, with no cmd, not."""
    slug = _slug(slug)
    if cmd and (every or 0) < MIN_EVERY:
        raise SpecError(f"refresh at most every {MIN_EVERY // 60} minutes")

    def fn(x):
        if cmd:
            x["refresh"] = {**(x.get("refresh") or {}), "cmd": cmd[:500], "every": int(every), "next_at": now() + int(every),
                            "by": by}
        else:
            x.pop("refresh", None)
        return x
    it = store._update("DASH", slug, fn)
    if not it:
        raise SpecError(f"no dashboard {slug}: push it first")
    return it


def history(store: Store, slug: str, since: float) -> list[dict]:
    rows = store.b.query(f"DASHH#{slug}", sk_gt=time.strftime("%Y-%m-%dT%H", time.gmtime(since - 3600)))
    return [{"at": float(r.get("at", 0)), "values": r.get("values") or {}} for r in rows if float(r.get("at", 0)) >= since]


def remove(store: Store, slug: str, by: str = "human") -> bool:
    d = get(store, slug)
    if not d:
        return False
    for r in store.b.query(f"DASHH#{slug}"):
        store.b.delete(r["PK"], r["SK"])
    store.b.delete("DASH", slug)
    store.event("dashboard.removed", f"{slug} {d.get('title', '')[:100]}", by=by)
    return True


def claim_due(store: Store) -> list[dict]:
    """The live dashboards due for a refresh, each claimed atomically (every box may call this; one runs each)."""
    out, t = [], now()
    for d in store.b.query("DASH"):
        r = d.get("refresh") or {}
        if not r.get("cmd") or float(r.get("next_at", 0)) > t:
            continue
        due = float(r["next_at"])

        def advance(x, due=due):
            rr = x.get("refresh") or {}
            if float(rr.get("next_at", -1)) != due:
                return None  # another box took it
            rr["next_at"] = t + int(rr.get("every", 3600))
            x["refresh"] = rr
            return x
        it = store._update("DASH", d["SK"], advance)
        if it:
            out.append(it)
    return out


def run_refresh(cmd: str, cwd: str, slug: str, timeout: int | None = None) -> dict:
    """Run a dashboard's command and return the spec it printed (the last JSON object on stdout)."""
    timeout = timeout or int(os.environ.get("FARM_DASHBOARD_TIMEOUT", "300"))
    try:
        p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                           env={**os.environ, "FARM_DASHBOARD": slug})
    except subprocess.TimeoutExpired:
        raise SpecError(f"`{cmd}` took longer than {timeout}s") from None
    if p.returncode != 0:
        raise SpecError(f"`{cmd}` exited {p.returncode}: {(p.stderr or p.stdout).strip()[-400:]}")
    out = p.stdout.strip()
    start = out.rfind("\n{") + 1 if not out.startswith("{") else 0
    try:
        return json.loads(out[start:])
    except ValueError:
        raise SpecError(f"`{cmd}` must print the dashboard as JSON; it printed: {out[-300:]!r}") from None


def refresh(store: Store, d: dict, cwd: str) -> dict:
    """Run one live dashboard and push the result, keeping its outcome (shown on the dashboard) either way."""
    r, t = d["refresh"], now()
    try:
        it = push(store, d["slug"], run_refresh(r["cmd"], cwd, d["slug"]), by=f"refresh:{r.get('by') or 'farm'}")
        ok, err = True, ""
    except SpecError as e:
        it, ok, err = d, False, str(e)[:600]
        store.event("dashboard.failed", f"{d['slug']}: {err[:300]}")
        if r.get("ok", True) and d.get("owner"):  # it just broke: tell the Claude that keeps it (once, not every run)
            store.send_message("farm", d["owner"], f"Your live dashboard '{d['slug']}' failed to refresh: {err[:400]}\n"
                               f"Fix the code (`{r['cmd']}`, run in the repo on main) and check it with "
                               f"`clodfarm dashboard refresh {d['slug']}`.", wake=True)
    store._update("DASH", d["slug"], lambda x: {**x, "refresh": {**(x.get("refresh") or {}), "last_at": t, "ok": ok,
                                                                  "error": err}} if x.get("refresh") else None)
    return {**it, "ok": ok, "error": err}


# ------------------------------------------------------------------- views
def _stats(d: dict) -> list[dict]:
    return [w for w in d.get("widgets") or [] if w["type"] == "stat"]


def summary(store: Store, d: dict, days: int = 30) -> dict:
    """One card of the dashboards list: title, owner, freshness and its first stats with their trend."""
    hist = history(store, d["slug"], now() - days * 86400) if _stats(d) else []
    stats = []
    for w in _stats(d)[:3]:
        pts = [[h["at"], h["values"][w["key"]]] for h in hist if w["key"] in h["values"]]
        stats.append({**{k: w.get(k) for k in ("key", "label", "value", "unit", "good")}, "points": pts[-60:]})
    r = d.get("refresh") or {}
    return {"slug": d["slug"], "title": d.get("title") or d["slug"], "description": d.get("description", ""),
            "owner": d.get("owner"), "updated": d.get("updated"), "widgets": len(d.get("widgets") or []), "stats": stats,
            "live": bool(r.get("cmd")), "every": r.get("every"), "ok": r.get("ok", True) if r.get("last_at") else None}


def view(store: Store, d: dict, days: int = 30) -> dict:
    """A whole dashboard for its page: the widgets plus the history of every stat."""
    r = d.get("refresh") or {}
    return {"slug": d["slug"], "title": d.get("title") or d["slug"], "description": d.get("description", ""),
            "owner": d.get("owner"), "created": d.get("created"), "updated": d.get("updated"),
            "updated_by": d.get("updated_by"), "widgets": d.get("widgets") or [], "days": days,
            "history": history(store, d["slug"], now() - days * 86400),
            "refresh": {k: r.get(k) for k in ("cmd", "every", "next_at", "last_at", "ok", "error")} if r.get("cmd") else None}
