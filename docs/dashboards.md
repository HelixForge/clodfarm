# Dashboards

The Claudes build pages that show what is improving: `/dashboards` lists them and each one is at
`/dashboards/<name>` (under `FARM_UI_BASE` behind a proxy). The farm draws them in its own look from a JSON spec;
no agent-written code runs in the browser.

## Making one

```bash
clodfarm dashboard metric tests pass_rate 97.2 --unit % --good up       # one number (adds the dashboard when new)
clodfarm dashboard push tests --file spec.json                           # the whole page
clodfarm dashboard push tests --run "python3 dashboards/tests.py" --every 1h   # live: the farm runs it
clodfarm dashboard list | show NAME | refresh NAME | remove NAME
```

Over MCP: `farm_dashboards` and `farm_dashboard_push`.

## The spec

```json
{"title": "Test suite", "description": "Is the suite getting faster and greener?",
 "widgets": [
   {"type": "stat", "key": "pass_rate", "label": "Pass rate", "value": 97.2, "unit": "%", "good": "up", "target": 99},
   {"type": "chart", "label": "Pass rate", "from": ["pass_rate"]},
   {"type": "chart", "label": "Build time", "unit": "s", "series": [{"name": "p50", "points": [["2026-09-01", 12.3]]}]},
   {"type": "bars", "label": "Slowest tests", "unit": "s", "items": [{"label": "test_x", "value": 3.2}]},
   {"type": "table", "label": "Flaky", "columns": ["test", "fails"], "rows": [["test_y", 3]]},
   {"type": "progress", "label": "Migration", "value": 42, "max": 100},
   {"type": "text", "label": "Notes", "text": "**Next:** split the slow suite. [The PR](https://example.com)"}]}
```

| Widget | Fields |
|---|---|
| `stat` | `key` (its history), `label`, `value`, `unit`, `good` (`up` or `down`: which way is better), `target` |
| `chart` | `label`, `unit`, and either `from` (stat keys: plots their recorded history) or `series` (up to 5, `points` are `[time, value]`, time as ISO or unix seconds) |
| `bars` | `label`, `unit`, `items`: `{label, value, href}` |
| `table` | `label`, `columns`, `rows` (a cell can be `{text, href}`) |
| `progress` | `label`, `value`, `max` (default 100), `unit` |
| `text` | `label`, `text`: paragraphs, `- ` lists, `## ` headings, `**bold**`, `` `code` ``, `[links](https://...)` |

Every widget also takes `note` and `width` (`full` or `half`). Links must be http(s).

## History and trends

Every push records each stat's value, one point per hour (the last one in the hour wins), kept 400 days. The page
shows each stat's change over 24h, 7d, 30d or 90d (green when it moved the `good` way), and clicking a stat charts
its history. The agent doesn't keep any history itself.

## Live dashboards

`--run CMD --every 1h` (at least 5 minutes) runs `CMD` once right away, so errors show at once, then the farm runs it
in the repo on main on that schedule, on one box of a multi-box farm, and pushes the last JSON object it prints.
Commit the code so every box has it. When a run fails, the page shows the error and keeps the last good data, and the
Claude that keeps it gets a message (with `--wake`, so a sub-agent starts to fix it if nobody reads it).
`FARM_DASHBOARD_TIMEOUT` (default 300 s) limits a run.
