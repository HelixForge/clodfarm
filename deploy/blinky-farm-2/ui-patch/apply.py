#!/usr/bin/env python3
"""Apply the farm-helpers patch to an installed clodfarm package: python3 apply.py <path to the clodfarm package dir>.

Draws each running sub-agent's in-session helpers (local Qwen briefs, Claude Code Agent-tool subagents) as minis on the
farm scene. Idempotent: an already patched file is left alone. Every anchor must match exactly once, or nothing is
written (a new clodfarm moved the code: update the anchors here)."""
import os
import shutil
import sys

MARK = "farm-helpers patch"
here = os.path.dirname(os.path.abspath(__file__))
pkg = sys.argv[1]

WEB = [
    ("from . import mcp\n",
     "from . import mcp\nfrom . import farm_controls, farm_helpers, farm_usage  # farm-helpers patch\n"),
    ('"agents": agents, "subagents": subs, "recent": recent,',
     '"agents": agents, "subagents": subs, "recent": recent,\n'
     '            "helpers": farm_helpers.collect(self.cfg.workspace, subs),  # farm-helpers patch\n'
     '            "usage_by_model": farm_usage.collect(self.cfg.workspace, next((a["budget"]["five_hour_resets"] for a in agents\n'
     '                                                  if (a.get("budget") or {}).get("five_hour_resets")), None)),'),
    ('"title": s.get("title"), "task": s.get("task"), "started": s.get("started"),',
     '"title": s.get("title") or ((ui.store.get_task(s["task"]) if s.get("task") else None) or {}).get("title"),\n'
     '                                       "task": s.get("task"), "started": s.get("started"), "live": farm_helpers.is_live(s),\n'
     '                                       "agents": farm_helpers.session_view(ui.store, s, ui.cfg.workspace),  # farm-helpers patch'),
    ('for t in ui.store.turns(s["id"])]})',
     'for t in ui.store.turns(s["id"]) + farm_helpers.live_turns(s)]})  # farm-helpers patch: live turns'),
    ('return self._json([{k: s.get(k) for k in keep} for s in ui.store.sessions(claude, 50)])',
     'return self._json(farm_helpers.live_list(ui.store, ui.store.sessions(claude, 50), keep))  # farm-helpers patch'),
    ('if path == "/api/sessions":  # every Claude session on the farm, newest first',
     'if path == "/api/session-tree":  # farm-helpers patch: the sessions as a tree with status and what each is doing\n'
     '                    q = {k: v[-1] for k, v in parse_qs(urlsplit(self.path).query).items()}\n'
     '                    claude = q.get("claude") if who.manager else who.owner\n'
     '                    return self._json(farm_helpers.session_tree(ui.store, ui.store.sessions(claude, 60), ui.cfg.workspace))\n'
     '                if path == "/api/sessions":  # every Claude session on the farm, newest first'),
    ('"events": [{"at": e["at"], "type": e["type"], "msg": e["msg"][:240], "task": e.get("task"), "by": e.get("by")}',
     '"events": farm_helpers.name_events(store, [{"at": e["at"], "type": e["type"], "msg": e["msg"][:240], "task": e.get("task"), "by": e.get("by")}'),
    ('for e in events[-40:]],', 'for e in events[-40:]]),  # farm-helpers patch: agent names in the feed'),
    ('"version": __version__, "hosts": [a["id"] for a in ui.manager.all()]}',
     '"version": __version__, "hosts": [a["id"] for a in ui.manager.all()],\n'
     '                    "controls": farm_controls.view(ui.cfg.policy)}  # farm-helpers patch: farm controls', True),
    ('            if path == "/api/manager/planner":\n',
     '            if path == "/api/manager/controls":  # farm-helpers patch: usage limits and the planner\'s hours\n'
     '                farm_controls.save({k: data[k] for k in ("five_hour_ceiling", "weekly_target", "planner_hours", "planner_model", "planner_may_sleep", "hammer_requests", "wake") if k in data})\n'
     '                store.event("farm.controls", "farm controls changed: " + farm_controls.describe(), by="ui")\n'
     '                return self._json(self._manager_view())\n'
     '            if path == "/api/manager/planner":\n', True),
]

