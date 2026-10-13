import { type IndustryType, type PrismaClient, type Tenant } from '@prisma/client';
import { type Logger } from '../lib/logger';
import { CLOSED_ALL_WEEK, WorkingHoursSchema, type WorkingHours } from '../domain/workingHours';

/** Everything a conversation needs about the tenant, resolved once per webhook change. */
export interface TenantProfile {
  id: string;
  businessName: string;
  industry: IndustryType;
  waPhoneNumberId: string;
  ownerWaId: string | null;
  metaCatalogId: string | null;
  timezone: string;
  workingHours: WorkingHours;
  slotIntervalMinutes: number;
  defaultSlotMinutes: number;
  bookingCapacity: number;
  minLeadMinutes: number;
  autoConfirmBookings: boolean;
  /** Upfront payment share in basis points; 0 means no online payment. */
  depositBps: number;
  waDisplayPhone: string;
  waBusinessAccountId: string | null;
  addressLine: string | null;
  mapsUrl: string | null;
  mediaDownloadEnabled: boolean;
  /** Shop fulfilment options; at least one should be on. */
  deliveryEnabled: boolean;
  deliveryFeeCents: number;
  deliveryNote: string | null;
  collectionEnabled: boolean;
}

interface CacheEntry {
  value: TenantProfile | null;
  expiresAt: number;
}

/**
 * Resolves Meta's `phone_number_id` to a tenant. This is the single point where
 * a webhook acquires tenant identity; nothing in the payload is trusted for it.
 * Lookups (including misses) are cached briefly to avoid a DB hit per message.
 */
export class TenantDirectory {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly ttlMs = 60_000,
  ) {}

  async byPhoneNumberId(phoneNumberId: string, now: number = Date.now()): Promise<TenantProfile | null> {
    const cached = this.cache.get(phoneNumberId);
    if (cached && cached.expiresAt > now) return cached.value;

    const row = await this.prisma.tenant.findUnique({ where: { waPhoneNumberId: phoneNumberId } });
    const value = row && row.active ? this.toProfile(row) : null;
    this.cache.set(phoneNumberId, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  /** Uncached: used off the hot path (payment settlement). */
  async byId(tenantId: string): Promise<TenantProfile | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    return row ? this.toProfile(row) : null;
  }

  invalidate(phoneNumberId: string): void {
    this.cache.delete(phoneNumberId);
  }

  private toProfile(row: Tenant): TenantProfile {
    const hours = WorkingHoursSchema.safeParse(row.workingHours);
    if (!hours.success) {
      this.logger.error({ tenantId: row.id, issues: hours.error.issues }, 'tenant working hours are invalid; treating as closed');
    }
    return {
      id: row.id,
      businessName: row.businessName,
      industry: row.industry,
      waPhoneNumberId: row.waPhoneNumberId,
      ownerWaId: row.ownerWaId,
      metaCatalogId: row.metaCatalogId,
      timezone: row.timezone,
      workingHours: hours.success ? hours.data : CLOSED_ALL_WEEK,
      slotIntervalMinutes: row.slotIntervalMinutes,
      defaultSlotMinutes: row.defaultSlotMinutes,
      bookingCapacity: row.bookingCapacity,
      minLeadMinutes: row.minLeadMinutes,
      autoConfirmBookings: row.autoConfirmBookings,
      depositBps: row.depositBps,
      waDisplayPhone: row.waDisplayPhone,
      waBusinessAccountId: row.waBusinessAccountId,
      addressLine: row.addressLine,
      mapsUrl: row.mapsUrl,
      mediaDownloadEnabled: row.mediaDownloadEnabled,
      deliveryEnabled: row.deliveryEnabled,
      deliveryFeeCents: row.deliveryFeeCents,
      deliveryNote: row.deliveryNote,
      collectionEnabled: row.collectionEnabled,
    };
  }
}
