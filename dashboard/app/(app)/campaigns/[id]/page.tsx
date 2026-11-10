"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDate, fromLocalInput, toLocalInput, window as win } from "@/lib/format";
import { useLoad } from "@/lib/hooks";
import type { Audit, Campaign, Creative, Page, Placement } from "@/lib/types";
import CreativePicker from "@/components/CreativePicker";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, RenderFrame, Select, Spinner, Textarea, useToast } from "@/components/ui";
import { ActivityList } from "@/components/shared";

const STATE: Record<string, string> = {
  eligible: "Showing now", overridden: "Outranked", campaign_scheduled: "Scheduled", campaign_pending_approval: "Awaiting approval", campaign_draft: "Draft", campaign_paused: "Paused",
  campaign_expired: "Ended", campaign_rejected: "Rejected", creative_pending: "Creative awaiting approval", creative_rejected: "Creative rejected", creative_inactive: "Creative off", incompatible: "No longer fits",
};

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const data = useLoad(() => api.get<{ campaign: Campaign; assignments: any[] }>(`/campaigns/${id}`), [id]);
  const placements = useLoad(async () => { const c = await api.get<any>(`/campaigns/${id}`); return api.get<Placement[]>(`/applications/${c.campaign.application_id}/placements`); }, [id]);
  const audit = useLoad(() => api.get<Page<Audit>>("/audit", { campaign_id: id, page_size: 20 }), [id]);
  const [modal, setModal] = useState<"edit" | "reject" | "add" | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [reason, setReason] = useState("");
  const [pl, setPl] = useState(""); const [cr, setCr] = useState<Creative | null>(null);
  const [edit, setEdit] = useState({ name: "", start: "", end: "", priority: 5 });

  if (data.loading && !data.data) return <Spinner />;
  if (data.error || !data.data) return <ErrorNote error={data.error} />;
  const { campaign: c, assignments } = data.data;
  const all = () => { data.reload(); audit.reload(); };
  const run = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); setModal(null); all(); } catch (e: any) {
    const d = e.details?.length ? ` ${JSON.stringify(e.details[0].campaign_name ?? e.details[0].creative ?? e.details[0].errors?.[0]?.message ?? "")}` : "";
    toast(e.message + (d.length > 3 ? ` (${d.replace(/"/g, "")})` : ""), "err"); setErr(e); } };
  const step = (action: string, ok: string, body?: unknown) => run(() => api.post(`/campaigns/${id}/${action}`, body), ok);
  const status = c.effective_status;
  const editable = status !== "expired";
  const openEdit = () => { setEdit({ name: c.name, start: toLocalInput(c.start_time), end: toLocalInput(c.end_time), priority: c.priority }); setErr(null); setModal("edit"); };
  const pickable = placements.data?.filter((p) => p.is_active && !assignments.some((a) => a.placement.id === p.id)) ?? [];
  const target = placements.data?.find((p) => p.id === (pl || pickable[0]?.id));

  return (
    <>
      <div className="mb-2 text-sm text-muted"><Link href="/campaigns" className="hover:underline">Campaigns</Link> / {c.name}</div>
      <PageHeader title={c.name} subtitle={<>{c.advertiser} · <Link className="text-brand" href={`/applications/${c.application_id}/workspace`}>open workspace</Link></>}
        actions={<><Badge status={status} className="text-sm" />
          {can("editor") && ["draft", "rejected"].includes(status) && <Button variant="primary" onClick={() => step("submit", "Submitted for approval")}>Submit for approval</Button>}
          {can("admin") && status === "pending_approval" && <><Button variant="primary" onClick={() => step("approve", "Campaign approved")}>Approve</Button><Button variant="danger" onClick={() => { setReason(""); setErr(null); setModal("reject"); }}>Reject</Button></>}
          {can("admin") && c.status === "approved" && status !== "expired" && <Button onClick={() => step("pause", "Campaign paused")}>Pause</Button>}
          {can("admin") && c.status === "paused" && status !== "expired" && <Button variant="primary" onClick={() => step("resume", "Campaign resumed")}>Resume</Button>}
          {can("admin") && editable && c.status !== "draft" && <Button variant="danger" onClick={() => step("expire", "Campaign ended")}>End now</Button>}
          {can("editor") && editable && <Button onClick={openEdit}>Edit schedule</Button>}</>} />
      {status === "scheduled" && <div className="mb-4 rounded-lg bg-info-soft px-4 py-2.5 text-sm text-info">Approved and scheduled. It goes live on {fmtDate(c.start_time)} without anyone needing to do anything.</div>}
      {status === "pending_approval" && <div className="mb-4 rounded-lg bg-warn-soft px-4 py-2.5 text-sm text-warn">Waiting for an administrator to approve it. Nothing is shown in the app until then.</div>}
      {status === "rejected" && <div className="mb-4 rounded-lg bg-bad-soft px-4 py-2.5 text-sm text-bad">Rejected. Fix the issues and submit it again.</div>}
      {err && !modal ? <div className="mb-4"><ErrorNote error={err} /></div> : null}
      <div className="grid gap-4 md:grid-cols-4">
        {[["Runs", win(c.start_time, c.end_time)], ["Time zone", c.timezone], ["Priority", String(c.priority)], ["Created", `${fmtDate(c.created_at)} by ${c.created_by ?? "—"}`]].map(([k, v]) => <Card key={k} className="p-4"><div className="text-xs uppercase tracking-wide text-muted">{k}</div><div className="mt-1 text-sm font-medium">{v}</div></Card>)}
      </div>
      <div className="mb-3 mt-8 flex items-center"><h2 className="text-lg font-semibold">Creative assignments <span className="text-muted">({assignments.length})</span></h2>
        {can("editor") && editable && c.status !== "rejected" && <Button size="sm" variant="primary" className="ml-auto" disabled={!pickable.length} onClick={() => { setPl(""); setCr(null); setErr(null); setModal("add"); }}>Add assignment</Button>}</div>
      {!assignments.length ? <Empty title="No assignments yet">Choose which placements this campaign replaces, and with what.</Empty> : (
        <Card className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="px-4 py-3">Placement</th><th className="px-4 py-3">Creative</th><th className="px-4 py-3">State</th><th /></tr></thead>
          <tbody>{assignments.map((a) => (
            <tr key={a.id} className="border-b border-line last:border-0"><td className="px-4 py-3"><div className="font-medium">{a.placement.name}</div><div className="font-mono text-xs text-muted">{a.placement.placement_key}</div></td>
              <td className="px-4 py-3"><div className="flex items-center gap-3"><div className="checker h-12 w-12 overflow-hidden rounded-lg border border-line"><img src={a.creative.thumbnail_url} alt="" className="h-full w-full object-contain" /></div><div><div>{a.creative.name}</div><Badge status={a.creative.approval_status} /></div></div></td>
              <td className="px-4 py-3"><Badge status={a.state === "eligible" ? "active" : a.state?.includes("rejected") ? "rejected" : a.state === "overridden" ? "overridden" : "pending"} label={STATE[a.state] ?? a.state} /></td>
              <td className="px-4 py-3 text-right">{can("editor") && editable && <Button size="sm" variant="danger" onClick={() => run(() => api.del(`/assignments/${a.id}`), "Assignment removed")}>Remove</Button>}</td></tr>))}</tbody></table></Card>)}
      <h2 className="mb-3 mt-8 text-lg font-semibold">Activity</h2><Card className="p-5"><ActivityList rows={audit.data?.items ?? []} /></Card>

      {modal === "edit" && <Modal title="Edit schedule" onClose={() => setModal(null)} footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="primary" onClick={() => run(() => api.patch(`/campaigns/${id}`, { name: edit.name, priority: edit.priority, start_time: fromLocalInput(edit.start), end_time: fromLocalInput(edit.end) }), "Saved")}>Save</Button></>}>
        <div className="space-y-4"><Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Start"><Input type="datetime-local" value={edit.start} onChange={(e) => setEdit({ ...edit, start: e.target.value })} /></Field><Field label="End"><Input type="datetime-local" value={edit.end} onChange={(e) => setEdit({ ...edit, end: e.target.value })} /></Field></div>
          <Field label="Priority"><Input type="number" min={1} max={100} value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: Number(e.target.value) || 5 })} /></Field>
          {err ? <ErrorNote error={err} /> : null}</div></Modal>}
      {modal === "reject" && <Modal title="Reject campaign" onClose={() => setModal(null)} footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="danger" disabled={reason.length < 3} onClick={() => step("reject", "Campaign rejected", { reason })}>Reject</Button></>}>
        <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>{err ? <div className="mt-3"><ErrorNote error={err} /></div> : null}</Modal>}
      {modal === "add" && target && <Modal title="Add assignment" wide onClose={() => setModal(null)} footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="primary" disabled={!cr} onClick={() => run(() => api.post(`/campaigns/${id}/assignments`, { placement_id: target.id, creative_id: cr!.id }), "Assignment added")}>Add</Button></>}>
        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]"><div><Field label="Placement"><Select value={target.id} onChange={(e) => { setPl(e.target.value); setCr(null); }}>{pickable.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.placement_key})</option>)}</Select></Field>
          <div className="mt-4"><CreativePicker key={target.id} placementId={target.id} selected={cr?.id ?? null} onSelect={setCr} /></div></div>
          <div className="space-y-3"><div className="grid grid-cols-2 gap-3"><RenderFrame src={target.fallback_preview_url} placement={target} label="Original" empty="App's own asset" /><RenderFrame src={cr?.url} placement={target} label={cr ? "Proposed" : undefined} empty="Pick a creative" /></div>{err ? <ErrorNote error={err} /> : null}</div></div></Modal>}
    </>
  );
}