JS_HEAD = r'''/* farm-helpers patch: in-session helpers (local Qwen briefs, Agent-tool subagents) stand by the mini they work for */
const HELPER_SPOTS = [[-8, 7], [8, 7], [-15, 3], [15, 3]];
const HELPER_LOOK = { qwen: "#8b6cff", haiku: "#3fbfa0", sonnet: "#ef8a3c", opus: "#d9a521" };
function helperTier(x) {
  if (x.kind === "local") return "qwen";
  const m = String(x.model || "");
  if (/haiku/.test(m)) return "haiku";
  if (/sonnet/.test(m)) return "sonnet";
  if (/opus/.test(m)) return "opus";
  return ["runner", "gd-tester"].includes(x.who) ? "haiku" : "sonnet"; // no answer yet: what its definition asks for
}
const helperColor = (x) => HELPER_LOOK[helperTier(x)] || HELPER_LOOK.sonnet;
/** Tokens by model family (state.usage_by_model, from the transcripts): a line under the counter and a table in its sign. */
const TIER_NAMES = { opus: "OPUS", sonnet: "SONNET", haiku: "HAIKU", qwen: "QWEN" };
const fmtK = (n) => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n); };
// the page's CSP (style-src 'self') drops style="" attributes; styles set from script are fine
const sty = (el, css) => { el.style.cssText = css; return el; };
const colorDot = (c) => sty(h("span"), `display:inline-block;width:7px;height:7px;margin:0 4px 0 9px;background:${c};box-shadow:1px 1px 0 #1b2410`);
const tierDot = (t) => colorDot(HELPER_LOOK[t]);
function renderTierLine(U) {
  let el = $("#tok-tiers");
  if (!el) { el = h("span", { class: "tok-today", id: "tok-tiers" }); $("#tok-today").after(el); }
  if (!U || !U.tiers) { el.hidden = true; return; }
  el.hidden = false;
  fill(el, h("span", { text: "THIS 5H:" }), Object.keys(TIER_NAMES).map(t => [tierDot(t), h("span", { text: `${TIER_NAMES[t]} ${fmtK(U.tiers[t].session.total)}` })]));
}
function tierGrid(U) {
  if (!U || !U.tiers) return null;
  const ends = U.resets ? new Date(U.resets * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const cell = (b) => h("span", { text: `${fmtK(b.total)} (out ${fmtK(b.output)})` });
  return [sty(h("span", { class: "tok-grid" }, h("b", { text: "BY MODEL" }), h("b", { text: "THIS 5H" }), h("b", { text: "TOTAL" }),
      Object.keys(TIER_NAMES).flatMap(t => [h("span", {}, tierDot(t), t === "qwen" ? "QWEN (LOCAL, FREE)" : TIER_NAMES[t]), cell(U.tiers[t].session), cell(U.tiers[t].total)])), "margin-top:14px"),
    h("span", { class: "tok-note", text: "By model, from the session transcripts: the Opus leads, their Sonnet and Haiku helpers (runs in progress included), and the free local Qwen. " +
      `"This 5h" is the current 5-hour usage window${ends ? `, which ends at ${ends}` : ""}. Most Claude tokens are cache reads, which cost far less than output.` })];
}
const helperHDCache = new Map();
/** A helper: miniHD's shape with the whole body in its tier's colour; the local model wears a yellow headband (free). */
function helperHD(x, { legs = 0, arms = 0, blink = false }) {
  const body = helperColor(x), band = x.kind === "local" ? "#f5c542" : "#f7f3ea";
  const code = body + band + (legs + 3 * arms + 6 * (blink ? 1 : 0));
  let c = helperHDCache.get(code);
  if (c) return c;
  const P = new Pix(20, 16), pal = bodyPalHD(body);
  for (let y = 2; y <= 11; y++) for (let x2 = 3; x2 <= 16; x2++) {
    if ((x2 === 3 || x2 === 16) && (y === 2 || y === 11)) continue;
    P.set(x2, y, y === 4 ? shade(band, 0.16) : y === 5 ? band : y === 2 || x2 === 3 ? pal.h : x2 === 16 || y === 11 ? pal.s : pal.b);
  }
  P.set(17, 5, band); P.set(18, 6, shade(band, -0.15));
  const ay = 7 - arms * 3;
  P.rect(1, ay, 2, 3, pal.h); P.rect(17, ay, 2, 3, pal.s);
  [4, 7, 11, 14].forEach((lx, i) => { const up = legs !== 0 && ((i % 2 === 0) === (legs === 1)); P.rect(lx, 12, 2, up ? 1 : 2, pal.d); });
  P.outline(pal.o);
  for (const ex of [6, 12]) { if (blink) P.rect(ex, 9, 2, 1, EYE); else { P.rect(ex, 7, 2, 3, EYE); P.set(ex, 7, SHINE); } }
  helperHDCache.set(code, (c = P.canvas()));
  return c;
}
const helperIcon = (x) => x.kind === "local" ? "scroll" : ({ reviewer: "chat", "gd-tester": "tasks", runner: "gear" })[x.who] || "terminal";
const helperTitle = (x) => x.kind === "local" ? `QWEN · TYPING ${x.label}`
  : `${helperTier(x).toUpperCase()} · ${String(x.who).toUpperCase()}${x.label ? ": " + x.label : ""}`;
'''

JS_SESS_OLD = r'''    const who = (t) => t.kind === "tool_result" ? "TOOL" : t.role === "assistant" ? String(s.claude || "CLAUDE").toUpperCase() : s.kind === "conversation" ? "YOU" : "THE FARM";
    fill($("#talk-body"), s.conversation.length ? s.conversation.map(t => h("div", { class: `turn ${t.role} k-${t.kind}` },
      h("b", { text: who(t) + (t.kind === "tool" ? " · TOOL CALL" : "") }), h("div", { text: t.text }))) : h("p", { class: "muted", text: "Nothing said yet." }));'''
