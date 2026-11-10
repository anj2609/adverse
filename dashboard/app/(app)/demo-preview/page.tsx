"use client";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { API_URL, api } from "@/lib/api";
import { ago, fmtDate } from "@/lib/format";
import { useLoad } from "@/lib/hooks";
import type { Application, Page } from "@/lib/types";
import { Badge, Button, Card, ErrorNote, PageHeader, Select, Spinner } from "@/components/ui";

export default function RuntimeTest() {
  const apps = useLoad(() => api.get<Page<Application>>("/applications", { page_size: 100 }));
  const [sel, setSel] = useState("");
  const id = sel || apps.data?.items[0]?.id || "";
  const rt = useLoad(() => (id ? api.get<any>(`/applications/${id}/runtime-preview`) : Promise.resolve(null)), [id]);
  if (apps.loading) return <Spinner />;
  const app = apps.data?.items.find((a) => a.id === id);
  const cfg = rt.data?.config;
  return (
    <>
      <PageHeader title="Runtime test" subtitle="See exactly what the app would be told right now, and whether a real app has fetched it."
        actions={<><Select value={id} onChange={(e) => setSel(e.target.value)} aria-label="Application" className="w-56">{apps.data?.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select><Button onClick={() => { apps.reload(); rt.reload(); }}><RefreshCw size={15} />Refresh</Button></>} />
      {rt.error ? <ErrorNote error={rt.error} /> : !cfg ? <Spinner /> : (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5">
            <Card className="p-5"><h2 className="mb-3 font-semibold">Proof the app received it</h2>
              <p className="mb-3 text-sm text-muted">A preview can't prove an app got an update. These come from the app's own requests to the runtime API.</p>
              <dl className="space-y-2 text-sm"><div className="flex justify-between"><dt className="text-muted">Current config</dt><dd className="font-semibold">v{cfg.config_version}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">Version the app last fetched</dt><dd className="font-semibold">{rt.data.last_seen_version ? `v${rt.data.last_seen_version}` : "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">Last fetched</dt><dd>{ago(rt.data.last_seen_at)}</dd></div></dl>
              <div className="mt-3">{!rt.data.last_seen_at ? <Badge status="awaiting_connection" /> : rt.data.app_is_up_to_date ? <Badge status="connected" label="App is up to date" /> : <Badge status="pending" label="App has an older version: refresh it" />}</div>
            </Card>
            <Card className="p-5"><h2 className="mb-2 font-semibold">Try it for real</h2>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted"><li>Run the Flutter demo app (see the README).</li><li>In the <b>workspace</b>, assign an approved creative to a placement.</li><li>In the app, pull to refresh or press <b>Refresh</b> in Diagnostics.</li><li>Come back here: “Version the app last fetched” should match the current config.</li></ol></Card>
            <Card className="p-5"><h2 className="mb-2 font-semibold">Ask the API directly</h2>
              <pre className="overflow-x-auto rounded-lg bg-subtle p-3 text-xs">{`curl ${API_URL}/api/v1/runtime/${app?.app_key}/config${app?.runtime_key_required ? ' \\\n  -H "X-AdForge-Key: <runtime key>"' : ""}`}</pre></Card>
          </div>
          <div className="space-y-3 lg:col-span-2">
            {cfg.ads_enabled === false && <div className="rounded-lg bg-bad-soft px-4 py-2.5 text-sm text-bad"><b>Ads are stopped for this app.</b> It is told to show its own pictures everywhere.</div>}
            <div className="text-sm text-muted">Generated {fmtDate(cfg.server_time)} · schema v{cfg.schema_version} · refresh hint {cfg.ttl_seconds}s{cfg.next_change_at ? ` · next scheduled change ${fmtDate(cfg.next_change_at)}` : ""}</div>
            {cfg.placements.map((p: any) => (
              <Card key={p.placement_id} className="flex items-center gap-4 p-4">
                <div className="checker grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded-lg border border-line">{p.creative ? <img src={p.creative.thumbnail_url} alt="" className="h-full w-full object-contain" /> : <span className="px-1 text-center text-[10px] text-muted">original</span>}</div>
                <div className="min-w-0 flex-1"><div className="font-mono text-sm font-medium">{p.placement_id}</div>
                  {p.asset_path && <div className="font-mono text-xs text-muted">replaces {p.asset_path}{p.creative?.renditions ? ` · fitted at ${p.creative.renditions.map((r: any) => `${r.width}×${r.height}`).join(", ")}` : ""}</div>}
                  {p.creative ? <div className="text-xs text-muted">{p.creative.advertiser} · {p.creative.width}×{p.creative.height} · campaign {p.creative.campaign_status}{p.creative.valid_until ? ` until ${fmtDate(p.creative.valid_until)}` : ""}</div> : <div className="text-xs text-muted">App shows its own asset <span className="font-mono">{p.fallback?.ref ?? ""}</span></div>}</div>
                <Badge status={p.creative ? "active" : "fallback"} label={p.creative ? "Branded creative" : "Fallback"} />
              </Card>))}
            <details className="rounded-xl border border-line bg-surface p-4"><summary className="cursor-pointer text-sm font-medium">Raw runtime response</summary><pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-subtle p-3 text-xs">{JSON.stringify(cfg, null, 2)}</pre></details>
          </div>
        </div>)}
    </>
  );
}
