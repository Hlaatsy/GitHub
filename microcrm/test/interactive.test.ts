import { describe, expect, it } from 'vitest';
import { mainMenu, productIndex, slotList, type ProductSummary } from '../src/bot/replies';
import { InteractiveSpecError, LIMITS, clip, listMessage, replyButtons } from '../src/whatsapp/interactive';
import { salonTenant } from './fixtures';

const productId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function products(count: number, withRetailerIds = false): ProductSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: productId(i),
    name: `Item ${i}`,
    description: null,
    priceCents: 1000 * (i + 1),
    priceUnit: 'per day',
    metaRetailerId: withRetailerIds ? `sku-${i}` : null,
  }));
}

describe('main menu', () => {
  it('is a 3-button interactive matching the Meta reply-button object', () => {
    expect(mainMenu(salonTenant(), 'Thandi Mokoena')).toEqual({
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Glow Studio' },
        body: { text: 'Hi Thandi 👋 How can we help? Tap an option below.' },
        footer: { text: 'Reply STOP to opt out' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'menu:book', title: '📅 Book Spot/Order' } },
            { type: 'reply', reply: { id: 'menu:catalog', title: '🧾 Pricing/Catalog' } },
            { type: 'reply', reply: { id: 'menu:location', title: '📍 Location/Hours' } },
          ],
        },
      },
    });
  });

  it.each([
    ['SALON', '📅 Book Spot/Order'],
    ['DECOR_HIRE', '📅 Hire Items'],
    ['PRODUCT_SELLER', '🛍️ Shop Now'],
  ] as const)('words the first button for a %s business', (industry, title) => {
    const menu = mainMenu(salonTenant({ industry }), null);
    if (menu.type !== 'interactive' || menu.interactive.type !== 'button') throw new Error('expected buttons');
    expect(menu.interactive.action.buttons[0]?.reply).toEqual({ id: 'menu:book', title });
    expect(title.length).toBeLessThanOrEqual(20);
  });
});

describe('builders enforce Meta limits', () => {
  it('clips by UTF-16 length without splitting emoji', () => {
    const clipped = clip('😀'.repeat(15), LIMITS.BUTTON_TITLE);
    expect(clipped.length).toBeLessThanOrEqual(LIMITS.BUTTON_TITLE);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('rejects more than 3 buttons and duplicate titles', () => {
    const b = (id: string, title = id) => ({ id, title });
    expect(() => replyButtons({ body: 'x', buttons: [b('1'), b('2'), b('3'), b('4')] })).toThrow(InteractiveSpecError);
    expect(() => replyButtons({ body: 'x', buttons: [b('1', 'Same'), b('2', 'Same')] })).toThrow(InteractiveSpecError);
  });

  it('rejects lists over 10 rows and untitled multi-section lists', () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));
    expect(() => listMessage({ body: 'x', buttonLabel: 'Go', sections: [{ rows }] })).toThrow(InteractiveSpecError);
    expect(() =>
      listMessage({ body: 'x', buttonLabel: 'Go', sections: [{ rows: rows.slice(0, 1) }, { rows: rows.slice(1, 2) }] }),
    ).toThrow(InteractiveSpecError);
  });
});

describe('product index', () => {
  it('falls back to a 5-row text list without a catalog', () => {
    const message = productIndex(salonTenant({ industry: 'DECOR_HIRE' }), products(8));
    expect(message.type).toBe('interactive');
    if (message.type !== 'interactive' || message.interactive.type !== 'list') throw new Error('expected list');
    const rows = message.interactive.action.sections.flatMap((s) => s.rows);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ id: `prod:${productId(0)}`, title: 'Item 0', description: 'R10.00 per day' });
  });

  it('uses a native product_list when every item is in the Meta catalog', () => {
    const message = productIndex(salonTenant({ industry: 'PRODUCT_SELLER', metaCatalogId: '987654321' }), products(6, true));
    if (message.type !== 'interactive' || message.interactive.type !== 'product_list') throw new Error('expected product_list');
    expect(message.interactive.action.catalog_id).toBe('987654321');
    expect(message.interactive.action.sections[0]?.product_items).toHaveLength(5);
    expect(message.interactive.header).toEqual({ type: 'text', text: 'Glow Studio' });
  });
});

describe('slot list', () => {
  it('groups slots into one titled section per local day', () => {
    const tenant = salonTenant();
    const at = (iso: string) => new Date(iso);
    const message = slotList(
      tenant,
      [
        { startsAt: at('2026-10-12T07:00:00Z'), endsAt: at('2026-10-12T08:00:00Z') },
        { startsAt: at('2026-10-13T12:30:00Z'), endsAt: at('2026-10-13T13:30:00Z') },
      ],
      null,
    );
    if (message.type !== 'interactive' || message.interactive.type !== 'list') throw new Error('expected list');
    expect(message.interactive.action.sections).toEqual([
      { title: 'Mon 12 Oct', rows: [{ id: `slot:${at('2026-10-12T07:00:00Z').getTime() / 1000}:`, title: '09:00 – 10:00' }] },
      { title: 'Tue 13 Oct', rows: [{ id: `slot:${at('2026-10-13T12:30:00Z').getTime() / 1000}:`, title: '14:30 – 15:30' }] },
    ]);
  });
});
