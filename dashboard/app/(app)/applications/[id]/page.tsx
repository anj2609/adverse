"use client";
import { ArrowRight, OctagonX, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/hooks";
import type { Application } from "@/lib/types";
import { Button, ErrorNote, Field, Input, Modal, PageHeader, Spinner, useToast } from "@/components/ui";
import ScanPanel from "@/components/ScanPanel";

/** Deleting an app: say plainly what goes and what stays, and make the admin type the app's ID first. */
function DeleteApp({ app, onClose }: { app: Application; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setErr(null); setBusy(true);
    try {
      await api.del(`/applications/${app.id}?confirm=${encodeURIComponent(typed)}`);
      toast(`${app.name} deleted`); router.push("/applications");
    } catch (e) { setErr(e); setBusy(false); }
  }
  return (
    <Modal title={`Delete ${app.name}?`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={typed !== app.app_key || busy} onClick={remove}><Trash2 size={15} />{busy ? "Deleting…" : "Delete app"}</Button></>}>
      <div className="space-y-3 text-sm">
        <p>This removes <b>{app.name}</b> from AdForge for good:</p>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>the pictures you chose and the ads put on them</li>
          <li>copies of the app already installed stop showing ads at their next check (about a second if they're open)</li>
        </ul>
        <p className="text-muted">Your ads stay in <b>Ads</b>. You can add the app again later.</p>
        <Field label={`Type ${app.app_key} to confirm`}><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder={app.app_key} aria-label="App ID to confirm" /></Field>
        {err ? <ErrorNote error={err} /> : null}
      </div>
    </Modal>
  );
}

export default function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const app = useLoad(() => api.get<Application>(`/applications/${id}`), [id]);
  const [deleting, setDeleting] = useState(false);

  if (app.loading && !app.data) return <Spinner />; // first load only: a refresh keeps the page (and what it remembers)
  if (app.error || !app.data) return <ErrorNote error={app.error} />;
  const a = app.data;
  async function setAds(enabled: boolean) {
    try { await api.put(`/applications/${id}/integration`, { enabled }); toast(enabled ? "Ads are back on" : "All ads stopped. Open apps drop them within seconds."); app.reload(); }
    catch (e) { toast((e as Error).message, "err"); }
  }
  return (
    <>
      <div className="mb-2 text-sm text-muted"><Link href="/applications" className="hover:underline">Apps</Link> / {a.name}</div>
      <PageHeader title={a.name}
        actions={<>
          {can("admin") && (a.ads_enabled ? <Button variant="danger" onClick={() => setAds(false)}><OctagonX size={15} />Stop all ads</Button>
            : <Button variant="primary" onClick={() => setAds(true)}>Turn ads back on</Button>)}
          <Link href={`/applications/${a.id}/workspace`}><Button variant="primary">Put ads on pictures<ArrowRight size={16} /></Button></Link></>} />
      {!a.ads_enabled && <div className="mb-4 rounded-lg bg-bad-soft px-4 py-2.5 text-sm text-bad"><b>All ads are stopped.</b> The app shows its own pictures only. Your ads are kept for when you turn them back on.</div>}
      <ScanPanel app={a} onSlots={() => app.reload()} />
      {can("admin") && <div className="mt-10 text-right">
        <Button size="sm" variant="ghost" className="text-bad" onClick={() => setDeleting(true)}><Trash2 size={14} />Delete this app</Button></div>}
      {deleting && <DeleteApp app={a} onClose={() => setDeleting(false)} />}
    </>
  );
}
