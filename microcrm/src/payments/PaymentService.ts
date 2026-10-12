import { randomBytes, randomInt } from 'node:crypto';
import { Prisma, type PaymentIntent, type PaymentProvider, type PrismaClient } from '@prisma/client';
import { type Logger } from '../lib/logger';
import { maskMsisdn } from '../lib/msisdn';
import { isSerializationFailure } from '../lib/prisma';
import { formatDayLabel, formatTime } from '../lib/time';
import { type OutboundMessenger } from '../services/messenger';
import { type TenantDirectory, type TenantProfile } from '../services/tenants';
import { clip } from '../whatsapp/interactive';
import { PaymentError } from './errors';
import { type NotificationContext, type PaymentGateway, type ProviderTransaction } from './gateway';
import { formatPaymentConfirmedTemplate, type PaymentLinkView } from './messages';
import { zarToCents } from './money';

export interface PaymentServiceOptions {
  /** e.g. https://yourdomain.co.za — origin of the webhook and short links. */
  publicBaseUrl: string;
  linkTtlMinutes: number;
  maxAmountCents: number;
  confirmationTemplate: string;
  templateLanguage: string;
  /** Unpaid intents are expired, and their holds released, this long after the link expires. */
  expiryGraceMinutes?: number;
}

export interface PaymentServiceDeps {
  prisma: PrismaClient;
  /** Configured gateways. Each intent remembers which one it was created with. */
  gateways: Partial<Record<PaymentProvider, PaymentGateway>>;
  /** Used for new links unless the business has its own `paymentProvider`. */
  defaultProvider: PaymentProvider;
  messenger: OutboundMessenger;
  tenants: TenantDirectory;
  logger: Logger;
}

export interface PaymentLink extends PaymentLinkView {
  intentId: string;
  reference: string;
  checkoutUrl: string;
}

export type NotificationResult =
  | { status: 'ignored'; reason: 'NOT_A_PAYMENT_EVENT' }
  | { status: 'settled'; intentId: string; confirmed: boolean; customerNotified: boolean }
  | { status: 'duplicate' | 'pending' | 'failed'; intentId: string }
  | { status: 'ignored'; reason: 'UNKNOWN_REFERENCE' }
  | { status: 'rejected'; intentId: string; reason: 'NOT_CONFIRMED_BY_PROVIDER' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'PROVIDER_MISMATCH' };

export type LinkResolution =
  | { action: 'redirect'; url: string }
  /** The browser must POST these signed fields to the provider (PayFast). */
  | { action: 'form'; url: string; fields: Record<string, string> }
  | { action: 'show'; state: 'paid' | 'processing' | 'expired' | 'unknown'; businessName?: string; waDisplayPhone?: string };

export interface ReconcileSummary {
  checked: number;
  settled: number;
  expired: number;
  notified: number;
}

type Subject =
  | { kind: 'appointment'; id: string; customerId: string; status: string; totalCents: number; holdExpiresAt: Date | null }
  | { kind: 'order'; id: string; customerId: string; status: string; totalCents: number; holdExpiresAt: null };

interface SettlementOutcome {
  confirmed: boolean;
  reviewReason: string | null;
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Where each provider reports settlements (must match the routes in app.ts). */
export const SETTLEMENT_PATHS: Readonly<Record<PaymentProvider, string>> = {
  OZOW: '/webhooks/payments',
  PAYFAST: '/api/payments/payfast-itn',
  PAYSTACK: '/api/payments/callback',
};
const LINK_REUSE_MIN_REMAINING_MS = 5 * 60_000;
const RECONCILE_MIN_AGE_MS = 2 * 60_000;
const NOTIFY_RETRY_WINDOW_MS = 24 * 60 * 60_000;
const SETTLEMENT_TX = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 };
const ACTIVE_BOOKING = (now: Date): Prisma.AppointmentWhereInput[] => [
  { status: { in: ['PENDING', 'CONFIRMED'] } },
  { status: 'PENDING_DEPOSIT', holdExpiresAt: { gt: now } },
];

/**
 * Pay-by-bank for appointments and orders, wired into the WhatsApp flow:
 * link generation, verified settlement, status flip and one confirmation
 * template. Settlement is idempotent: every state change is a conditional
 * update, so duplicate notifications, concurrent reconcilers and retries
 * converge on one outcome and one customer message.
 */
