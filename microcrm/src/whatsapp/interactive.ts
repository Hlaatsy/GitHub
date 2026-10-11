import {
  type ButtonInteractive,
  type CtaUrlInteractive,
  type InteractiveObject,
  type ListInteractive,
  type ListRow,
  type OutboundMessage,
  type ProductListInteractive,
} from './types';

/** Field limits from Meta's Interactive Object reference. */
export const LIMITS = {
  HEADER_TEXT: 60,
  BODY_TEXT: 1024,
  FOOTER_TEXT: 60,
  TEXT_MESSAGE: 4096,
  MAX_BUTTONS: 3,
  BUTTON_TITLE: 20,
  BUTTON_ID: 256,
  LIST_BUTTON: 20,
  MAX_SECTIONS: 10,
  MAX_LIST_ROWS: 10,
  SECTION_TITLE: 24,
  ROW_TITLE: 24,
  ROW_DESCRIPTION: 72,
  ROW_ID: 200,
  MAX_PRODUCTS: 30,
  CTA_DISPLAY_TEXT: 20,
  TEMPLATE_PARAM: 1024,
} as const;

export class InteractiveSpecError extends Error {
  override readonly name = 'InteractiveSpecError';
}

/**
 * Trims and shortens display text to `max` UTF-16 units (the conservative way
 * to count, since emoji take two), never splitting a surrogate pair.
 */
export function clip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/** IDs drive routing, so an oversized one is a bug rather than something to truncate. */
function assertId(id: string, max: number): string {
  if (id.length === 0 || id.length > max) {
    throw new InteractiveSpecError(`Interactive id must be 1-${max} characters: "${id}"`);
  }
  return id;
}

function assertUnique(values: readonly string[], what: string): void {
  if (new Set(values).size !== values.length) {
    throw new InteractiveSpecError(`${what} must be unique`);
  }
}

interface CommonParts {
  header?: string;
  body: string;
  footer?: string;
}

function commonParts({ header, body, footer }: CommonParts) {
  return {
    ...(header ? { header: { type: 'text' as const, text: clip(header, LIMITS.HEADER_TEXT) } } : {}),
    body: { text: clip(body, LIMITS.BODY_TEXT) },
    ...(footer ? { footer: { text: clip(footer, LIMITS.FOOTER_TEXT) } } : {}),
  };
}

export interface ReplyButtonsInput extends CommonParts {
  buttons: ReadonlyArray<{ id: string; title: string }>;
}

export function replyButtons(input: ReplyButtonsInput): ButtonInteractive {
  if (input.buttons.length < 1 || input.buttons.length > LIMITS.MAX_BUTTONS) {
    throw new InteractiveSpecError(`Reply buttons need 1-${LIMITS.MAX_BUTTONS} buttons`);
  }
  const buttons = input.buttons.map((button) => ({
    type: 'reply' as const,
    reply: { id: assertId(button.id, LIMITS.BUTTON_ID), title: clip(button.title, LIMITS.BUTTON_TITLE) },
  }));
  assertUnique(buttons.map((b) => b.reply.id), 'Button ids');
  assertUnique(buttons.map((b) => b.reply.title), 'Button titles');

  return { type: 'button', ...commonParts(input), action: { buttons } };
}

export interface ListInput extends CommonParts {
  buttonLabel: string;
  sections: ReadonlyArray<{ title?: string; rows: readonly ListRow[] }>;
}

export function listMessage(input: ListInput): ListInteractive {
  const { sections } = input;
  if (sections.length < 1 || sections.length > LIMITS.MAX_SECTIONS) {
    throw new InteractiveSpecError(`List messages need 1-${LIMITS.MAX_SECTIONS} sections`);
  }
  const totalRows = sections.reduce((sum, section) => sum + section.rows.length, 0);
  if (totalRows < 1 || totalRows > LIMITS.MAX_LIST_ROWS) {
    throw new InteractiveSpecError(`List messages need 1-${LIMITS.MAX_LIST_ROWS} rows in total`);
  }
  if (sections.length > 1 && sections.some((section) => !section.title)) {
    throw new InteractiveSpecError('Every section needs a title when a list has more than one');
  }

  const builtSections = sections
    .filter((section) => section.rows.length > 0)
    .map((section) => ({
      ...(section.title ? { title: clip(section.title, LIMITS.SECTION_TITLE) } : {}),
      rows: section.rows.map((row) => ({
        id: assertId(row.id, LIMITS.ROW_ID),
        title: clip(row.title, LIMITS.ROW_TITLE),
        ...(row.description ? { description: clip(row.description, LIMITS.ROW_DESCRIPTION) } : {}),
      })),
    }));
  assertUnique(
    builtSections.flatMap((section) => section.rows.map((row) => row.id)),
    'List row ids',
  );

  return {
    type: 'list',
    ...commonParts(input),
    action: { button: clip(input.buttonLabel, LIMITS.LIST_BUTTON), sections: builtSections },
  };
}

export interface ProductListInput extends CommonParts {
  header: string;
  catalogId: string;
  sections: ReadonlyArray<{ title: string; retailerIds: readonly string[] }>;
}

/** Multi-product message rendered natively from the WABA-linked Meta catalog. */
export function productList(input: ProductListInput): ProductListInteractive {
  const { sections } = input;
  if (sections.length < 1 || sections.length > LIMITS.MAX_SECTIONS) {
    throw new InteractiveSpecError(`Product lists need 1-${LIMITS.MAX_SECTIONS} sections`);
  }
  const totalItems = sections.reduce((sum, section) => sum + section.retailerIds.length, 0);
  if (totalItems < 1 || totalItems > LIMITS.MAX_PRODUCTS) {
    throw new InteractiveSpecError(`Product lists need 1-${LIMITS.MAX_PRODUCTS} items in total`);
  }

  const parts = commonParts(input);
  return {
    type: 'product_list',
    header: { type: 'text', text: clip(input.header, LIMITS.HEADER_TEXT) },
    body: parts.body,
    ...(parts.footer ? { footer: parts.footer } : {}),
    action: {
      catalog_id: input.catalogId,
      sections: sections.map((section) => ({
        title: clip(section.title, LIMITS.SECTION_TITLE),
        product_items: section.retailerIds.map((id) => ({ product_retailer_id: id })),
      })),
    },
  };
}

export interface CtaUrlInput extends CommonParts {
  displayText: string;
  url: string;
}

export function ctaUrl(input: CtaUrlInput): CtaUrlInteractive {
  const url = new URL(input.url);
  if (url.protocol !== 'https:') {
    throw new InteractiveSpecError('CTA URLs must use https');
  }
  return {
    type: 'cta_url',
    ...commonParts(input),
    action: { name: 'cta_url', parameters: { display_text: clip(input.displayText, LIMITS.CTA_DISPLAY_TEXT), url: url.toString() } },
  };
}

export function asInteractive(interactive: InteractiveObject): OutboundMessage {
  return { type: 'interactive', interactive };
}

/** Plain text with link previews off: previews make WhatsApp fetch and render a page. */
export function asText(body: string): OutboundMessage {
  return { type: 'text', text: { body: clip(body, LIMITS.TEXT_MESSAGE), preview_url: false } };
}

export function describeMessage(message: OutboundMessage): string {
  switch (message.type) {
    case 'interactive':
      return `interactive:${message.interactive.type}`;
    case 'template':
      return `template:${message.template.name}`;
    case 'text':
      return 'text';
  }
}
