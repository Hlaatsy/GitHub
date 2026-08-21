import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { JoinForm } from "@/components/auth/JoinForm";

export default function JoinPage() {
  return (
    <AuthShell
      title="Join your family"
      subtitle="Enter the invite code your parent gave you."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-coral">
            Sign in
          </Link>
        </>
      }
    >
      <JoinForm />
    </AuthShell>
  );
}
