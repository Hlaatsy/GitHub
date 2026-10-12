import { type AppointmentStatus, type OrderStatus, type Prisma, type PrismaClient } from '@prisma/client';
import { type Logger } from '../lib/logger';
import { maskMsisdn } from '../lib/msisdn';
import { formatDayLabel, formatTime, toWallClock, wallClockToUtc } from '../lib/time';
import { type OutboundMessenger } from '../services/messenger';
import { type TenantProfile } from '../services/tenants';
import { asText } from '../whatsapp/interactive';

// Read models and owner actions for the dashboard API. Every query takes the
// tenant from the authenticated session and filters on it; ids from the URL
// are only ever looked up together with that tenant id.

const SERVICE_WINDOW_MS = 24 * 60 * 60_000 - 10 * 60_000;
const PAGE_SIZE = 50;

/** Real (non-test) payments: test orders from onboarding never count as revenue. */
const NOT_TEST: Prisma.PaymentIntentWhereInput = { OR: [{ orderId: null }, { order: { isTest: false } }] };

const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  PENDING_DEPOSIT: ['CANCELLED'],
  CONFIRMED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: [],
};

const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  PENDING_DEPOSIT: ['CANCELLED'],
  CONFIRMED: ['FULFILLED', 'CANCELLED'],
  FULFILLED: [],
  CANCELLED: [],
};

export type ActionResult =
  | { ok: true; status: string; customerNotified: boolean; refundRequired: boolean }
  | { ok: false; error: 'NOT_FOUND' | 'INVALID_TRANSITION'; allowed?: readonly string[] };

export interface CustomerView {
  name: string | null;
  phoneMasked: string;
  /** Opens a WhatsApp chat with the customer from the owner's phone. */
  chatUrl: string;
}

function customerView(customer: { displayName: string | null; waId: string }): CustomerView {
  return { name: customer.displayName, phoneMasked: maskMsisdn(customer.waId), chatUrl: `https://wa.me/${customer.waId}` };
}

function localDay(now: Date, timeZone: string, offsetDays = 0): { start: Date; end: Date } {
  const today = toWallClock(now, timeZone);
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offsetDays));
  const next = new Date(day.getTime() + 86_400_000);
  return {
    start: wallClockToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, timeZone),
    end: wallClockToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone),
  };
}

