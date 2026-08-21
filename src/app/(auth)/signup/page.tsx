import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignupForm } from "@/components/auth/SignupForm";

export default function SignupPage() {
  return (
    <AuthShell
      title="Create your family"
      subtitle="You'll be the parent. You can invite your child next."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-coral">
            Sign in
          </Link>
        </>
      }
    >
      <SignupForm />
    </AuthShell>
  );
}
