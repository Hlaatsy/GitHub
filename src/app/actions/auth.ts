"use server";

import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  joinFamilySchema,
  signInSchema,
  signUpParentSchema,
} from "@/lib/validation";

export type ActionState = { error?: string; message?: string };

function firstError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Invalid input.";
}

/**
 * Completes onboarding using the intent stashed in user metadata at signup.
 * The security-critical role/family assignment happens in the database
 * functions (create_family_and_parent / redeem_invite), not from this metadata.
 */
async function finalizeProfile(
  supabase: SupabaseClient
): Promise<ActionState | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const meta = (user.user_metadata ?? {}) as Record<string, string>;

  if (meta.flow === "join") {
    const { error } = await supabase.rpc("redeem_invite", {
      p_code: meta.invite_code,
      p_display_name: meta.display_name,
    });
    return error ? { error: error.message } : null;
  }

  const { error } = await supabase.rpc("create_family_and_parent", {
    p_family_name: meta.family_name,
    p_display_name: meta.display_name,
  });
  return error ? { error: error.message } : null;
}

export async function signUpParent(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = signUpParentSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName"),
    familyName: formData.get("familyName"),
  });
  if (!parsed.success) return { error: firstError(parsed.error.issues) };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: {
        flow: "create_family",
        display_name: parsed.data.displayName,
        family_name: parsed.data.familyName,
      },
    },
  });
  if (error) return { error: error.message };

  if (data.session) {
    const finalize = await finalizeProfile(supabase);
    if (finalize?.error) return finalize;
    redirect("/dashboard");
  }

  return {
    message: "Account created. Check your email to confirm, then sign in.",
  };
}

export async function joinFamily(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = joinFamilySchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName"),
    inviteCode: formData.get("inviteCode"),
  });
  if (!parsed.success) return { error: firstError(parsed.error.issues) };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: {
        flow: "join",
        display_name: parsed.data.displayName,
        invite_code: parsed.data.inviteCode.toUpperCase(),
      },
    },
  });
  if (error) return { error: error.message };

  if (data.session) {
    const finalize = await finalizeProfile(supabase);
    if (finalize?.error) return finalize;
    redirect("/dashboard");
  }

  return {
    message: "Account created. Check your email to confirm, then sign in.",
  };
}

export async function signIn(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: firstError(parsed.error.issues) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return { error: "Invalid email or password." };

  const next = (formData.get("next") as string) || "/dashboard";
  redirect(next.startsWith("/") ? next : "/dashboard");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/** Invoked from the onboarding screen for accounts finalized after email confirmation. */
export async function completeOnboarding(): Promise<ActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (existing) redirect("/dashboard");

  const finalize = await finalizeProfile(supabase);
  if (finalize?.error) return finalize;
  redirect("/dashboard");
}
