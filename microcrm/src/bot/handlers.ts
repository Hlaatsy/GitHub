import { randomInt } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { generateAvailableSlots, isSlotAvailable, spreadEvenly, type SlotQuery, type TimeRange } from '../domain/slots';
import { type Logger } from '../lib/logger';
import { formatZar } from '../lib/money';
import { isSerializationFailure, isUniqueViolation } from '../lib/prisma';
import { formatDayLabel, formatTime } from '../lib/time';
import { formatPaymentLinkMessage } from '../payments/messages';
import { type DashboardAuth } from '../dashboard/DashboardAuth';
import { type PaymentService } from '../payments/PaymentService';
import { type CustomerContext, type CustomerRepository } from '../services/customers';
import { type TenantProfile } from '../services/tenants';
import { LIMITS, asInteractive, asText, clip, ctaUrl } from '../whatsapp/interactive';
import { type OutboundMessage } from '../whatsapp/types';
import { type Intent } from './intents';
import * as replies from './replies';

export type ReplyKind = 'MENU' | 'SLOTS' | 'CATALOG' | 'LOCATION' | 'BOOKING' | 'CART' | 'CHECKOUT' | 'ORDER' | 'PAYMENT' | 'OPT_OUT' | 'LOGIN';

export interface BotReply {
  kind: ReplyKind;
  message: OutboundMessage;
  /** Runs once Meta has accepted the message, with its wamid. */
  afterSend?: (wamid: string) => Promise<void>;
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
  /** When set, the owner can request a dashboard login link by sending LOGIN. */
  dashboard?: { auth: Pick<DashboardAuth, 'issueLoginLink' | 'countRecentLinks'>; maxLinksPerHour: number };
  /** Linked from a customer's first menu. */
  privacyNoticeUrl?: string;
}

type CheckoutLine = { product: replies.ProductSummary & { stockQuantity: number | null }; quantity: number };

class OutOfStock extends Error {
  constructor(
    readonly productId: string,
    readonly available: number,
  ) {
    super('out of stock');
  }
}

type DepositSubject = { kind: 'appointment' | 'order'; id: string; summary: string; fallback: BotReply };

type Db = PrismaClient | Prisma.TransactionClient;

