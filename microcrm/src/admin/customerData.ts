import { randomInt } from 'node:crypto';
import { type PrismaClient } from '@prisma/client';

// POPIA data-subject requests, run by the operator on a business's behalf:
// access (section 23) as a JSON export, and deletion (section 24) as
// anonymisation. Orders and payments stay, without the person attached,
// because financial records must be kept for five years (Tax Administration Act).

const OPEN_ORDER = ['PENDING', 'PENDING_DEPOSIT', 'CONFIRMED'] as const;
const OPEN_BOOKING = ['PENDING', 'PENDING_DEPOSIT', 'CONFIRMED'] as const;

export async function exportCustomer(prisma: PrismaClient, tenantId: string, waId: string) {
  const customer = await prisma.customer.findUnique({
    where: { tenantId_waId: { tenantId, waId } },
    include: {
      tenant: { select: { businessName: true } },
      appointments: { select: { startsAt: true, status: true, totalCents: true, service: { select: { name: true } } }, orderBy: { startsAt: 'asc' } },
      orders: {
        select: {
          reference: true,
          status: true,
          totalCents: true,
          fulfilment: true,
          deliveryAddress: true,
          createdAt: true,
          items: { select: { quantity: true, unitPriceCents: true, product: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      },
      paymentIntents: { select: { reference: true, provider: true, amountCents: true, status: true, createdAt: true, settledAt: true }, orderBy: { createdAt: 'asc' } },
      cartItems: { select: { quantity: true, product: { select: { name: true } } } },
      _count: { select: { outboundMessages: true } },
    },
  });
  if (!customer) return null;
  return {
    exportedAt: new Date().toISOString(),
    responsibleParty: customer.tenant.businessName,
    customer: {
      whatsappNumber: customer.waId,
      name: customer.displayName,
      savedDeliveryAddress: customer.savedAddress,
      firstContactAt: customer.firstContactAt,
      lastMessageAt: customer.lastInboundAt,
      optedOutAt: customer.optedOutAt,
      marketingConsentAt: customer.marketingConsentAt,
    },
    bookings: customer.appointments.map((a) => ({ startsAt: a.startsAt, service: a.service?.name ?? null, status: a.status, totalCents: a.totalCents })),
    orders: customer.orders.map((o) => ({ ...o, items: o.items.map((i) => ({ product: i.product.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents })) })),
    payments: customer.paymentIntents,
    cart: customer.cartItems.map((c) => ({ product: c.product.name, quantity: c.quantity })),
    // Message content is not stored; only that messages were sent.
    messagesSentToCustomer: customer._count.outboundMessages,
  };
}

export type EraseResult = { status: 'erased'; customerId: string } | { status: 'not_found' } | { status: 'open_items'; orders: number; bookings: number };

/**
 * Removes everything that identifies the person and keeps the anonymous
 * financial history. Refused while they have open orders or bookings: finish
 * or cancel those first, or the business can't deliver or refund.
 */
export async function eraseCustomer(prisma: PrismaClient, tenantId: string, waId: string, now = new Date()): Promise<EraseResult> {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { tenantId_waId: { tenantId, waId } }, select: { id: true } });
    if (!customer) return { status: 'not_found' };
    const [orders, bookings] = await Promise.all([
      tx.order.count({ where: { tenantId, customerId: customer.id, status: { in: [...OPEN_ORDER] }, isTest: false } }),
      tx.appointment.count({ where: { tenantId, customerId: customer.id, status: { in: [...OPEN_BOOKING] } } }),
    ]);
    if (orders > 0 || bookings > 0) return { status: 'open_items', orders, bookings };

    await tx.cartItem.deleteMany({ where: { tenantId, customerId: customer.id } });
    await tx.order.updateMany({ where: { tenantId, customerId: customer.id }, data: { deliveryAddress: null } });
    await tx.customer.update({
      where: { tenantId_id: { tenantId, id: customer.id } },
      data: {
        // Not a phone number (leading 0 has no country code), unique per business.
        waId: anonymousId(),
        displayName: null,
        savedAddress: null,
        checkoutStage: 'NONE',
        marketingConsentAt: null,
        optedOutAt: now,
        erasedAt: now,
      },
    });
    return { status: 'erased', customerId: customer.id };
  });
}

function anonymousId(): string {
  let id = '0';
  while (id.length < 15) id += String(randomInt(10));
  return id;
}