JS_SESS_NEW = r'''    // farm-helpers patch: one log per agent, each turn named by the agent that wrote it (its farm job or helper, and model)
    const A = s.agents || {}, tierOf = (m, who = "") => helperTier({ kind: "agent", model: m, who }), tierName = (m, who) => tierOf(m, who).toUpperCase();
    const mainName = A.name ? `${A.name.toUpperCase()}${A.model ? " · " + tierName(A.model) : ""}` : String(s.claude || "CLAUDE").toUpperCase();
    const conv = (rows, me, them) => rows.length ? rows.map(t => h("div", { class: `turn ${t.role} k-${t.kind}` },
      h("b", { text: (t.kind === "tool_result" ? "TOOL" : t.role === "assistant" ? me : them) + (t.kind === "tool" ? " · TOOL CALL" : "") }),
      h("div", { text: t.text }))) : [h("p", { class: "muted", text: "Nothing said yet." })];
    const tabs = [{ key: "main", label: mainName, color: HELPER_LOOK[tierOf(A.model)] || "#9aa3b2",
      body: () => conv(s.conversation, mainName, s.kind === "conversation" ? "YOU" : "THE FARM") }];
    for (const x of A.helpers || []) {
      const nm = `${String(x.who).toUpperCase()} · ${tierName(x.model, x.who)}`;
      tabs.push({ key: "h" + x.id, label: nm + (x.done ? "" : " (WORKING)"), color: HELPER_LOOK[tierOf(x.model, x.who)],
        body: () => [h("p", { class: "muted small", text: `${x.label ? x.label + ". " : ""}Started by ${mainName} ${ago(x.started)}; ${x.done ? "finished" : "still working"}.` }),
          ...conv(x.conversation, nm, mainName)] });
    }
    const briefLine = (b) => `${b.outcome === "ok" ? "✅ wrote" : b.outcome === "running" ? "⌨️ typing" : "❌ " + b.outcome}  ${b.out}` +
      `${b.lines ? `, ${b.lines} lines` : ""}${b.secs ? ` in ${Math.round(b.secs)}s` : ""} · ${ago(b.at)}`;
    const mono = (el) => sty(el, "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.35");
    const briefView = (b) => [
      h("p", { class: "small" }, h("a", { href: "#", onclick: (e) => { e.preventDefault(); show("qwen"); } }, "◀ all briefs"), ` · ${briefLine(b)}`),
      h("div", { class: "turn user k-text" }, h("b", { text: `${mainName} → QWEN · THE BRIEF` }),
        b.context && b.context.length ? h("p", { class: "muted small", text: `with context: ${b.context.join(", ")}` }) : null,
        mono(h("div", { text: b.brief || "(the brief wasn't recorded)" }))),
      h("div", { class: "turn assistant k-text" }, h("b", { text: `QWEN · ${b.model} · THE ANSWER` }),
        b.answer_note ? h("p", { class: "muted small", text: b.answer_note }) : null,
        mono(h("div", { text: b.answer || (b.outcome === "running" ? "(still typing)" : "(no answer recorded)") })))];
    if ((A.briefs || []).length) tabs.push({ key: "qwen", label: `QWEN · ${A.briefs.length} BRIEF${A.briefs.length > 1 ? "S" : ""}`, color: HELPER_LOOK.qwen,
      body: () => [h("p", { class: "muted small", text: `Pseudocode briefs ${mainName} sent to the free local model on hammer. Click one to read the brief and Qwen's answer.` }),
        ...A.briefs.map((b, i) => sty(h("div", { class: "turn assistant k-text", role: "button", tabindex: "0",
            onclick: () => show("qwen", i), onkeydown: (e) => { if (e.key === "Enter") show("qwen", i); } },
          h("b", { text: `QWEN · ${b.model}` }), h("div", { text: briefLine(b) + "   ▸ open" })), "cursor:pointer"))],
      brief: (i) => briefView(A.briefs[i]) });
    const bar = sty(h("div"), "display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;align-self:stretch");
    let curTab = "main";
    const show = (k, brief) => {
      curTab = k;
      for (const b of bar.children) b.classList.toggle("primary", b.dataset.k === k);
      const t = tabs.find(x => x.key === k) || tabs[0];
      fill($("#talk-body"), tabs.length > 1 ? bar : null, brief != null && t.brief ? t.brief(brief) : t.body());
      $("#talk-body").scrollTop = 0;
    };
    for (const t of tabs) { const b = h("button", { class: "btn", type: "button", onclick: () => show(t.key) }, colorDot(t.color), t.label); b.dataset.k = t.key; bar.append(b); }
    show(opts && tabs.some(t => t.key === opts.tab) ? opts.tab : "main");
    if (opts) $("#talk-body").scrollTop = opts.scroll;
    clearTimeout(this._liveT);
    if (s.live) { // a running session refreshes itself every 8 s while its window is open, keeping the tab and the scroll
      const sig = (n) => JSON.stringify([n.conversation.length, ((n.agents || {}).helpers || []).map(x => x.conversation.length),
        ((n.agents || {}).briefs || []).length]);
      const was = sig(s);
      const again = () => { this._liveT = setTimeout(async () => {
        if (!$("#dlg-talk").open || $("#talk-h").dataset.sid !== id) return;
        let n; try { n = await api(`api/sessions/${id}`); } catch { again(); return; }
        if (sig(n) === was && n.live) { again(); return; }
        const b = $("#talk-body"), atEnd = b.scrollTop + b.clientHeight >= b.scrollHeight - 40;
        this.openSession(id, back, { data: n, tab: curTab, scroll: atEnd ? 1e9 : b.scrollTop });
      }, 8000); };
      again();
    }'''

