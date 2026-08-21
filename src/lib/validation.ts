import { z } from "zod";

const email = z.string().trim().email("Enter a valid email address.");
const password = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(72, "Password must be at most 72 characters.");
const displayName = z
  .string()
  .trim()
  .min(1, "Enter a display name.")
  .max(60, "Display name is too long.");

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password."),
});

export const signUpParentSchema = z.object({
  email,
  password,
  displayName,
  familyName: z
    .string()
    .trim()
    .min(1, "Enter a family name.")
    .max(100, "Family name is too long."),
});

export const joinFamilySchema = z.object({
  email,
  password,
  displayName,
  inviteCode: z
    .string()
    .trim()
    .min(6, "Invite codes are 8 characters.")
    .max(12, "That code is too long."),
});

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpParentInput = z.infer<typeof signUpParentSchema>;
export type JoinFamilyInput = z.infer<typeof joinFamilySchema>;
