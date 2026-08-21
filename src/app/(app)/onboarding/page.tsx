import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/AuthShell";
import { OnboardingForm } from "@/components/auth/OnboardingForm";

// Reads auth cookies — always render per request, never prerender at build.
export const dynamic = "force-dynamic";

import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export default async function OnboardingPage() {
  const { userId, profile } = await getCurrentProfile();
  if (!userId) redirect("/login");
  if (profile) redirect("/dashboard");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const flow = (user?.user_metadata?.flow as string) ?? "create_family";
  const isJoin = flow === "join";

  return (
    <AuthShell
      title={isJoin ? "Almost there" : "Finish your family"}
      subtitle={
        isJoin
          ? "Confirm to join your family with the code you entered."
          : "Confirm to create your family and become its parent."
      }
    >
      <OnboardingForm label={isJoin ? "Join family" : "Create family"} />
    </AuthShell>
  );
}
