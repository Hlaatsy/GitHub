import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { getSupabaseEnv } from "./env";

/** Routes that require an authenticated session. */
const PROTECTED_PREFIXES = ["/dashboard", "/family", "/onboarding"];
/** Auth routes an already-signed-in user should be bounced away from. */
const AUTH_ROUTES = ["/login", "/signup", "/join"];

/**
 * Refreshes the Supabase auth session on every request and gates protected
 * routes. Auth is enforced in the database by RLS — this middleware is the
 * convenience layer that keeps unauthenticated users out of app screens and
 * keeps the session cookie fresh.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const { isConfigured, url, anonKey } = getSupabaseEnv();
  // Without Supabase configured there is no session to manage. Let public
  // pages render, but keep protected routes from hitting a client that would
  // throw — send them to /login instead.
  if (!isConfigured || !url || !anonKey) {
    const { pathname } = request.nextUrl;
    if (PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      return NextResponse.redirect(redirectUrl);
    }
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options: CookieOptions }[]
      ) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAuthRoute = AUTH_ROUTES.some((p) => pathname.startsWith(p));

  if (!user && isProtected) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && isAuthRoute) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/dashboard";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
