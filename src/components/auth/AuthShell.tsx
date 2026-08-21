import Link from "next/link";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cream px-6 py-16">
      <div className="w-full max-w-md">
        <Link
          href="/"
          className="mb-8 block text-center font-serif text-2xl font-bold text-dark"
        >
          Kinnect
        </Link>
        <div className="rounded-card bg-white p-8 shadow-soft">
          <h1 className="font-serif text-2xl font-bold text-dark">{title}</h1>
          <p className="mt-1 text-sm text-dark/60">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        {footer ? (
          <p className="mt-6 text-center text-sm text-dark/60">{footer}</p>
        ) : null}
      </div>
    </main>
  );
}

export function Field({
  label,
  name,
  type = "text",
  autoComplete,
  placeholder,
  required = true,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-dark/80">
        {label}
      </span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        className="w-full rounded-xl border border-dark/15 bg-cream/50 px-3.5 py-2.5 text-dark outline-none transition focus:border-coral focus:ring-2 focus:ring-coral/20"
      />
    </label>
  );
}

export function FormMessage({
  error,
  message,
}: {
  error?: string;
  message?: string;
}) {
  if (!error && !message) return null;
  return (
    <p
      className={`rounded-xl px-3.5 py-2.5 text-sm ${
        error
          ? "bg-coral/10 text-coral"
          : "bg-sage/10 text-sage"
      }`}
    >
      {error ?? message}
    </p>
  );
}
