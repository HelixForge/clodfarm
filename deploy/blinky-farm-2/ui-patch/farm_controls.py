"""Farm controls (local patch, farm-helpers): the usage limits and the planner's hours, set from the farm UI.

Stored in <workspace>/.farm/controls.json. The governor (every decision) and the planner (every tick) read it, so a
change takes effect within seconds, with no restart. A limit left empty falls back to .env (FARM_FIVE_HOUR_CEILING,
FARM_WEEKLY_TARGET). Planner hours are in the farm's time zone (FARM_TZ).
hammer_requests (default on) is the switch for the farm's automatic requests to hammer's Ollama: the repo's
tools/local-llm/ask.py waits while it's off, and blinky's book.py skips its runs. Both read this file directly.
"""
from __future__ import annotations

import copy
import dataclasses
import json
import os
import re
import time
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

LIMIT_MIN, LIMIT_MAX = 0.05, 1.30
PLANNER_MODELS = ("", "haiku", "sonnet", "opus")  # "" = the farm's own model (FARM_MODEL)  # above 1.00 = no limit: the farm runs until Anthropic turns it away
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_cache: dict = {"key": None, "data": {}}


def _path() -> str:
    return os.path.join(os.environ.get("FARM_WORKSPACE", "/workspace"), ".farm", "controls.json")


def load() -> dict:
    """The saved controls ({} when none), re-read only when the file changes."""
    p = _path()
    try:
        st = os.stat(p)
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    if _cache["key"] != key:
        try:
            _cache["data"] = json.load(open(p)) or {}
        except (OSError, ValueError):
            _cache["data"] = {}
        _cache["key"] = key
    return dict(_cache["data"])


def _limit(v):
    if v in (None, ""):
        return None
    v = float(v)
    if v > 1.5:  # given as a percent
        v = v / 100.0
    if not LIMIT_MIN <= v <= LIMIT_MAX:
        raise ValueError(f"a limit must be between {LIMIT_MIN:.0%} and {LIMIT_MAX:.0%}")
    return round(v, 4)


def save(changes: dict, by: str = "ui") -> dict:
    """Validate and store the given fields; the rest keep their values. Raises ValueError on bad input."""
    d = load()
    for k in ("five_hour_ceiling", "weekly_target"):
        if k in changes:
            d[k] = _limit(changes[k])
    if "planner_may_sleep" in changes:
        d["planner_may_sleep"] = bool(changes["planner_may_sleep"])
    if "hammer_requests" in changes:
        d["hammer_requests"] = bool(changes["hammer_requests"])
    if changes.get("wake"):
        d["wake_at"] = time.time()
    if "planner_model" in changes:
        m = str(changes["planner_model"] or "")
        if m not in PLANNER_MODELS:
            raise ValueError("planner model: one of " + ", ".join(x or "(the farm's default)" for x in PLANNER_MODELS))
        d["planner_model"] = m
    if "planner_hours" in changes:
        ph = changes["planner_hours"] or {}
        mode = str(ph.get("mode") or "always")
        if mode not in ("always", "hours"):
            raise ValueError("planner hours: 'always' or 'hours'")
        out = {"mode": mode}
        for k, dflt in (("start", "22:00"), ("end", "07:00")):
            v = str(ph.get(k) or (d.get("planner_hours") or {}).get(k) or dflt)
            if not HHMM.match(v):
                raise ValueError(f"planner hours: {k} must be HH:MM (24-hour)")
            out[k] = v
        if mode == "hours" and out["start"] == out["end"]:
            raise ValueError("planner hours: start and end can't be the same")
        d["planner_hours"] = out
    d["changed_at"], d["changed_by"] = time.time(), by
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, p)
    return load()


def policy(p):
    """The governor's Policy with the UI's limits applied (unchanged when none are set)."""
    d = load()
    ch = {k: d[k] for k in ("five_hour_ceiling", "weekly_target") if d.get(k) is not None and hasattr(p, k)}
    return dataclasses.replace(p, **ch) if ch else p


def task_cfg(cfg, task):
    """The config a task runs with: planner cycles (kind "plan") use the planner model when one is set, e.g. haiku,
    since the planner only dispatches the job queue. Every other task keeps the farm's model."""
    m = load().get("planner_model")
    if m and (task or {}).get("kind") == "plan":
        c = copy.copy(cfg)
        c.model = m
        return c
    return cfg


def may_sleep() -> bool:
    """May the planner put itself to sleep (`clodfarm planner idle`)? Off unless Chris allows it in the farm UI
    (2026-10-08: "I don't want the farm to sleep"); then a self-set idle is cancelled and it keeps its 10-minute rhythm."""
    return bool(load().get("planner_may_sleep", False))


def hammer_on() -> bool:
    """May the farm send requests to hammer's Ollama (local Qwen briefs, the book)? On unless switched off in the UI."""
    return bool(load().get("hammer_requests", True))


def woken(last_at: float) -> bool:
    """True once after "Wake now" in the UI: a wake newer than the planner's last cycle."""
    return float(load().get("wake_at") or 0) > last_at


def _tz():
    name = os.environ.get("FARM_TZ") or "UTC"
    try:
        return ZoneInfo(name) if ZoneInfo else timezone.utc
    except Exception:  # noqa: BLE001
        return timezone.utc


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def planner_gate(now: float | None = None) -> str | None:
    """None when the planner may start a cycle now; otherwise the state to show (outside its hours)."""
    ph = load().get("planner_hours") or {}
    if ph.get("mode") != "hours":
        return None
    t = datetime.fromtimestamp(now or time.time(), _tz())
    cur, a, b = t.hour * 60 + t.minute, _minutes(ph["start"]), _minutes(ph["end"])
    inside = a <= cur < b if a < b else (cur >= a or cur < b)  # a window that crosses midnight
    return None if inside else f"outside its hours (runs {ph['start']}-{ph['end']})"


def view(p) -> dict:
    """What the UI shows: the limits in effect, where they come from, and the planner's hours."""
    d, eff = load(), policy(p)
    ph = d.get("planner_hours") or {"mode": "always", "start": "22:00", "end": "07:00"}
    return {
        "five_hour_ceiling": eff.five_hour_ceiling, "weekly_target": eff.weekly_target,
        "env": {"five_hour_ceiling": p.five_hour_ceiling, "weekly_target": p.weekly_target},
        "from_ui": {k: d.get(k) is not None for k in ("five_hour_ceiling", "weekly_target")},
        "planner_hours": ph, "planner_open": planner_gate() is None,
        "planner_model": d.get("planner_model") or "", "farm_model": getattr(p, "_farm_model", None),
        "planner_may_sleep": bool(d.get("planner_may_sleep", False)),
        "hammer_requests": hammer_on(),
        "tz": os.environ.get("FARM_TZ") or "UTC", "now_local": datetime.now(_tz()).strftime("%H:%M"),
        "changed_at": d.get("changed_at"),
    }


def describe() -> str:
    d = load()
    ph = d.get("planner_hours") or {}
    lim = lambda k: "from .env" if d.get(k) is None else f"{d[k]:.0%}"  # noqa: E731
    hours = "any time" if ph.get("mode") != "hours" else f"{ph.get('start')}-{ph.get('end')}"
    pm = d.get("planner_model") or "farm default"
    sleep = "may sleep" if d.get("planner_may_sleep") else "never sleeps"
    hammer = "on" if d.get("hammer_requests", True) else "off"
    return (f"5-hour limit {lim('five_hour_ceiling')}, weekly limit {lim('weekly_target')}, planner {hours}, "
            f"planner model {pm}, planner {sleep}, hammer requests {hammer}")
