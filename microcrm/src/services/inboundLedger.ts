import { type PrismaClient } from '@prisma/client';
import { isUniqueViolation } from '../lib/prisma';

/**
 * Meta redelivers webhooks it thinks failed. Claiming each `wamid` once means a
 * redelivery can never produce (and bill) a second reply.
 */
export class InboundLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(tenantId: string, wamid: string, messageType: string): Promise<boolean> {
    try {
      await this.prisma.inboundMessage.create({
        data: { wamid, tenantId, messageType: messageType.slice(0, 24) },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Data minimisation: the ledger is only needed for the redelivery window. */
  async prune(olderThanDays = 30, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);
    const { count } = await this.prisma.inboundMessage.deleteMany({ where: { receivedAt: { lt: cutoff } } });
    return count;
  }
}
