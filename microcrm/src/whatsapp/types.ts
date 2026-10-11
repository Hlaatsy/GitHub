// Meta WhatsApp Business Cloud API (Graph v20.0+) payload shapes.

// ---------------------------------------------------------------------------
// Inbound webhook
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  object: 'whatsapp_business_account';
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  /** WhatsApp Business Account ID. */
  id: string;
  changes: WebhookChange[];
}

export interface WebhookChange {
  field: string;
  value: WebhookChangeValue;
}

export interface WebhookChangeValue {
  messaging_product: 'whatsapp';
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: WebhookContact[];
  messages?: InboundMessage[];
  statuses?: MessageStatus[];
}

export interface WebhookContact {
  wa_id: string;
  profile?: { name?: string };
}

export interface InboundMediaObject {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

export interface InboundOrderItem {
  product_retailer_id: string;
  quantity: number | string;
  item_price?: number | string;
  currency?: string;
}

export type InboundMessageType =
  | 'text'
  | 'interactive'
  | 'button'
  | 'order'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'reaction'
  | 'system'
  | 'request_welcome'
  | 'unsupported';

export interface InboundMessage {
  from: string;
  id: string;
  /** Unix seconds, as a string. */
  timestamp: string;
  type: InboundMessageType | (string & {});
  context?: { from?: string; id?: string };
  text?: { body: string };
  interactive?:
    | { type: 'button_reply'; button_reply: { id: string; title: string } }
    | { type: 'list_reply'; list_reply: { id: string; title: string; description?: string } }
    | { type: string };
  /** Quick-reply button tapped on a template message. */
  button?: { payload: string; text: string };
  order?: { catalog_id: string; text?: string; product_items: InboundOrderItem[] };
  image?: InboundMediaObject;
  audio?: InboundMediaObject;
  video?: InboundMediaObject;
  document?: InboundMediaObject;
  sticker?: InboundMediaObject;
}

export interface MessageStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | (string & {});
  timestamp: string;
  recipient_id: string;
}

// ---------------------------------------------------------------------------
// Outbound Interactive Objects
// ---------------------------------------------------------------------------

/** Text-only headers: media headers are deliberately unsupported to keep payloads light. */
export interface TextHeader {
  type: 'text';
  text: string;
}

export interface TextObject {
  text: string;
}

export interface ReplyButton {
  type: 'reply';
  reply: { id: string; title: string };
}

export interface ButtonInteractive {
  type: 'button';
  header?: TextHeader;
  body: TextObject;
  footer?: TextObject;
  action: { buttons: ReplyButton[] };
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

export interface ListInteractive {
  type: 'list';
  header?: TextHeader;
  body: TextObject;
  footer?: TextObject;
  action: { button: string; sections: ListSection[] };
}

export interface ProductSection {
  title: string;
  product_items: Array<{ product_retailer_id: string }>;
}

export interface ProductListInteractive {
  type: 'product_list';
  header: TextHeader;
  body: TextObject;
  footer?: TextObject;
  action: { catalog_id: string; sections: ProductSection[] };
}

export type InteractiveObject = ButtonInteractive | ListInteractive | ProductListInteractive;

export interface TemplateComponent {
  type: 'body';
  parameters: Array<{ type: 'text'; text: string }>;
}

export type OutboundMessage =
  | { type: 'interactive'; interactive: InteractiveObject }
  | { type: 'text'; text: { body: string; preview_url: boolean } }
  | {
      type: 'template';
      template: { name: string; language: { code: string }; components?: TemplateComponent[] };
    };

export interface SendMessageResponse {
  messaging_product: 'whatsapp';
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
}

export interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface MediaMetadata {
  id: string;
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
}