export class DashboardService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messenger: Pick<OutboundMessenger, 'send'>,
    private readonly logger: Logger,
  ) {}

  me(tenant: TenantProfile) {
    return {
      businessName: tenant.businessName,
      industry: tenant.industry,
      timezone: tenant.timezone,
      waDisplayPhone: tenant.waDisplayPhone,
      depositPercent: tenant.depositBps / 100,
    };
  }

  async summary(tenant: TenantProfile, now: Date = new Date()) {
    const { prisma } = this;
    const tenantId = tenant.id;
    const today = localDay(now, tenant.timezone);

    const [settled, bookingsToday, upcoming, toConfirmBookings, toConfirmOrders, review, wallet] = await Promise.all([
      prisma.paymentIntent.aggregate({
        where: { tenantId, status: 'SUCCEEDED', settledAt: { gte: today.start, lt: today.end }, ...NOT_TEST },
        _sum: { amountCents: true },
        _count: true,
      }),
      prisma.appointment.count({
        where: {
          tenantId,
          startsAt: { gte: today.start, lt: today.end },
          OR: [{ status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] } }, { status: 'PENDING_DEPOSIT', holdExpiresAt: { gt: now } }],
        },
      }),
      prisma.appointment.count({ where: { tenantId, startsAt: { gte: now }, status: { in: ['PENDING', 'CONFIRMED'] } } }),
      prisma.appointment.count({ where: { tenantId, status: 'PENDING', startsAt: { gte: now } } }),
      prisma.order.count({ where: { tenantId, status: 'PENDING', isTest: false } }),
      prisma.paymentIntent.count({ where: { tenantId, reviewRequired: true } }),
      prisma.tenantWallet.findUnique({ where: { tenantId } }),
    ]);

    return {
      today: { settledCents: settled._sum.amountCents ?? 0, payments: settled._count, bookings: bookingsToday },
      upcomingBookings: upcoming,
      awaitingYourConfirmation: { bookings: toConfirmBookings, orders: toConfirmOrders },
      paymentsNeedingReview: review,
      wallet: wallet
        ? { balanceCents: wallet.balanceCents, thresholdCents: wallet.lowBalanceThresholdCents, low: wallet.balanceCents < wallet.lowBalanceThresholdCents }
        : null,
    };
  }

  async bookings(tenant: TenantProfile, range: 'today' | 'upcoming' | 'past', now: Date = new Date()) {
    const today = localDay(now, tenant.timezone);
    const where: Prisma.AppointmentWhereInput =
      range === 'today'
        ? { startsAt: { gte: today.start, lt: today.end } }
        : range === 'upcoming'
          ? { startsAt: { gte: now } }
          : { startsAt: { lt: now } };
    const rows = await this.prisma.appointment.findMany({
      where: { tenantId: tenant.id, ...where },
      orderBy: { startsAt: range === 'past' ? 'desc' : 'asc' },
      take: PAGE_SIZE,
      include: {
        customer: { select: { displayName: true, waId: true } },
        service: { select: { name: true } },
        paymentIntents: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, amountCents: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      when: `${formatDayLabel(row.startsAt, tenant.timezone)} ${formatTime(row.startsAt, tenant.timezone)}`,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      service: row.service?.name ?? null,
      status: row.status,
      totalCents: row.totalCents,
      holdExpired: row.status === 'PENDING_DEPOSIT' && Boolean(row.holdExpiresAt && row.holdExpiresAt <= now),
      payment: row.paymentIntents[0] ?? null,
      customer: customerView(row.customer),
      actions: APPOINTMENT_TRANSITIONS[row.status],
    }));
  }

  async orders(tenant: TenantProfile, filter: 'open' | 'all') {
    const rows = await this.prisma.order.findMany({
      where: {
        tenantId: tenant.id,
        isTest: false,
        ...(filter === 'open' ? { status: { in: ['PENDING', 'PENDING_DEPOSIT', 'CONFIRMED'] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      include: {
        customer: { select: { displayName: true, waId: true } },
        items: { include: { product: { select: { name: true } } } },
        paymentIntents: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, amountCents: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      createdAt: row.createdAt.toISOString(),
      status: row.status,
      totalCents: row.totalCents,
      items: row.items.map((item) => `${item.quantity}× ${item.product.name}`),
      payment: row.paymentIntents[0] ?? null,
      customer: customerView(row.customer),
      actions: ORDER_TRANSITIONS[row.status],
    }));
  }

  async payments(tenant: TenantProfile, before?: Date) {
    const rows = await this.prisma.paymentIntent.findMany({
      where: { tenantId: tenant.id, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      include: {
        customer: { select: { displayName: true, waId: true } },
        appointment: { select: { startsAt: true, service: { select: { name: true } } } },
        order: { select: { reference: true, isTest: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      createdAt: row.createdAt.toISOString(),
      settledAt: row.settledAt?.toISOString() ?? null,
      amountCents: row.amountCents,
      status: row.status,
      reviewRequired: row.reviewRequired,
      reviewReason: row.reviewRequired ? row.failureReason : null,
      isTest: row.order?.isTest ?? false,
      for: row.appointment
        ? `${row.appointment.service?.name ?? 'Booking'} ${formatDayLabel(row.appointment.startsAt, tenant.timezone)} ${formatTime(row.appointment.startsAt, tenant.timezone)}`
        : `Order ${row.order?.reference ?? ''}`,
      customer: customerView(row.customer),
    }));
  }

  async wallet(tenant: TenantProfile) {
    const [wallet, transactions] = await Promise.all([
      this.prisma.tenantWallet.findUnique({ where: { tenantId: tenant.id } }),
      this.prisma.walletTransaction.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'desc' },
        take: PAGE_SIZE,
        include: { outboundMessage: { select: { kind: true, category: true } } },
      }),
    ]);
    return {
      balanceCents: wallet?.balanceCents ?? 0,
      thresholdCents: wallet?.lowBalanceThresholdCents ?? 0,
      transactions: transactions.map((tx) => ({
        at: tx.createdAt.toISOString(),
        type: tx.type,
        amountCents: tx.amountCents,
        balanceAfterCents: tx.balanceAfterCents,
        // What the money paid for, never who it was sent to.
        description: tx.outboundMessage ? `${tx.outboundMessage.category.toLowerCase()} ${tx.outboundMessage.kind}` : tx.reference ?? tx.type.toLowerCase(),
      })),
    };
  }

  async setAppointmentStatus(tenant: TenantProfile, id: string, to: AppointmentStatus, now: Date = new Date()): Promise<ActionResult> {
    const row = await this.prisma.appointment.findUnique({
      where: { tenantId_id: { tenantId: tenant.id, id } },
      include: {
        customer: { select: { id: true, waId: true, lastInboundAt: true, optedOutAt: true } },
        service: { select: { name: true } },
        paymentIntents: { where: { status: 'SUCCEEDED' }, select: { id: true } },
      },
    });
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    const allowed = APPOINTMENT_TRANSITIONS[row.status];
    if (!allowed.includes(to)) return { ok: false, error: 'INVALID_TRANSITION', allowed };

    // Conditional on the status we just read, so two clicks cannot both apply.
    const { count } = await this.prisma.appointment.updateMany({
      where: { tenantId: tenant.id, id, status: row.status },
      data: { status: to, ...(to === 'CANCELLED' ? { holdExpiresAt: null } : {}) },
    });
    if (count === 0) return { ok: false, error: 'INVALID_TRANSITION', allowed };

    const when = `${formatDayLabel(row.startsAt, tenant.timezone)} at ${formatTime(row.startsAt, tenant.timezone)}`;
    const what = row.service?.name ?? 'booking';
    const text =
      to === 'CONFIRMED'
        ? `✅ ${tenant.businessName}: your ${what} on ${when} is confirmed. See you then!`
        : to === 'CANCELLED'
          ? `${tenant.businessName}: your ${what} on ${when} has been cancelled. Reply MENU to book another time.`
          : null;
    const customerNotified = text ? await this.notify(tenant, row.customer, text, now) : false;
    const refundRequired = to === 'CANCELLED' && (await this.flagRefund(tenant.id, row.paymentIntents));
    return { ok: true, status: to, customerNotified, refundRequired };
  }

  async setOrderStatus(tenant: TenantProfile, id: string, to: OrderStatus, now: Date = new Date()): Promise<ActionResult> {
    const row = await this.prisma.order.findUnique({
      where: { tenantId_id: { tenantId: tenant.id, id } },
      include: {
        customer: { select: { id: true, waId: true, lastInboundAt: true, optedOutAt: true } },
        paymentIntents: { where: { status: 'SUCCEEDED' }, select: { id: true } },
      },
    });
    if (!row || row.isTest) return { ok: false, error: 'NOT_FOUND' };
    const allowed = ORDER_TRANSITIONS[row.status];
    if (!allowed.includes(to)) return { ok: false, error: 'INVALID_TRANSITION', allowed };

    const { count } = await this.prisma.order.updateMany({ where: { tenantId: tenant.id, id, status: row.status }, data: { status: to } });
    if (count === 0) return { ok: false, error: 'INVALID_TRANSITION', allowed };

    const text =
      to === 'CONFIRMED'
        ? `✅ ${tenant.businessName}: order ${row.reference} is confirmed. We'll be in touch about collection or delivery.`
        : to === 'CANCELLED'
          ? `${tenant.businessName}: order ${row.reference} has been cancelled. Reply MENU to see other options.`
          : to === 'FULFILLED'
            ? `${tenant.businessName}: order ${row.reference} is complete. Thank you!`
            : null;
    const customerNotified = text ? await this.notify(tenant, row.customer, text, now) : false;
    const refundRequired = to === 'CANCELLED' && (await this.flagRefund(tenant.id, row.paymentIntents));
    return { ok: true, status: to, customerNotified, refundRequired };
  }

  /**
   * Payments settle into the platform's merchant account, so refunds are the
   * platform team's job: the paid intent is flagged for review where they see it.
   */
  private async flagRefund(tenantId: string, paid: readonly { id: string }[]): Promise<boolean> {
    if (paid.length === 0) return false;
    await this.prisma.paymentIntent.updateMany({
      where: { tenantId, id: { in: paid.map((p) => p.id) } },
      data: { reviewRequired: true, failureReason: 'REFUND_DUE_CANCELLED_BY_OWNER' },
    });
    return true;
  }

  /**
   * Free-form update, only inside the 24h service window and never to opted-out
   * customers. Outside the window the owner is told to contact the customer.
   */
  private async notify(
    tenant: TenantProfile,
    customer: { id: string; waId: string; lastInboundAt: Date | null; optedOutAt: Date | null },
    text: string,
    now: Date,
  ): Promise<boolean> {
    if (customer.optedOutAt || !customer.lastInboundAt || now.getTime() - customer.lastInboundAt.getTime() > SERVICE_WINDOW_MS) {
      return false;
    }
    try {
      const outcome = await this.messenger.send(tenant, customer, asText(text), { now });
      return outcome.status === 'sent';
    } catch (error) {
      this.logger.error({ err: error, tenantId: tenant.id }, 'dashboard customer notification failed');
      return false;
    }
  }
}
