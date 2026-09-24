import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { optional } from "@/lib/env";
import { parseInbound, sendText, verifyMetaSignature, type InboundMessage } from "@/lib/whatsapp";
import { answer, housePrompt } from "@/lib/groq";
import { forwardToN8n } from "@/lib/n8n";
import { holdingMessage, shouldNotifyOwner, upgradeMessage } from "@/lib/wallet";
import { isPlanKey } from "@/lib/plans";
import { SITE_URL } from "@/lib/env";

export const runtime = "nodejs";
// Signature verification needs the raw bytes, and the route writes to the
// database on every call, so nothing here may be cached or statically built.
export const dynamic = "force-dynamic";

/**
 * GET: Meta's one-time webhook verification handshake.
 *
 * Meta calls this when the webhook is first configured and expects the
 * challenge echoed back as plain text -- not JSON, and not quoted.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const expected = optional("WHATSAPP_VERIFY_TOKEN");
  if (mode === "subscribe" && expected && token === expected && challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new NextResponse("forbidden", { status: 403 });
}

/**
 * POST: an inbound message.
 *
 * Meta retries until it gets a 200, so this returns 200 for anything it has
 * durably recorded -- including messages it chose not to answer. Returning
 * an error because one client is over their limit would have Meta redeliver
 * that message for a day.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) {
    // Anyone can find this URL. Without the signature check they could post
    // messages as any business on the platform.
    return new NextResponse("bad signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("bad json", { status: 400 });
  }

  const messages = parseInbound(payload);
  // Delivery and read receipts land here constantly and are not messages.
  if (messages.length === 0) return NextResponse.json({ ok: true, handled: 0 });

  for (const message of messages) {
    try {
      await handle(message);
    } catch (err) {
      // One bad message must not cost us the 200 for the others in the
      // batch, which Meta would then redeliver in full.
      console.error("swiftinbox: failed to handle message", message.messageId, err);
    }
  }

  return NextResponse.json({ ok: true, handled: messages.length });
}

async function handle(message: InboundMessage) {
  const db = supabaseAdmin();

  // One call: identifies the business, dedupes the retry, opens or reuses
  // the 24-hour conversation window, and decides whether it is paid for --
  // all under a row lock. See supabase/schema.sql.
  const { data, error } = await db.rpc("consume_conversation", {
    p_phone_number_id: message.phoneNumberId,
    p_wa_id: message.waId,
    p_wa_message_id: message.messageId,
    p_body: message.text,
    p_contact_name: message.contactName,
  });

  if (error) throw new Error(`consume_conversation: ${error.message}`);
  const result = data as any;

  switch (result?.status) {
    case "duplicate":
    case "unknown_number":
      return;
    case "blocked":
      await handleBlocked(result, message);
      return;
    case "ok":
      break;
    default:
      throw new Error(`consume_conversation returned ${JSON.stringify(result)}`);
  }

  // n8n owns the per-client workflow. Groq is the fallback so a customer
  // does not get silence when a workflow is down.
  let reply = await forwardToN8n({
    clientId: result.client_id,
    clientName: result.client_name,
    plan: result.plan,
    conversationId: result.conversation_id,
    contactId: result.contact_id,
    phoneNumberId: message.phoneNumberId,
    waId: message.waId,
    contactName: message.contactName,
    messageId: message.messageId,
    text: message.text,
    newConversation: result.new_conversation,
    used: result.used,
    limit: result.limit,
  });

  if (!reply) {
    reply = await answerDirectly(db, result, message);
  }

  await sendText(message.phoneNumberId, message.waId, reply);

  await db.from("messages").insert({
    client_id: result.client_id,
    conversation_id: result.conversation_id,
    direction: "outbound",
    body: reply,
  });
}

/** Groq, with the last few turns of this conversation for context. */
async function answerDirectly(
  db: ReturnType<typeof supabaseAdmin>,
  result: any,
  message: InboundMessage,
): Promise<string> {
  const { data: history } = await db
    .from("messages")
    .select("direction, body")
    .eq("conversation_id", result.conversation_id)
    .order("created_at", { ascending: false })
    .limit(10);

  const turns = (history ?? [])
    .reverse()
    .filter((m: any) => typeof m.body === "string" && m.body.trim())
    .map((m: any) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: m.body as string,
    }));

  return answer([
    { role: "system", content: housePrompt(result.client_name, result.system_prompt) },
    ...turns,
  ]);
}

/**
 * Out of conversations.
 *
 * The person who messaged gets a normal holding reply -- they are a member
 * of the public and the state of the shop's software subscription is not
 * their business. The owner gets the upgrade nudge on their own number, at
 * most once a day.
 */
async function handleBlocked(result: any, message: InboundMessage) {
  const db = supabaseAdmin();

  const holding = holdingMessage(result.client_name);
  await sendText(message.phoneNumberId, message.waId, holding);
  await db.from("messages").insert({
    client_id: result.client_id,
    direction: "outbound",
    body: holding,
    blocked: true,
  });

  if (!result.owner_wa_id) return;
  if (!shouldNotifyOwner(result.upgrade_notice_at)) return;

  const planKey = isPlanKey(result.plan) ? result.plan : "starter";
  const nudge = upgradeMessage({
    businessName: result.client_name,
    planKey,
    used: result.used,
    missed: result.blocked_since_cap ?? 1,
    dashboardUrl: `${SITE_URL()}/dashboard/billing`,
  });

  await sendText(message.phoneNumberId, result.owner_wa_id, nudge);
  await db
    .from("clients")
    .update({ upgrade_notice_at: new Date().toISOString() })
    .eq("id", result.client_id);
}
