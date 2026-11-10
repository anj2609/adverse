"use client";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { kb } from "@/lib/format";
import { useLoad } from "@/lib/hooks";
import type { Creative, Page } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, useToast } from "@/components/ui";

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = (x?: File | null) => { if (x) { setFile(x); if (!name) setName(x.name.replace(/\.[^.]+$/, "")); } };
  async function submit() {
    if (!file) return setErr(new Error("Choose a picture first"));
    setErr(null); setBusy(true);
    const form = new FormData();
    form.append("file", file); form.append("name", name); form.append("advertiser", name); form.append("asset_type", "product_image");
    try {
      const c = await api.upload<Creative>("/creatives", form);
      if (can("admin")) await api.post(`/creatives/${c.id}/approve`); // your own upload is ready to use
      toast("Ad uploaded"); onDone();
    } catch (e) { setErr(e); setBusy(false); }
  }
  return (
    <Modal title="Upload an ad" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!file || !name || busy} onClick={submit}>{busy ? "Uploading…" : "Upload"}</Button></>}>
      <div className="space-y-4">
        <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}
          onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center text-sm ${over ? "border-brand bg-brand-soft" : "border-line"}`}>
          <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => pick(e.target.files?.[0])} />
          {file ? <div className="flex items-center justify-center gap-3"><img src={URL.createObjectURL(file)} alt="" className="checker h-16 w-16 rounded-lg object-contain" /><div className="text-left"><div className="font-medium">{file.name}</div><div className="text-muted">{kb(file.size)}</div></div></div>
            : <><Upload className="mx-auto mb-2 text-muted" size={22} /><b>Drop a picture here</b> or click to choose<div className="text-xs text-muted">PNG, JPEG or WebP, up to 8 MB</div></>}
        </div>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Summer sale" /></Field>
        {err ? <ErrorNote error={err} /> : null}
      </div>
    </Modal>
  );
}

function Detail({ c, onClose, onChange }: { c: Creative; onClose: () => void; onChange: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const usage = useLoad(() => api.get<any[]>(`/creatives/${c.id}/usage`), [c.id]);
  const act = (path: string, msg: string) => async () => { try { await api.post(`/creatives/${c.id}/${path}`); toast(msg); onChange(); onClose(); } catch (e) { toast((e as Error).message, "err"); } };
  const where = (usage.data ?? []).filter((u) => u.assignment_status === "active");
  return (
    <Modal title={c.name} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      <div className="checker grid place-items-center overflow-hidden rounded-xl border border-line p-3"><img src={c.url} alt={c.name} className="max-h-[260px] max-w-full object-contain" /></div>
      <div className="mt-4 text-sm">
        <div className="font-medium">Showing on</div>
        {usage.loading ? <Spinner /> : !where.length ? <p className="text-muted">No pictures yet.</p>
          : <ul className="mt-1 list-disc pl-5 text-muted">{where.map((u) => <li key={u.assignment_id}>{u.placement_name ?? u.placement_key}</li>)}</ul>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {can("admin") && c.approval_status !== "approved" && <Button size="sm" variant="primary" onClick={act("approve", "Ad approved")}>Approve</Button>}
        {can("editor") && (c.is_active ? <Button size="sm" variant="danger" onClick={act("deactivate", "Ad stopped everywhere")}>Stop this ad everywhere</Button>
          : <Button size="sm" onClick={act("activate", "Ad can be used again")}>Use this ad again</Button>)}
      </div>
    </Modal>
  );
}

export default function Ads() {
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const list = useLoad(() => api.get<Page<Creative>>("/creatives", { page_size: 100, latest_only: true }));
  const [upload, setUpload] = useState(false); const [open, setOpen] = useState<Creative | null>(null);
  const items = (list.data?.items ?? []).filter((c) => c.approval_status !== "rejected" && (!q || c.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <PageHeader title="Ads" subtitle="Your ads. Put them on an app's pictures from the app's page." actions={can("editor") && <Button variant="primary" onClick={() => setUpload(true)}><Upload size={16} />Upload an ad</Button>} />
      {(list.data?.items.length ?? 0) > 12 && <Input placeholder="Search your ads" value={q} onChange={(e) => setQ(e.target.value)} className="mb-5 max-w-sm" aria-label="Search" />}
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorNote error={list.error} /> : !items.length ? <Empty title="No ads yet">Click Upload an ad to add one.</Empty> : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {items.map((c) => (
            <button key={c.id} onClick={() => setOpen(c)} className="text-left"><Card className="h-full overflow-hidden transition hover:-translate-y-0.5">
              <div className="checker h-36 border-b border-line"><img src={c.thumbnail_url} alt={c.name} className="h-full w-full object-contain p-2" /></div>
              <div className="flex items-center gap-2 p-3"><div className="min-w-0 flex-1 truncate font-medium">{c.name}</div>
                {!c.is_active ? <Badge status="inactive" label="Stopped" /> : c.approval_status !== "approved" ? <Badge status="pending" label="Needs approval" /> : null}</div>
            </Card></button>))}
        </div>)}
      {upload && <UploadModal onClose={() => setUpload(false)} onDone={() => { setUpload(false); list.reload(); }} />}
      {open && <Detail c={open} onClose={() => setOpen(null)} onChange={() => list.reload()} />}
    </>
  );
}
