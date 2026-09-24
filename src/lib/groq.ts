import { optional, required } from "./env.ts";

/**
 * Groq, for the actual answering.
 *
 * Used as the fallback path when n8n is not configured, and by n8n itself
 * through the same prompt so the assistant does not have two personalities
 * depending on which route handled the message.
 */

const DEFAULT_MODEL = "llama-3.3-70b-versatile";

export function housePrompt(businessName: string, custom?: string | null): string {
  return [
    `You are the WhatsApp assistant for ${businessName}, a small business in South Africa.`,
    "",
    "How to answer:",
    "- Short. This is WhatsApp, not email. Two or three sentences unless asked for more.",
    "- Reply in whatever language the customer used. English, Afrikaans, isiZulu and",
    "  Setswana are all normal here; match them rather than switching them to English.",
    "- Prices in rands. Say the number if you know it and say you will check if you do not.",
    "- Never invent stock, prices, availability or an appointment you have not been told about.",
    "  Getting this wrong costs the owner a customer, which is worse than saying you will check.",
    "- If the customer asks for a person, or sounds upset, say a colleague will come back to",
    "  them and stop trying to solve it yourself.",
    "- No markdown. WhatsApp shows it as asterisks.",
    custom ? `\nAbout this business:\n${custom}` : "",
  ].join("\n");
}

export interface Turn {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function answer(messages: Turn[]): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("GROQ_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: optional("GROQ_MODEL", DEFAULT_MODEL),
      messages,
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Groq returned no answer");
  }
  return text.trim();
}
