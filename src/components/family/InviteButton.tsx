"use client";

import { useActionState } from "react";
import { createInvite, type InviteState } from "@/app/actions/family";
import { SubmitButton } from "@/components/SubmitButton";

export function InviteButton() {
  const [state, action] = useActionState<InviteState>(
    async () => createInvite(),
    {}
  );

  return (
    <form action={action} className="space-y-3">
      <SubmitButton pendingLabel="Generating…">
        Generate invite code
      </SubmitButton>
      {state.error ? (
        <p className="rounded-xl bg-coral/10 px-3.5 py-2.5 text-sm text-coral">
          {state.error}
        </p>
      ) : null}
      {state.code ? (
        <p className="rounded-xl bg-sage/10 px-3.5 py-2.5 text-sm text-dark">
          New code:{" "}
          <span className="font-mono text-lg font-bold tracking-widest text-sage">
            {state.code}
          </span>
        </p>
      ) : null}
    </form>
  );
}
