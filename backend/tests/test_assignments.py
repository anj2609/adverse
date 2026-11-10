from app.db import SessionLocal
from app.models import Assignment
from conftest import at
from test_campaigns import add, new_campaign, step


def test_direct_assign_replace_remove_and_rollback(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    a, b = api.creative("Cup A"), api.creative("Cup B")
    r1 = api.assign(pid, a)
    assert r1.status_code == 201 and r1.json()["status"] == "applied"
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == a
    r2 = api.assign(pid, b)  # replaces the first direct assignment
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == b
    asg_b = r2.json()["results"][0]["assignment_id"]
    assert r2.json()["results"][0]["replaces_assignment_id"] == r1.json()["results"][0]["assignment_id"]
    # undo the replacement: A is back
    assert client.post(f"/api/v1/admin/assignments/{asg_b}/rollback", headers=admin).json()["outcome"] == "restored_replaced_assignment"
    assert api.slot(app, "home.coffee_cup")["creative"]["creative_id"] == a
    assert client.post(f"/api/v1/admin/assignments/{asg_b}/rollback", headers=admin).status_code == 409  # can't roll back twice
    # remove it: fallback
    asg_a = r1.json()["results"][0]["assignment_id"]
    assert client.delete(f"/api/v1/admin/assignments/{asg_a}", headers=admin).status_code == 200
    assert api.slot(app, "home.coffee_cup")["creative"] is None


def test_restore_fallback_and_history(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    api.assign(pid, api.creative("A"))
    assert api.slot(app, "home.coffee_cup")["creative"]
    r = client.post(f"/api/v1/admin/placements/{pid}/restore-fallback", headers=admin)
    assert r.status_code == 200 and len(r.json()["removed_assignments"]) == 1
    assert api.slot(app, "home.coffee_cup")["creative"] is None
    history = client.get(f"/api/v1/admin/placements/{pid}/history", headers=admin).json()
    assert [h["action"] for h in history["items"]][:3] == ["placement.restore_fallback", "assignment.remove", "assignment.create"]


def test_scheduled_direct_assignment(client, api):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    api.assign(pid, api.creative(), start_time=at(hours=1).isoformat(), end_time=at(hours=2).isoformat())
    assert api.slot(app, "home.coffee_cup")["creative"] is None
    from app import clock
    clock.freeze(at(hours=1, minutes=1))
    assert api.slot(app, "home.coffee_cup")["creative"]
    clock.freeze(at(hours=2, minutes=1))
    assert api.slot(app, "home.coffee_cup")["creative"] is None


def test_in_campaign_replacement_and_rollback(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    a, b = api.creative("A"), api.creative("B")
    camp = new_campaign(client, admin, app)
    first = add(client, admin, camp, pid, a).json()
    second = add(client, admin, camp, pid, b).json()  # same campaign + placement: replaced in place
    assert second["id"] == first["id"] and second["creative_id"] == b and second["previous_creative_id"] == a
    assert client.post(f"/api/v1/admin/assignments/{first['id']}/rollback", headers=admin).json()["outcome"] == "restored_previous_creative"
    assert [x["creative"]["id"] for x in client.get(f"/api/v1/admin/campaigns/{camp['id']}", headers=admin).json()["assignments"]] == [a]


def test_db_allows_one_live_assignment_per_campaign_and_placement(client, api, admin):
    import pytest
    from sqlalchemy.exc import IntegrityError
    app = api.app()
    pid, cid = app["placements"]["home.coffee_cup"], api.creative()
    camp = new_campaign(client, admin, app)
    a = add(client, admin, camp, pid, cid).json()
    with SessionLocal() as db:
        db.add(Assignment(application_id=app["id"], campaign_id=camp["id"], placement_id=pid, creative_id=cid))
        with pytest.raises(IntegrityError):
            db.commit()
    assert a["status"] == "active"


def test_bulk_all_or_nothing_leaves_nothing_behind(client, api, admin):
    app = api.app(placements=[api.placement_spec("home.coffee_cup"), api.placement_spec("home.desk_lamp"),
                              api.placement_spec("home.banner", types=("banner",), aspect=3.0, transparency=False)])
    ids = app["placements"]
    cid = api.creative("Cutout square")
    body = {"placement_ids": [ids["home.coffee_cup"], ids["home.desk_lamp"], ids["home.banner"]], "creative_id": cid}
    r = client.post(f"/api/v1/admin/applications/{app['id']}/assignments/bulk", headers=admin, json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == "bulk_validation_failed"
    statuses = {x["placement_id"]: x["status"] for x in r.json()["error"]["details"]}
    assert statuses == {"home.coffee_cup": "not_applied", "home.desk_lamp": "not_applied", "home.banner": "failed"}
    assert api.slot(app, "home.coffee_cup")["creative"] is None and api.slot(app, "home.desk_lamp")["creative"] is None
    with SessionLocal() as db:
        assert db.query(Assignment).count() == 0
    ops = client.get(f"/api/v1/admin/applications/{app['id']}/bulk-operations", headers=admin).json()["items"]
    assert [o["status"] for o in ops] == ["failed"]  # the attempt itself is recorded
    failed_audit = client.get("/api/v1/admin/audit?outcome=failure", headers=admin).json()
    assert failed_audit["total"] == 1 and failed_audit["items"][0]["action"] == "bulk.assign"


def test_bulk_preview_apply_and_rollback(client, api, admin):
    app = api.app(placements=[api.placement_spec("home.coffee_cup"), api.placement_spec("home.desk_lamp")])
    ids = app["placements"]
    cid = api.creative("Cutout")
    body = {"placement_ids": [ids["home.coffee_cup"], "home.desk_lamp"], "creative_id": cid}  # ids or keys both work
    prev = client.post(f"/api/v1/admin/applications/{app['id']}/assignments/preview", headers=admin, json=body).json()
    assert prev["valid"] and all(r["status"] == "ok" for r in prev["results"])
    assert api.slot(app, "home.coffee_cup")["creative"] is None  # a preview changes nothing
    op = client.post(f"/api/v1/admin/applications/{app['id']}/assignments/bulk", headers=admin, json=body).json()
    assert op["status"] == "applied" and [r["status"] for r in op["results"]] == ["created", "created"]
    v = api.runtime(app).json()["config_version"]
    assert all(api.slot(app, k)["creative"] for k in ids)
    done = client.post(f"/api/v1/admin/bulk-operations/{op['id']}/rollback", headers=admin).json()
    assert done["status"] == "rolled_back"
    assert all(api.slot(app, k)["creative"] is None for k in ids)
    assert api.runtime(app).json()["config_version"] > v
    assert client.post(f"/api/v1/admin/bulk-operations/{op['id']}/rollback", headers=admin).status_code == 409


def test_bulk_partial_applies_only_valid(client, api, admin):
    app = api.app(placements=[api.placement_spec("home.coffee_cup"), api.placement_spec("home.banner", types=("banner",), aspect=3.0, transparency=False)])
    ids = app["placements"]
    body = {"placement_ids": list(ids.values()), "creative_id": api.creative("Cutout"), "mode": "partial"}
    op = client.post(f"/api/v1/admin/applications/{app['id']}/assignments/bulk", headers=admin, json=body).json()
    assert op["status"] == "partial"
    assert {r["placement_id"]: r["status"] for r in op["results"]} == {"home.coffee_cup": "created", "home.banner": "skipped"}
    assert api.slot(app, "home.coffee_cup")["creative"] and api.slot(app, "home.banner")["creative"] is None


def test_bulk_rejects_placements_from_another_application(client, api, admin):
    mine = api.app("focusflow")
    other = api.app("cookwise", "CookWise", placements=[api.placement_spec("home.milk_carton")])
    body = {"placement_ids": [other["placements"]["home.milk_carton"]], "creative_id": api.creative("X")}
    r = client.post(f"/api/v1/admin/applications/{mine['id']}/assignments/bulk", headers=admin, json=body)
    assert r.status_code == 422 and r.json()["error"]["details"][0]["errors"][0]["code"] == "not_found"


def test_direct_assign_is_blocked_by_equal_priority_campaign(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    camp = new_campaign(client, admin, app, priority=5)
    add(client, admin, camp, pid, api.creative("A")); step(client, admin, camp, "submit"); step(client, admin, camp, "approve")
    r = api.assign(pid, api.creative("B", advertiser="Rival"))
    assert r.status_code == 422 and "Same priority" in r.json()["error"]["details"][0]["errors"][0]["message"]
    assert api.assign(pid, api.creative("C", advertiser="Rival"), priority=8).status_code == 201  # a deliberate higher priority wins
    assert api.slot(app, "home.coffee_cup")["creative"]["campaign_id"] != camp["id"]


def test_direct_assign_keeps_and_validates_the_time_zone(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    cid = api.creative()
    # times already carry an offset, so the zone is only how people read them; it must still be a real zone
    bad = api.assign(pid, cid, start_time=at(hours=1).isoformat(), timezone="Mars/Olympus_Mons")
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_timezone"
    ok = api.assign(pid, cid, start_time=at(hours=1).isoformat(), timezone="Asia/Kolkata")
    assert ok.status_code == 201, ok.text
    campaign = client.get(f"/api/v1/admin/campaigns/{ok.json()['campaign_id']}", headers=admin).json()["campaign"]
    assert campaign["timezone"] == "Asia/Kolkata"


def test_preview_only_warns_about_rivals_that_can_still_serve(client, api, admin):
    from app import clock
    app = api.app()
    pid, cid = app["placements"]["home.coffee_cup"], api.creative()
    camp = new_campaign(client, admin, app, name="Flash sale", priority=10, end_time=at(hours=1).isoformat())
    assert add(client, admin, camp, pid, cid).status_code == 201
    preview = lambda **kw: client.post(f"/api/v1/admin/applications/{app['id']}/assignments/preview", headers=admin,  # noqa: E731
                                       json={"placement_ids": [pid], "creative_id": cid, **kw}).json()["results"][0]["warnings"]
    assert preview() == []  # a draft can't serve
    step(client, admin, camp, "submit"), step(client, admin, camp, "approve")
    assert "will keep showing instead" in preview()[0]["message"]  # live now and outranks a priority-5 direct assignment
    assert preview(start_time=at(hours=2).isoformat()) == []  # the new one starts after the flash sale ends
    clock.freeze(at(hours=1, minutes=1))
    assert preview() == []  # ended on its own: it can't keep anything from showing
