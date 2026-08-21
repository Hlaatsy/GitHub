"use client";

import { useActionState } from "react";
import { completeOnboarding, type ActionState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { FormMessage } from "./AuthShell";

export function OnboardingForm({ label }: { label: string }) {
  const [state, action] = useActionState<ActionState>(
    async () => completeOnboarding(),
    {}
  );

  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} />
      <SubmitButton className="w-full" pendingLabel="Setting up…">
        {label}
      </SubmitButton>
    </form>
  );
}
