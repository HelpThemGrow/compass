"use client";

import { useState, type FormEvent } from "react";
<<<<<<< HEAD
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
=======
>>>>>>> 32f2f75

/** Only same-site paths are allowed as the post-sign-in destination. */
function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get("next") ?? "/";
  // Compare resolved origins: prefix checks miss tricks like "/\t/evil.example",
  // which browsers turn into "//evil.example".
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.href = safeNext();
        return;
      }
      const payload = await res.json().catch(() => null);
      setError(payload?.detail ?? `Sign-in failed (${res.status}).`);
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  }

  return (
<<<<<<< HEAD
    <div className="grid min-h-screen place-items-center bg-sidebar p-6">
      <Card className="w-full max-w-sm gap-4 py-6">
        <form className="grid gap-4 px-6" onSubmit={submit}>
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-logo-surface px-2.5 py-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/vibha-logo.png" alt="Vibha" className="h-7 w-auto" />
            </div>
            <strong className="text-lg font-semibold tracking-tight">Compass</strong>
          </div>
          <p className="m-0 text-muted-foreground">Sign in to continue.</p>
          <div className="grid gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <div role="alert" className="rounded-md border border-l-[3px] border-destructive/30 border-l-destructive bg-destructive/10 px-3 py-2 text-[13px]">
              {error}
            </div>
          )}
          <Button size="default" type="submit" disabled={busy || !email || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
=======
    <div className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand">
          <img src="/vibha-logo.png" alt="Vibha" />
          <strong>Compass</strong>
        </div>
        <p className="lead">Sign in to continue.</p>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="notice bad">{error}</div>}
        <button className="btn" type="submit" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
>>>>>>> 32f2f75
    </div>
  );
}
