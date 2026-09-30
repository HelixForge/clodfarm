"""An invite: a link for one person, who logs in with their own Claude account and gets their own Claude on the farm,
once, whether the farm is private or its hatching is closed. And a public farm's visitor only watches."""
import hashlib
import re

from test_owners import ui  # noqa: F401 - the fixture
from test_sso import browser
from test_web import client, login


def make_invite(api, base):
    code, r, _ = api(base + "/api/manager/invite", {})
    assert code == 200, r
    return r["link"]


def test_an_invite_hatches_one_claude_once(ui, monkeypatch):
    base, farm_ui = ui
    manager = client()
    login(manager, base)
    manager(base + "/api/manager/settings", {"hatch_open": False})  # closed to everyone else
    link = make_invite(manager, base)
    token = link.rsplit("/", 1)[1]
    assert re.fullmatch(r"[A-Za-z0-9_-]{20,}", token) and "/invite/" in link

    friend_call, friend = browser()
    # opening it (or a chat app's preview) doesn't spend it
    code, _, headers = friend_call(base + f"/invite/{token}")
    assert code == 302 and headers["Location"].endswith("/?invited=1") and "clodfarm_invite=" in headers["Set-Cookie"]
    assert farm_ui.store.invite(hashlib.sha256(token.encode()).hexdigest())
    me = friend(base + "/api/me")[1]
    assert me["invite"] is True and not me["owner"]
    # logging in hatches their own Claude, and spends the invite
    code, a, headers = friend(base + "/api/agents", {"invite": True})
    assert code == 200, a
    assert "clodfarm_owner=" in headers["Set-Cookie"]
    me = friend(base + "/api/me")[1]
    assert me["owner"] == a["id"] and me["invite"] is False
    assert farm_ui.store.claude(a["id"])["hatched_by"] == "invite"
    assert farm_ui.store.invite(hashlib.sha256(token.encode()).hexdigest()) is None
    # the same link again: refused
    other_call, other = browser()
    assert other_call(base + f"/invite/{token}")[2]["Location"].endswith("/?invited=0")
    assert other(base + "/api/agents", {"invite": True})[0] == 410
    assert other(base + "/api/agents", {"name": "sneaky"})[0] == 403, "hatching is closed without an invite"


def test_an_invite_works_on_a_private_farm(ui, monkeypatch):
    base, farm_ui = ui
    monkeypatch.setenv("FARM_UI_PRIVATE", "1")
    manager = client()
    login(manager, base)
    token = make_invite(manager, base).rsplit("/", 1)[1]
    call, friend = browser()
    call(base + f"/invite/{token}")
    code, me, _ = friend(base + "/api/me")
    assert code == 401 and me["invite"] is True, "can't watch yet, but may log in"
    code, a, _ = friend(base + "/api/agents", {"invite": True})
    assert code == 200, a
    assert friend(base + "/api/me")[0] == 200, "now they're a person on the farm"


def test_the_plan_still_counts(ui, monkeypatch):
    base, farm_ui = ui
    monkeypatch.setenv("FARM_MAX_CLAUDES", "0")
    manager = client()
    login(manager, base)
    r = manager(base + "/api/manager/invite", {})[1]
    assert r["room"] is False
    call, friend = browser()
    call(base + "/invite/" + r["link"].rsplit("/", 1)[1])
    code, body, _ = friend(base + "/api/agents", {"invite": True})
    assert code == 400 and "room for 1 Claude" in body["error"]
    assert friend(base + "/api/me")[1]["invite"] is True, "the invite isn't spent by a refusal"


def test_only_the_manager_makes_invites(ui):
    base, _ = ui
    assert client()(base + "/api/manager/invite", {})[0] == 403
