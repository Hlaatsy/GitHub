import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await supabaseServer().auth.signOut();
  return NextResponse.redirect(new URL("/login", req.nextUrl.origin), { status: 303 });
}
