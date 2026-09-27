"""Dashboards (the spec check, history of stats, live refresh (claimed once across boxes), the pages, the API and MCP) and each Claude's tools."""
import json
import sys
import time
import urllib.request

import pytest

from clodfarm import dashboards as dash
from clodfarm.cli import main as cli
from clodfarm.config import load
from clodfarm.store import Store
from test_mcp import connect, farm, tool  # noqa: F401 - the MCP farm fixture
from test_web import client, login, ui  # noqa: F401 - the UI server fixture

SPEC = {"title": "Test suite", "description": "Faster and greener",
        "widgets": [{"type": "stat", "key": "pass_rate", "label": "Pass rate", "value": 91.5, "unit": "%", "good": "up"},
                    {"type": "stat", "label": "Run time", "value": 42, "unit": "s", "good": "down"},
                    {"type": "chart", "label": "Pass rate", "from": ["pass_rate"]},
                    {"type": "chart", "label": "Build", "series": [{"name": "p50", "points": [["2026-09-02", 2], ["2026-09-01T00:00Z", 1]]}]},
                    {"type": "bars", "label": "Slowest", "unit": "s", "items": [{"label": "test_x", "value": 3.2, "href": "javascript:alert(1)"}]},
                    {"type": "table", "label": "Flaky", "columns": ["test", "fails"], "rows": [["test_y", 3], [{"text": "PR", "href": "https://x.test/1"}, None]]},
                    {"type": "progress", "label": "Migration", "value": 42},
                    {"type": "text", "label": "Notes", "text": "**Next:** split it"}]}


@pytest.fixture
def store(env):
    s = Store.from_config(load())
    s.ensure_table()
    return s


def test_normalize_cleans_and_explains():
    out = dash.normalize(SPEC)
    ws = out["widgets"]
    assert ws[1]["key"] == "run_time"                                  # a stat's key defaults from its label
    assert [p[1] for p in ws[3]["series"][0]["points"]] == [1, 2]      # ISO times parsed and sorted
    assert "href" not in ws[4]["items"][0]                             # only http(s) links survive
    assert ws[5]["rows"][1][0] == {"text": "PR", "href": "https://x.test/1"}
    assert ws[6]["max"] == 100
    for bad, msg in [({"widgets": [{"type": "pie"}]}, "type must be one of"),
                     ({"widgets": [{"type": "stat", "label": "x", "value": "lots"}]}, "not a number"),
                     ({"widgets": [{"type": "chart", "label": "c"}]}, "give `series`"),
                     ({"widgets": [{"type": "chart", "series": [{"points": [["yesterday", 1]]}]}]}, "not a time"),
                     ({"widgets": [{"type": "stat", "key": "a", "value": 1}, {"type": "stat", "key": "a", "value": 2}]}, "same key"),
                     ("{nope", "not JSON"), ([], "JSON object")]:
        with pytest.raises(dash.SpecError, match=msg):
            dash.normalize(bad)
    with pytest.raises(dash.SpecError, match="bad name"):
        dash._slug("Not OK!")


def test_push_records_history_and_metric_updates(store):
    d = dash.push(store, "tests", SPEC, by="gil", owner="gil")
    assert d["title"] == "Test suite" and d["owner"] == "gil" and d["pushes"] == 1
    d = dash.set_metric(store, "tests", "pass_rate", 97.2)
    assert next(w for w in d["widgets"] if w.get("key") == "pass_rate")["value"] == 97.2
    assert d["owner"] == "gil" and len(d["widgets"]) == len(SPEC["widgets"])    # the rest of the page stays
    h = dash.history(store, "tests", time.time() - 3600)
    assert h[-1]["values"] == {"pass_rate": 97.2, "run_time": 42}              # one point per hour: last value wins
    new = dash.set_metric(store, "fresh", "users", 3, label="Users", good="up")  # a metric makes its dashboard
    assert new["title"] == "fresh" and new["widgets"][0]["label"] == "Users"
    card = dash.summary(store, dash.get(store, "tests"))
    assert [s["key"] for s in card["stats"]] == ["pass_rate", "run_time"] and card["stats"][0]["points"]
    assert [d["slug"] for d in dash.all_(store)] == ["fresh", "tests"]         # newest first
    assert dash.remove(store, "tests") and dash.get(store, "tests") is None
    assert dash.history(store, "tests", 0) == []
    assert any(e["type"] == "dashboard.added" for e in store.events(None, 50))


