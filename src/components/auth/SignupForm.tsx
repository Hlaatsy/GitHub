"use client";

import { useActionState } from "react";
import { signUpParent, type ActionState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { Field, FormMessage } from "./AuthShell";

export function SignupForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(
    signUpParent,
    {}
  );

  return (
    <form action={formAction} className="space-y-4">
      <Field label="Your name" name="displayName" autoComplete="name" />
      <Field label="Family name" name="familyName" placeholder="e.g. The Makgolane Family" />
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />
      <FormMessage error={state.error} message={state.message} />
      <SubmitButton className="w-full" pendingLabel="Creating…">
        Create family
      </SubmitButton>
    </form>
  );
}
