import { type TenantProfile } from '../src/services/tenants';

const weekday = [{ open: '08:00', close: '17:00' }];

export function salonTenant(overrides: Partial<TenantProfile> = {}): TenantProfile {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    businessName: 'Glow Studio',
    industry: 'SALON',
    waPhoneNumberId: '100000000000001',
    ownerWaId: '27820000001',
    metaCatalogId: null,
    timezone: 'Africa/Johannesburg',
    workingHours: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: [{ open: '08:00', close: '14:00' }], sun: [] },
    slotIntervalMinutes: 30,
    defaultSlotMinutes: 60,
    bookingCapacity: 1,
    minLeadMinutes: 60,
    autoConfirmBookings: false,
    depositBps: 0,
    waDisplayPhone: '+27 11 000 0001',
    waBusinessAccountId: '200000000000001',
    addressLine: '12 Vilakazi St, Soweto',
    mapsUrl: null,
    mediaDownloadEnabled: false,
    ...overrides,
  };
}
