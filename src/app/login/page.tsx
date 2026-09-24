"use client";

import { useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) setError(error.message);
    else setSent(true);
    setBusy(false);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <Link href="/" className="text-lg font-bold text-emerald-ink">
        SwiftInbox
      </Link>

      <div className="card mt-5">
        <h1 className="text-xl font-bold text-emerald-ink">Sign in</h1>

        {sent ? (
          <p className="mt-3 rounded-xl bg-whatsapp-wash px-4 py-3 text-sm">
            Check <strong>{email}</strong> — we have sent you a link. It signs you in
            without a password and expires in an hour.
          </p>
        ) : (
          <form onSubmit={send} className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted">
              We email you a link. No password to remember.
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="label">Your email</span>
              <input
                className="field"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbusiness.co.za"
              />
            </label>
            <button className="btn-go" disabled={busy}>
              {busy ? "Sending…" : "Email me a link"}
            </button>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
