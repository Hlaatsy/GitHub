import { describe, expect, it } from 'vitest';
import { generateAvailableSlots, spreadEvenly, type SlotQuery } from '../src/domain/slots';
import { formatWorkingHours } from '../src/domain/workingHours';
import { salonTenant } from './fixtures';

const tenant = salonTenant();

function query(overrides: Partial<SlotQuery> = {}): SlotQuery {
  return {
    // Sunday 11 Oct 2026, 20:00 SAST.
    now: new Date('2026-10-11T18:00:00Z'),
    timeZone: tenant.timezone,
    workingHours: tenant.workingHours,
    durationMinutes: 60,
    intervalMinutes: 30,
    minLeadMinutes: 60,
    horizonHours: 48,
    capacity: 1,
    busy: [],
    ...overrides,
  };
}

const sast = (date: Date) => date.toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg', weekday: 'short', hour: '2-digit', minute: '2-digit' });

describe('generateAvailableSlots', () => {
  it('offers Monday and Tuesday business hours within 48 hours, nothing on Sunday', () => {
    const slots = generateAvailableSlots(query());
    expect(sast(slots[0]!.startsAt)).toBe('Mon 08:00');
    // Horizon ends Tue 20:00 SAST; last start is 16:00 so a 60 min slot ends at close.
    expect(sast(slots.at(-1)!.startsAt)).toBe('Tue 16:00');
    expect(slots).toHaveLength(2 * 17);
  });

  it('respects the minimum lead time', () => {
    const slots = generateAvailableSlots(query({ now: new Date('2026-10-12T08:10:00Z') })); // Mon 10:10
    expect(sast(slots[0]!.startsAt)).toBe('Mon 11:30');
  });

  it('removes slots that overlap bookings at capacity', () => {
    const busy = [{ startsAt: new Date('2026-10-12T06:00:00Z'), endsAt: new Date('2026-10-12T07:00:00Z') }]; // Mon 08:00-09:00
    const starts = generateAvailableSlots(query({ busy })).map((s) => sast(s.startsAt));
    expect(starts).not.toContain('Mon 08:00');
    expect(starts).not.toContain('Mon 08:30');
    expect(starts).toContain('Mon 09:00');

    const withTwoChairs = generateAvailableSlots(query({ busy, capacity: 2 })).map((s) => sast(s.startsAt));
    expect(withTwoChairs).toContain('Mon 08:00');
  });

  it('spreads a long list evenly to 10 rows covering both days', () => {
    const picked = spreadEvenly(generateAvailableSlots(query()), 10);
    expect(picked).toHaveLength(10);
    expect(sast(picked[0]!.startsAt)).toBe('Mon 08:00');
    expect(sast(picked.at(-1)!.startsAt)).toBe('Tue 16:00');
  });
});

describe('formatWorkingHours', () => {
  it('groups consecutive identical days', () => {
    expect(formatWorkingHours(tenant.workingHours)).toEqual(['Mon–Fri 08:00–17:00', 'Sat 08:00–14:00', 'Sun Closed']);
  });
});
