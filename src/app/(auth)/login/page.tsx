import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your family."
      footer={
        <>
          New here?{" "}
          <Link href="/signup" className="font-medium text-coral">
            Create a family
          </Link>{" "}
          or{" "}
          <Link href="/join" className="font-medium text-lavender">
            join with a code
          </Link>
          .
        </>
      }
    >
      <LoginForm next={next} />
    </AuthShell>
  );
}
