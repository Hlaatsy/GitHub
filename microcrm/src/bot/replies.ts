import { formatWorkingHours } from '../domain/workingHours';
import { type TimeRange } from '../domain/slots';
import { formatZar } from '../lib/money';
import { formatDayLabel, formatTime, localDateKey } from '../lib/time';
import { type TenantProfile } from '../services/tenants';
import { asInteractive, asText, listMessage, productList, replyButtons, LIMITS } from '../whatsapp/interactive';
import { type ListRow, type OutboundMessage } from '../whatsapp/types';
import { MENU_BUTTONS, encodeProductId, encodeServiceId, encodeSlotId } from './intents';

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

export function mainMenu(tenant: TenantProfile, customerName: string | null): OutboundMessage {
  const firstName = customerName?.split(' ', 1)[0];
  return asInteractive(
    replyButtons({
      header: tenant.businessName,
      body: `Hi${firstName ? ` ${firstName}` : ''} 👋 How can we help? Tap an option below.`,
      footer: 'Reply STOP to opt out',
      buttons: [
        { id: MENU_BUTTONS.BOOK, title: '📅 Book Spot/Order' },
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

export function orderReceived(tenant: TenantProfile, reference: string, summary: string, totalCents: number): OutboundMessage {
  return asText(
    `🧾 Order *${reference}* received: ${summary}. Total ${formatZar(totalCents)}.\n` +
      `${tenant.businessName} will confirm availability and payment shortly. Reply MENU for options.`,
  );
}

export function optedOut(tenant: TenantProfile): OutboundMessage {
  return asText(`You’ve been opted out and won’t receive further messages from ${tenant.businessName}. Send HI any time to start again.`);
}

function noCatalog(tenant: TenantProfile): OutboundMessage {
  return asText(`${tenant.businessName} hasn’t published a price list yet. Reply MENU for other options.`);
}
