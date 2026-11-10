"use client";
import { Move, OctagonX } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isAdSlot } from "@/lib/format";
import { useLoad } from "@/lib/hooks";
import type { Application, Creative, Placement, WorkspaceCard } from "@/lib/types";
import AdEditor, { sameSpot, spotOf, type Spot } from "@/components/AdEditor";
import CreativePicker from "@/components/CreativePicker";
import { Badge, Button, Card, Empty, ErrorNote, Modal, OnTopFrame, PageHeader, RenderFrame, Spinner, useToast } from "@/components/ui";

const NOT_SHOWING: Record<string, string> = { pending: "Ad waiting for approval", rejected: "Ad rejected", expired: "Ad turned off", scheduled: "Ad starts later" };

/** The picture as the app shows it: with the ad on top for pictures found in the app, in the box for widget spots. */
const WithAd = ({ p, ad, label, empty }: { p: Placement; ad?: Creative | null; label?: string; empty: string }) => isAdSlot(p)
  ? <OnTopFrame picture={p.fallback_preview_url} ad={ad} placement={p} label={label} empty={empty} />
  : <RenderFrame src={ad?.url ?? p.fallback_preview_url} placement={p} label={label} empty={empty} />;

/** Saves where the ad sits, its size and corners, if they changed. Open apps redraw within seconds. */
const saveSpot = (p: Placement, spot: Spot) => (sameSpot(spot, spotOf(p.render)) ? Promise.resolve() : api.patch(`/placements/${p.id}`, { render: { ...p.render, ...spot } }));

function ChooseAd({ card, onClose, onDone }: { card: WorkspaceCard; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const p = card.placement;
  const [picked, setPicked] = useState<Creative | null>(null);
  const [spot, setSpot] = useState<Spot>(spotOf(p.render));
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setErr(null); setBusy(true);
    try {
      if (picked!.approval_status !== "approved" && can("admin")) await api.post(`/creatives/${picked!.id}/approve`); // choosing it is approving it
      if (isAdSlot(p)) await saveSpot(p, spot);
      await api.post(`/placements/${p.id}/assign`, { creative_id: picked!.id, start_time: null, end_time: null, priority: 5 });
      toast("Ad is on. Open apps show it within seconds."); onDone();
    } catch (e) { setErr(e); setBusy(false); }
  }
  return (
    <Modal title={`Put an ad on “${p.name}”`} wide onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!picked || busy} onClick={confirm}>{busy ? "Saving…" : "Show this ad"}</Button></>}>
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <CreativePicker placementId={isAdSlot(p) ? undefined : p.id} selected={picked?.id ?? null} onSelect={setPicked} />
        <div className="space-y-3">
          {picked && isAdSlot(p) ? <AdEditor p={p} ad={picked} spot={spot} onChange={setSpot} /> : <WithAd p={p} ad={picked} empty="Pick an ad" />}
          {err ? <ErrorNote error={err} /> : null}
        </div>
      </div>
    </Modal>
  );
}

function MoveAd({ card, onClose, onDone }: { card: WorkspaceCard; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const p = card.placement;
  const [spot, setSpot] = useState<Spot>(spotOf(p.render));
  const [err, setErr] = useState<unknown>(null);
  async function save() {
    setErr(null);
    try { await saveSpot(p, spot); toast("Saved. Open apps redraw within seconds."); onDone(); } catch (e) { setErr(e); }
  }
  return (
    <Modal title={`Move or resize the ad on “${p.name}”`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={sameSpot(spot, spotOf(p.render))} onClick={save}>Save</Button></>}>
      <AdEditor p={p} ad={card.effective!.creative} spot={spot} onChange={setSpot} />
      {err ? <div className="mt-3"><ErrorNote error={err} /></div> : null}
    </Modal>
  );
}

export default function Workspace() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const ws = useLoad(() => api.get<{ application: Application; placements: WorkspaceCard[] }>(`/applications/${id}/workspace`), [id]);
  const [modal, setModal] = useState<{ kind: "choose" | "move"; card: WorkspaceCard } | null>(null);

  if (ws.loading && !ws.data) return <Spinner />;
  if (ws.error || !ws.data) return <ErrorNote error={ws.error} />;
  const { application: app } = ws.data;
  const cards = ws.data.placements.filter((c) => c.placement.is_active);
  const done = () => { setModal(null); ws.reload(); };

  async function stopAd(card: WorkspaceCard) {
    try { await api.post(`/placements/${card.placement.id}/restore-fallback`); toast("Ad stopped: the app shows its own picture again"); ws.reload(); } catch (e) { toast((e as Error).message, "err"); }
  }
  async function setAds(enabled: boolean) {
    try { await api.put(`/applications/${app.id}/integration`, { enabled }); toast(enabled ? "Ads are back on" : "All ads stopped. Open apps drop them within seconds."); ws.reload(); }
    catch (e) { toast((e as Error).message, "err"); }
  }
  return (
    <>
      <div className="mb-2 text-sm text-muted"><Link href="/applications" className="hover:underline">Apps</Link> / <Link href={`/applications/${app.id}`} className="hover:underline">{app.name}</Link> / Ads on pictures</div>
      <PageHeader title="Put ads on pictures" subtitle="The ad is drawn on top of the picture. Changes reach open apps within seconds."
        actions={can("admin") && (app.ads_enabled ? <Button variant="danger" onClick={() => setAds(false)}><OctagonX size={15} />Stop all ads</Button>
          : <Button variant="primary" onClick={() => setAds(true)}>Turn ads back on</Button>)} />
      {!app.ads_enabled && <div className="mb-4 rounded-lg bg-bad-soft px-4 py-2.5 text-sm text-bad"><b>All ads are stopped in {app.name}.</b> Your choices below are kept for when you turn ads back on.</div>}
      {!cards.length ? <Empty title="No pictures chosen yet"><Link href={`/applications/${app.id}`} className="text-brand underline">Choose pictures</Link> in the app first.</Empty> : (
        <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {cards.map((c) => {
            const p = c.placement;
            const live = c.effective;
            const waiting = !live && c.assignments.length > 0;
            return (
              <Card key={p.id} className="flex flex-col p-4">
                <div className="mb-3 flex items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate font-semibold">{p.name}</h3>
                  {live && !app.ads_enabled ? <Badge status="paused" label="Stopped" /> : live ? <Badge status="active" label="Ad showing" />
                    : waiting ? <Badge status="pending" label={NOT_SHOWING[c.status] ?? "Ad not showing"} /> : <Badge status="fallback" label="No ad" />}
                </div>
                <WithAd p={p} ad={live?.creative} empty="The app's picture" />
                {live && <div className="mt-2 truncate text-sm">Ad: <b>{live.creative.name}</b></div>}
                {can("admin") && <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
                  <Button size="sm" variant="primary" onClick={() => setModal({ kind: "choose", card: c })}>{live ? "Change ad" : "Put an ad on it"}</Button>
                  {live && isAdSlot(p) && <Button size="sm" onClick={() => setModal({ kind: "move", card: c })}><Move size={13} />Move or resize</Button>}
                  {(live || waiting) && <Button size="sm" variant="danger" onClick={() => stopAd(c)}>Stop ad</Button>}
                </div>}
              </Card>
            );
          })}
        </div>)}
      {modal?.kind === "choose" && <ChooseAd card={modal.card} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "move" && <MoveAd card={modal.card} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}
