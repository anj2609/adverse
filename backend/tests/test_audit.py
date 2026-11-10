from test_campaigns import add, new_campaign, step


def test_audit_covers_the_important_actions(client, api, admin):
    app = api.app()
    pid = app["placements"]["home.coffee_cup"]
    cid = api.creative("Cup")
    camp = new_campaign(client, admin, app)
    add(client, admin, camp, pid, cid); step(client, admin, camp, "submit"); step(client, admin, camp, "approve"); step(client, admin, camp, "pause")
    api.assign(pid, api.creative("Other", advertiser="X"), priority=9)
    client.post(f"/api/v1/admin/placements/{pid}/restore-fallback", headers=admin)
    actions = {r["action"] for r in client.get("/api/v1/admin/audit?page_size=100", headers=admin).json()["items"]}
    for want in ("application.create", "placement.create", "creative.upload", "creative.approve", "campaign.create", "assignment.create", "campaign.submit",
                 "campaign.approve", "campaign.pause", "bulk.assign", "placement.restore_fallback", "assignment.remove"):
        assert want in actions, want


def test_audit_entries_identify_actor_resource_time_and_outcome(client, api, admin):
    api.app()
    row = client.get("/api/v1/admin/audit?action=application.create", headers=admin).json()["items"][0]
    assert row["actor_email"] == "admin@test.dev" and row["resource_type"] == "application" and row["outcome"] == "success"
    assert row["created_at"].startswith("2030-01-01T12:00") and row["detail"]["app_key"] == "focusflow"


def test_audit_filters_and_pagination(client, api, admin):
    a = api.app("focusflow")
    b = api.app("cookwise", "CookWise", placements=[api.placement_spec("home.milk_carton")])
    page = client.get(f"/api/v1/admin/audit?application_id={a['id']}&page_size=1&page=2", headers=admin).json()
    assert len(page["items"]) == 1 and page["total"] == 2 and page["page"] == 2 and all(i["application_id"] == a["id"] for i in page["items"])
    only = client.get(f"/api/v1/admin/audit?placement_id={b['placements']['home.milk_carton']}", headers=admin).json()
    assert [i["action"] for i in only["items"]] == ["placement.create"]
    assert client.get("/api/v1/admin/audit?action=placement.*", headers=admin).json()["total"] == 2
    assert client.get("/api/v1/admin/audit?actor=nobody", headers=admin).json()["total"] == 0


def test_overview_counts(client, api, admin):
    app = api.app()
    api.creative("Approved")
    api.creative("Pending", approve=False)
    api.assign(app["placements"]["home.coffee_cup"], api.creative("Live"))
    o = client.get("/api/v1/admin/overview", headers=admin).json()
    assert o["applications"] == 1 and o["active_campaigns"] == 1 and o["pending_creative_approvals"] == 1 and o["available_creatives"] == 2
    assert o["recent_assignment_changes"] and o["recent_activity"]
