export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function toWallClock(date: Date, timeZone: string): WallClock {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
  };
}

function offsetMs(instant: number, timeZone: string): number {
  const wall = toWallClock(new Date(instant), timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return wallAsUtc - Math.floor(instant / 60_000) * 60_000;
}

/** Converts a wall-clock time in `timeZone` to the UTC instant it denotes. */
export function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = naive - offsetMs(naive, timeZone);
  // A second pass settles instants that sit on a DST transition.
  return new Date(naive - offsetMs(first, timeZone));
}

export function parseHhmm(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function formatDayLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function localDateKey(date: Date, timeZone: string): string {
  const wall = toWallClock(date, timeZone);
  return `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
}
