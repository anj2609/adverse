"use client";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api, token } from "./api";
import type { Role, User } from "./types";

const Ctx = createContext<{ user: User | null; signOut: () => void; can: (role: Role) => boolean }>({ user: null, signOut: () => {}, can: () => false });
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (!token.get()) { setReady(true); if (path !== "/login") router.replace("/login"); return; }
    api.me().then(setUser).catch(() => { token.clear(); router.replace("/login"); }).finally(() => setReady(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = () => { token.clear(); setUser(null); router.replace("/login"); };
  const can = (role: Role) => !!user && RANK[user.role] >= RANK[role];
  if (!ready) return <div className="grid min-h-screen place-items-center text-muted">Loading…</div>;
  return <Ctx.Provider value={{ user, signOut, can }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
export function setSession(t: string) { token.set(t); }
