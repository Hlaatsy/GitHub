import { z } from 'zod';
import { type WebhookChangeValue, type WebhookPayload } from '../whatsapp/types';

// Only the fields the processor relies on are validated; everything else passes
// through untouched so new Meta fields never break ingestion.

export const WebhookPayloadSchema = z
  .object({
    object: z.literal('whatsapp_business_account'),
    entry: z
      .array(
        z
          .object({
            id: z.string(),
            changes: z.array(z.object({ field: z.string(), value: z.unknown() }).passthrough()).max(100),
          })
          .passthrough(),
      )
      .max(100),
  })
  .passthrough();

const InboundMessageSchema = z
  .object({
    from: z.string().min(8).max(20),
    id: z.string().min(1).max(128),
    timestamp: z.string().regex(/^\d{1,12}$/),
    type: z.string().min(1).max(32),
  })
  .passthrough();

export const MessagesValueSchema = z
  .object({
    messaging_product: z.literal('whatsapp'),
    metadata: z
      .object({ display_phone_number: z.string(), phone_number_id: z.string().min(1).max(32) })
      .passthrough(),
    contacts: z
      .array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough())
      .optional(),
    messages: z.array(InboundMessageSchema).max(100).optional(),
    statuses: z.array(z.unknown()).optional(),
  })
  .passthrough();

export function parseWebhookPayload(input: unknown): WebhookPayload {
  return WebhookPayloadSchema.parse(input) as unknown as WebhookPayload;
}

export function parseMessagesValue(input: unknown): WebhookChangeValue | null {
  const result = MessagesValueSchema.safeParse(input);
  return result.success ? (result.data as unknown as WebhookChangeValue) : null;
}
