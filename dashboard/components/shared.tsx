"use client";
import type { Audit } from "@/lib/types";
import { ago } from "@/lib/format";
import { Badge } from "./ui";

export const ACTION_LABEL: Record<string, string> = {
  "application.create": "Registered an application", "application.update": "Edited an application", "application.key_rotated": "Rotated a runtime key",
  "application.integration_enabled": "Enabled integration", "application.integration_disabled": "Disabled integration",
  "application.ads_stopped": "Stopped all ads in the app", "application.ads_resumed": "Resumed ads in the app", "application.scan": "Scanned the app's project", "application.delete": "Deleted an application", "application.ready_zip": "Downloaded the app ready for ads",
  "placement.create": "Registered a placement", "placement.update": "Changed a placement", "placement.activate": "Activated a placement", "placement.deactivate": "Deactivated a placement",
  "placement.fallback_preview": "Set the fallback preview", "placement.restore_fallback": "Restored the fallback asset",
  "creative.upload": "Uploaded a creative", "creative.new_version": "Uploaded a new version", "creative.approve": "Approved a creative", "creative.reject": "Rejected a creative",
  "creative.deactivate": "Deactivated a creative", "creative.activate": "Reactivated a creative", "creative.update": "Edited a creative",
  "campaign.create": "Created a campaign", "campaign.update": "Edited a campaign", "campaign.submit": "Submitted for approval", "campaign.approve": "Approved a campaign",
  "campaign.reject": "Rejected a campaign", "campaign.pause": "Paused a campaign", "campaign.resume": "Resumed a campaign", "campaign.expire": "Ended a campaign",
  "campaign.active": "Campaign went live (by schedule)", "campaign.expired": "Campaign ended (by schedule)", "campaign.scheduled": "Campaign scheduled", "campaign.paused": "Campaign paused",
  "assignment.create": "Assigned a creative", "assignment.replace": "Replaced a creative", "assignment.remove": "Removed an assignment", "assignment.rollback": "Rolled back an assignment",
  "assignment.replaced": "Superseded by a newer assignment", "assignment.rolled_back": "Assignment rolled back",
  "bulk.assign": "Bulk assignment", "bulk.rollback": "Rolled back a bulk assignment", "user.login": "Signed in",
};

export function ActivityList({ rows, empty = "Nothing yet." }: { rows: Audit[]; empty?: string }) {
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id} className="flex items-start gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm">{ACTION_LABEL[r.action] ?? r.action}{r.outcome === "failure" && <span className="ml-2 align-middle"><Badge status="failure" label="Failed" /></span>}</div>
            <div className="truncate text-xs text-muted">{r.actor_email}{r.detail?.placement_key ? ` · ${r.detail.placement_key}` : ""}{r.detail?.name ? ` · ${r.detail.name}` : ""}{r.detail?.creative ? ` · ${r.detail.creative}` : ""}</div>
          </div>
          <span className="whitespace-nowrap text-xs text-muted">{ago(r.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}
