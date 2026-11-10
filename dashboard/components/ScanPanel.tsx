"use client";
import { Check, Download, FileArchive, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/hooks";
import type { Application, AssetScan, ScanAsset } from "@/lib/types";
import { Button, Card, ErrorNote, Spinner, cx, useToast } from "./ui";

const usable = (a: ScanAsset) => a.replaceable && !a.slot; // already chosen: shown as done (a new scan refreshes it by itself)
const label = (a: ScanAsset) => (a.remote ? a.name ?? a.file_name : a.path.split("/").pop()) ?? a.path;
const shown = (a: ScanAsset) => a.replaceable && a.used !== false; // pictures the app shows and that can take an ad

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2.5 font-semibold"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-soft text-xs text-brand">{n}</span>{title}</h2>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function Tile({ a, on, onToggle, onSwitch, editable }: { a: ScanAsset; on: boolean; onToggle: () => void; onSwitch: (active: boolean) => void; editable: boolean }) {
  const chosen = !!a.slot?.is_active;
  return (
    <label className={cx("flex items-center gap-3 rounded-xl border p-2.5 text-sm transition", chosen ? "border-ok/50 bg-ok-soft" : on ? "border-brand bg-brand-soft" : "border-line",
      usable(a) && editable && "cursor-pointer hover:border-muted", !a.replaceable && "opacity-60")}>
      {chosen ? <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok text-white"><Check size={13} /></span>
        : usable(a) ? <input type="checkbox" className="h-4 w-4 shrink-0" disabled={!editable} checked={on} onChange={onToggle} aria-label={`Use ${label(a)} for ads`} />
        : <span className="h-5 w-5 shrink-0" />}
      <div className="checker h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line">{a.thumbnail_url ? <img src={a.thumbnail_url} alt="" className={cx("h-full w-full", a.remote ? "object-cover" : "object-contain")} /> : null}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={a.path}>{label(a)}</div>
        {chosen ? <div className="text-xs text-ok">Ready for ads{editable && <> · <button type="button" className="underline" onClick={(e) => { e.preventDefault(); onSwitch(false); }}>remove</button></>}</div>
          : a.slot ? <div className="text-xs text-muted">Removed{editable && <> · <button type="button" className="text-brand underline" onClick={(e) => { e.preventDefault(); onSwitch(true); }}>use again</button></>}</div>
          : !a.replaceable ? <div className="truncate text-xs text-muted" title={a.reason ?? ""}>{a.reason ?? "Can't take ads"}</div>
          : a.used === false ? <div className="text-xs text-muted">Not shown in the app</div> : null}
      </div>
    </label>
  );
}

/** The whole job for one app: upload it, choose its pictures, and get the app ready to show ads. */
export default function ScanPanel({ app, onSlots }: { app: Application; onSlots: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can("editor");
  const scans = useLoad(() => api.get<AssetScan[]>(`/applications/${app.id}/scans`), [app.id]);
  const [scan, setScan] = useState<AssetScan | null>(null);
  const [busy, setBusy] = useState<"" | "scanning" | "creating" | "preparing">("");
  const [lastZip, setLastZip] = useState<File | null>(null); // kept in this page only, so step 3 needn't ask again
  const [readyFile, setReadyFile] = useState("");
  const readyInput = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<unknown>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [made, setMade] = useState<string[] | null>(null); // names just chosen, shown until the next choice
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { // open the latest scan, if there is one
    const latest = scans.data?.[0];
    if (latest && !scan) api.get<AssetScan>(`/scans/${latest.id}`).then(setScan).catch(setErr);
  }, [scans.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadScan = async () => { if (scan) setScan(await api.get<AssetScan>(`/scans/${scan.id}`)); onSlots(); };
  async function upload(file?: File | null) {
    if (!file) return;
    setErr(null); setBusy("scanning"); setLastZip(file); setReadyFile(""); setMade(null); setPicked(new Set());
    const form = new FormData(); form.append("file", file);
    try { const s = await api.upload<AssetScan>(`/applications/${app.id}/scans`, form); setScan(s); scans.reload(); toast(`Found ${s.summary.images + (s.summary.remote ?? 0)} pictures`); }
    catch (e) { setErr(e); } finally { setBusy(""); }
  }
  async function prepare(file?: File | null) {
    const zip = file ?? lastZip;
    if (!zip) return readyInput.current?.click(); // page was reloaded: ask for the zip again
    setErr(null); setBusy("preparing"); setLastZip(zip);
    const form = new FormData(); form.append("file", zip);
    try {
      const r = await api.uploadForFile(`/applications/${app.id}/ready-zip`, form);
      const url = URL.createObjectURL(r.blob), link = document.createElement("a");
      link.href = url; link.download = r.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setReadyFile(r.name); toast(`Downloaded ${r.name}`);
    } catch (e) { setErr(e); } finally { setBusy(""); }
  }
  async function makeSlots() {
    if (!scan) return;
    setErr(null); setBusy("creating");
    try {
      const r = await api.post<{ created: number; results: { path: string; status: string }[] }>(`/scans/${scan.id}/slots`, { paths: Array.from(picked) });
      setMade(r.results.filter((x) => x.status === "created").map((x) => label(scan.assets.find((a) => a.path === x.path) ?? ({ path: x.path } as ScanAsset))));
      setPicked(new Set()); await reloadScan();
    } catch (e) { setErr(e); } finally { setBusy(""); }
  }
  async function switchSlot(a: ScanAsset, active: boolean) {
    try { await api.patch(`/placements/${a.slot!.placement_id}`, { is_active: active }); toast(active ? `${label(a)} is ready for ads again` : `${label(a)} removed: no ads on it`); await reloadScan(); }
    catch (e) { toast((e as Error).message, "err"); }
  }

  const [main, rest] = useMemo(() => {
    const all = [...(scan?.assets ?? [])].sort((a, b) => label(a).localeCompare(label(b)));
    return [all.filter(shown), all.filter((a) => !shown(a))];
  }, [scan]);
  const choosable = main.filter(usable);
  const chosen = scan?.assets.filter((a) => a.slot?.is_active).length ?? 0;
  const toggle = (p: string) => { setMade(null); setPicked((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; }); };
  const tile = (a: ScanAsset) => <Tile key={a.path} a={a} on={picked.has(a.path)} onToggle={() => toggle(a.path)} onSwitch={(v) => switchSlot(a, v)} editable={editable} />;

  return (
    <div className="space-y-4">
      {err ? <ErrorNote error={err} /> : null}
      <Step n={1} title="Upload the app">
        <p className="mb-3 text-sm text-muted">The app's project folder as a zip. AdForge finds every picture in it.</p>
        {editable && <>
          <input ref={input} type="file" hidden accept=".zip,application/zip" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
          <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]); }}
            onClick={() => busy || input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && input.current?.click()} aria-label="Upload the app's zip"
            className={cx("flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-4 py-3 text-sm", over ? "border-brand bg-brand-soft" : "border-line hover:border-muted")}>
            {busy === "scanning" ? <><FileArchive size={18} className="animate-pulse text-brand" />Looking for pictures…</>
              : <><Upload size={18} className="text-muted" /><span><b>{scan ? "Upload a newer version" : "Choose the zip"}</b> or drop it here</span>{scan && <span className="ml-auto truncate text-xs text-muted">Now: {scan.project_name ?? scan.file_name}</span>}</>}
          </div></>}
      </Step>

      {scans.loading && !scan ? <Spinner /> : scan && <>
        <Step n={2} title="Choose the pictures that get ads">
          {!main.length ? <p className="text-sm text-muted">No pictures in this app can take ads.</p> : <>
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">{main.map(tile)}</div>
            {editable && choosable.length > 0 && <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => { setMade(null); setPicked(new Set(choosable.map((a) => a.path))); }}>Select all</Button>
              {picked.size > 0 && <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>}
              <Button variant="primary" className="ml-auto" disabled={!picked.size || busy !== ""} onClick={makeSlots}><Check size={16} />
                {busy === "creating" ? "Saving…" : picked.size ? `Use ${picked.size} picture${picked.size === 1 ? "" : "s"} for ads` : "Tick pictures first"}</Button>
            </div>}
          </>}
          {made && made.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-ok-soft px-4 py-3 text-sm text-ok" role="status">
            <Check size={18} /><span className="flex-1"><b>Done:</b> {made.join(", ")} {made.length === 1 ? "is" : "are"} ready for ads.</span>
            <Link href={`/applications/${app.id}/workspace`}><Button size="sm" variant="primary">Put ads on pictures</Button></Link></div>}
          {rest.length > 0 && <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted">{rest.length} other picture{rest.length === 1 ? "" : "s"} (not shown in the app, or can't take ads)</summary>
            <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">{rest.map(tile)}</div>
          </details>}
        </Step>

        <Step n={3} title="Get the app ready (only once)">
          <p className="mb-3 text-sm text-muted">Download the app with AdForge added and give it to whoever builds the app. They build and publish it as usual. After that, ads are added and stopped from here, with no more app updates.</p>
          {editable && <div className="flex flex-wrap items-center gap-3">
            <input ref={readyInput} type="file" hidden accept=".zip,application/zip" onChange={(e) => { prepare(e.target.files?.[0]); e.target.value = ""; }} />
            <Button variant="primary" disabled={busy !== ""} onClick={() => prepare()}><Download size={16} />{busy === "preparing" ? "Preparing…" : "Download app ready for ads"}</Button>
            {readyFile ? <span className="text-sm text-ok"><Check size={14} className="inline" /> {readyFile} downloaded</span>
              : !lastZip && <span className="text-xs text-muted">You'll be asked for the app's zip again.</span>}
          </div>}
        </Step>
        {chosen > 0 && <p className="text-sm text-muted">{chosen} picture{chosen === 1 ? "" : "s"} ready for ads. Next: <Link href={`/applications/${app.id}/workspace`} className="font-medium text-brand underline">put ads on them</Link>.</p>}
      </>}
    </div>
  );
}