JS_OPEN_OLD = '  async openSession(id, back) {\n    for (const d of $$("dialog[open]")) d.close();\n    $("#talk-kicker").textContent = "SESSION"; $("#talk-h").textContent = "…"; fill($("#talk-body"), h("p", { class: "muted", text: "Loading…" }));\n    fill($("#talk-actions"), back ? h("button", { class: "btn", type: "button", onclick: () => { const c = Scene.critters.get(back); if (c) this.openCritter(c); } }, "◀ BACK") : null);\n    $("#dlg-talk").showModal();\n    let s;\n    try { s = await api(`api/sessions/${id}`); } catch (x) { fill($("#talk-body"), h("p", { class: "form-error", text: x.message })); return; }'
JS_OPEN_NEW = '  async openSession(id, back, opts) { // farm-helpers patch: opts = {data, tab, scroll} is a live refresh (no reopen)\n    if (!opts) {\n      for (const d of $$("dialog[open]")) d.close();\n      $("#talk-kicker").textContent = "SESSION"; $("#talk-h").textContent = "…"; fill($("#talk-body"), h("p", { class: "muted", text: "Loading…" }));\n      fill($("#talk-actions"), back ? h("button", { class: "btn", type: "button", onclick: () => { const c = Scene.critters.get(back); if (c) this.openCritter(c); } }, "◀ BACK") : null);\n      $("#dlg-talk").showModal();\n    }\n    $("#talk-h").dataset.sid = id;\n    let s;\n    try { s = opts ? opts.data : await api(`api/sessions/${id}`); } catch (x) { fill($("#talk-body"), h("p", { class: "form-error", text: x.message })); return; }'

JS_TREE_METHOD = '  sessionTree(claude, box) { // farm-helpers patch: a Claude\'s sessions as a tree, with status and what each is doing now\n    const BADGE = { working: ["running", "WORKING"], waiting: ["running", "WAITING"], queued: ["running", "QUEUED"],\n      done: ["done", "DONE"], failed: ["failed", "FAILED"], cancelled: ["failed", "CANCELLED"] };\n    const badge = (st) => { const [c, t] = BADGE[st] || ["done", String(st || "").toUpperCase()]; return h("span", { class: `badge ${c}`, text: t }); };\n    const tier = (m) => { const t = helperTier({ kind: "agent", model: m, who: "" }); return m ? t.toUpperCase() : ""; };\n    const mins = (s) => { s = Math.max(0, Math.round(s / 60)); return s < 60 ? `${s}m` : `${Math.floor(s / 60)}h ${s % 60}m`; };\n    const active = (n) => ["working", "waiting", "queued"].includes(n.status);\n    const node = (n, depth, full) => {\n      const meta = [tier(n.model), active(n) ? `${n.status} ${mins(Date.now() / 1000 - (n.started || n.last_at))}` : ago(n.finished || n.last_at),\n        `${n.turns} turns`].filter(Boolean).join(" · ");\n      const head = sty(h("div", {}, depth ? h("span", { class: "muted", text: "└ " }) : null, badge(n.status), " ",\n        h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.openSession(n.session, this.summaryKey); } }, n.name),\n        h("span", { class: "muted", text: ` · ${meta}` })), `margin-left:${depth * 18}px;margin-top:${depth ? 4 : 10}px`);\n      const sub = (txt) => sty(h("div", { class: "muted small", text: txt }), `margin-left:${depth * 18 + 22}px`);\n      const out = [head];\n      if (active(n) && n.now) out.push(sub(`now: ${n.now}`));\n      if (!active(n) && n.outcome) out.push(sub(n.outcome));\n      const working = (n.helpers || []).filter(x => !x.done), done = (n.helpers || []).length - working.length;\n      for (const x of working) out.push(sty(h("div", { class: "small" }, colorDot(HELPER_LOOK[helperTier({ kind: "agent", model: x.model, who: x.who })]),\n        `${String(x.who).toUpperCase()} · ${tier(x.model) || "…"} · working`, h("span", { class: "muted", text: ` · ${x.label}${x.now ? " · now: " + x.now : ""}` })),\n        `margin-left:${depth * 18 + 18}px`));\n      if (done && active(n)) out.push(sub(`${done} helper${done > 1 ? "s" : ""} finished`));\n      if (full) for (const c of n.children || []) out.push(...node(c, depth + 1, true));\n      else if ((n.children || []).length) out.push(sub(`${n.children.length} farm job${n.children.length > 1 ? "s" : ""}: ${n.children.map(c => c.name).join(", ").slice(0, 120)}`));\n      return out;\n    };\n    const draw = (T) => {\n      const now = (T.roots || []).filter(active), earlier = (T.roots || []).filter(n => !active(n));\n      const me = (App.state?.agents || []).find(a => a.id === claude), fh = me?.budget?.five_hour;\n      const ms = T.milestone && T.milestone.name ? `${T.milestone.name} · ${T.milestone.done}/${T.milestone.total} done` : "";\n      fill(box,\n        sty(h("div", {}, h("b", { text: now.length ? "NOW" : "NOTHING RUNNING" }),\n          h("span", { class: "muted", text: [ms, fh != null ? `${Math.round(fh * 100)}% of the 5-hour window` : ""].filter(Boolean).map(x => " · " + x).join("") })), "margin-bottom:2px"),\n        now.flatMap(n => node(n, 0, true)),\n        earlier.length ? sty(h("details", {}, sty(h("summary", { text: `EARLIER (${earlier.length})` }), "cursor:pointer;margin-top:14px"),\n          earlier.flatMap(n => node(n, 0, false))), "margin-top:6px") : null);\n    };\n    const load = () => api(`api/session-tree?claude=${encodeURIComponent(claude)}`).then(T => {\n      this.treeCache = { at: Date.now(), claude, T }; if (document.body.contains(box) || !box.isConnected) draw(T);\n    }).catch(() => {});\n    const hit = this.treeCache;\n    if (hit && hit.claude === claude) draw(hit.T); else fill(box, h("p", { class: "muted small", text: "Loading…" }));\n    if (!hit || Date.now() - hit.at > 4000) load();\n    clearInterval(this._treeT);\n    this._treeT = setInterval(() => { if (!box.isConnected) { clearInterval(this._treeT); return; } load(); }, 8000);\n    return box;\n  },\n'

