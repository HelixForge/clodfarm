"""Slack: the manifest link, Markdown to mrkdwn, taking a message (once, from members only) and answering in the thread."""
import json
import urllib.parse

import pytest

from clodfarm import slack
from clodfarm.config import load
from clodfarm.slack import SlackBridge, manifest_url, save_settings, to_mrkdwn
from clodfarm.store import Store

MEMBER = {"id": "U1", "name": "gil", "team_id": "T1", "real_name": "Gil", "profile": {"email": "gil@jestr.ai"}}


@pytest.fixture
def bridge(env, backend, monkeypatch):
    if backend != "sqlite":
        pytest.skip("the bridge uses the same Store API on both backends; one is enough")
    cfg = load()
    store = Store.from_config(cfg)
    store.ensure_table()
    save_settings(cfg, {"bot_token": "xoxb-1", "app_token": "xapp-1",
                        "info": {"team": "jestr", "team_id": "T1", "bot_user_id": "UBOT"}})
    calls, users = [], {"U1": MEMBER, "UG": {**MEMBER, "id": "UG", "is_restricted": True},
                        "UX": {**MEMBER, "id": "UX", "team_id": "T9"}}

    def fake_api(method, token, **p):
        calls.append((method, p))
        if method == "users.info":
            return {"ok": True, "user": users[p["user"]]}
        if method == "conversations.replies":
            return {"ok": True, "messages": [{"ts": "1.0", "user": "U1", "text": "first ask"},
                                             {"ts": "1.1", "bot_id": "B1", "user": "UBOT", "text": "first answer"},
                                             {"ts": "1.2", "user": "U1", "text": "follow up"}]}
        return {"ok": True}
    monkeypatch.setattr(slack, "api", fake_api)
    return SlackBridge(cfg, store), store, calls


def mention(text, user="U1", ts="1.0", **extra):
    return {"event": {"type": "app_mention", "user": user, "text": f"<@UBOT> {text}", "channel": "C1", "ts": ts, **extra}}


def posts(calls):
    return [p["text"] for m, p in calls if m == "chat.postMessage"]


def test_manifest_link_is_a_socket_mode_app():
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(manifest_url("jestr")).query)
    m = json.loads(q["manifest_json"][0])
    assert q["new_app"] == ["1"] and m["settings"]["socket_mode_enabled"] is True
    assert set(m["settings"]["event_subscriptions"]["bot_events"]) == {"app_mention", "message.im"}
    assert "chat:write" in m["oauth_config"]["scopes"]["bot"] and m["display_information"]["name"] == "clodfarm jestr"


def test_markdown_becomes_mrkdwn():
    out = to_mrkdwn("## Done\n**Tests** pass: see [PR](https://x.io/1)\n- a < b\n```\n**kept**\n```")
    assert out == "*Done*\n*Tests* pass: see <https://x.io/1|PR>\n• a &lt; b\n```\n**kept**\n```"


def test_a_mention_starts_a_sub_agent_once_and_the_answer_lands_in_the_thread(bridge):
    b, store, calls = bridge
    t = b.handle(mention("add CSV export to the report page"))
    assert t and t["title"] == "add CSV export to the report page" and t["created_by"] == "slack:Gil"
    assert "Gil asked you this in Slack" in t["prompt"] and "Slack thread" in t["prompt"]
    assert "On it" in posts(calls)[-1] and ("reactions.add", {"channel": "C1", "timestamp": "1.0", "name": "eyes"}) in calls
    assert b.handle(mention("add CSV export to the report page")) is None  # Slack retried: taken once
    assert store.count("queued") == 1

    assert b.deliver() == 0  # not finished yet
    worker = "test@box/w0"
    store.claim_next(worker, 300)
    store.finish(t["id"], worker, True, "## Done\n**CSV export** added.", 5)
    calls.clear()
    assert b.deliver() == 1
    assert posts(calls) == ["*Done*\n*CSV export* added."]
    assert ("reactions.add", {"channel": "C1", "timestamp": "1.0", "name": "white_check_mark"}) in calls
    assert b.deliver() == 0  # posted once


def test_a_follow_up_in_the_thread_carries_the_conversation(bridge):
    b, _, _ = bridge
    t = b.handle(mention("and add a test", ts="1.2", thread_ts="1.0"))
    assert "- Gil: first ask" in t["prompt"] and "- you (the farm): first answer" in t["prompt"]
    assert "follow up" not in t["prompt"]  # the message itself is the ask, not context


def test_only_members_of_the_workspace_and_the_allow_list(bridge):
    b, store, calls = bridge
    assert b.handle(mention("do it", user="UG", ts="2.0")) is None and "guests" in posts(calls)[-1]
    assert b.handle(mention("do it", user="UX", ts="2.1")) is None and "shared channels" in posts(calls)[-1]
    b.set_allow(["someone@else.io"])
    assert b.handle(mention("do it", ts="2.2")) is None and "list" in posts(calls)[-1]
    b.set_allow(["GIL@jestr.ai"])
    assert b.handle(mention("do it", ts="2.3"))
    assert store.count("queued") == 1


def test_help_status_bots_and_channel_chatter_start_nothing(bridge):
    b, store, calls = bridge
    assert b.handle(mention("help", ts="3.0")) is None and "status" in posts(calls)[-1]
    assert b.handle(mention("status", ts="3.1")) is None and "No sub-agents running" in posts(calls)[-1]
    assert b.handle({"event": {"type": "message", "channel_type": "channel", "user": "U1", "text": "hi", "channel": "C1",
                               "ts": "3.2"}}) is None
    assert b.handle({"event": {"type": "message", "channel_type": "im", "bot_id": "B2", "user": "U2", "text": "x",
                               "channel": "D1", "ts": "3.3"}}) is None
    assert b.handle({"event": {"type": "message", "channel_type": "im", "user": "U1", "text": "fix the build",
                               "channel": "D1", "ts": "3.4"}})["title"] == "fix the build"
    assert store.count("queued") == 1


def test_view_never_shows_the_tokens(bridge):
    b, _, _ = bridge
    v = json.dumps(b.view())
    assert "xoxb-1" not in v and "xapp-1" not in v and '"configured": true' in v


def test_connect_rejects_the_wrong_tokens(bridge):
    b, _, _ = bridge
    with pytest.raises(ValueError, match="xoxb-"):
        b.connect("xapp-2", "xapp-2")
    with pytest.raises(ValueError, match="xapp-"):
        b.connect("xoxb-2", "xoxb-2")