def test_live_dashboard_refreshes_once_and_reports_failures(store, tmp_path):
    script = tmp_path / "measure.py"
    script.write_text("import json\nprint('warming up')\n"
                      "print(json.dumps({'title': 'Live', 'widgets': [{'type': 'stat', 'key': 'n', 'value': 7}]}))\n")
    dash.push(store, "live", {"widgets": []}, owner="gil")
    with pytest.raises(dash.SpecError, match="at most every"):
        dash.set_refresh(store, "live", "true", 60)
    dash.set_refresh(store, "live", f"{sys.executable} {script}", 300)
    assert dash.claim_due(store) == []                                         # not due yet
    store._update("DASH", "live", lambda x: {**x, "refresh": {**x["refresh"], "next_at": 1}})
    first, second = dash.claim_due(store), dash.claim_due(store)
    assert len(first) == 1 and second == []                                    # one box takes it
    r = dash.refresh(store, first[0], str(tmp_path))
    assert r["ok"] and r["title"] == "Live" and dash.get(store, "live")["refresh"]["ok"] is True
    assert dash.history(store, "live", time.time() - 60)[-1]["values"] == {"n": 7}
    script.write_text("import sys\nsys.exit('boom')\n")
    r = dash.refresh(store, dash.get(store, "live"), str(tmp_path))
    assert not r["ok"] and "boom" in r["error"]
    d = dash.get(store, "live")
    assert d["refresh"]["ok"] is False and d["title"] == "Live"                # the last good data stays
    msgs = store.inbox("gil")
    assert len(msgs) == 1 and "failed to refresh" in msgs[0]["text"]           # its Claude is told to fix it
    dash.refresh(store, dash.get(store, "live"), str(tmp_path))
    assert store.inbox("gil") == []                                            # once, not on every failed run
    assert dash.set_refresh(store, "live", None).get("refresh") is None


def test_cli(env, store, tmp_path, capsys):
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps(SPEC))
    assert cli(["dashboard", "push", "tests", "--file", str(spec)]) == 0
    assert "/dashboards/tests" in capsys.readouterr().out
    assert cli(["dashboard", "metric", "tests", "pass_rate", "98", "--unit", "%"]) == 0
    assert cli(["dashboard", "list", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out.split("\n", 1)[1])
    assert rows[0]["slug"] == "tests" and rows[0]["stats"][0]["value"] == 98
    assert cli(["dashboard", "push", "Bad Name", "--file", str(spec)]) == 2
    assert cli(["dashboard", "push", "x", "--run", "true", "--every", "1m"]) == 2
    assert cli(["dashboard", "push", "x", "--run", "echo nope"]) == 2          # must print JSON
    assert cli(["dashboard", "remove", "tests"]) == 0


def test_pages_and_api(ui):  # noqa: F811
    base, farm_ui = ui
    call = client()
    assert call(base + "/api/dashboards")[0] == 401
    with urllib.request.urlopen(base + "/dashboards/tests") as r:              # the page itself is public HTML
        html = r.read().decode()
    assert 'href="/dash.css"' in html and "{{BASE}}" not in html
    assert urllib.request.urlopen(base + "/dashboards").status == 200
    login(call, base)
    dash.push(farm_ui.store, "tests", SPEC, owner="gil")
    code, rows, _ = call(base + "/api/dashboards")
    assert code == 200 and rows[0]["slug"] == "tests" and rows[0]["stats"][0]["value"] == 91.5
    code, d, _ = call(base + "/api/dashboards/tests?days=7")
    assert code == 200 and d["days"] == 7 and d["history"][0]["values"]["pass_rate"] == 91.5
    assert call(base + "/api/dashboards/nope")[0] == 404


def test_mcp_tools(farm):  # noqa: F811
    base, farm_ui = farm
    _, tok = connect(base)
    err, out = tool(base, tok["access_token"], "farm_dashboard_push", dashboard="perf", spec=SPEC)
    assert not err and out["url"].endswith("/dashboards/perf")
    err, rows = tool(base, tok["access_token"], "farm_dashboards")
    assert not err and rows[0]["slug"] == "perf" and rows[0]["owner"] == "matan-laptop"
    err, text = tool(base, tok["access_token"], "farm_dashboard_push", dashboard="perf", spec={"widgets": [{"type": "x"}]})
    assert err and "type must be one of" in text
    _, ro = connect(base, access="read")
    assert tool(base, ro["access_token"], "farm_dashboard_push", dashboard="perf", spec=SPEC)[0]


def test_tools_record_and_api(ui):  # noqa: F811
    base, farm_ui = ui
    st, init = farm_ui.store, {"tools": ["Bash", "mcp__x__y"], "model": "m", "mcp_servers": [{"name": "x", "status": "failed"}],
                               "plugins": [{"name": "p", "path": "/home/me/secret"}]}
    st.put_tools("gil", {"subtype": "init"})                                   # no tools list: nothing recorded
    assert st.tools() == {}
    st.put_tools("gil", init)
    st.put_tools("gil", {**init, "model": "usage"}, where="usage check", keep_newer=86400)  # a fresh task record wins
    assert st.tools()["gil"]["model"] == "m" and st.tools()["gil"]["plugins"] == [{"name": "p", "version": ""}]
    call = client()
    assert call(base + "/api/agents/gil/tools")[0] == 401
    login(call, base)
    code, t, _ = call(base + "/api/agents/gil/tools")
    assert code == 200 and t["tools"] == ["Bash", "mcp__x__y"] and "PK" not in t
    assert call(base + "/api/agents/nobody/tools")[1] == {"tools": None}
