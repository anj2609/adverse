"use client";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { adRect } from "@/lib/format";
import type { Placement } from "@/lib/types";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------- buttons, inputs ----------
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md" };
export function Button({ variant = "secondary", size = "md", className, ...p }: BtnProps) {
  const styles = {
    primary: "bg-brand text-brand-ink hover:brightness-110", secondary: "bg-surface border border-line hover:bg-subtle",
    danger: "bg-surface border border-line text-bad hover:bg-bad-soft", ghost: "hover:bg-subtle",
  }[variant];
  return <button {...p} className={cx("inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50", size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm", styles, className)} />;
}
const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted/70 focus:border-brand";
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(field, p.className)} />;
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(field, p.className)} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(field, p.className)} />;
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

// ---------- layout bits ----------
export const Card = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div {...p} className={cx("rounded-xl border border-line bg-surface shadow-card", className)} />;
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start gap-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}</div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export const Empty = ({ title, children }: { title: string; children?: React.ReactNode }) => (
  <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center"><div className="font-medium">{title}</div><div className="mt-1 text-sm text-muted">{children}</div></div>
);
export const Spinner = () => <div className="py-10 text-center text-sm text-muted">Loading…</div>;
export const ErrorNote = ({ error }: { error: unknown }) => <div className="rounded-lg bg-bad-soft px-4 py-3 text-sm text-bad">{(error as Error)?.message ?? "Something went wrong"}</div>;

// ---------- status ----------
const TONES: Record<string, string> = {
  active: "bg-ok-soft text-ok", approved: "bg-ok-soft text-ok", connected: "bg-ok-soft text-ok", success: "bg-ok-soft text-ok", eligible: "bg-ok-soft text-ok",
  scheduled: "bg-info-soft text-info", pending: "bg-warn-soft text-warn", pending_approval: "bg-warn-soft text-warn", paused: "bg-warn-soft text-warn",
  awaiting_connection: "bg-warn-soft text-warn", stale: "bg-warn-soft text-warn", overridden: "bg-subtle text-muted",
  expired: "bg-bad-soft text-bad", rejected: "bg-bad-soft text-bad", failure: "bg-bad-soft text-bad", disabled: "bg-bad-soft text-bad", failed: "bg-bad-soft text-bad",
  draft: "bg-subtle text-muted", fallback: "bg-subtle text-muted", inactive: "bg-subtle text-muted",
};
const LABELS: Record<string, string> = {
  active: "Active campaign creative", scheduled: "Scheduled", pending: "Pending", pending_approval: "Pending approval", fallback: "Fallback asset", expired: "Expired",
  rejected: "Rejected", awaiting_connection: "Awaiting first connection", overridden: "Outranked", draft: "Draft", paused: "Paused", approved: "Approved",
  connected: "Connected", stale: "Not seen lately", disabled: "Disabled",
};
export function Badge({ status, label, className }: { status: string; label?: string; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", TONES[status] ?? "bg-subtle text-muted", className)}>
    <span className="h-1.5 w-1.5 rounded-full bg-current" />{label ?? LABELS[status] ?? status.replace(/_/g, " ")}</span>;
}
export const Chip = ({ children }: { children: React.ReactNode }) => <span className="inline-block rounded-md bg-subtle px-2 py-0.5 text-xs text-muted">{children}</span>;

// ---------- modal ----------
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx("flex max-h-[92vh] w-full flex-col rounded-2xl bg-surface shadow-2xl", wide ? "max-w-5xl" : "max-w-lg")}>
        <div className="flex items-center gap-3 px-6 pt-5"><h2 className="flex-1 text-lg font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-subtle"><X size={18} /></button></div>
        <div className="overflow-y-auto px-6 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- toasts ----------
const ToastCtx = createContext<(msg: string, kind?: "ok" | "err") => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function Toasts({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const push = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((i) => [...i, { id, msg, kind }]);
    setTimeout(() => setItems((i) => i.filter((x) => x.id !== id)), kind === "err" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col gap-2" aria-live="polite">
        {items.map((t) => <div key={t.id} className={cx("max-w-[90vw] rounded-lg px-4 py-2.5 text-sm shadow-lg", t.kind === "err" ? "bg-bad text-white" : "bg-ink text-bg")}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- render frame: shows an image the way the app will draw it ----------
const FIT: Record<string, string> = { contain: "contain", cover: "cover", fill: "fill", fitWidth: "contain", fitHeight: "contain", none: "none", scaleDown: "scale-down" };
const POS: Record<string, string> = {
  center: "center", topLeft: "top left", topCenter: "top", topRight: "top right", centerLeft: "left", centerRight: "right",
  bottomLeft: "bottom left", bottomCenter: "bottom", bottomRight: "bottom right",
};
export function RenderFrame({ src, placement, label, empty, className }: { src?: string | null; placement: Placement; label?: string; empty?: string; className?: string }) {
  const r = placement.render ?? {};
  const ratio = placement.aspect_ratio ?? 1.5;
  return (
    <figure className={className}>
      <div className="checker relative overflow-hidden border border-line" style={{ aspectRatio: String(ratio), borderRadius: r.corner_radius ?? 8, background: r.background_color ?? undefined }}>
        {src ? <img src={src} alt={label ?? placement.name} className="h-full w-full" style={{ objectFit: (FIT[r.fit ?? "contain"] ?? "contain") as any, objectPosition: POS[r.alignment ?? "center"] }} />
          : <div className="grid h-full w-full place-items-center p-2 text-center text-xs text-muted">{empty ?? "No preview"}</div>}
      </div>
      {label && <figcaption className="mt-1.5 text-center text-xs text-muted">{label}</figcaption>}
    </figure>
  );
}

/** Where the ad image goes inside a frame of the picture, as percentages, with its corners rounded like the app draws them. */
export function adStyle(r: { x: number; y: number; w: number; h: number }, w: number, h: number, radius = 0): React.CSSProperties {
  const c = Math.min(Math.max(radius, 0), 0.5) * Math.min(r.w, r.h);
  return { left: `${(r.x / w) * 100}%`, top: `${(r.y / h) * 100}%`, width: `${(r.w / w) * 100}%`, height: `${(r.h / h) * 100}%`,
    borderRadius: c && r.w && r.h ? `${(c / r.w) * 100}% / ${(c / r.h) * 100}%` : undefined };
}

// ---------- ad on top of a picture: what the app will show for a picture found in it ----------
export function OnTopFrame({ picture, ad, placement, label, empty, className }: {
  picture?: string | null; ad?: { url: string; width: number; height: number } | null; placement: Placement; label?: string; empty?: string; className?: string;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const w = size?.w || placement.fallback?.width || 300, h = size?.h || placement.fallback?.height || 200;
  const rd = placement.render ?? {};
  const r = ad ? adRect(w, h, ad.width, ad.height, rd.ad_position, rd.ad_size, rd.ad_area, rd.ad_x, rd.ad_y) : null;
  return (
    <figure className={className}>
      <div className="checker relative overflow-hidden rounded-lg border border-line" style={{ aspectRatio: `${w} / ${h}` }}>
        {picture ? <img src={picture} alt={label ?? placement.name} className="absolute inset-0 h-full w-full" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          : <div className="grid h-full w-full place-items-center p-2 text-center text-xs text-muted">{empty ?? "No preview"}</div>}
        {ad && r && <img src={ad.url} alt="" className="absolute" style={adStyle(r, w, h, rd.ad_radius)} />}
      </div>
      {label && <figcaption className="mt-1.5 text-center text-xs text-muted">{label}</figcaption>}
    </figure>
  );
}