export class PaymentService {
  private readonly publicOrigin: string;
  private readonly expiryGraceMs: number;

  constructor(
    private readonly deps: PaymentServiceDeps,
    private readonly options: PaymentServiceOptions,
  ) {
    const base = new URL(options.publicBaseUrl);
    if (base.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must be https');
    this.publicOrigin = base.origin;
    this.expiryGraceMs = (options.expiryGraceMinutes ?? 60) * 60_000;
  }

  /** Settlement URL of the default provider; any of this service's settlement URLs is accepted as callbackUrl. */
  get webhookUrl(): string {
    return this.settlementUrl(this.deps.defaultProvider);
  }

  settlementUrl(provider: PaymentProvider): string {
    return `${this.publicOrigin}${SETTLEMENT_PATHS[provider]}`;
  }

  /** Tenant-scoped facade: callers can only reach their own tenant's orders and appointments. */
  forTenant(tenantId: string) {
    return {
      generateWhatsAppPaymentLink: (orderId: string, amountZAR: number, callbackUrl: string, now: Date = new Date()) =>
        this.generateLink(tenantId, orderId, amountZAR, callbackUrl, now),
    };
  }

  // -------------------------------------------------------------------------
  // 1. Link generation
  // -------------------------------------------------------------------------

  private async generateLink(tenantId: string, subjectId: string, amountZAR: number, callbackUrl: string, now: Date): Promise<PaymentLink> {
    const { prisma, logger } = this.deps;
    const amountCents = zarToCents(amountZAR);
    if (amountCents > this.options.maxAmountCents) {
      throw new PaymentError('REQUEST_INVALID', `Amount exceeds the R${this.options.maxAmountCents / 100} limit`);
    }
    this.assertOwnUrl(callbackUrl);

    const subject = await this.loadSubject(tenantId, subjectId);
    if (!subject || subject.status !== 'PENDING_DEPOSIT') {
      throw new PaymentError('REQUEST_INVALID', 'Only bookings or orders awaiting a deposit can be paid');
    }
    if (amountCents > subject.totalCents) {
      throw new PaymentError('REQUEST_INVALID', 'Amount exceeds the outstanding total');
    }

    const subjectKey = subject.kind === 'appointment' ? { appointmentId: subject.id } : { orderId: subject.id };

    // Hand back the live link rather than opening a second checkout session.
    const live = await prisma.paymentIntent.findFirst({
      where: {
        tenantId,
        ...subjectKey,
        status: 'PENDING',
        amountCents,
        checkoutUrl: { not: null },
        expiresAt: { gt: new Date(now.getTime() + LINK_REUSE_MIN_REMAINING_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (live?.checkoutUrl) return this.toLink(live, live.checkoutUrl);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessName: true, paymentProvider: true } });
    const gateway = this.gatewayFor(tenant.paymentProvider ?? this.deps.defaultProvider);
    // Each provider reports to its own endpoint, whichever of ours the caller passed:
    // a PayFast ITN sent to the Ozow endpoint would be refused as unsigned.
    const notifyUrl = this.settlementUrl(gateway.provider);

    // A link must never outlive the slot hold it pays for.
    const ttlExpiry = now.getTime() + this.options.linkTtlMinutes * 60_000;
    const expiresAt = new Date(subject.holdExpiresAt ? Math.min(ttlExpiry, subject.holdExpiresAt.getTime()) : ttlExpiry);

    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId,
        customerId: subject.customerId,
        ...subjectKey,
        provider: gateway.provider,
        reference: newReference(),
        linkToken: randomBytes(24).toString('base64url'),
        amountCents,
        expiresAt,
      },
    });

    const returnUrl = (result: string) => `${this.publicOrigin}/pay/${intent.linkToken}/return?result=${result}`;
    let created;
    try {
      created = await gateway.createPayment({
        reference: intent.reference,
        amountCents,
        description: `${tenant.businessName} ${subject.kind === 'appointment' ? 'booking' : 'order'} deposit ${intent.reference}`,
        notifyUrl,
        successUrl: returnUrl('success'),
        cancelUrl: returnUrl('cancelled'),
        errorUrl: returnUrl('error'),
      });
    } catch (error) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'FAILED', failureReason: clip((error as Error).message, 200) },
      });
      logger.error({ err: error, tenantId, intentId: intent.id }, 'payment link generation failed');
      throw error;
    }

    const updated = await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        providerPaymentId: created.providerPaymentId,
        checkoutUrl: created.checkout.url,
        // Stored as ordered [key, value] pairs: jsonb does not keep object key
        // order, and the form must reach PayFast in the order it was signed.
        checkoutFields: created.checkout.method === 'POST' ? Object.entries(created.checkout.fields) : Prisma.DbNull,
      },
    });
    logger.info({ tenantId, intentId: intent.id, amountCents, provider: gateway.provider }, 'payment link created');
    return this.toLink(updated, created.checkout.url);
  }

  // -------------------------------------------------------------------------
  // 3. Settlement webhook
  // -------------------------------------------------------------------------

  /** Providers with a configured gateway, i.e. the settlement endpoints to expose. */
  get providers(): PaymentProvider[] {
    return Object.keys(this.deps.gateways) as PaymentProvider[];
  }

  async handleNotification(provider: PaymentProvider, context: NotificationContext, now: Date = new Date()): Promise<NotificationResult> {
    const { prisma, logger } = this.deps;
    const gateway = this.gatewayFor(provider);
    const notification = await gateway.verifyNotification(context);
    if (!notification) return { status: 'ignored', reason: 'NOT_A_PAYMENT_EVENT' };

    const intent = await prisma.paymentIntent.findUnique({ where: { reference: notification.reference } });
    if (!intent) {
      logger.warn({ reference: notification.reference, provider }, 'payment notification for unknown reference');
      return { status: 'ignored', reason: 'UNKNOWN_REFERENCE' };
    }
    // An authentic notification from one provider can never settle another provider's payment.
    if (intent.provider !== provider) {
      logger.warn({ intentId: intent.id, provider, intentProvider: intent.provider }, 'notification from the wrong provider');
      return { status: 'rejected', intentId: intent.id, reason: 'PROVIDER_MISMATCH' };
    }
    if (notification.outcome === 'PENDING') return { status: 'pending', intentId: intent.id };

    // The push is a hint, not proof: the provider's own record of the
    // transaction decides the outcome before any booking is touched.
    const verified = await gateway.confirmTransaction(notification, context);
    if (!verified) {
      logger.warn({ intentId: intent.id, pushed: notification.rawStatus }, 'notification not confirmed by provider');
      return { status: 'rejected', intentId: intent.id, reason: 'NOT_CONFIRMED_BY_PROVIDER' };
    }
    if (verified.outcome !== notification.outcome) {
      logger.warn({ intentId: intent.id, pushed: notification.rawStatus, verified: verified.rawStatus }, 'provider status differs from notification; using provider');
    }
    return this.applyOutcome(intent, verified, now);
  }

  /** Reconciliation lookup by reference; null when the provider has no lookup API (PayFast). */
  private async lookupByReference(intent: PaymentIntent): Promise<ProviderTransaction | null> {
    const gateway = this.deps.gateways[intent.provider];
    if (!gateway?.supportsLookup) return null;
    const transactions = await gateway.fetchTransactions(intent.reference);
    return transactions.find((tx) => tx.outcome === 'SUCCESSFUL') ?? transactions[0] ?? null;
  }

  private gatewayFor(provider: PaymentProvider): PaymentGateway {
    const gateway = this.deps.gateways[provider];
    if (!gateway) throw new PaymentError('REQUEST_INVALID', `Payment provider ${provider} is not configured`);
    return gateway;
  }

  private async applyOutcome(intent: PaymentIntent, tx: ProviderTransaction, now: Date): Promise<NotificationResult> {
    const { prisma, logger } = this.deps;

    if (tx.outcome === 'PENDING') return { status: 'pending', intentId: intent.id };

    if (tx.outcome !== 'SUCCESSFUL') {
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: 'PENDING' },
        data: { status: tx.outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED', failureReason: clip(tx.rawStatus, 200) },
      });
      return { status: 'failed', intentId: intent.id };
    }

    if (tx.currency !== intent.currency || tx.amountCents !== intent.amountCents) {
      const reason = tx.currency !== intent.currency ? 'CURRENCY_MISMATCH' : 'AMOUNT_MISMATCH';
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { reviewRequired: true, failureReason: reason } });
      logger.error({ intentId: intent.id, expected: intent.amountCents, received: tx.amountCents, currency: tx.currency }, 'paid amount does not match intent');
      return { status: 'rejected', intentId: intent.id, reason };
    }

    const outcome = await this.settle(intent, tx, now);
    if (!outcome) return { status: 'duplicate', intentId: intent.id };

    if (outcome.reviewReason) {
      logger.error({ intentId: intent.id, reason: outcome.reviewReason }, 'payment settled but needs manual review');
    }
    const customerNotified = outcome.confirmed ? await this.notifyCustomer(intent.id, now) : false;
    return { status: 'settled', intentId: intent.id, confirmed: outcome.confirmed, customerNotified };
  }

  /** Returns null when another worker already settled this intent. */
  private async settle(intent: PaymentIntent, tx: ProviderTransaction, now: Date): Promise<SettlementOutcome | null> {
    try {
      return await this.deps.prisma.$transaction(async (db) => {
        // Money received is the source of truth: a late payment on an expired
        // or cancelled intent is still recorded as settled.
        const claimed = await db.paymentIntent.updateMany({
          where: { id: intent.id, status: { not: 'SUCCEEDED' } },
          data: { status: 'SUCCEEDED', settledAt: now, providerTransactionId: tx.providerTransactionId },
        });
        if (claimed.count === 0) return null;

        const outcome = intent.appointmentId
          ? await this.confirmAppointment(db, intent.tenantId, intent.appointmentId, now)
          : await this.confirmOrder(db, intent.tenantId, intent.orderId as string);

        if (outcome.reviewReason) {
          await db.paymentIntent.update({ where: { id: intent.id }, data: { reviewRequired: true, failureReason: outcome.reviewReason } });
        }
        return outcome;
      }, SETTLEMENT_TX);
    } catch (error) {
      if (isSerializationFailure(error) || isTransactionTimeout(error)) {
        throw new PaymentError('SETTLEMENT_CONFLICT', 'Settlement transaction did not complete; retry', { cause: error });
      }
      throw error;
    }
  }

  private async confirmAppointment(db: Prisma.TransactionClient, tenantId: string, id: string, now: Date): Promise<SettlementOutcome> {
    const flipped = await db.appointment.updateMany({
      where: { tenantId, id, status: 'PENDING_DEPOSIT' },
      data: { status: 'CONFIRMED', holdExpiresAt: null },
    });
    if (flipped.count === 0) return { confirmed: false, reviewReason: 'BOOKING_NO_LONGER_PENDING_DEPOSIT' };

    // If the hold lapsed before payment, someone else may have taken the slot.
    // The paying customer keeps it; the business is flagged to sort it out.
    const [booking, tenant] = await Promise.all([
      db.appointment.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id } }, select: { startsAt: true, endsAt: true } }),
      db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { bookingCapacity: true } }),
    ]);
    const others = await db.appointment.count({
      where: {
        tenantId,
        id: { not: id },
        startsAt: { lt: booking.endsAt },
        endsAt: { gt: booking.startsAt },
        OR: ACTIVE_BOOKING(now),
      },
    });
    return { confirmed: true, reviewReason: others >= tenant.bookingCapacity ? 'SLOT_OVERBOOKED' : null };
  }

  private async confirmOrder(db: Prisma.TransactionClient, tenantId: string, id: string): Promise<SettlementOutcome> {
    const flipped = await db.order.updateMany({
      where: { tenantId, id, status: 'PENDING_DEPOSIT' },
      data: { status: 'CONFIRMED' },
    });
    return flipped.count === 1 ? { confirmed: true, reviewReason: null } : { confirmed: false, reviewReason: 'ORDER_NO_LONGER_PENDING_DEPOSIT' };
  }

  // -------------------------------------------------------------------------
  // 4. Confirmation
  // -------------------------------------------------------------------------

  /** Claims, then sends, exactly one confirmation per settled intent. */
  private async notifyCustomer(intentId: string, now: Date): Promise<boolean> {
    const { prisma, messenger, tenants, logger } = this.deps;

    const claim = await prisma.paymentIntent.updateMany({
      where: { id: intentId, status: 'SUCCEEDED', customerNotifiedAt: null },
      data: { customerNotifiedAt: now },
    });
    if (claim.count === 0) return false;

    const release = () =>
      prisma.paymentIntent.update({ where: { id: intentId }, data: { customerNotifiedAt: null } }).catch((err: unknown) => {
        logger.error({ err, intentId }, 'could not release confirmation claim');
      });

    const intent = await prisma.paymentIntent.findUniqueOrThrow({
      where: { id: intentId },
      include: {
        customer: { select: { id: true, waId: true } },
        appointment: { select: { startsAt: true, service: { select: { name: true } } } },
        order: { select: { reference: true } },
      },
    });
    const tenant = await tenants.byId(intent.tenantId);
    if (!tenant) {
      await release();
      return false;
    }

    const message = formatPaymentConfirmedTemplate(this.options.confirmationTemplate, this.options.templateLanguage, {
      businessName: tenant.businessName,
      summary: describeSubject(tenant, intent),
      amountCents: intent.amountCents,
      reference: intent.order?.reference ?? intent.reference,
    });
    const outcome = await messenger.send(tenant, intent.customer, message, { now, essential: true });
    if (outcome.status !== 'sent') {
      await release();
      logger.error({ intentId, to: maskMsisdn(intent.customer.waId), outcome: outcome.status }, 'payment confirmation not delivered; will retry');
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Reconciliation: missed webhooks, expiry, unsent confirmations
  // -------------------------------------------------------------------------

  async reconcile(now: Date = new Date(), batchSize = 25): Promise<ReconcileSummary> {
    const { prisma, logger } = this.deps;
    const summary: ReconcileSummary = { checked: 0, settled: 0, expired: 0, notified: 0 };

    const pending = await prisma.paymentIntent.findMany({
      where: {
        status: 'PENDING',
        // Flagged intents wait for a human; re-checking them would only repeat the alert.
        reviewRequired: false,
        checkoutUrl: { not: null },
        createdAt: { lt: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    for (const intent of pending) {
      summary.checked++;
      try {
        const tx = await this.lookupByReference(intent);
        if (tx && tx.outcome !== 'PENDING') {
          const result = await this.applyOutcome(intent, tx, now);
          if (result.status === 'settled') summary.settled++;
        } else if (intent.expiresAt.getTime() + this.expiryGraceMs < now.getTime() && (await this.expire(intent))) {
          summary.expired++;
        }
      } catch (error) {
        logger.warn({ err: error, intentId: intent.id }, 'reconciliation check failed; will retry');
      }
    }

    const unnotified = await prisma.paymentIntent.findMany({
      where: {
        status: 'SUCCEEDED',
        customerNotifiedAt: null,
        reviewRequired: false,
        settledAt: { gt: new Date(now.getTime() - NOTIFY_RETRY_WINDOW_MS), lt: new Date(now.getTime() - 60_000) },
      },
      select: { id: true },
      take: batchSize,
    });
    for (const { id } of unnotified) {
      if (await this.notifyCustomer(id, now)) summary.notified++;
    }
    return summary;
  }

  /** Abandoned payment: release the slot hold / order so stock and time free up. */
  private async expire(intent: PaymentIntent): Promise<boolean> {
    return this.deps.prisma.$transaction(async (db) => {
      const expired = await db.paymentIntent.updateMany({ where: { id: intent.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      if (expired.count === 0) return false;
      const stillOpen = await db.paymentIntent.count({
        where: {
          tenantId: intent.tenantId,
          status: 'PENDING',
          ...(intent.appointmentId ? { appointmentId: intent.appointmentId } : { orderId: intent.orderId }),
        },
      });
      if (stillOpen === 0 && intent.appointmentId) {
        await db.appointment.updateMany({
          where: { tenantId: intent.tenantId, id: intent.appointmentId, status: 'PENDING_DEPOSIT' },
          data: { status: 'CANCELLED', holdExpiresAt: null },
        });
      } else if (stillOpen === 0 && intent.orderId) {
        await db.order.updateMany({
          where: { tenantId: intent.tenantId, id: intent.orderId, status: 'PENDING_DEPOSIT' },
          data: { status: 'CANCELLED' },
        });
      }
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Short link (/pay/:token)
  // -------------------------------------------------------------------------

  async resolveLink(token: string, now: Date = new Date()): Promise<LinkResolution> {
    const intent = await this.deps.prisma.paymentIntent.findUnique({
      where: { linkToken: token },
      select: { status: true, expiresAt: true, checkoutUrl: true, checkoutFields: true, tenant: { select: { businessName: true, waDisplayPhone: true } } },
    });
    if (!intent) return { action: 'show', state: 'unknown' };

    const brand = { businessName: intent.tenant.businessName, waDisplayPhone: intent.tenant.waDisplayPhone };
    if (intent.status === 'SUCCEEDED') return { action: 'show', state: 'paid', ...brand };
    if (intent.status !== 'PENDING' || !intent.checkoutUrl || intent.expiresAt <= now) {
      return { action: 'show', state: 'expired', ...brand };
    }
    const fields = intent.checkoutFields;
    if (Array.isArray(fields)) {
      const pairs = fields.filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2).map(([k, v]) => [String(k), String(v)] as const);
      return { action: 'form', url: intent.checkoutUrl, fields: Object.fromEntries(pairs) };
    }
    return { action: 'redirect', url: intent.checkoutUrl };
  }

  async describeReturn(token: string): Promise<LinkResolution> {
    const intent = await this.deps.prisma.paymentIntent.findUnique({
      where: { linkToken: token },
      select: { status: true, tenant: { select: { businessName: true, waDisplayPhone: true } } },
    });
    if (!intent) return { action: 'show', state: 'unknown' };
    // Redirect query strings are attacker-controlled; the page reflects our own record only.
    const state = intent.status === 'SUCCEEDED' ? 'paid' : intent.status === 'PENDING' ? 'processing' : 'expired';
    return { action: 'show', state, businessName: intent.tenant.businessName, waDisplayPhone: intent.tenant.waDisplayPhone };
  }

  // -------------------------------------------------------------------------

  private assertOwnUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new PaymentError('REQUEST_INVALID', 'callbackUrl is not a valid URL');
    }
    // Settlement notices must only ever come back to us.
    const settlementPaths = new Set(Object.values(SETTLEMENT_PATHS));
    if (url.origin !== this.publicOrigin || url.username || url.password || url.hash || !settlementPaths.has(url.pathname)) {
      throw new PaymentError('REQUEST_INVALID', `callbackUrl must be one of this service's settlement endpoints (${[...settlementPaths].join(', ')})`);
    }
    return url.toString();
  }

  private async loadSubject(tenantId: string, id: string): Promise<Subject | null> {
    const { prisma } = this.deps;
    const appointment = await prisma.appointment.findUnique({
      where: { tenantId_id: { tenantId, id } },
      select: { id: true, customerId: true, status: true, totalCents: true, holdExpiresAt: true },
    });
    if (appointment) return { kind: 'appointment', ...appointment };

    const order = await prisma.order.findUnique({
      where: { tenantId_id: { tenantId, id } },
      select: { id: true, customerId: true, status: true, totalCents: true },
    });
    return order ? { kind: 'order', ...order, holdExpiresAt: null } : null;
  }

  private toLink(intent: PaymentIntent, checkoutUrl: string): PaymentLink {
    return {
      intentId: intent.id,
      reference: intent.reference,
      amountCents: intent.amountCents,
      linkToken: intent.linkToken,
      shortUrl: `${this.publicOrigin}/pay/${intent.linkToken}`,
      checkoutUrl,
      expiresAt: intent.expiresAt,
    };
  }
}

function describeSubject(
  tenant: TenantProfile,
  intent: { appointment: { startsAt: Date; service: { name: string } | null } | null; order: { reference: string } | null },
): string {
  if (intent.appointment) {
    const { startsAt, service } = intent.appointment;
    return `${service?.name ?? 'your booking'} on ${formatDayLabel(startsAt, tenant.timezone)} at ${formatTime(startsAt, tenant.timezone)}`;
  }
  return `order ${intent.order?.reference ?? ''}`.trim();
}

/** Bank-statement friendly: "WA" + 10 unambiguous characters. */
function newReference(): string {
  let reference = 'WA';
  for (let index = 0; index < 10; index++) reference += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return reference;
}

/** Prisma's interactive transaction exceeded maxWait/timeout. */
function isTransactionTimeout(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028';
}
