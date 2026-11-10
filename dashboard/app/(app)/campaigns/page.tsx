"use client";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { browserTz, fromLocalInput, window as win } from "@/lib/format";
import { useLoad } from "@/lib/hooks";
import type { Application, Campaign, Page } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, useToast } from "@/components/ui";

const CAMPAIGN_STATUSES = ["draft", "pending_approval", "approved", "scheduled", "active", "paused", "expired", "rejected"];

function CampaignList() {
  const { can } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get("status") ?? ""); const [appId, setAppId] = useState(""); const [q, setQ] = useState("");
  const list = useLoad(() => api.get<Page<Campaign>>("/campaigns", { status, application_id: appId, q, page_size: 100 }), [status, appId, q]);
  const apps = useLoad(() => api.get<Page<Application>>("/applications", { page_size: 100 }));
  const [open, setOpen] = useState(false); const [err, setErr] = useState<unknown>(null);
  const [f, setF] = useState({ application_id: "", name: "", advertiser: "", description: "", start: "", end: "", priority: 5 });
  const appName = (id: string) => apps.data?.items.find((a) => a.id === id)?.name ?? "";
  async function create() {
    setErr(null);
    try {
      const c = await api.post<Campaign>("/campaigns", { application_id: f.application_id || apps.data?.items[0]?.id, name: f.name, advertiser: f.advertiser, description: f.description || null,
        start_time: fromLocalInput(f.start), end_time: fromLocalInput(f.end), timezone: browserTz(), priority: f.priority });
      toast("Campaign created. Add assignments next."); router.push(`/campaigns/${c.id}`);
    } catch (e) { setErr(e); }
  }
  return (
    <>
      <PageHeader title="Campaigns" subtitle="Which creatives may appear, where, and when." actions={can("editor") && <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} />New campaign</Button>} />
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Input placeholder="Search campaigns" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <Select value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="Application"><option value="">All applications</option>{apps.data?.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option>{CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</Select>
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorNote error={list.error} /> : !list.data?.items.length ? <Empty title="No campaigns">Create one to schedule creatives in an app.</Empty> : (
        <Card className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="px-4 py-3">Campaign</th><th className="px-4 py-3">Application</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Runs</th><th className="px-4 py-3 text-right">Placements</th><th className="px-4 py-3 text-right">Priority</th></tr></thead>
          <tbody>{list.data.items.map((c) => (
            <tr key={c.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-subtle" onClick={() => router.push(`/campaigns/${c.id}`)}>
              <td className="px-4 py-3"><Link href={`/campaigns/${c.id}`} className="font-medium">{c.name}</Link><div className="text-xs text-muted">{c.advertiser}{c.is_direct ? " · direct assignment" : ""}</div></td>
              <td className="px-4 py-3">{appName(c.application_id)}</td><td className="px-4 py-3"><Badge status={c.effective_status} /></td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{win(c.start_time, c.end_time)}</td><td className="px-4 py-3 text-right tabular-nums">{c.assignment_count}</td><td className="px-4 py-3 text-right tabular-nums">{c.priority}</td></tr>))}</tbody></table></Card>)}
      {open && (
        <Modal title="New campaign" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create}>Create draft</Button></>}>
          <div className="space-y-4">
            <Field label="Application"><Select value={f.application_id || apps.data?.items[0]?.id || ""} onChange={(e) => setF({ ...f, application_id: e.target.value })}>{apps.data?.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            <div className="grid grid-cols-2 gap-3"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field><Field label="Advertiser"><Input value={f.advertiser} onChange={(e) => setF({ ...f, advertiser: e.target.value })} /></Field></div>
            <div className="grid grid-cols-2 gap-3"><Field label="Start" hint="Empty = as soon as approved"><Input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field><Field label="End" hint="Empty = until paused or ended"><Input type="datetime-local" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field></div>
            <p className="text-xs text-muted">Times are in your time zone ({browserTz()}).</p>
            <Field label="Priority (1–100)" hint="Higher wins when campaigns want the same placement."><Input type="number" min={1} max={100} value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) || 5 })} /></Field>
            <Field label="Description (optional)"><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            {err ? <ErrorNote error={err} /> : null}
          </div>
        </Modal>)}
    </>
  );
}
export default function CampaignsPage() { return <Suspense fallback={<Spinner />}><CampaignList /></Suspense>; }
