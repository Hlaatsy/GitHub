import { randomInt } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { generateAvailableSlots, isSlotAvailable, spreadEvenly, type SlotQuery, type TimeRange } from '../domain/slots';
import { type Logger } from '../lib/logger';
import { formatZar } from '../lib/money';
import { isSerializationFailure, isUniqueViolation } from '../lib/prisma';
import { formatDayLabel, formatTime } from '../lib/time';
import { formatPaymentLinkMessage } from '../payments/messages';
import { type PaymentService } from '../payments/PaymentService';
import { type CustomerContext, type CustomerRepository } from '../services/customers';
import { type TenantProfile } from '../services/tenants';
import { LIMITS, clip } from '../whatsapp/interactive';
import { type OutboundMessage } from '../whatsapp/types';
import { type Intent } from './intents';
import * as replies from './replies';

export type ReplyKind = 'MENU' | 'SLOTS' | 'CATALOG' | 'LOCATION' | 'BOOKING' | 'ORDER' | 'PAYMENT' | 'OPT_OUT';

export interface BotReply {
  kind: ReplyKind;
  message: OutboundMessage;
}

export interface ConversationContext {
  tenant: TenantProfile;
  customer: CustomerContext;
  now: Date;
}

export interface ConversationPayments {
  service: Pick<PaymentService, 'forTenant' | 'webhookUrl'>;
  /** How long an unpaid booking holds its slot. */
  holdMinutes: number;
  requestTemplate: string;
  templateLanguage: string;
  logger: Logger;
}

export interface ConversationOptions {
  menuCooldownMs: number;
  horizonHours?: number;
  /** When set, tenants with `depositBps > 0` collect payment before confirming. */
  payments?: ConversationPayments;
}

type DepositSubject = { kind: 'appointment' | 'order'; id: string; summary: string; fallback: BotReply };

type Db = PrismaClient | Prisma.TransactionClient;

const ACTIVE_BOOKING_STATUSES = ['PENDING', 'CONFIRMED'] as const;
const BPS_DENOMINATOR = 10_000;
const DEFAULT_HORIZON_HOURS = 48;
const MAX_LINE_QUANTITY = 99;
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const serviceSelect = { id: true, name: true, durationMinutes: true, priceCents: true } as const;
const productSelect = {
  id: true,
  name: true,
  description: true,
  priceCents: true,
  priceUnit: true,
  metaRetailerId: true,
} as const;

/**
 * Maps an intent to at most one reply. Returning a single message (or none) per
 * inbound event is the core cost guarantee: no handler can fan out into
 * several billable messages.
 *
 * Every query is scoped by `tenant.id`. IDs echoed back from list rows are
 * re-validated against the tenant, so a forged row id cannot reach another
 * tenant's data.
 */
