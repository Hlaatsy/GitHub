import { type PrismaClient } from '@prisma/client';
import { type Logger } from '../lib/logger';
import { formatZar } from '../lib/money';
import { maskMsisdn, normaliseWaId } from '../lib/msisdn';
import { formatDayLabel, formatTime } from '../lib/time';
import { type OutboundMessenger } from '../services/messenger';
import { type TenantProfile } from '../services/tenants';
import { type WalletService } from '../services/wallet';
import { type FailedStatus } from '../webhooks/schema';
import { type SmsProvider } from './provider';
import { measureSms } from './segments';

/**
 * Meta error codes where WhatsApp cannot reach the person at all, so SMS is
 * the only way through. Other failures are deliberately excluded: throttling
 * (131056) clears on its own, 131047 needs a template rather than SMS, and
 * 131049 means Meta chose not to deliver, which SMS should not route around.
 */
export const UNDELIVERABLE_CODES: ReadonlySet<number> = new Set([131026]);

export interface SmsFallbackDeps {
  prisma: PrismaClient;
  provider: SmsProvider;
  wallet: WalletService;
  messenger: Pick<OutboundMessenger, 'notifyLowBalance'>;
  logger: Logger;
}

export interface SmsFallbackOptions {
  publicBaseUrl: string;
  costPerSegmentCents: number;
}

export type SmsFallbackResult =
  | { status: 'sent'; segments: number; costCents: number }
  | {
      status: 'skipped';
      reason:
        | 'NOT_UNDELIVERABLE'
        | 'NOT_A_PAY_LINK'
        | 'RECIPIENT_MISMATCH'
        | 'NO_LONGER_PAYABLE'
        | 'OPTED_OUT'
        | 'ALREADY_SENT'
        | 'WALLET_EMPTY'
        | 'PROVIDER_ERROR';
    };

/**
 * Re-sends an undeliverable WhatsApp pay link by SMS, at most once per
 * payment, billed per segment to the tenant's wallet.
 */
export class SmsFallbackService {
  private readonly publicOrigin: string;

  constructor(
    private readonly deps: SmsFallbackDeps,
    private readonly options: SmsFallbackOptions,
  ) {
    this.publicOrigin = new URL(options.publicBaseUrl).origin;
  }

  async handleFailedStatus(tenant: TenantProfile, status: FailedStatus, now: Date): Promise<SmsFallbackResult> {
    const { prisma, provider, wallet, messenger, logger } = this.deps;

    if (!status.errors.some((error) => UNDELIVERABLE_CODES.has(error.code))) {
      return { status: 'skipped', reason: 'NOT_UNDELIVERABLE' };
    }

    // Tenant-scoped: a status for one business can never reach another's payment.
    const intent = await prisma.paymentIntent.findFirst({
      where: { tenantId: tenant.id, payLinkWamid: status.id },
      include: {
        customer: { select: { id: true, waId: true, optedOutAt: true } },
        appointment: { select: { startsAt: true, service: { select: { name: true } } } },
        order: { select: { reference: true } },
      },
    });
    if (!intent) return { status: 'skipped', reason: 'NOT_A_PAY_LINK' };

    const log = logger.child({ tenantId: tenant.id, intentId: intent.id, to: maskMsisdn(intent.customer.waId) });

    let recipient: string;
    try {
      recipient = normaliseWaId(status.recipient_id);
    } catch {
      recipient = '';
    }
    if (recipient !== intent.customer.waId) {
      log.warn('failed-status recipient does not match the payment customer');
      return { status: 'skipped', reason: 'RECIPIENT_MISMATCH' };
    }
    if (intent.status !== 'PENDING' || intent.expiresAt <= now) return { status: 'skipped', reason: 'NO_LONGER_PAYABLE' };
    if (intent.customer.optedOutAt) return { status: 'skipped', reason: 'OPTED_OUT' };

    const body = this.composeBody(tenant, intent);
    const size = measureSms(body);
    const costCents = size.segments * this.options.costPerSegmentCents;

    const funds = await wallet.balance(tenant.id);
    if (!funds || funds.balanceCents < costCents) {
      log.warn({ costCents }, 'wallet cannot cover SMS fallback');
      if (await wallet.claimLowBalanceNotice(tenant.id, now)) {
        await messenger.notifyLowBalance(tenant, wallet.warning(tenant.id, funds?.balanceCents ?? 0, funds?.thresholdCents ?? 0, true));
      }
      return { status: 'skipped', reason: 'WALLET_EMPTY' };
    }

    // At-most-once: claim before sending and never release. Meta may
    // re-deliver the same status, and a timed-out provider call may still
    // have been delivered, so a retry could double-text and double-bill.
    const claim = await prisma.paymentIntent.updateMany({
      where: { id: intent.id, smsFallbackSentAt: null },
      data: { smsFallbackSentAt: now },
    });
    if (claim.count === 0) return { status: 'skipped', reason: 'ALREADY_SENT' };

    let providerMessageId: string;
    try {
      ({ providerMessageId } = await provider.send(intent.customer.waId, body, size.encoding));
    } catch (error) {
      log.error({ err: error }, 'SMS fallback send failed');
      return { status: 'skipped', reason: 'PROVIDER_ERROR' };
    }

    const record = await prisma.outboundMessage.create({
      data: {
        tenantId: tenant.id,
        customerId: intent.customer.id,
        wamid: `${provider.name}:${providerMessageId}`,
        category: 'SMS',
        kind: 'sms:payment_link',
        costCents,
        inReplyTo: status.id,
      },
    });
    const billing = await wallet.debitForMessage(tenant.id, costCents, record.id, now);
    if (billing.topUpWarning?.notifyOwner) await messenger.notifyLowBalance(tenant, billing.topUpWarning);

    log.info({ segments: size.segments, encoding: size.encoding, costCents }, 'pay link re-sent by SMS');
    return { status: 'sent', segments: size.segments, costCents };
  }

  /**
   * Names the business and the amount up front, so it does not read like the
   * anonymous "your payment failed, click here" SMS phishing customers ignore.
   * Plain ASCII keeps it in GSM-7: one segment for typical names.
   */
  private composeBody(
    tenant: TenantProfile,
    intent: {
      linkToken: string;
      amountCents: number;
      expiresAt: Date;
      appointment: { startsAt: Date; service: { name: string } | null } | null;
      order: { reference: string } | null;
    },
  ): string {
    const what = intent.appointment
      ? `${intent.appointment.service?.name ?? 'your booking'} ${formatDayLabel(intent.appointment.startsAt, tenant.timezone)} ${formatTime(intent.appointment.startsAt, tenant.timezone)}`
      : `order ${intent.order?.reference ?? ''}`.trim();
    const until = formatTime(intent.expiresAt, tenant.timezone);
    return `${tenant.businessName}: pay ${formatZar(intent.amountCents)} to confirm ${what}: ${this.publicOrigin}/pay/${intent.linkToken} (valid until ${until})`;
  }
}
