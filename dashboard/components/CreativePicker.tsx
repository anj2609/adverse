"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import type { Creative, Page } from "@/lib/types";
import { Input, Spinner, cx } from "./ui";

/** Pick one of your ads. Given a widget spot (placementId), ads that don't fit its box can't be picked; pictures take any ad. */
export default function CreativePicker({ placementId, selected, onSelect }: { placementId?: string; selected: string | null; onSelect: (c: Creative) => void }) {
  const [q, setQ] = useState("");
  const all = useLoad(() => api.get<Page<Creative>>("/creatives", { page_size: 100, latest_only: true }));
  const fits = useLoad(() => (placementId ? api.get<Page<Creative>>("/creatives", { compatible_with: placementId, page_size: 100, latest_only: true }) : Promise.resolve(null)), [placementId]);
  const fitIds = useMemo(() => new Set(fits.data?.items.map((c) => c.id) ?? []), [fits.data]);
  const ads = (all.data?.items ?? []).filter((c) => c.is_active && c.approval_status !== "rejected");
  const rows = ads.filter((c) => !q || `${c.name} ${c.advertiser}`.toLowerCase().includes(q.toLowerCase()));
  if (all.loading || fits.loading) return <Spinner />;
  if (!ads.length) return <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">You have no ads yet. <Link href="/creatives" className="text-brand underline">Upload one in Ads</Link>.</p>;
  return (
    <div>
      {ads.length > 9 && <Input placeholder="Search your ads" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" aria-label="Search your ads" />}
      <div className="grid max-h-[50vh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
        {rows.map((c) => {
          const fit = !placementId || fitIds.has(c.id);
          return (
            <button key={c.id} onClick={() => onSelect(c)} disabled={!fit} aria-pressed={selected === c.id} title={fit ? c.name : "Doesn't fit this spot"}
              className={cx("rounded-xl border-2 p-2 text-left transition", selected === c.id ? "border-brand bg-brand-soft" : "border-line hover:border-muted", !fit && "cursor-not-allowed opacity-40")}>
              <div className="checker h-24 overflow-hidden rounded-lg"><img src={c.thumbnail_url} alt="" className="h-full w-full object-contain" /></div>
              <div className="mt-2 truncate text-sm font-medium">{c.name}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