# clodfarm after 1.12.0: a session can be LOCAL (a person's own computer, `clodfarm attach`)
JS_SESS_OLD_LOCAL = JS_SESS_OLD.replace(
    '? String(s.claude || "CLAUDE").toUpperCase() : s.kind === "conversation" ? "YOU" : "THE FARM";',
    '? (local ? "CLAUDE" : String(s.claude || "CLAUDE").toUpperCase()) : s.kind === "conversation" || local ? "YOU" : "THE FARM";')
JS_SESS_NEW_LOCAL = JS_SESS_NEW.replace(
    ': String(s.claude || "CLAUDE").toUpperCase();', ': (local ? "CLAUDE" : String(s.claude || "CLAUDE").toUpperCase());').replace(
    's.kind === "conversation" ? "YOU" : "THE FARM"', 's.kind === "conversation" || local ? "YOU" : "THE FARM"')
assert JS_SESS_OLD_LOCAL != JS_SESS_OLD and JS_SESS_NEW_LOCAL.count("|| local") == 1 and JS_SESS_NEW_LOCAL.count('local ? "CLAUDE"') == 1

JS = [
    ("const MINIS_PER_PLOT = SUB_SPOTS.length;\n",
     "const MINIS_PER_PLOT = SUB_SPOTS.length;\n" + JS_HEAD),
    ("      const [dx, dy] = SUB_SPOTS[n];\n",
     "      const [dx, dy] = SUB_SPOTS[n];\n"
     "      (st.helpers || []).filter(x => x.task === t.id).slice(0, HELPER_SPOTS.length).forEach((x, k) => { // farm-helpers patch\n"
     "        const [hx, hy] = HELPER_SPOTS[k];\n"
     "        want.set(\"help:\" + x.id, { agent: a, sub: { id: t.id, title: x.label, status: \"running\" }, helper: x, kind: \"claude\",\n"
     "          mini: true, hat: \"\", color: helperColor(x), mode: \"work\", spot: { x: plot.x + dx + hx, y: plot.y + dy + hy } });\n"
     "      });\n"),
    ('owner = d.mini && Scene.critters.get("claude:" + d.agent.id);',
     'owner = d.helper ? (Scene.critters.get("sub:" + d.helper.task) || Scene.critters.get("claude:" + d.agent.id)) // farm-helpers patch\n'
     '        : d.mini && Scene.critters.get("claude:" + d.agent.id);'),
    ("Object.assign(c, { kind: d.kind, agent: d.agent, sub: d.sub || null,",
     "Object.assign(c, { helper: d.helper || null, kind: d.kind, agent: d.agent, sub: d.sub || null,"),
    ('      : d.mini ? (d.mode === "work" ? { icon: "terminal", title: d.sub.title }',
     '      : d.helper ? { icon: helperIcon(d.helper), title: helperTitle(d.helper) } // farm-helpers patch\n'
     '      : d.mini ? (d.mode === "work" ? { icon: "terminal", title: d.sub.title }'),
    ("    if (this.mini) return miniHD(this.color, {",
     "    if (this.mini) return (this.helper ? (o) => helperHD(this.helper, o) : (o) => miniHD(this.color, o))({ // farm-helpers patch"),
    ('paintSprite($("#sum-sprite"), c.mini ? miniHD(c.color, {})',
     'paintSprite($("#sum-sprite"), c.helper ? helperHD(c.helper, {}) : c.mini ? miniHD(c.color, {})'),
    ('const sig = JSON.stringify([tot, day]), sign = $("#tokens-sign");',
     'const UBM = st.usage_by_model || null; renderTierLine(UBM); // farm-helpers patch\n'
     '    const sig = JSON.stringify([tot, day, UBM && UBM.tiers]), sign = $("#tokens-sign");'),
    ('h("span", { class: "tok-note", text: "Every Claude on the farm, every sub-agent and conversation." }));',
     'h("span", { class: "tok-note", text: "Every Claude on the farm, every sub-agent and conversation." }), tierGrid(UBM)); // farm-helpers patch'),
    ('h("span", { class: "muted", text: ` · ${s.turns || 0} turns · ${ago(s.last_at)}` })))));',
     'h("span", { class: "muted", text: ` · ${s.turns || 0} turns${s.live ? " so far · LIVE" : ""} · ${ago(s.last_at)}` }))))); // farm-helpers patch'),
    (JS_OPEN_OLD, JS_OPEN_NEW),
    ('${ago(s.started)}`;\n    $("#talk-h").textContent',
     '${ago(s.started)}${s.live ? " · LIVE, REFRESHING" : ""}`; // farm-helpers patch\n    $("#talk-h").textContent'),
    ('  sessionList(claude, task) {\n    const box = h("div", { class: "sessions" }), key = claude + "|" + (task || "");',
     JS_TREE_METHOD + '  sessionList(claude, task) {\n    const box = h("div", { class: "sessions" }), key = claude + "|" + (task || "");\n'
     '    if (!task) return this.sessionTree(claude, box); // farm-helpers patch'),
    # one of the two matches: 1.12.0's session view, or the one with LOCAL sessions
    (JS_SESS_OLD, JS_SESS_NEW, True),
    (JS_SESS_OLD_LOCAL, JS_SESS_NEW_LOCAL, True),
    ("    if (c.mini) { // a sub-agent\n",
     r'''    if (c.helper) { // farm-helpers patch: a local brief or an Agent-tool subagent inside a sub-agent's session
      const x = c.helper, tier = helperTier(x), t = st.subagents.find(s => s.id === x.task);
      $("#sum-name").textContent = (x.kind === "local" ? "LOCAL MODEL · QWEN" : `HELPER · ${x.who} · ${tier}`).toUpperCase();
      $("#sum-sub").textContent = x.kind === "local"
        ? `Typing a pseudocode brief on hammer's Ollama (${x.model}), for free`
        : `A Claude Code subagent inside a sub-agent's session (${x.model || tier})`;
      fill($("#sum-body"), [h("dl", { class: "stat-row" },
          h("dt", { text: "STATUS" }), h("dd", { text: x.kind === "local" ? `TYPING ${x.label}` : "WORKING" }),
          h("dt", { text: "STARTED" }), h("dd", { text: ago(x.since) }),
          t ? [h("dt", { text: "HELPING" }), h("dd", { text: t.title })] : null),
        x.kind === "local" ? null : [h("h3", { text: "ITS JOB" }), h("p", { class: "job-text", text: x.label || x.who })],
        h("p", { class: "small" }, h("a", { href: "dashboards/local-llm", text: "The local model's dashboard →" }))]);
      fill($("#sum-actions")); fill($("#sum-top"));
      return;
    }
    if (c.mini) { // a sub-agent
'''),
    ('    fill($("#mgr-body"), managers, invite, planner, privacy, hatching, computers, owners, release);',
     '    // farm-helpers patch: usage limits and the planner\'s hours (farm_controls.py)\n    const C = m.controls || null;\n    const pctIn = (name, v) => h("input", { name, type: "number", min: 5, max: 130, step: 1, value: v == null ? "" : Math.round(v * 100), inputmode: "numeric" });\n    const PH = (C && C.planner_hours) || { mode: "always", start: "22:00", end: "07:00" };\n    const anyBox = h("input", { type: "radio", name: "ph_mode", value: "always", checked: PH.mode !== "hours" });\n    const hrsBox = h("input", { type: "radio", name: "ph_mode", value: "hours", checked: PH.mode === "hours" });\n    const startIn = h("input", { type: "time", name: "ph_start", value: PH.start }), endIn = h("input", { type: "time", name: "ph_end", value: PH.end });\n    const preset = (label, a, b) => h("button", { class: "btn tiny", type: "button", onclick: () => { hrsBox.checked = true; startIn.value = a; endIn.value = b; } }, label);\n    const pct = (x) => `${Math.round(x * 100)}%`;\n    const hamBox = h("input", { type: "checkbox", name: "hammer_requests", checked: !C || C.hammer_requests !== false });\n    const hammer = C ? section("HAMMER (LOCAL QWEN)", [\n      h("label", { class: "check toggle" }, hamBox, "SEND REQUESTS TO HAMMER\'S OLLAMA"),\n      h("p", { class: "muted small", text: `${C.hammer_requests !== false ? "On" : "Off: nothing new goes to hammer"}. Covers the Claudes\' pseudocode briefs (tools/local-llm/ask.py) and the book\'s pages. While it\'s off, a new brief waits (up to 25 minutes, then its lead runs it again) and the book stops rewriting pages; a brief already typing finishes. Turning it back on lets both carry on within about 30 seconds.` })],\n      async () => { await api("api/manager/controls", { hammer_requests: hamBox.checked }); this.renderManager(await api("api/manager")); }) : null;\n    const hours = C ? section("WHEN THE PLANNER RUNS", [\n      h("label", { class: "check" }, anyBox, "ANY TIME"),\n      h("label", { class: "check" }, hrsBox, "ONLY BETWEEN THESE HOURS"),\n      h("div", { class: "two" }, h("label", {}, "FROM", startIn), h("label", {}, "UNTIL", endIn)),\n      h("div", { class: "dlg-actions left" }, preset("OVERNIGHT 22:00-07:00", "22:00", "07:00"), preset("DAYTIME 08:00-22:00", "08:00", "22:00")),\n      h("label", { class: "check" }, h("input", { type: "checkbox", name: "ph_sleep", checked: !!C.planner_may_sleep }), "LET THE PLANNER SLEEP WHEN NOTHING IS READY"),\n      h("div", { class: "dlg-actions left" }, h("button", { class: "btn tiny", type: "button", onclick: async () => { await api("api/manager/controls", { wake: true }); this.renderManager(await api("api/manager")); } }, "WAKE NOW")),\n      h("label", {}, "PLANNER MODEL", h("select", { name: "ph_model" }, [["", "farm default (Opus)"], ["haiku", "Haiku (cheapest)"], ["sonnet", "Sonnet"], ["opus", "Opus"]].map(([v, t]) => h("option", { value: v, text: t, selected: (C.planner_model || "") === v })))),\n      h("p", { class: "muted small", text: `Farm time now ${C.now_local} (${C.tz}): ${C.planner_open ? "inside its hours" : "outside its hours, so new cycles wait"}. A cycle already running finishes, and jobs you start yourself always run. PLANNER ON (above) still switches it off completely. Sleeping off: if the planner puts itself to sleep, the farm cancels it and it checks again every cycle. WAKE NOW starts a cycle at once. The planner model only changes the planner\'s own cycles (it dispatches the job queue); every job keeps the farm\'s model.` })],\n      async (f) => { const d = new FormData(f); await api("api/manager/controls", { planner_hours: { mode: d.get("ph_mode"), start: startIn.value, end: endIn.value }, planner_model: d.get("ph_model") || "", planner_may_sleep: d.get("ph_sleep") === "on" }); this.renderManager(await api("api/manager")); }) : null;\n    const limits = C ? section("USAGE LIMITS (THIS FARM)", [\n      h("div", { class: "two" }, h("label", {}, "5-HOUR WINDOW: STOP AT %", pctIn("five", C.from_ui.five_hour_ceiling ? C.five_hour_ceiling : null)),\n        h("label", {}, "WEEK: STOP AT %", pctIn("week", C.from_ui.weekly_target ? C.weekly_target : null))),\n      h("p", { class: "muted small", text: `In effect now: 5-hour ${pct(C.five_hour_ceiling)}, week ${pct(C.weekly_target)}. Empty uses the .env value (5-hour ${pct(C.env.five_hour_ceiling)}, week ${pct(C.env.weekly_target)}). These windows belong to your whole Claude account: your own Claude Code sessions and the Scrappy farm (which stops at 60%) use them too. Over 100% means no limit: the farm runs until Anthropic turns it away. Takes effect within a minute.` })],\n      async (f) => { const d = new FormData(f), v = (k) => d.get(k) === "" ? null : Number(d.get(k)) / 100; await api("api/manager/controls", { five_hour_ceiling: v("five"), weekly_target: v("week") }); this.renderManager(await api("api/manager")); }) : null;\n    fill($("#mgr-body"), managers, invite, planner, hammer, hours, limits, privacy, hatching, computers, owners, release);', True),
]
# a clodfarm with BOTS FIRST: the same manager panel with its BOTS FIRST section
_MGR = next(e for e in JS if e[0].startswith('    fill($("#mgr-body")'))
JS.append((_MGR[0].replace("planner, privacy,", "planner, botsFirst, privacy,"),
           _MGR[1].replace("planner, hammer,", "planner, botsFirst, hammer,"), True))