export class ConversationHandlers {
  private readonly horizonHours: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly customers: CustomerRepository,
    private readonly options: ConversationOptions,
  ) {
    this.horizonHours = options.horizonHours ?? DEFAULT_HORIZON_HOURS;
  }

  async handle(intent: Intent, ctx: ConversationContext): Promise<BotReply | null> {
    const { tenant } = ctx;
    const isSalon = tenant.industry === 'SALON';

    switch (intent.name) {
      case 'MENU':
        return this.menu(ctx);

      case 'UNRECOGNISED':
        return this.menuUnlessRecentlySent(ctx);

      case 'BOOK':
        return isSalon
          ? this.offerSlots(ctx, null)
          : { kind: 'CATALOG', message: replies.productIndex(tenant, await this.products(tenant.id, replies.PRODUCT_INDEX_SIZE)) };

      case 'CATALOG':
        return isSalon
          ? { kind: 'CATALOG', message: replies.serviceList(tenant, await this.services(tenant.id)) }
          : {
              kind: 'CATALOG',
              message: replies.productIndex(tenant, await this.products(tenant.id, LIMITS.MAX_LIST_ROWS), LIMITS.MAX_LIST_ROWS),
            };

      case 'LOCATION':
        return { kind: 'LOCATION', message: replies.locationAndHours(tenant) };

      case 'PICK_SERVICE': {
        const service = isSalon ? await this.service(tenant.id, intent.serviceId) : null;
        return service ? this.offerSlots(ctx, service) : this.menu(ctx);
      }

      case 'PICK_SLOT':
        return isSalon ? this.book(ctx, intent.startsAt, intent.serviceId) : this.menu(ctx);

      case 'PICK_PRODUCT':
        return isSalon ? this.menu(ctx) : this.orderProduct(ctx, intent.productId);

      case 'PLACE_CART':
        return isSalon || intent.catalogId !== tenant.metaCatalogId ? this.menu(ctx) : this.orderCart(ctx, intent.items);

      case 'OPT_OUT':
        await this.customers.optOut(tenant.id, ctx.customer.id, ctx.now);
        return { kind: 'OPT_OUT', message: replies.optedOut(tenant) };

      case 'IGNORE':
        return null;
    }
  }

  private menu(ctx: ConversationContext): BotReply {
    return { kind: 'MENU', message: replies.mainMenu(ctx.tenant, ctx.customer.displayName) };
  }

  /** Free text the bot can't route: re-offer the menu, but never twice within the cooldown. */
  private menuUnlessRecentlySent(ctx: ConversationContext): BotReply | null {
    const last = ctx.customer.lastMenuSentAt;
    if (last && ctx.now.getTime() - last.getTime() < this.options.menuCooldownMs) return null;
    return this.menu(ctx);
  }

  // -------------------------------------------------------------------------
  // Salon booking
  // -------------------------------------------------------------------------

  private async offerSlots(
    ctx: ConversationContext,
    service: replies.ServiceSummary | null,
    intro?: string,
  ): Promise<BotReply> {
    const duration = service?.durationMinutes ?? ctx.tenant.defaultSlotMinutes;
    const busy = await this.loadBusy(this.prisma, ctx.tenant.id, ctx.now, duration);
    const slots = generateAvailableSlots(this.slotQuery(ctx, duration, busy));
    return {
      kind: 'SLOTS',
      message: replies.slotList(ctx.tenant, spreadEvenly(slots, LIMITS.MAX_LIST_ROWS), service, intro),
    };
  }

  private async book(ctx: ConversationContext, startsAt: Date, serviceId: string | null): Promise<BotReply> {
    const { tenant, customer, now } = ctx;
    const service = serviceId ? await this.service(tenant.id, serviceId) : null;
    if (serviceId && !service) return this.menu(ctx);

    const duration = service?.durationMinutes ?? tenant.defaultSlotMinutes;
    const slot: TimeRange = { startsAt, endsAt: new Date(startsAt.getTime() + duration * 60_000) };

    const depositCents = this.depositFor(tenant, service?.priceCents ?? 0);
    let appointmentId: string | null = null;
    try {
      // Serializable: two customers tapping the same last slot cannot both
      // pass the availability check; the loser gets a serialization failure.
      appointmentId = await this.prisma.$transaction(
        async (tx) => {
          const busy = await this.loadBusy(tx, tenant.id, now, duration);
          if (!isSlotAvailable(this.slotQuery(ctx, duration, busy), startsAt)) return null;
          const created = await tx.appointment.create({
            data: {
              tenantId: tenant.id,
              customerId: customer.id,
              serviceId: service?.id ?? null,
              status: depositCents > 0 ? 'PENDING_DEPOSIT' : tenant.autoConfirmBookings ? 'CONFIRMED' : 'PENDING',
              holdExpiresAt: depositCents > 0 ? this.holdExpiry(now) : null,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              totalCents: service?.priceCents ?? 0,
            },
            select: { id: true },
          });
          return created.id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
    }

    if (appointmentId && depositCents > 0) {
      const when = `${formatDayLabel(slot.startsAt, tenant.timezone)} at ${formatTime(slot.startsAt, tenant.timezone)}`;
      return this.requestDeposit(ctx, depositCents, {
        kind: 'appointment',
        id: appointmentId,
        summary: `📅 ${service?.name ?? 'Your booking'} on ${when}`,
        fallback: { kind: 'BOOKING', message: replies.bookingConfirmed(tenant, slot, service, false) },
      });
    }
    if (appointmentId) {
      return { kind: 'BOOKING', message: replies.bookingConfirmed(tenant, slot, service, tenant.autoConfirmBookings) };
    }
    // One message, not two: the refreshed list doubles as the "slot taken" notice.
    return this.offerSlots(ctx, service, 'Sorry, that time was just taken. Here are the next open slots 👇');
  }

  private slotQuery(ctx: ConversationContext, durationMinutes: number, busy: readonly TimeRange[]): SlotQuery {
    const { tenant, now } = ctx;
    return {
      now,
      timeZone: tenant.timezone,
      workingHours: tenant.workingHours,
      durationMinutes,
      intervalMinutes: tenant.slotIntervalMinutes,
      minLeadMinutes: tenant.minLeadMinutes,
      horizonHours: this.horizonHours,
      capacity: tenant.bookingCapacity,
      busy,
    };
  }

  private loadBusy(db: Db, tenantId: string, now: Date, durationMinutes: number): Promise<TimeRange[]> {
    const until = new Date(now.getTime() + (this.horizonHours * 60 + durationMinutes) * 60_000);
    return db.appointment.findMany({
      where: {
        tenantId,
        startsAt: { lt: until },
        endsAt: { gt: now },
        // Unpaid deposit holds block the slot only until they lapse.
        OR: [{ status: { in: [...ACTIVE_BOOKING_STATUSES] } }, { status: 'PENDING_DEPOSIT', holdExpiresAt: { gt: now } }],
      },
      select: { startsAt: true, endsAt: true },
    });
  }

  // -------------------------------------------------------------------------
  // Decor hire / product sellers
  // -------------------------------------------------------------------------

  private async orderProduct(ctx: ConversationContext, productId: string): Promise<BotReply> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: ctx.tenant.id, active: true },
      select: productSelect,
    });
    if (!product) return this.menu(ctx);
    return this.placeOrder(ctx, [{ product, quantity: 1 }]);
  }

  /** Cart sent from a native `product_list`. Prices come from our DB, never from the payload. */
  private async orderCart(
    ctx: ConversationContext,
    items: ReadonlyArray<{ retailerId: string; quantity: number }>,
  ): Promise<BotReply> {
    const quantities = new Map<string, number>();
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) continue;
      quantities.set(item.retailerId, Math.min((quantities.get(item.retailerId) ?? 0) + item.quantity, MAX_LINE_QUANTITY));
    }
    const products = await this.prisma.product.findMany({
      where: { tenantId: ctx.tenant.id, active: true, metaRetailerId: { in: [...quantities.keys()] } },
      select: productSelect,
    });
    if (products.length === 0) return this.menu(ctx);

    return this.placeOrder(
      ctx,
      products.map((product) => ({ product, quantity: quantities.get(product.metaRetailerId ?? '') ?? 1 })),
    );
  }

  private async placeOrder(
    ctx: ConversationContext,
    lines: ReadonlyArray<{ product: replies.ProductSummary; quantity: number }>,
  ): Promise<BotReply> {
    const { tenant, customer } = ctx;
    const totalCents = lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
    const depositCents = this.depositFor(tenant, totalCents);

    for (let attempt = 0; ; attempt++) {
      const reference = generateReference();
      try {
        const orderId = await this.prisma.$transaction(async (tx) => {
          const order = await tx.order.create({
            data: {
              tenantId: tenant.id,
              customerId: customer.id,
              reference,
              totalCents,
              status: depositCents > 0 ? 'PENDING_DEPOSIT' : 'PENDING',
            },
            select: { id: true },
          });
          await tx.orderItem.createMany({
            data: lines.map((line) => ({
              tenantId: tenant.id,
              orderId: order.id,
              productId: line.product.id,
              quantity: line.quantity,
              unitPriceCents: line.product.priceCents,
            })),
          });
          return order.id;
        });
        const summary = clip(lines.map((line) => `${line.quantity}× ${line.product.name}`).join(', '), 300);
        const received: BotReply = { kind: 'ORDER', message: replies.orderReceived(tenant, reference, summary, totalCents) };
        if (depositCents === 0) return received;
        return this.requestDeposit(ctx, depositCents, {
          kind: 'order',
          id: orderId,
          summary: `🧾 Order ${reference}: ${summary} (total ${formatZar(totalCents)})`,
          fallback: received,
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= 2) throw error;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Deposits
  // -------------------------------------------------------------------------

  private depositFor(tenant: TenantProfile, totalCents: number): number {
    if (!this.options.payments || tenant.depositBps <= 0 || totalCents <= 0) return 0;
    return Math.ceil((totalCents * Math.min(tenant.depositBps, BPS_DENOMINATOR)) / BPS_DENOMINATOR);
  }

  private holdExpiry(now: Date): Date {
    return new Date(now.getTime() + (this.options.payments?.holdMinutes ?? 0) * 60_000);
  }

  /** One message carrying the pay button. If no link can be made, the request falls back to manual confirmation. */
  private async requestDeposit(ctx: ConversationContext, depositCents: number, subject: DepositSubject): Promise<BotReply> {
    const payments = this.options.payments;
    if (!payments) return subject.fallback;
    const { tenant, now } = ctx;
    try {
      const link = await payments.service
        .forTenant(tenant.id)
        .generateWhatsAppPaymentLink(subject.id, depositCents / 100, payments.service.webhookUrl, now);
      return {
        kind: 'PAYMENT',
        message: formatPaymentLinkMessage(
          link,
          {
            businessName: tenant.businessName,
            timeZone: tenant.timezone,
            summary: subject.summary,
            templateLanguage: payments.templateLanguage,
            requestTemplate: payments.requestTemplate,
          },
          // We are answering the customer's own message, so the service window is open.
          { inServiceWindow: true },
        ),
      };
    } catch (error) {
      payments.logger.error({ err: error, tenantId: tenant.id, subject: subject.kind }, 'deposit link unavailable; falling back to manual confirmation');
      const where = { tenantId: tenant.id, id: subject.id, status: 'PENDING_DEPOSIT' as const };
      if (subject.kind === 'appointment') {
        await this.prisma.appointment.updateMany({ where, data: { status: 'PENDING', holdExpiresAt: null } });
      } else {
        await this.prisma.order.updateMany({ where, data: { status: 'PENDING' } });
      }
      return subject.fallback;
    }
  }

  // -------------------------------------------------------------------------
  // Tenant-scoped reads
  // -------------------------------------------------------------------------

  private service(tenantId: string, serviceId: string): Promise<replies.ServiceSummary | null> {
    return this.prisma.service.findFirst({ where: { id: serviceId, tenantId, active: true }, select: serviceSelect });
  }

  private services(tenantId: string): Promise<replies.ServiceSummary[]> {
    return this.prisma.service.findMany({
      where: { tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: LIMITS.MAX_LIST_ROWS,
      select: serviceSelect,
    });
  }

  private products(tenantId: string, take: number): Promise<replies.ProductSummary[]> {
    return this.prisma.product.findMany({
      where: { tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take,
      select: productSelect,
    });
  }
}

function generateReference(): string {
  let reference = '';
  for (let index = 0; index < 6; index++) {
    reference += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return reference;
}
