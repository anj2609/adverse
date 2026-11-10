"use client";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/hooks";
import type { Application, Page } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner } from "@/components/ui";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

export default function Applications() {
  const { can } = useAuth();
  const router = useRouter();
  const { data, error, loading } = useLoad(() => api.get<Page<Application>>("/applications", { page_size: 100 }));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState(""); // filled from the name unless typed
  const [err, setErr] = useState<unknown>(null);
  const appKey = key || slug(name);

  async function create(e?: React.FormEvent) {
    e?.preventDefault(); setErr(null);
    try { const app = await api.post<Application>("/applications", { name, app_key: appKey }); router.push(`/applications/${app.id}`); }
    catch (x) { setErr(x); }
  }
  return (
    <>
      <PageHeader title="Apps" subtitle="Add an app, then put your ads on its pictures."
        actions={can("admin") && <Button variant="primary" onClick={() => { setName(""); setKey(""); setErr(null); setOpen(true); }}><Plus size={16} />Add app</Button>} />
      {loading ? <Spinner /> : error ? <ErrorNote error={error} /> : !data?.items.length ? <Empty title="No apps yet">Click Add app to start.</Empty> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((a) => (
            <Link key={a.id} href={`/applications/${a.id}`}>
              <Card className="h-full p-5 transition hover:-translate-y-0.5">
                <div className="flex items-start gap-2"><h2 className="text-lg font-semibold">{a.name}</h2>
                  <span className="ml-auto">{a.ads_enabled ? <Badge status="active" label="Ads on" /> : <Badge status="expired" label="Ads stopped" />}</span></div>
                <div className="mt-3 text-sm text-muted">{a.active_placement_count ? `${a.active_placement_count} picture${a.active_placement_count === 1 ? "" : "s"} ready for ads` : "No pictures chosen yet"}</div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      {open && (
        <Modal title="Add app" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name || !appKey} onClick={() => create()}>Add</Button></>}>
          <form onSubmit={create} className="space-y-4">
            <Field label="App name"><Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="FitFlow" /></Field>
            <Field label="App ID" hint="Made from the name. Lowercase letters, numbers and dashes."><Input value={appKey} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="fitflow" /></Field>
            {err ? <ErrorNote error={err} /> : null}
            <button className="hidden" />
          </form>
        </Modal>
      )}
    </>
  );
}