assert JS[-1][0] != _MGR[0] and JS[-1][1] != _MGR[1]


GOV = [
    ("    n = max(policy.max_workers, 0)\n",
     "    from . import farm_controls  # farm-helpers patch: the usage limits set in the farm UI\n"
     "    policy = farm_controls.policy(policy)\n"
     "    n = max(policy.max_workers, 0)\n", True),
]
DASH_JS = [  # farm-helpers patch: links to this farm's own pages open in the same tab (the book's page turns)
    ('"use strict";\n',
     '"use strict";\n// farm-helpers patch: a link to this farm\'s own pages opens in the same tab, others in a new one\n'
     'const _away = (u) => { try { return new URL(u, location.href).origin === location.origin ? null : "_blank"; } catch (e) { return "_blank"; } };\n', True),
    ('out.push(h("a", { href: m[4], target: "_blank", rel: "noopener noreferrer", text: m[3] }));',
     'out.push(h("a", { href: m[4], target: _away(m[4]), rel: "noopener noreferrer", text: m[3] }));', True),
    ('href: i.href, target: i.href ? "_blank" : null,', 'href: i.href, target: i.href ? _away(i.href) : null,', True),
    ('v.href ? h("a", { href: v.href, target: "_blank", rel: "noopener noreferrer", text: v.text || v.href })',
     'v.href ? h("a", { href: v.href, target: _away(v.href), rel: "noopener noreferrer", text: v.text || v.href })', True),
]
PLANNER = [
    ('    if float(pl.get("idle_until") or 0) > now():\n',
     '    from . import farm_controls  # farm-helpers patch: the planner\'s hours, set in the farm UI\n'
     '    gate = farm_controls.planner_gate()\n'
     '    if gate:\n'
     '        if pl.get("state") != gate:\n'
     '            store.set_planner(state=gate)\n'
     '        return None\n'
     '    if farm_controls.woken(float(pl.get("last_at") or 0)):  # "Wake now" in the farm UI: no sleep, no rest\n'
     '        store.set_planner(idle_until=0)\n'
     '        pl = dict(pl, idle_until=0, last_at=0)\n'
     '    elif not farm_controls.may_sleep() and float(pl.get("idle_until") or 0) > now():  # sleeping is off in the UI\n'
     '        store.set_planner(idle_until=0)\n'
     '        pl = dict(pl, idle_until=0)\n'
     '    if float(pl.get("idle_until") or 0) > now():\n', True),
]
SUP = [
    ("            return run_agent(build_cmd(cfg, sysprompt, resume_session, name, live=bool(live),\n",
     "            from . import farm_controls  # farm-helpers patch: planner cycles may use their own model\n"
     "            return run_agent(build_cmd(farm_controls.task_cfg(cfg, task), sysprompt, resume_session, name, live=bool(live),\n", True),
]
CLI = [
    ('    seat, snap, d, p = r["seat"], r["snapshot"], r["decision"], r["policy"]\n',
     '    seat, snap, d, p = r["seat"], r["snapshot"], r["decision"], r["policy"]\n'
     '    from . import farm_controls  # farm-helpers patch: show the limits set in the farm UI\n'
     '    p = farm_controls.policy(p)\n', True),
]


