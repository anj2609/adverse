"use client";
import { Activity } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { setSession } from "@/lib/auth";
import { Button, Card, ErrorNote, Field, Input } from "@/components/ui";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.login(email, password);
      setSession(r.access_token);
      window.location.href = "/"; // full load so the auth context picks the session up
    } catch (err) { setError(err); setBusy(false); }
  }
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm p-7">
        <div className="mb-5 flex items-center gap-2.5"><span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-brand-ink"><Activity size={19} /></span><span className="text-xl font-semibold">AdForge</span></div>
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mb-5 mt-1 text-sm text-muted">Put your ads on the pictures in your apps.</p>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email"><Input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error ? <ErrorNote error={error} /> : null}
          <Button variant="primary" className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
        </form>
      </Card>
    </div>
  );
}
