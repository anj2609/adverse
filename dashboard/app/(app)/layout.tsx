"use client";
import { Activity, AppWindow, Image as ImageIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Button, cx } from "@/components/ui";

const NAV = [
  { href: "/applications", label: "Apps", icon: AppWindow },
  { href: "/creatives", label: "Ads", icon: ImageIcon },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const path = usePathname();
  if (!user) return null;
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="flex flex-col gap-1 border-b border-line bg-surface p-3 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:p-4">
        <div className="flex items-center gap-2.5 px-2 pb-3 lg:pb-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-brand-ink"><Activity size={18} /></span>
          <span className="text-lg font-semibold tracking-tight">AdForge</span>
          <span className="ml-auto truncate text-xs text-muted lg:hidden">{user.name}</span>
          <Button size="sm" className="lg:hidden" onClick={signOut}>Sign out</Button>
        </div>
        <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => {
            const on = path.startsWith(href);
            return (
              <Link key={href} href={href} className={cx("flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium", on ? "bg-brand-soft text-brand" : "text-ink hover:bg-subtle")}>
                <Icon size={17} />{label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto hidden rounded-xl bg-subtle p-3 lg:block">
          <div className="text-sm font-medium">{user.name}</div>
          <Button size="sm" className="mt-2" onClick={signOut}>Sign out</Button>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-8 sm:py-8">{children}</main>
    </div>
  );
}
