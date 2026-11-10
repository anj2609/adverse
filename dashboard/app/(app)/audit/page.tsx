"use client";
import { Fragment, useState } from "react";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { useLoad } from "@/lib/hooks";
import type { Application, Audit, Page } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from "@/components/ui";
import { ACTION_LABEL } from "@/components/shared";

const GROUPS = [["", "All activity"], ["application.*", "Applications"], ["placement.*", "Placements"], ["creative.*", "Creatives"], ["campaign.*", "Campaigns"], ["assignment.*", "Assignments"], ["bulk.*", "Bulk operations"]];

export default function AuditPage() {
  const [action, setAction] = useState(""); const [outcome, setOutcome] = useState(""); const [actor, setActor] = useState(""); const [app, setApp] = useState(""); const [page, setPage] = useState(1);
  const apps = useLoad(() => api.get<Page<Application>>("/applications", { page_size: 100 }));
  const list = useLoad(() => api.get<Page<Audit>>("/audit", { action, outcome, actor, application_id: app, page, page_size: 25 }), [action, outcome, actor, app, page]);
  const [open, setOpen] = useState<number | null>(null);
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.page_size)) : 1;
  const reset = (fn: (v: string) => void) => (e: React.ChangeEvent<any>) => { fn(e.target.value); setPage(1); };
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every registration, upload, approval, assignment, schedule change and rollback." />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Select value={action} onChange={reset(setAction)} aria-label="Type of action">{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Select value={app} onChange={reset(setApp)} aria-label="Application"><option value="">All applications</option>{apps.data?.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <Select value={outcome} onChange={reset(setOutcome)} aria-label="Outcome"><option value="">Any outcome</option><option value="success">Succeeded</option><option value="failure">Failed</option></Select>
        <Input placeholder="Filter by person" value={actor} onChange={reset(setActor)} aria-label="Actor" />
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorNote error={list.error} /> : !list.data?.items.length ? <Empty title="No matching activity" /> : (
        <>
          <Card className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="px-4 py-3">When</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Who</th><th className="px-4 py-3">Resource</th><th className="px-4 py-3">Outcome</th></tr></thead>
            <tbody>{list.data.items.map((r) => (
              <Fragment key={r.id}>
                <tr className="cursor-pointer border-b border-line hover:bg-subtle" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{fmtDate(r.created_at)}</td><td className="px-4 py-3">{ACTION_LABEL[r.action] ?? r.action}<div className="font-mono text-xs text-muted">{r.action}</div></td>
                  <td className="px-4 py-3">{r.actor_email}</td><td className="px-4 py-3 text-xs"><span className="capitalize">{r.resource_type}</span>{r.detail?.placement_key ? ` · ${r.detail.placement_key}` : r.detail?.name ? ` · ${r.detail.name}` : ""}</td>
                  <td className="px-4 py-3"><Badge status={r.outcome} label={r.outcome === "success" ? "Succeeded" : "Failed"} /></td></tr>
                {open === r.id && <tr key={`${r.id}-d`} className="border-b border-line bg-subtle"><td colSpan={5} className="px-4 py-3"><pre className="overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify({ resource_id: r.resource_id, placement_id: r.placement_id, campaign_id: r.campaign_id, bulk_operation_id: r.bulk_operation_id, ...r.detail }, null, 2)}</pre></td></tr>}
              </Fragment>))}</tbody></table></Card>
          <div className="mt-5 flex items-center justify-center gap-3 text-sm"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>Page {page} of {pages} · {list.data.total} entries<Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
        </>)}
    </>
  );
}
