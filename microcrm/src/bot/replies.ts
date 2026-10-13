import { formatWorkingHours } from '../domain/workingHours';
import { type TimeRange } from '../domain/slots';
import { formatZar } from '../lib/money';
import { formatDayLabel, formatTime, localDateKey } from '../lib/time';
import { type TenantProfile } from '../services/tenants';
import { asInteractive, asText, listMessage, productList, replyButtons, LIMITS } from '../whatsapp/interactive';
import { type ListRow, type OutboundMessage } from '../whatsapp/types';
import { CART_BUTTONS, MENU_BUTTONS, encodeProductId, encodeServiceId, encodeSlotId } from './intents';

// Pure builders: every function returns exactly one outbound message.

export const PRODUCT_INDEX_SIZE = 5;

export interface ServiceSummary {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}

export interface ProductSummary {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  priceUnit: string | null;
  metaRetailerId: string | null;
}

export interface CartLine {
  name: string;
  quantity: number;
  priceCents: number;
}

export type FulfilmentChoice = { fulfilment: 'DELIVERY'; address: string; feeCents: number } | { fulfilment: 'COLLECTION' } | { fulfilment: null };

/** First menu button, worded for what the business actually does (titles max 20 characters). */
const BOOK_BUTTON_TITLES: Record<TenantProfile['industry'], string> = {
  SALON: '📅 Book Spot/Order',
  DECOR_HIRE: '📅 Hire Items',
  PRODUCT_SELLER: '🛍️ Shop Now',
};

/**
 * @param privacyNoticeUrl Shown on a customer's first menu (POPIA section 18:
 *   tell people what is collected and why, when it is collected).
 */
export function mainMenu(tenant: TenantProfile, customerName: string | null, privacyNoticeUrl?: string): OutboundMessage {
  const firstName = customerName?.split(' ', 1)[0];
  const privacy = privacyNoticeUrl ? `\n\nWe keep your number, name and orders to serve you. Privacy notice: ${privacyNoticeUrl}` : '';
  return asInteractive(
    replyButtons({
      header: tenant.businessName,
      body: `Hi${firstName ? ` ${firstName}` : ''} 👋 How can we help? Tap an option below.${privacy}`,
      footer: 'Reply STOP to opt out',
      buttons: [
        { id: MENU_BUTTONS.BOOK, title: BOOK_BUTTON_TITLES[tenant.industry] },
        { id: MENU_BUTTONS.CATALOG, title: '🧾 Pricing/Catalog' },
        { id: MENU_BUTTONS.LOCATION, title: '📍 Location/Hours' },
      ],
    }),
  );
}

/** Slots grouped into one section per local day, in a single list message. */
export function slotList(
  tenant: TenantProfile,
  slots: readonly TimeRange[],
  service: ServiceSummary | null,
  intro = 'Pick a time in the next 48 hours 👇',
): OutboundMessage {
  if (slots.length === 0) {
    return asText(`Sorry, there are no open slots in the next 48 hours. Reply MENU to see other options.`);
  }

  const sections = new Map<string, { title: string; rows: ListRow[] }>();
  for (const slot of slots.slice(0, LIMITS.MAX_LIST_ROWS)) {
    const key = localDateKey(slot.startsAt, tenant.timezone);
    const section = sections.get(key) ?? { title: formatDayLabel(slot.startsAt, tenant.timezone), rows: [] };
    section.rows.push({
      id: encodeSlotId(slot.startsAt, service?.id ?? null),
      title: `${formatTime(slot.startsAt, tenant.timezone)} – ${formatTime(slot.endsAt, tenant.timezone)}`,
      ...(service ? { description: `${service.name} · ${formatZar(service.priceCents)}` } : {}),
    });
    sections.set(key, section);
  }

  return asInteractive(
    listMessage({
      header: service ? service.name : 'Book a spot',
      body: intro,
      buttonLabel: 'View times',
      sections: [...sections.values()],
    }),
  );
}

export function serviceList(tenant: TenantProfile, services: readonly ServiceSummary[]): OutboundMessage {
  if (services.length === 0) return noCatalog(tenant);
  return asInteractive(
    listMessage({
      header: 'Our prices',
      body: 'Choose a service to see open times 👇',
      buttonLabel: 'View services',
      sections: [
        {
          rows: services.slice(0, LIMITS.MAX_LIST_ROWS).map((service) => ({
            id: encodeServiceId(service.id),
            title: service.name,
            description: `${formatZar(service.priceCents)} · ${service.durationMinutes} min`,
          })),
        },
      ],
    }),
  );
}

/**
 * Compact product index. Uses Meta's native `product_list` when the tenant has
 * a linked catalog and every item is mapped to it; otherwise an equivalent
 * text-only `list`, which needs no catalog images at all.
 */
export function productIndex(
  tenant: TenantProfile,
  products: readonly ProductSummary[],
  size: number = PRODUCT_INDEX_SIZE,
): OutboundMessage {
  const items = products.slice(0, size);
  if (items.length === 0) return noCatalog(tenant);

  const retailerIds = items.map((product) => product.metaRetailerId);
  if (tenant.metaCatalogId && retailerIds.every((id): id is string => Boolean(id))) {
    return asInteractive(
      productList({
        header: tenant.businessName,
        body: 'Tap an item to view it and add it to your cart 🛒',
        catalogId: tenant.metaCatalogId,
        sections: [{ title: 'Popular', retailerIds }],
      }),
    );
  }

  return asInteractive(
    listMessage({
      header: tenant.businessName,
      body: 'Tap an item to order it 👇',
      buttonLabel: 'View items',
      sections: [
        {
          rows: items.map((product) => ({
            id: encodeProductId(product.id),
            title: product.name,
            description: [
              `${formatZar(product.priceCents)}${product.priceUnit ? ` ${product.priceUnit}` : ''}`,
              product.description,
            ]
              .filter(Boolean)
              .join(' · '),
          })),
        },
      ],
    }),
  );
}

