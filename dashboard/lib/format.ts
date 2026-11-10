export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
export const ago = (iso?: string | null) => {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
export const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
export const window = (s?: string | null, e?: string | null) => (!s && !e ? "Always on" : `${s ? fmtDate(s) : "Now"} → ${e ? fmtDate(e) : "no end"}`);
export const toLocalInput = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
export const title = (s: string) => s.replace(/[_.]/g, " ").replace(/^./, (c) => c.toUpperCase());
export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const ASSET_TYPES = ["product_image", "illustration", "texture", "sprite", "background", "banner", "promotional_card", "sticker", "theme_artwork"];

/** Ad slots: where the ad sits on top of a picture. The same rule the app uses (lib/adforge/ad_overlay.dart). */
/** The part of a picture that stays visible however the app crops it (any box from 4:5 to 2:1). */
export function safeArea(w: number, h: number) {
  const sw = Math.min(w, h * 0.8), sh = Math.min(h, w / 2);
  return { x: (w - sw) / 2, y: (h - sh) / 2, w: sw, h: sh };
}
/** The box the ad is placed in: the whole picture, or its always-visible centre for photos the app crops. */
export const adArea = (w: number, h: number, area = "whole") => (area === "safe" && w > 0 && h > 0 ? safeArea(w, h) : { x: 0, y: 0, w, h });
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
export function adRect(w: number, h: number, aw: number, ah: number, position = "bottom_right", size = 0.3, area = "whole", cx = 0.5, cy = 0.5): { x: number; y: number; w: number; h: number } {
  if (area === "safe" && w > 0 && h > 0) {
    const s = safeArea(w, h), r = adRect(s.w, s.h, aw, ah, position, size, "whole", cx, cy);
    return { ...r, x: r.x + s.x, y: r.y + s.y };
  }
  if (w <= 0 || h <= 0 || aw <= 0 || ah <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const aspect = aw / ah, s = Math.min(Math.max(size, 0.05), 1);
  if (position === "custom") { // dragged: centred where it was dropped, kept inside the picture
    let bw = w * s, bh = bw / aspect;
    if (bh > h) { bh = h; bw = bh * aspect; }
    return { x: clamp(w * clamp(cx, 0, 1) - bw / 2, 0, w - bw), y: clamp(h * clamp(cy, 0, 1) - bh / 2, 0, h - bh), w: bw, h: bh };
  }
  if (position === "bottom_strip") {
    let bw = w, bh = w / aspect;
    if (bh > h * s) { bh = h * s; bw = bh * aspect; }
    return { x: (w - bw) / 2, y: h - bh, w: bw, h: bh };
  }
  const m = w * 0.03;
  let bw = w * s, bh = bw / aspect;
  if (bh > h - 2 * m) { bh = h - 2 * m; bw = bh * aspect; }
  if (bw > w - 2 * m) { bw = w - 2 * m; bh = bw / aspect; }
  const x = position === "top_left" || position === "bottom_left" ? m : position === "center" ? (w - bw) / 2 : w - m - bw;
  const y = position === "top_left" || position === "top_right" ? m : position === "center" ? (h - bh) / 2 : h - m - bh;
  return { x, y, w: bw, h: bh };
}
export const isAdSlot = (p: { integration: string }) => p.integration === "asset" || p.integration === "remote";
