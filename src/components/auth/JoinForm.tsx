"use client";

import { useActionState } from "react";
import { joinFamily, type ActionState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { Field, FormMessage } from "./AuthShell";

export function JoinForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(
    joinFamily,
    {}
  );

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="Invite code"
        name="inviteCode"
        placeholder="From your parent"
        autoComplete="off"
      />
      <Field label="Your name" name="displayName" autoComplete="name" />
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />
      <FormMessage error={state.error} message={state.message} />
      <SubmitButton className="w-full" pendingLabel="Joining…">
        Join family
      </SubmitButton>
    </form>
  );
}
