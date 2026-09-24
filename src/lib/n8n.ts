import { optional } from "./env.ts";

/**
 * Hand the message to n8n, where the per-client workflow lives (calendar
 * lookups, the 7-day nurture, escalation to a human).
 *
 * Returns null when n8n is not configured or does not answer, and the
 * webhook route then answers with Groq directly. An SME's customer waiting
 * on WhatsApp should not get silence because a workflow engine is down.
 */

export interface N8nPayload {
  clientId: string;
  clientName: string;
  plan: string;
  conversationId: string;
  contactId: string;
  phoneNumberId: string;
  waId: string;
  contactName: string | null;
  messageId: string;
  text: string;
  newConversation: boolean;
  used: number;
  limit: number;
}

export function n8nConfigured(): boolean {
  return Boolean(optional("N8N_WEBHOOK_URL"));
}

export async function forwardToN8n(payload: N8nPayload): Promise<string | null> {
  const url = optional("N8N_WEBHOOK_URL");
  if (!url) return null;

  const secret = optional("N8N_SHARED_SECRET");
  const controller = new AbortController();
  // WhatsApp wants the webhook acknowledged quickly, and a customer will not
  // wait either. If n8n has not answered in 20s we fall back to Groq.
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-SwiftInbox-Secret": secret } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const text = await res.text();
    if (!text.trim()) return null;

    // n8n workflows return either {reply: "..."} or bare text depending on
    // how the Respond node is set up. Accept both rather than making every
    // client's workflow match one shape.
    try {
      const data = JSON.parse(text);
      const reply = data?.reply ?? data?.text ?? data?.message ?? data?.[0]?.reply;
      return typeof reply === "string" && reply.trim() ? reply.trim() : null;
    } catch {
      return text.trim();
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