export function locationAndHours(tenant: TenantProfile): OutboundMessage {
  const lines = [`📍 *${tenant.businessName}*`];
  if (tenant.addressLine) lines.push(tenant.addressLine);
  if (tenant.mapsUrl) lines.push(tenant.mapsUrl);
  lines.push('', '🕘 *Hours*', ...formatWorkingHours(tenant.workingHours));
  return asText(lines.join('\n'));
}

export function bookingConfirmed(tenant: TenantProfile, slot: TimeRange, service: ServiceSummary | null, confirmed: boolean): OutboundMessage {
  const when = `${formatDayLabel(slot.startsAt, tenant.timezone)} at ${formatTime(slot.startsAt, tenant.timezone)}`;
  const what = service ? ` for ${service.name} (${formatZar(service.priceCents)})` : '';
  const status = confirmed ? '✅ You’re booked' : '📝 Request received';
  const next = confirmed ? 'See you then!' : `${tenant.businessName} will confirm shortly.`;
  return asText(`${status}${what} on ${when}. ${next}\nReply MENU for options.`);
}

export function orderReceived(
  tenant: TenantProfile,
  reference: string,
  summary: string,
  totalCents: number,
  choice: FulfilmentChoice = { fulfilment: null },
): OutboundMessage {
  return asText(
    `🧾 Order *${reference}* received: ${summary}. Total ${formatZar(totalCents)}.\n` +
      (choice.fulfilment ? `${describeFulfilment(tenant, choice)}\n` : '') +
      `${tenant.businessName} will confirm availability and payment shortly. Reply MENU for options.`,
  );
}

export function describeFulfilment(tenant: TenantProfile, choice: FulfilmentChoice): string {
  if (choice.fulfilment === 'DELIVERY') {
    return `🚚 Delivery to ${choice.address}${choice.feeCents > 0 ? ` (delivery ${formatZar(choice.feeCents)})` : ''}`;
  }
  if (choice.fulfilment === 'COLLECTION') {
    return `🏪 Collect from ${tenant.addressLine ?? tenant.businessName}`;
  }
  return '';
}

/** @param note e.g. a stock warning, shown above the cart. */
export function cartSummary(lines: readonly CartLine[], note?: string): OutboundMessage {
  if (lines.length === 0) return asText(`${note ? `${note}\n` : ''}Your cart is empty. Reply MENU to start shopping.`);
  const subtotal = lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
  const body = [
    ...(note ? [note, ''] : []),
    '🛒 *Your cart*',
    ...lines.map((line) => `${line.quantity}× ${line.name} · ${formatZar(line.priceCents * line.quantity)}`),
    `Subtotal: *${formatZar(subtotal)}*`,
    '',
    'Tap an item again to add another.',
  ].join('\n');
  return asInteractive(
    replyButtons({
      body,
      buttons: [
        { id: CART_BUTTONS.CHECKOUT, title: '✅ Checkout' },
        { id: CART_BUTTONS.ADD_MORE, title: '🛍️ Add more' },
        { id: CART_BUTTONS.EMPTY, title: '🗑️ Empty cart' },
      ],
    }),
  );
}

export function fulfilmentChoice(tenant: TenantProfile, subtotalCents: number): OutboundMessage {
  const lines = [`Subtotal ${formatZar(subtotalCents)}. How would you like to get your order?`];
  lines.push(`🚚 Delivery: ${tenant.deliveryFeeCents > 0 ? `+${formatZar(tenant.deliveryFeeCents)}` : 'free'}${tenant.deliveryNote ? ` (${tenant.deliveryNote})` : ''}`);
  lines.push(`🏪 Collect: free${tenant.addressLine ? `, from ${tenant.addressLine}` : ''}`);
  return asInteractive(
    replyButtons({
      body: lines.join('\n'),
      buttons: [
        { id: CART_BUTTONS.DELIVERY, title: '🚚 Delivery' },
        { id: CART_BUTTONS.COLLECT, title: '🏪 Collect' },
      ],
    }),
  );
}

export function confirmAddress(address: string): OutboundMessage {
  return asInteractive(
    replyButtons({
      body: `Deliver to:\n${address}`,
      buttons: [
        { id: CART_BUTTONS.SAVED_ADDRESS, title: '✅ Use this address' },
        { id: CART_BUTTONS.NEW_ADDRESS, title: '✏️ New address' },
      ],
    }),
  );
}

export function askAddress(tenant: TenantProfile, retry = false): OutboundMessage {
  const note = tenant.deliveryNote ? `\n(${tenant.deliveryNote})` : '';
  return asText(
    retry
      ? `Sorry, that doesn't look like a full address. Please type it in one message: street and number, suburb, town and postal code.${note}`
      : `📍 Please type your delivery address in one message: street and number, suburb, town and postal code.${note}`,
  );
}

export function optedOut(tenant: TenantProfile): OutboundMessage {
  return asText(`You’ve been opted out and won’t receive further messages from ${tenant.businessName}. Send HI any time to start again.`);
}

function noCatalog(tenant: TenantProfile): OutboundMessage {
  return asText(`${tenant.businessName} hasn’t published a price list yet. Reply MENU for other options.`);
}
