import { type InboundMediaObject, type InboundMessage } from '../whatsapp/types';

export type MediaType = 'image' | 'audio' | 'video' | 'document' | 'sticker';

export type InboundEvent =
  | { kind: 'text'; text: string }
  | { kind: 'button'; id: string; title: string }
  | { kind: 'list'; id: string; title: string }
  | { kind: 'order'; catalogId: string; items: Array<{ retailerId: string; quantity: number }> }
  | { kind: 'media'; mediaType: MediaType; mediaId: string; mimeType?: string; caption?: string }
  | { kind: 'unsupported'; rawType: string };

const MEDIA_TYPES: readonly MediaType[] = ['image', 'audio', 'video', 'document', 'sticker'];
const MAX_TEXT_INSPECTED = 256;

/**
 * Collapses Meta's message variants into the handful of shapes the bot acts on.
 * Media is reduced to its id: nothing is downloaded at this stage.
 */
export function normaliseMessage(message: InboundMessage): InboundEvent {
  switch (message.type) {
    case 'text':
      // Only the opening words matter for intent matching; long bodies are cut early.
      return { kind: 'text', text: (message.text?.body ?? '').slice(0, MAX_TEXT_INSPECTED) };

    case 'interactive': {
      const interactive = message.interactive;
      if (interactive && 'button_reply' in interactive) {
        return { kind: 'button', id: interactive.button_reply.id, title: interactive.button_reply.title };
      }
      if (interactive && 'list_reply' in interactive) {
        return { kind: 'list', id: interactive.list_reply.id, title: interactive.list_reply.title };
      }
      return { kind: 'unsupported', rawType: `interactive:${interactive?.type ?? 'unknown'}` };
    }

    case 'button':
      return message.button
        ? { kind: 'button', id: message.button.payload, title: message.button.text }
        : { kind: 'unsupported', rawType: 'button' };

    case 'order':
      return message.order
        ? {
            kind: 'order',
            catalogId: message.order.catalog_id,
            items: message.order.product_items.map((item) => ({
              retailerId: item.product_retailer_id,
              quantity: Number(item.quantity),
            })),
          }
        : { kind: 'unsupported', rawType: 'order' };

    default: {
      const mediaType = MEDIA_TYPES.find((type) => type === message.type);
      const media: InboundMediaObject | undefined = mediaType ? message[mediaType] : undefined;
      if (mediaType && media) {
        return {
          kind: 'media',
          mediaType,
          mediaId: media.id,
          ...(media.mime_type ? { mimeType: media.mime_type } : {}),
          ...(media.caption ? { caption: media.caption.slice(0, MAX_TEXT_INSPECTED) } : {}),
        };
      }
      return { kind: 'unsupported', rawType: message.type };
    }
  }
}
