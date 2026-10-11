import { WEEKDAYS, parseHhmm, toWallClock, wallClockToUtc } from '../lib/time';
import { type WorkingHours } from './workingHours';

export interface TimeRange {
  startsAt: Date;
  endsAt: Date;
}

export interface SlotQuery {
  now: Date;
  timeZone: string;
  workingHours: WorkingHours;
  durationMinutes: number;
  intervalMinutes: number;
  minLeadMinutes: number;
  horizonHours: number;
  capacity: number;
  /** Existing PENDING/CONFIRMED bookings that overlap the horizon. */
  busy: readonly TimeRange[];
}

const MINUTE_MS = 60_000;
const MAX_DAYS_SCANNED = 8;

/** Every bookable slot whose start falls within the horizon, earliest first. */
export function generateAvailableSlots(query: SlotQuery): TimeRange[] {
  const { now, timeZone, workingHours, durationMinutes, intervalMinutes, capacity, busy } = query;
  const earliestStart = now.getTime() + query.minLeadMinutes * MINUTE_MS;
  const horizonEnd = now.getTime() + query.horizonHours * 60 * MINUTE_MS;
  const today = toWallClock(now, timeZone);
  const slots: TimeRange[] = [];

  for (let offset = 0; offset < MAX_DAYS_SCANNED; offset++) {
    const calendarDay = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const year = calendarDay.getUTCFullYear();
    const month = calendarDay.getUTCMonth() + 1;
    const day = calendarDay.getUTCDate();
    if (wallClockToUtc(year, month, day, 0, 0, timeZone).getTime() > horizonEnd) break;

    const weekday = WEEKDAYS[calendarDay.getUTCDay()];
    if (!weekday) continue;

    for (const window of workingHours[weekday]) {
      const close = parseHhmm(window.close);
      for (let minute = parseHhmm(window.open); minute + durationMinutes <= close; minute += intervalMinutes) {
        const startsAt = wallClockToUtc(year, month, day, Math.floor(minute / 60), minute % 60, timeZone);
        const start = startsAt.getTime();
        if (start > horizonEnd) break;
        if (start < earliestStart) continue;

        const endsAt = new Date(start + durationMinutes * MINUTE_MS);
        const overlapping = busy.filter((range) => range.startsAt < endsAt && range.endsAt > startsAt).length;
        if (overlapping < capacity) slots.push({ startsAt, endsAt });
      }
    }
  }

  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export function isSlotAvailable(query: SlotQuery, startsAt: Date): boolean {
  return generateAvailableSlots(query).some((slot) => slot.startsAt.getTime() === startsAt.getTime());
}

/** Picks `max` items spread evenly across the list so both days of the horizon are offered. */
export function spreadEvenly<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max <= 1) return items.slice(0, Math.max(max, 0));
  const picked: T[] = [];
  for (let index = 0; index < max; index++) {
    const item = items[Math.round((index * (items.length - 1)) / (max - 1))];
    if (item !== undefined) picked.push(item);
  }
  return picked;
}
