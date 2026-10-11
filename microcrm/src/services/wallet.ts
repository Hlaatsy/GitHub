import { type PrismaClient } from '@prisma/client';
import { formatZar } from '../lib/money';

const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Returned whenever a debit leaves the wallet under its threshold (default R10.00). */
export interface TopUpWarning {
  code: 'WALLET_LOW_BALANCE';
  tenantId: string;
  balanceCents: number;
  thresholdCents: number;
  balance: string;
  threshold: string;
  /** True for exactly one caller per notice interval: that caller sends the WhatsApp alert. */
  notifyOwner: boolean;
}

export interface DebitResult {
  debitedCents: number;
  balanceCents: number;
  lowBalance: boolean;
  topUpWarning: TopUpWarning | null;
}

export interface WalletBalance {
  balanceCents: number;
  thresholdCents: number;
}

export class WalletService {
  constructor(private readonly prisma: PrismaClient) {}

  async balance(tenantId: string): Promise<WalletBalance | null> {
    const wallet = await this.prisma.tenantWallet.findUnique({
      where: { tenantId },
      select: { balanceCents: true, lowBalanceThresholdCents: true },
    });
    return wallet ? { balanceCents: wallet.balanceCents, thresholdCents: wallet.lowBalanceThresholdCents } : null;
  }

  /**
   * Debits one sent message. Runs after Meta has accepted the message, so it is
   * unconditional: concurrent sends may take the balance slightly negative,
   * which the next top-up settles. The unique `outboundMessageId` on the
   * ledger row makes a repeated call for the same message fail instead of
   * double-charging.
   */
  async debitForMessage(tenantId: string, costCents: number, outboundMessageId: string, now: Date): Promise<DebitResult> {
    const wallet =
      costCents === 0
        ? await this.prisma.tenantWallet.findUniqueOrThrow({ where: { tenantId } })
        : await this.prisma.$transaction(async (tx) => {
            const updated = await tx.tenantWallet.update({
              where: { tenantId },
              data: { balanceCents: { decrement: costCents } },
            });
            await tx.walletTransaction.create({
              data: {
                tenantId,
                type: 'MESSAGE_DEBIT',
                amountCents: -costCents,
                balanceAfterCents: updated.balanceCents,
                outboundMessageId,
              },
            });
            return updated;
          });

    const lowBalance = wallet.balanceCents < wallet.lowBalanceThresholdCents;
    return {
      debitedCents: costCents,
      balanceCents: wallet.balanceCents,
      lowBalance,
      topUpWarning: lowBalance
        ? this.warning(tenantId, wallet.balanceCents, wallet.lowBalanceThresholdCents, await this.claimLowBalanceNotice(tenantId, now))
        : null,
    };
  }

  /** Atomically claims the right to alert the owner, at most once per 24 hours. */
  async claimLowBalanceNotice(tenantId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.tenantWallet.updateMany({
      where: {
        tenantId,
        OR: [{ lowBalanceNotifiedAt: null }, { lowBalanceNotifiedAt: { lt: new Date(now.getTime() - NOTICE_INTERVAL_MS) } }],
      },
      data: { lowBalanceNotifiedAt: now },
    });
    return count === 1;
  }

  async topUp(tenantId: string, amountCents: number, reference: string): Promise<WalletBalance> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new RangeError('Top-up amount must be a positive number of cents');
    }
    return this.prisma.$transaction(async (tx) => {
      const credited = await tx.tenantWallet.update({
        where: { tenantId },
        data: { balanceCents: { increment: amountCents } },
      });
      const recovered = credited.balanceCents >= credited.lowBalanceThresholdCents;
      if (recovered && credited.lowBalanceNotifiedAt) {
        await tx.tenantWallet.update({ where: { tenantId }, data: { lowBalanceNotifiedAt: null } });
      }
      await tx.walletTransaction.create({
        data: { tenantId, type: 'TOP_UP', amountCents, balanceAfterCents: credited.balanceCents, reference },
      });
      return { balanceCents: credited.balanceCents, thresholdCents: credited.lowBalanceThresholdCents };
    });
  }

  warning(tenantId: string, balanceCents: number, thresholdCents: number, notifyOwner: boolean): TopUpWarning {
    return {
      code: 'WALLET_LOW_BALANCE',
      tenantId,
      balanceCents,
      thresholdCents,
      balance: formatZar(balanceCents),
      threshold: formatZar(thresholdCents),
      notifyOwner,
    };
  }
}
