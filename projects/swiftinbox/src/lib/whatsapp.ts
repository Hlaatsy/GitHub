import crypto from "node:crypto";
import { optional, required } from "./env.ts";

/**
 * WhatsApp Cloud API: signature checks and sending.
 */

/**
 * Meta signs every webhook POST with sha256=<hmac> over the raw body.
 *
 * The comparison is timing-safe, and the raw bytes matter: re-serialising
 * the parsed JSON changes key order and whitespace and the digest stops
 * matching, so callers must pass the body exactly as it arrived.
 */
export function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const appSecret = optional("WHATSAPP_APP_SECRET");
  if (!appSecret) return false;
  if (!header?.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

export interface InboundMessage {
  phoneNumberId: string;
  waId: string;
  contactName: string | null;
  messageId: string;
  text: string;
  timestamp: string;
}

/**
 * Pull the messages out of a Cloud API webhook payload.
 *
 * The shape is entry[] > changes[] > value.messages[], and most deliveries
 * are not messages at all -- they are delivery receipts and read receipts,
 * which carry `statuses` instead. Those must be ignored rather than charged
 * as conversations.
 */
export function parseInbound(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const body = payload as any;
  if (!body || body.object !== "whatsapp_business_account") return out;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change?.value;
      if (!value?.messages) continue;

      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id) names.set(c.wa_id, c.profile?.name ?? "");
      }

      for (const m of value.messages) {
        // Only text for now. Images, audio and location arrive here too and
        // need their own handling; charging for one we cannot answer would
        // be taking money for nothing.
        if (m?.type !== "text" || !m?.id || !m?.from) continue;
        out.push({
          phoneNumberId,
          waId: m.from,
          contactName: names.get(m.from) || null,
          messageId: m.id,
          text: m.text?.body ?? "",
          timestamp: m.timestamp ?? "",
        });
      }
    }
  }
  return out;
}

/** Send a text message back to a customer. */
export async function sendText(phoneNumberId: string, to: string, body: string) {
  const token = required("WHATSAPP_ACCESS_TOKEN");
  const version = optional("WHATSAPP_API_VERSION", "v21.0");

  const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });

  if (!res.ok) {
    throw new Error(`WhatsApp send failed ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
