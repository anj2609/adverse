from datetime import timedelta

from app import clock
from conftest import T0, at


def new_campaign(client, h, app, name="Spring", advertiser="BrewCo", **kw):
    r = client.post("/api/v1/admin/campaigns", headers=h, json={"application_id": app["id"], "name": name, "advertiser": advertiser, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def add(client, h, camp, placement_id, creative_id):
    return client.post(f"/api/v1/admin/campaigns/{camp['id']}/assignments", headers=h, json={"placement_id": placement_id, "creative_id": creative_id})


def step(client, h, camp, action, **json):
    return client.post(f"/api/v1/admin/campaigns/{camp['id']}/{action}", headers=h, json=json or None)


def test_full_workflow_and_time_windows(client, api, admin, editor):
    app = api.app()
    pid, cid = app["placements"]["home.coffee_cup"], api.creative()
    start, end = at(hours=2).isoformat(), at(hours=5).isoformat()
    camp = new_campaign(client, editor, app, start_time=start, end_time=end)
    assert camp["status"] == "draft" and camp["effective_status"] == "draft"
    assert step(client, editor, camp, "submit").status_code == 409  # nothing assigned yet
    assert add(client, editor, camp, pid, cid).status_code == 201
    assert step(client, editor, camp, "submit").json()["status"] == "pending_approval"
    assert step(client, editor, camp, "approve").status_code == 403  # only admins approve
    assert api.slot(app, "home.coffee_cup")["creative"] is None  # pending approval: not served
    assert step(client, admin, camp, "approve").json()["effective_status"] == "scheduled"
    assert api.slot(app, "home.coffee_cup")["creative"] is None  # approved but before its start time

    clock.freeze(at(hours=2, seconds=1))
    live = api.slot(app, "home.coffee_cup")["creative"]
    assert live["creative_id"] == cid and live["campaign_status"] == "active" and live["valid_until"].startswith(end[:16])

    clock.freeze(at(hours=5))  # exactly at the end: not eligible
    assert api.slot(app, "home.coffee_cup")["creative"] is None
    got = client.get(f"/api/v1/admin/campaigns/{camp['id']}", headers=admin).json()["campaign"]
    assert got["effective_status"] == "expired"
    assert step(client, admin, camp, "pause").status_code == 409


def test_pause_resume_reject_expire(client, api, admin):
    app = api.app()
    pid, cid = app["placements"]["home.coffee_cup"], api.creative()
    camp = new_campaign(client, admin, app)
    add(client, admin, camp, pid, cid)
    step(client, admin, camp, "submit"); step(client, admin, camp, "approve")
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == cid
    assert step(client, admin, camp, "pause").json()["effective_status"] == "paused"
    assert api.slot(app, "home.coffee_cup")["creative"] is None
    assert step(client, admin, camp, "resume").json()["effective_status"] == "active"
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == cid
    assert step(client, admin, camp, "expire").json()["status"] == "expired"
    assert api.slot(app, "home.coffee_cup")["creative"] is None
    assert step(client, admin, camp, "resume").status_code == 409

    rejected = new_campaign(client, admin, app, name="Nope")
    add(client, admin, rejected, pid, cid)
    step(client, admin, rejected, "submit")
    assert step(client, admin, rejected, "reject").status_code in (400, 422)  # reason required
    assert step(client, admin, rejected, "reject", reason="off brand").json()["status"] == "rejected"
    assert api.slot(app, "home.coffee_cup")["creative"] is None
    assert add(client, admin, rejected, pid, cid).status_code == 409


def test_cannot_approve_with_unapproved_creative(client, api, admin):
    app = api.app()
    pid, cid = app["placements"]["home.coffee_cup"], api.creative(approve=False)
    camp = new_campaign(client, admin, app)
    add(client, admin, camp, pid, cid)
    step(client, admin, camp, "submit")
    r = step(client, admin, camp, "approve")
    assert r.status_code == 409 and r.json()["error"]["code"] == "creative_not_approved"
    client.post(f"/api/v1/admin/creatives/{cid}/approve", headers=admin)
    assert step(client, admin, camp, "approve").status_code == 200


def test_rejected_creative_stops_serving(client, api, admin):
    app = api.app()
    pid, cid = app["placements"]["home.coffee_cup"], api.creative()
    assert api.assign(pid, cid).status_code == 201
    assert api.slot(app, "home.coffee_cup")["creative"]
    client.post(f"/api/v1/admin/creatives/{cid}/reject", headers=admin, json={"reason": "legal"})
    assert api.slot(app, "home.coffee_cup")["creative"] is None
    client.post(f"/api/v1/admin/creatives/{cid}/approve", headers=admin)
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == cid


def test_deactivated_creative_stops_serving(client, api, admin):
    app = api.app()
    pid, cid = app["placements"]["home.coffee_cup"], api.creative()
    api.assign(pid, cid)
    client.post(f"/api/v1/admin/creatives/{cid}/deactivate", headers=admin)
    assert api.slot(app, "home.coffee_cup")["creative"] is None


def test_timezone_is_applied_to_naive_times(client, api, admin):
    app = api.app()
    camp = new_campaign(client, admin, app, timezone="America/New_York", start_time="2030-06-01T09:00:00", end_time="2030-06-01T17:00:00")
    assert camp["start_time"].startswith("2030-06-01T13:00:00")  # 09:00 in New York (summer) is 13:00 UTC
    bad = client.post("/api/v1/admin/campaigns", headers=admin, json={"application_id": app["id"], "name": "x", "advertiser": "y", "timezone": "Mars/Base"})
    assert bad.json()["error"]["code"] == "bad_timezone"
    backwards = client.post("/api/v1/admin/campaigns", headers=admin, json={"application_id": app["id"], "name": "x", "advertiser": "y",
                                                                           "start_time": at(hours=2).isoformat(), "end_time": at(hours=1).isoformat()})
    assert backwards.json()["error"]["code"] == "bad_window"


def test_conflicting_campaigns_are_refused_not_overwritten(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    a, b = api.creative("A"), api.creative("B", advertiser="Rival")
    first = new_campaign(client, admin, app, name="First", priority=5)
    add(client, admin, first, pid, a); step(client, admin, first, "submit"); step(client, admin, first, "approve")
    second = new_campaign(client, admin, app, name="Second", advertiser="Rival", priority=5)
    assert add(client, admin, second, pid, b).status_code == 201  # drafts may overlap...
    r = step(client, admin, second, "submit")  # ...but can't go live-ish alongside an equal-priority rival
    assert r.status_code == 409 and r.json()["error"]["details"][0]["campaign_name"] == "First"
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == a
    # different dates don't clash
    client.patch(f"/api/v1/admin/campaigns/{second['id']}", headers=admin, json={"start_time": at(days=30).isoformat()})
    client.patch(f"/api/v1/admin/campaigns/{first['id']}", headers=admin, json={"end_time": at(days=10).isoformat()})
    assert step(client, admin, second, "submit").status_code == 200


def test_priority_decides_and_loser_returns_when_winner_ends(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    low_c, high_c = api.creative("Low"), api.creative("High", advertiser="Big")
    low = new_campaign(client, admin, app, name="Low", priority=3)
    high = new_campaign(client, admin, app, name="High", advertiser="Big", priority=9)
    for camp, c in ((low, low_c), (high, high_c)):
        add(client, admin, camp, pid, c); step(client, admin, camp, "submit"); step(client, admin, camp, "approve")
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == high_c
    ws = client.get(f"/api/v1/admin/applications/{app['id']}/workspace", headers=admin).json()["placements"][0]
    assert ws["status"] == "active" and {a["state"] for a in ws["assignments"]} == {"eligible", "overridden"}
    step(client, admin, high, "pause")
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == low_c  # next valid assignment takes over
    step(client, admin, low, "expire")
    assert api.slot(app, "home.coffee_cup")["creative"] is None  # nothing valid left: fallback
