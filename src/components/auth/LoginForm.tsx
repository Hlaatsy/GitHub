"use client";

import { useActionState } from "react";
import { signIn, type ActionState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { Field, FormMessage } from "./AuthShell";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(signIn, {});

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
      />
      <FormMessage error={state.error} message={state.message} />
      <SubmitButton className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