def patch(path: str, edits: list):
    """Patch from the pristine copy (<file>.orig, kept on the first patch), so a newer version of this patch replaces
    an older one. A file without the mark is a new clodfarm: it becomes the new pristine copy."""
    orig = path + ".orig"
    s = open(path).read()
    if MARK in s:
        if not os.path.exists(orig):
            sys.exit(f"{path}: patched, but no {orig} to start again from (restore it from the image)")
        s = open(orig).read()
    else:
        shutil.copy(path, orig)
    todo = []
    for old, new, *opt in edits:  # a third item True = optional (farm controls): an older clodfarm skips it
        n = s.count(old)
        if n == 0 and opt and opt[0]:
            print(f"{path}: optional edit skipped (anchor not in this clodfarm): {old[:60]!r}")
            continue
        if n != 1:
            sys.exit(f"{path}: anchor found {n} times, nothing written: {old[:70]!r}")
        todo.append((old, new))
    if not todo:
        print(f"{path}: nothing to patch")
        return
    for old, new in todo:
        s = s.replace(old, new)
    tmp = path + ".farm-helpers.tmp"
    open(tmp, "w").write(s)
    os.replace(tmp, path)
    print(f"{path}: patched (pristine copy: {orig})")


patch(os.path.join(pkg, "web.py"), WEB)
patch(os.path.join(pkg, "ui", "app.js"), JS)
patch(os.path.join(pkg, "ui", "dash.js"), DASH_JS)
patch(os.path.join(pkg, "governor.py"), GOV)
patch(os.path.join(pkg, "planner.py"), PLANNER)
patch(os.path.join(pkg, "cli.py"), CLI)
patch(os.path.join(pkg, "supervisor.py"), SUP)
for mod in ("farm_helpers.py", "farm_usage.py", "farm_controls.py"):
    shutil.copy(os.path.join(here, mod), os.path.join(pkg, mod))
    os.chmod(os.path.join(pkg, mod), 0o644)
    print(f"{pkg}/{mod}: copied")
