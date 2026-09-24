import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

/**
 * Refreshes the Supabase session on every request and keeps signed-out
 * people out of the dashboards.
 *
 * The pages check permissions again server-side. Middleware is the polite
 * redirect, not the security boundary -- RLS is.
 */
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: { headers: req.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name: string) => req.cookies.get(name)?.value,
        set(name: string, value: string, options: CookieOptions) {
          req.cookies.set({ name, value, ...options });
          res = NextResponse.next({ request: { headers: req.headers } });
          res.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          req.cookies.set({ name, value: "", ...options });
          res = NextResponse.next({ request: { headers: req.headers } });
          res.cookies.set({ name, value: "", ...options });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = req.nextUrl.pathname;
  if (!user && (path.startsWith("/dashboard") || path.startsWith("/manager"))) {
    const to = new URL("/login", req.url);
    to.searchParams.set("next", path);
    return NextResponse.redirect(to);
  }

  return res;
}

export const config = {
  // Webhooks are excluded: WhatsApp and Paystack have no session and their
  // signature checks are what authenticate them.
  matcher: ["/dashboard/:path*", "/manager/:path*"],
};