const ACTIVE_BOOKING_STATUSES = ['PENDING', 'CONFIRMED'] as const;
const BPS_DENOMINATOR = 10_000;
const DEFAULT_HORIZON_HOURS = 48;
const MAX_LINE_QUANTITY = 99;
const ADDRESS_MIN = 10;
const ADDRESS_MAX = 300;
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
const IN_STOCK: Prisma.ProductWhereInput = { OR: [{ stockQuantity: null }, { stockQuantity: { gt: 0 } }] };

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
    const { tenant, customer } = ctx;
    const isSalon = tenant.industry === 'SALON';

    // Typing an address is only expected straight after asking for one.
    if (customer.checkoutStage === 'AWAITING_ADDRESS') {
      if (intent.name === 'UNRECOGNISED' && intent.text !== undefined && !isSalon) return this.receiveAddress(ctx, intent.text);
      await this.customers.setCheckoutStage(tenant.id, customer.id, 'NONE');
    }

    switch (intent.name) {
      case 'MENU':
        return this.menu(ctx);

      case 'UNRECOGNISED':
        return this.menuUnlessRecentlySent(ctx);

      case 'BOOK':
      case 'CART_ADD_MORE':
        return isSalon
          ? intent.name === 'BOOK'
            ? this.offerSlots(ctx, null)
            : this.menu(ctx)
          : { kind: 'CATALOG', message: replies.productIndex(tenant, await this.products(tenant.id, replies.PRODUCT_INDEX_SIZE)) };

      case 'CART_CHECKOUT':
        return isSalon ? this.menu(ctx) : this.checkout(ctx);

      case 'CART_EMPTY':
        if (isSalon) return this.menu(ctx);
        await this.prisma.cartItem.deleteMany({ where: { tenantId: tenant.id, customerId: customer.id } });
        return { kind: 'CART', message: replies.cartSummary([]) };

      case 'CHOOSE_FULFILMENT':
        return isSalon ? this.menu(ctx) : this.chooseFulfilment(ctx, intent.fulfilment);

      case 'USE_SAVED_ADDRESS':
        return isSalon || !customer.savedAddress || !tenant.deliveryEnabled
          ? this.menu(ctx)
          : this.placeCartOrder(ctx, { fulfilment: 'DELIVERY', address: customer.savedAddress, feeCents: tenant.deliveryFeeCents });

      case 'NEW_ADDRESS':
        return isSalon || !tenant.deliveryEnabled ? this.menu(ctx) : this.askForAddress(ctx);

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
        return isSalon ? this.menu(ctx) : this.addToCart(ctx, intent.productId);

      case 'PLACE_CART':
        return isSalon || intent.catalogId !== tenant.metaCatalogId ? this.menu(ctx) : this.replaceCart(ctx, intent.items);

      case 'DASHBOARD_LOGIN':
        return this.dashboardLogin(ctx);

      case 'OPT_OUT':
        await this.customers.optOut(tenant.id, ctx.customer.id, ctx.now);
        return { kind: 'OPT_OUT', message: replies.optedOut(tenant) };

      case 'IGNORE':
        return null;
    }
  }

  /**
   * Only the owner's own number gets a link: possession of that WhatsApp is the
   * login credential. Anyone else is treated as ordinary free text, so the
   * feature is not revealed.
   */
  private async dashboardLogin(ctx: ConversationContext): Promise<BotReply | null> {
    const { tenant, customer, now } = ctx;
    const dashboard = this.options.dashboard;
    if (!dashboard || !tenant.ownerWaId || customer.waId !== tenant.ownerWaId) return this.menuUnlessRecentlySent(ctx);

    const recent = await dashboard.auth.countRecentLinks(tenant.id, new Date(now.getTime() - 3_600_000));
    if (recent >= dashboard.maxLinksPerHour) {
      return { kind: 'LOGIN', message: asText('Too many login links in the last hour. Please try again later.') };
    }
    const link = await dashboard.auth.issueLoginLink(tenant.id, now);
    return {
      kind: 'LOGIN',
      message: asInteractive(
        ctaUrl({
          body: `Your ${tenant.businessName} dashboard login link. It works once, for ${Math.round((link.expiresAt.getTime() - now.getTime()) / 60_000)} minutes. Don't forward it.`,
          footer: "Didn't ask for this? Ignore it.",
          displayText: 'Open dashboard',
          url: link.url,
        }),
      ),
    };
  }

  private menu(ctx: ConversationContext): BotReply {
    // The privacy notice goes with the first menu a customer ever receives.
    const notice = ctx.customer.lastMenuSentAt ? undefined : this.options.privacyNoticeUrl;
    return { kind: 'MENU', message: replies.mainMenu(ctx.tenant, ctx.customer.displayName, notice) };
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
  // Decor hire / product sellers: cart → fulfilment → order → pay
  // -------------------------------------------------------------------------

  private async addToCart(ctx: ConversationContext, productId: string): Promise<BotReply> {
    const { tenant, customer } = ctx;
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: tenant.id, active: true },
      select: { id: true, name: true, stockQuantity: true },
    });
    if (!product) return this.menu(ctx);

    const existing = await this.prisma.cartItem.findUnique({
      where: { tenantId_customerId_productId: { tenantId: tenant.id, customerId: customer.id, productId } },
      select: { quantity: true },
    });
    const wanted = Math.min((existing?.quantity ?? 0) + 1, MAX_LINE_QUANTITY);
    const quantity = product.stockQuantity === null ? wanted : Math.min(wanted, product.stockQuantity);
    let intro: string | undefined;
    if (quantity <= 0) {
      intro = `Sorry, ${product.name} is sold out.`;
    } else {
      if (quantity < wanted) intro = `Only ${quantity} ${product.name} available.`;
      await this.prisma.cartItem.upsert({
        where: { tenantId_customerId_productId: { tenantId: tenant.id, customerId: customer.id, productId } },
        create: { tenantId: tenant.id, customerId: customer.id, productId, quantity },
        update: { quantity },
      });
    }
    return this.cartReply(ctx, intro);
  }

  /** Cart sent from a native `product_list`: it replaces the chat cart and goes straight to checkout. */
  private async replaceCart(ctx: ConversationContext, items: ReadonlyArray<{ retailerId: string; quantity: number }>): Promise<BotReply> {
    const { tenant, customer } = ctx;
    const quantities = new Map<string, number>();
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) continue;
      quantities.set(item.retailerId, Math.min((quantities.get(item.retailerId) ?? 0) + item.quantity, MAX_LINE_QUANTITY));
    }
    // Prices and stock come from our DB, never from the payload.
    const products = await this.prisma.product.findMany({
      where: { tenantId: tenant.id, active: true, metaRetailerId: { in: [...quantities.keys()] }, ...IN_STOCK },
      select: { id: true, metaRetailerId: true },
    });
    if (products.length === 0) return this.menu(ctx);

    await this.prisma.$transaction([
      this.prisma.cartItem.deleteMany({ where: { tenantId: tenant.id, customerId: customer.id } }),
      this.prisma.cartItem.createMany({
        data: products.map((product) => ({
          tenantId: tenant.id,
          customerId: customer.id,
          productId: product.id,
          quantity: quantities.get(product.metaRetailerId ?? '') ?? 1,
        })),
      }),
    ]);
    return this.checkout(ctx);
  }

  private async cartReply(ctx: ConversationContext, intro?: string): Promise<BotReply> {
    const lines = await this.cartLines(ctx);
    return { kind: 'CART', message: replies.cartSummary(lines.map(toCartLine), intro) };
  }

  /** Delivery or collection: asks only when the business offers both. */
  private async checkout(ctx: ConversationContext): Promise<BotReply> {
    const { tenant } = ctx;
    const lines = await this.cartLines(ctx);
    if (lines.length === 0) return { kind: 'CATALOG', message: replies.productIndex(tenant, await this.products(tenant.id, replies.PRODUCT_INDEX_SIZE)) };

    if (tenant.deliveryEnabled && tenant.collectionEnabled) {
      const subtotal = lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
      return { kind: 'CHECKOUT', message: replies.fulfilmentChoice(tenant, subtotal) };
    }
    if (tenant.deliveryEnabled) return this.chooseFulfilment(ctx, 'DELIVERY');
    if (tenant.collectionEnabled) return this.chooseFulfilment(ctx, 'COLLECTION');
    // Neither configured: the business arranges it with the customer.
    return this.placeCartOrder(ctx, { fulfilment: null });
  }

  private async chooseFulfilment(ctx: ConversationContext, fulfilment: 'DELIVERY' | 'COLLECTION'): Promise<BotReply> {
    const { tenant, customer } = ctx;
    if (fulfilment === 'COLLECTION') {
      return tenant.collectionEnabled ? this.placeCartOrder(ctx, { fulfilment: 'COLLECTION' }) : this.menu(ctx);
    }
    if (!tenant.deliveryEnabled) return this.menu(ctx);
    if (customer.savedAddress) return { kind: 'CHECKOUT', message: replies.confirmAddress(customer.savedAddress) };
    return this.askForAddress(ctx);
  }

  private async askForAddress(ctx: ConversationContext, retry = false): Promise<BotReply> {
    await this.customers.setCheckoutStage(ctx.tenant.id, ctx.customer.id, 'AWAITING_ADDRESS');
    return { kind: 'CHECKOUT', message: replies.askAddress(ctx.tenant, retry) };
  }

  private async receiveAddress(ctx: ConversationContext, text: string): Promise<BotReply> {
    const { tenant, customer } = ctx;
    const address = text.replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').trim();
    if (address.length < ADDRESS_MIN || address.length > ADDRESS_MAX || !/\p{L}/u.test(address)) return this.askForAddress(ctx, true);
    await this.customers.saveAddress(tenant.id, customer.id, address);
    return this.placeCartOrder(ctx, { fulfilment: 'DELIVERY', address, feeCents: tenant.deliveryFeeCents });
  }

  /**
   * Turns the cart into an order. Prices are re-read and stock is reserved
   * with conditional decrements in the same transaction, so two customers
   * cannot both buy the last candle; the loser's cart is trimmed instead.
   */
  private async placeCartOrder(ctx: ConversationContext, choice: replies.FulfilmentChoice): Promise<BotReply> {
    const { tenant, customer } = ctx;
    const lines = await this.cartLines(ctx);
    if (lines.length === 0) return { kind: 'CATALOG', message: replies.productIndex(tenant, await this.products(tenant.id, replies.PRODUCT_INDEX_SIZE)) };

    const deliveryFeeCents = choice.fulfilment === 'DELIVERY' ? choice.feeCents : 0;
    const subtotal = lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
    const totalCents = subtotal + deliveryFeeCents;
    const depositCents = this.depositFor(tenant, totalCents);

    for (let attempt = 0; ; attempt++) {
      const reference = generateReference();
      try {
        const orderId = await this.prisma.$transaction(async (tx) => {
          for (const line of lines) {
            if (line.product.stockQuantity === null) continue;
            const reserved = await tx.product.updateMany({
              where: { tenantId: tenant.id, id: line.product.id, stockQuantity: { gte: line.quantity } },
              data: { stockQuantity: { decrement: line.quantity } },
            });
            if (reserved.count === 0) {
              const current = await tx.product.findUnique({ where: { tenantId_id: { tenantId: tenant.id, id: line.product.id } }, select: { stockQuantity: true } });
              throw new OutOfStock(line.product.id, Math.max(current?.stockQuantity ?? 0, 0));
            }
          }
          const order = await tx.order.create({
            data: {
              tenantId: tenant.id,
              customerId: customer.id,
              reference,
              totalCents,
              deliveryFeeCents,
              fulfilment: choice.fulfilment,
              deliveryAddress: choice.fulfilment === 'DELIVERY' ? choice.address : null,
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
          await tx.cartItem.deleteMany({ where: { tenantId: tenant.id, customerId: customer.id } });
          return order.id;
        });

        const summary = clip(lines.map((line) => `${line.quantity}× ${line.product.name}`).join(', '), 300);
        const received: BotReply = { kind: 'ORDER', message: replies.orderReceived(tenant, reference, summary, totalCents, choice) };
        if (depositCents === 0) return received;
        const how = replies.describeFulfilment(tenant, choice);
        return this.requestDeposit(ctx, depositCents, {
          kind: 'order',
          id: orderId,
          summary: clip(`🧾 Order ${reference}: ${summary} (total ${formatZar(totalCents)})${how ? `\n${how}` : ''}`, 600),
          fallback: received,
        });
      } catch (error) {
        if (error instanceof OutOfStock) return this.trimCart(ctx, error);
        if (!isUniqueViolation(error) || attempt >= 2) throw error;
      }
    }
  }

  private async trimCart(ctx: ConversationContext, shortage: OutOfStock): Promise<BotReply> {
    const { tenant, customer } = ctx;
    const where = { tenantId_customerId_productId: { tenantId: tenant.id, customerId: customer.id, productId: shortage.productId } };
    const product = await this.prisma.product.findUnique({ where: { tenantId_id: { tenantId: tenant.id, id: shortage.productId } }, select: { name: true } });
    if (shortage.available > 0) await this.prisma.cartItem.update({ where, data: { quantity: shortage.available } });
    else await this.prisma.cartItem.delete({ where });
    const name = product?.name ?? 'An item';
    const note = shortage.available > 0 ? `Sorry, only ${shortage.available} ${name} left, so we've updated your cart.` : `Sorry, ${name} just sold out, so we've removed it from your cart.`;
    return this.cartReply(ctx, note);
  }

  /** Current cart with today's prices; inactive products drop out. */
  private async cartLines(ctx: ConversationContext): Promise<CheckoutLine[]> {
    const items = await this.prisma.cartItem.findMany({
      where: { tenantId: ctx.tenant.id, customerId: ctx.customer.id, product: { active: true } },
      orderBy: { updatedAt: 'asc' },
      select: { quantity: true, product: { select: { ...productSelect, stockQuantity: true } } },
    });
    return items.map((item) => ({ product: item.product, quantity: item.quantity }));
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
        // Meta's delivery statuses reference this wamid; the SMS fallback looks the payment up by it.
        afterSend: async (wamid) => {
          await this.prisma.paymentIntent.update({ where: { id: link.intentId }, data: { payLinkWamid: wamid } });
        },
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

  /** Sold-out products are left out of lists. */
  private products(tenantId: string, take: number): Promise<replies.ProductSummary[]> {
    return this.prisma.product.findMany({
      where: { tenantId, active: true, ...IN_STOCK },
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

function toCartLine(line: CheckoutLine): replies.CartLine {
  return { name: line.product.name, quantity: line.quantity, priceCents: line.product.priceCents };
}
