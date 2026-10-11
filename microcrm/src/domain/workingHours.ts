import { z } from 'zod';
import { type Weekday } from '../lib/time';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

const OpeningWindow = z
  .object({ open: Hhmm, close: Hhmm })
  .refine((window) => window.open < window.close, 'open must be before close');

const DayWindows = z.array(OpeningWindow).max(4).default([]);

export const WorkingHoursSchema = z.object({
  mon: DayWindows,
  tue: DayWindows,
  wed: DayWindows,
  thu: DayWindows,
  fri: DayWindows,
  sat: DayWindows,
  sun: DayWindows,
});

export type WorkingHours = z.infer<typeof WorkingHoursSchema>;

export const CLOSED_ALL_WEEK: WorkingHours = {
  mon: [],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [],
};

const DISPLAY_ORDER: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function label(day: Weekday): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/** Compact hours summary that groups consecutive identical days: "Mon–Fri 08:00–17:00". */
export function formatWorkingHours(hours: WorkingHours): string[] {
  const describe = (day: Weekday): string =>
    hours[day].length === 0
      ? 'Closed'
      : hours[day].map((window) => `${window.open}–${window.close}`).join(', ');

  const lines: string[] = [];
  let runStart = 0;
  for (let index = 1; index <= DISPLAY_ORDER.length; index++) {
    const startDay = DISPLAY_ORDER[runStart] as Weekday;
    const current = DISPLAY_ORDER[index];
    if (current && describe(current) === describe(startDay)) continue;

    const endDay = DISPLAY_ORDER[index - 1] as Weekday;
    const days = startDay === endDay ? label(startDay) : `${label(startDay)}–${label(endDay)}`;
    lines.push(`${days} ${describe(startDay)}`);
    runStart = index;
  }
  return lines;
}
