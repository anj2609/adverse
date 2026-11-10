"use client";
import { useRef, useState } from "react";
import { adArea, adRect, safeArea } from "@/lib/format";
import type { Creative, Placement, Render } from "@/lib/types";
import { adStyle } from "./ui";

export type Spot = Pick<Render, "ad_position" | "ad_size" | "ad_x" | "ad_y" | "ad_radius" | "ad_area">;
export const spotOf = (r: Render | undefined): Spot =>
  ({ ad_position: r?.ad_position ?? "bottom_right", ad_size: r?.ad_size ?? 0.3, ad_x: r?.ad_x ?? 0.5, ad_y: r?.ad_y ?? 0.5, ad_radius: r?.ad_radius ?? 0, ad_area: r?.ad_area ?? "whole" });
export const sameSpot = (a: Spot, b: Spot) => (Object.keys(a) as (keyof Spot)[]).every((k) => a[k] === b[k]);

/** The app's picture with the ad on top: drag the ad (or use the arrow keys) to move it, and the sliders for its size and corners.
 *  Everything is kept as shares of the picture, so it lands in the same place on every screen. */
export default function AdEditor({ p, ad, spot, onChange }: { p: Placement; ad: Creative; spot: Spot; onChange: (s: Spot) => void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const w = size?.w || p.fallback?.width || 300, h = size?.h || p.fallback?.height || 200;
  const r = adRect(w, h, ad.width, ad.height, spot.ad_position, spot.ad_size, spot.ad_area, spot.ad_x, spot.ad_y);
  const area = adArea(w, h); // moved or resized here: placed anywhere on the whole picture, corners included
  // Photos the app trims to fit its box: shade the edges that may be cut off on some screens, so the choice is informed
  const trimmed = p.render?.ad_area === "safe" ? safeArea(w, h) : null;

  /** Puts the ad's centre at (cx, cy) in picture pixels, kept inside the picture. */
  const moveTo = (cx: number, cy: number) => {
    const hw = r.w / 2 / area.w, hh = r.h / 2 / area.h;
    const x = Math.min(Math.max(cx / area.w, hw), 1 - hw), y = Math.min(Math.max(cy / area.h, hh), 1 - hh);
    onChange({ ...spot, ad_area: "whole", ad_position: "custom", ad_size: +(r.w / area.w).toFixed(3), ad_x: +x.toFixed(4), ad_y: +y.toFixed(4) });
  };
  const inPicture = (e: React.PointerEvent) => {
    const b = box.current!.getBoundingClientRect();
    return { px: ((e.clientX - b.left) / b.width) * w, py: ((e.clientY - b.top) / b.height) * h };
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = (e.shiftKey ? 0.1 : 0.02) * area.w, d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
    if (d) { e.preventDefault(); moveTo(r.x + r.w / 2 + d[0], r.y + r.h / 2 + d[1]); }
  };
  const centre = () => ({ ad_area: "whole", ad_x: +((r.x + r.w / 2) / area.w).toFixed(4), ad_y: +((r.y + r.h / 2) / area.h).toFixed(4) });
  const width = r.w / area.w; // what the slider shows: how wide the ad really is, whichever way it was placed
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div>
      <div ref={box} className="checker relative select-none overflow-hidden rounded-lg border border-line" style={{ aspectRatio: `${w} / ${h}` }}>
        {p.fallback_preview_url ? <img src={p.fallback_preview_url} alt={p.name} draggable={false} className="absolute inset-0 h-full w-full" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          : <div className="grid h-full w-full place-items-center text-xs text-muted">The app's picture</div>}
        {trimmed && <div className="pointer-events-none absolute" style={{ left: `${(trimmed.x / w) * 100}%`, top: `${(trimmed.y / h) * 100}%`, width: `${(trimmed.w / w) * 100}%`, height: `${(trimmed.h / h) * 100}%`, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.28)" }} />}
        <img src={ad.url} alt={`${ad.name}: drag to move`} draggable={false} tabIndex={0} role="slider" aria-label="Ad position: drag, or use the arrow keys" aria-valuetext={`${pct(spot.ad_x ?? 0.5)} across, ${pct(spot.ad_y ?? 0.5)} down`}
          className="absolute cursor-move touch-none outline-none ring-brand ring-offset-1 hover:ring-2 focus-visible:ring-2" style={adStyle(r, w, h, spot.ad_radius)}
          onKeyDown={onKey}
          onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); const { px, py } = inPicture(e); grab.current = { dx: px - (r.x + r.w / 2), dy: py - (r.y + r.h / 2) }; }}
          onPointerMove={(e) => { if (!grab.current) return; const { px, py } = inPicture(e); moveTo(px - grab.current.dx, py - grab.current.dy); }}
          onPointerUp={() => { grab.current = null; }} onPointerCancel={() => { grab.current = null; }} />
      </div>
      <p className="mt-1.5 text-center text-xs text-muted">Drag the ad to move it{trimmed ? ". The app may trim the shaded edges on some screens." : ""}</p>
      <div className="mt-3 space-y-2.5 text-sm">
        <label className="flex items-center gap-3"><span className="w-28 shrink-0">Size</span>
          <input type="range" min={5} max={100} value={Math.round(width * 100)} className="flex-1 accent-[rgb(var(--brand))]"
            onChange={(e) => onChange({ ...spot, ...centre(), ad_position: "custom", ad_size: Number(e.target.value) / 100 })} aria-label="Ad size" />
          <span className="w-10 text-right tabular-nums text-muted">{pct(width)}</span></label>
        <label className="flex items-center gap-3"><span className="w-28 shrink-0">Rounded corners</span>
          <input type="range" min={0} max={50} value={Math.round((spot.ad_radius ?? 0) * 100)} className="flex-1 accent-[rgb(var(--brand))]"
            onChange={(e) => onChange({ ...spot, ad_radius: Number(e.target.value) / 100 })} aria-label="Rounded corners" />
          <span className="w-10 text-right tabular-nums text-muted">{spot.ad_radius ? pct((spot.ad_radius ?? 0) * 2) : "None"}</span></label>
      </div>
    </div>
  );
}
