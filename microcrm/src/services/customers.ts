import { type PrismaClient } from '@prisma/client';

export interface CustomerContext {
  id: string;
  waId: string;
  displayName: string | null;
  optedOutAt: Date | null;
  lastMenuSentAt: Date | null;
}

const customerSelect = {
  id: true,
  waId: true,
  displayName: true,
  optedOutAt: true,
  lastMenuSentAt: true,
} as const;

const MAX_NAME_LENGTH = 80;

/** All reads and writes are keyed by (tenantId, ...): a customer never resolves across tenants. */
export class CustomerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  touch(tenantId: string, waId: string, profileName: string | undefined, now: Date): Promise<CustomerContext> {
    const displayName = profileName?.trim().slice(0, MAX_NAME_LENGTH) || null;
    return this.prisma.customer.upsert({
      where: { tenantId_waId: { tenantId, waId } },
      create: { tenantId, waId, displayName, firstContactAt: now, lastInboundAt: now },
      update: { lastInboundAt: now, ...(displayName ? { displayName } : {}) },
      select: customerSelect,
    });
  }

  async optOut(tenantId: string, customerId: string, now: Date): Promise<void> {
    await this.prisma.customer.update({
      where: { tenantId_id: { tenantId, id: customerId } },
      data: { optedOutAt: now, marketingConsentAt: null },
    });
  }

  /** The customer messaged a trigger word after opting out: they have re-initiated contact. */
  async optBackIn(tenantId: string, customerId: string): Promise<void> {
    await this.prisma.customer.update({
      where: { tenantId_id: { tenantId, id: customerId } },
      data: { optedOutAt: null },
    });
  }

  async markMenuSent(tenantId: string, customerId: string, now: Date): Promise<void> {
    await this.prisma.customer.update({
      where: { tenantId_id: { tenantId, id: customerId } },
      data: { lastMenuSentAt: now },
    });
  }
}
