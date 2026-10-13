import { type InboundEvent } from '../webhooks/normalise';

/** Reply-button ids for the main menu. Stable: they come back verbatim in `button_reply.id`. */
export const MENU_BUTTONS = {
  BOOK: 'menu:book',
  CATALOG: 'menu:catalog',
  LOCATION: 'menu:location',
} as const;

/** Shop checkout buttons. */
export const CART_BUTTONS = {
  ADD_MORE: 'cart:add',
  CHECKOUT: 'cart:checkout',
  EMPTY: 'cart:empty',
  DELIVERY: 'ful:delivery',
  COLLECT: 'ful:collect',
  SAVED_ADDRESS: 'addr:saved',
  NEW_ADDRESS: 'addr:new',
} as const;

const ROW_PREFIX = {
  SLOT: 'slot',
  SERVICE: 'svc',
  PRODUCT: 'prod',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Intent =
  | { name: 'MENU' }
  | { name: 'BOOK' }
  | { name: 'CATALOG' }
  | { name: 'LOCATION' }
  | { name: 'PICK_SLOT'; startsAt: Date; serviceId: string | null }
  | { name: 'PICK_SERVICE'; serviceId: string }
  | { name: 'PICK_PRODUCT'; productId: string }
  | { name: 'PLACE_CART'; catalogId: string; items: Array<{ retailerId: string; quantity: number }> }
  | { name: 'CART_ADD_MORE' }
  | { name: 'CART_CHECKOUT' }
  | { name: 'CART_EMPTY' }
  | { name: 'CHOOSE_FULFILMENT'; fulfilment: 'DELIVERY' | 'COLLECTION' }
  | { name: 'USE_SAVED_ADDRESS' }
  | { name: 'NEW_ADDRESS' }
  | { name: 'OPT_OUT' }
  /** Owner asking for a dashboard login link; the handler checks it really is the owner. */
  | { name: 'DASHBOARD_LOGIN' }
  /** Free text the menu can't route; during checkout it may be a delivery address. */
  | { name: 'UNRECOGNISED'; text?: string }
  | { name: 'IGNORE' };

/** Greetings in the languages SA customers commonly open a chat with, plus the brief's trigger words. */
const TRIGGER_WORDS = new Set([
  'hi', 'hello', 'hey', 'hallo', 'hiya', 'howzit', 'heita', 'sawubona', 'sanibonani', 'molo',
  'molweni', 'dumela', 'thobela', 'avuxeni', 'ndaa', 'goeie', 'morning', 'afternoon',
  'book', 'booking', 'bookings', 'appointment', 'price', 'prices', 'pricing', 'catalog',
  'catalogue', 'order', 'menu', 'start', 'help',
]);

const OPT_OUT_PHRASES = new Set(['stop', 'stop all', 'unsubscribe', 'opt out', 'optout', 'cancel all']);
const LOGIN_PHRASES = new Set(['login', 'log in', 'dashboard']);

export function encodeSlotId(startsAt: Date, serviceId: string | null): string {
  return `${ROW_PREFIX.SLOT}:${Math.floor(startsAt.getTime() / 1000)}:${serviceId ?? ''}`;
}

export const encodeServiceId = (serviceId: string): string => `${ROW_PREFIX.SERVICE}:${serviceId}`;
export const encodeProductId = (productId: string): string => `${ROW_PREFIX.PRODUCT}:${productId}`;

export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveText(text: string): Intent {
  const normalised = normaliseText(text);
  if (OPT_OUT_PHRASES.has(normalised)) return { name: 'OPT_OUT' };
  if (LOGIN_PHRASES.has(normalised)) return { name: 'DASHBOARD_LOGIN' };
  const firstWord = normalised.split(' ', 1)[0] ?? '';
  return TRIGGER_WORDS.has(firstWord) ? { name: 'MENU' } : { name: 'UNRECOGNISED', text };
}

function resolveButton(id: string): Intent {
  switch (id) {
    case MENU_BUTTONS.BOOK:
      return { name: 'BOOK' };
    case MENU_BUTTONS.CATALOG:
      return { name: 'CATALOG' };
    case MENU_BUTTONS.LOCATION:
      return { name: 'LOCATION' };
    case CART_BUTTONS.ADD_MORE:
      return { name: 'CART_ADD_MORE' };
    case CART_BUTTONS.CHECKOUT:
      return { name: 'CART_CHECKOUT' };
    case CART_BUTTONS.EMPTY:
      return { name: 'CART_EMPTY' };
    case CART_BUTTONS.DELIVERY:
      return { name: 'CHOOSE_FULFILMENT', fulfilment: 'DELIVERY' };
    case CART_BUTTONS.COLLECT:
      return { name: 'CHOOSE_FULFILMENT', fulfilment: 'COLLECTION' };
    case CART_BUTTONS.SAVED_ADDRESS:
      return { name: 'USE_SAVED_ADDRESS' };
    case CART_BUTTONS.NEW_ADDRESS:
      return { name: 'NEW_ADDRESS' };
    default:
      // Unknown or stale ids (e.g. from an old template) fall back to the menu.
      return { name: 'MENU' };
  }
}

/** Row ids are client-echoed, so they are parsed strictly and re-validated against the tenant later. */
function resolveListRow(id: string): Intent {
  const [prefix, first, second] = id.split(':');

  if (prefix === ROW_PREFIX.SLOT && first && /^\d{9,11}$/.test(first)) {
    const serviceId = second && UUID.test(second) ? second : null;
    return { name: 'PICK_SLOT', startsAt: new Date(Number(first) * 1000), serviceId };
  }
  if (prefix === ROW_PREFIX.SERVICE && first && UUID.test(first)) {
    return { name: 'PICK_SERVICE', serviceId: first };
  }
  if (prefix === ROW_PREFIX.PRODUCT && first && UUID.test(first)) {
    return { name: 'PICK_PRODUCT', productId: first };
  }
  return { name: 'MENU' };
}

export function resolveIntent(event: InboundEvent): Intent {
  switch (event.kind) {
    case 'text':
      return resolveText(event.text);
    case 'button':
      return resolveButton(event.id);
    case 'list':
      return resolveListRow(event.id);
    case 'order':
      return { name: 'PLACE_CART', catalogId: event.catalogId, items: event.items };
    case 'media':
      return event.caption ? resolveText(event.caption) : { name: 'UNRECOGNISED' };
    case 'unsupported':
      return { name: 'IGNORE' };
  }
}
