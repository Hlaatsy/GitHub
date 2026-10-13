import { describe, expect, it } from 'vitest';
import { encodeSlotId, resolveIntent } from '../src/bot/intents';

const SERVICE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('resolveIntent', () => {
  it.each(['Hi', 'hi there!', 'BOOK', 'Price?', 'Sawubona', 'Dumêla'])('treats "%s" as a menu trigger', (text) => {
    expect(resolveIntent({ kind: 'text', text })).toEqual({ name: 'MENU' });
  });

  it('recognises opt-out phrases', () => {
    expect(resolveIntent({ kind: 'text', text: 'STOP' })).toEqual({ name: 'OPT_OUT' });
  });

  it('marks other free text as unrecognised, keeping the text (it may be an address)', () => {
    expect(resolveIntent({ kind: 'text', text: '12 Main Rd, Soweto 1804' })).toEqual({ name: 'UNRECOGNISED', text: '12 Main Rd, Soweto 1804' });
  });

  it('routes cart and checkout buttons', () => {
    const button = (id: string) => resolveIntent({ kind: 'button', id, title: '' });
    expect(button('cart:checkout')).toEqual({ name: 'CART_CHECKOUT' });
    expect(button('cart:add')).toEqual({ name: 'CART_ADD_MORE' });
    expect(button('cart:empty')).toEqual({ name: 'CART_EMPTY' });
    expect(button('ful:delivery')).toEqual({ name: 'CHOOSE_FULFILMENT', fulfilment: 'DELIVERY' });
    expect(button('ful:collect')).toEqual({ name: 'CHOOSE_FULFILMENT', fulfilment: 'COLLECTION' });
    expect(button('addr:saved')).toEqual({ name: 'USE_SAVED_ADDRESS' });
    expect(button('addr:new')).toEqual({ name: 'NEW_ADDRESS' });
  });

  it('routes menu buttons, including template quick replies', () => {
    expect(resolveIntent({ kind: 'button', id: 'menu:book', title: '' })).toEqual({ name: 'BOOK' });
    expect(resolveIntent({ kind: 'button', id: 'menu:location', title: '' })).toEqual({ name: 'LOCATION' });
    expect(resolveIntent({ kind: 'button', id: 'something-old', title: '' })).toEqual({ name: 'MENU' });
  });

  it('round-trips slot row ids', () => {
    const startsAt = new Date('2026-10-12T07:00:00Z');
    expect(resolveIntent({ kind: 'list', id: encodeSlotId(startsAt, SERVICE), title: '' })).toEqual({
      name: 'PICK_SLOT',
      startsAt,
      serviceId: SERVICE,
    });
  });

  it('falls back to the menu for malformed row ids', () => {
    expect(resolveIntent({ kind: 'list', id: 'prod:not-a-uuid', title: '' })).toEqual({ name: 'MENU' });
    expect(resolveIntent({ kind: 'list', id: "svc:1' OR 1=1", title: '' })).toEqual({ name: 'MENU' });
  });

  it('ignores unsupported message types', () => {
    expect(resolveIntent({ kind: 'unsupported', rawType: 'reaction' })).toEqual({ name: 'IGNORE' });
  });
});
