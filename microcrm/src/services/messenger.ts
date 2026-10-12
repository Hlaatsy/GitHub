import { type MessageCategory, type PrismaClient } from '@prisma/client';
import { type Logger } from '../lib/logger';
import { maskMsisdn } from '../lib/msisdn';
import { describeMessage } from '../whatsapp/interactive';
import { type OutboundMessage } from '../whatsapp/types';
import { type WhatsAppService } from '../whatsapp/WhatsAppService';
import { type CustomerContext } from './customers';
import { type TenantProfile } from './tenants';
import { type DebitResult, type TopUpWarning, type WalletService } from './wallet';

export interface MessageCosts {
  /** Free-form reply inside the 24h customer service window. */
  serviceCents: number;
  utilityTemplateCents: number;
}

export interface OutboundMessengerDeps {
  prisma: PrismaClient;
  whatsapp: WhatsAppService;
  wallet: WalletService;
  logger: Logger;
  costs: MessageCosts;
  lowBalanceTemplate: string;
  templateLanguage: string;
}

export type ReplyOutcome =
  | { status: 'sent'; wamid: string; billing: DebitResult }
  | { status: 'skipped'; reason: 'WALLET_EMPTY'; topUpWarning: TopUpWarning }
  | { status: 'failed'; error: string };

export interface SendOptions {
  now: Date;
  /** Inbound wamid this message answers, if any. */
  inReplyTo?: string;
  /**
   * Transactional messages the customer has already paid for (e.g. payment
   * confirmations) go out even if the wallet is empty; the debit then takes
   * the balance negative and the next top-up settles it.
   */
  essential?: boolean;
}

/**
 * The only path that sends a customer-facing message: checks the prepaid
 * wallet, sends, records the cost and debits it.
 */
export class OutboundMessenger {
  constructor(private readonly deps: OutboundMessengerDeps) {}

  reply(
    tenant: TenantProfile,
    customer: CustomerContext,
    message: OutboundMessage,
    inReplyTo: string,
    now: Date,
  ): Promise<ReplyOutcome> {
    return this.send(tenant, customer, message, { now, inReplyTo });
  }

  async send(
    tenant: TenantProfile,
    customer: Pick<CustomerContext, 'id' | 'waId'>,
    message: OutboundMessage,
    { now, inReplyTo, essential = false }: SendOptions,
  ): Promise<ReplyOutcome> {
    const { prisma, whatsapp, wallet, logger } = this.deps;
    const category: MessageCategory = message.type === 'template' ? 'UTILITY' : 'SERVICE';
    const costCents = category === 'UTILITY' ? this.deps.costs.utilityTemplateCents : this.deps.costs.serviceCents;
    const log = logger.child({ tenantId: tenant.id, to: maskMsisdn(customer.waId), kind: describeMessage(message) });

    const funds = await wallet.balance(tenant.id);
    if (!funds || (!essential && funds.balanceCents < costCents)) {
      const warning = wallet.warning(
        tenant.id,
        funds?.balanceCents ?? 0,
        funds?.thresholdCents ?? 0,
        await wallet.claimLowBalanceNotice(tenant.id, now),
      );
      log.warn({ balanceCents: warning.balanceCents }, 'wallet cannot cover reply; not sending');
      await this.notifyLowBalance(tenant, warning);
      return { status: 'skipped', reason: 'WALLET_EMPTY', topUpWarning: warning };
    }

    let wamid: string;
    try {
      ({ wamid } = await whatsapp.sendMessage(tenant.waPhoneNumberId, customer.waId, message));
    } catch (error) {
      log.error({ err: error }, 'whatsapp send failed');
      return { status: 'failed', error: (error as Error).message };
    }

    const record = await prisma.outboundMessage.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        wamid,
        category,
        kind: describeMessage(message),
        costCents,
        inReplyTo: inReplyTo ?? null,
      },
    });
    const billing = await wallet.debitForMessage(tenant.id, costCents, record.id, now);
    log.info({ wamid, costCents, balanceCents: billing.balanceCents, lowBalance: billing.lowBalance }, 'reply sent');

    if (billing.topUpWarning) await this.notifyLowBalance(tenant, billing.topUpWarning);
    return { status: 'sent', wamid, billing };
  }

  /**
   * Top-up alert to the business owner via an approved utility template (the
   * owner is usually outside a service window). Absorbed by the platform: it is
   * logged at zero cost to the tenant.
   */
  async notifyLowBalance(tenant: TenantProfile, warning: TopUpWarning): Promise<void> {
    if (!warning.notifyOwner || !tenant.ownerWaId) return;
    const { prisma, whatsapp, logger, lowBalanceTemplate, templateLanguage } = this.deps;
    try {
      const { wamid } = await whatsapp.sendTemplate(tenant.waPhoneNumberId, tenant.ownerWaId, lowBalanceTemplate, templateLanguage, [
        tenant.businessName,
        warning.balance,
        warning.threshold,
      ]);
      await prisma.outboundMessage.create({
        data: { tenantId: tenant.id, wamid, category: 'UTILITY', kind: `template:${lowBalanceTemplate}`, costCents: 0 },
      });
      logger.info({ tenantId: tenant.id, balanceCents: warning.balanceCents }, 'low-balance warning sent to owner');
    } catch (error) {
      logger.error({ err: error, tenantId: tenant.id }, 'failed to send low-balance warning');
    }
  }
}
