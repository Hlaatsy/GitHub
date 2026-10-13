import { createHmac, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseCustomer, exportCustomer } from '../src/admin/customerData';
import { applyTenantFile, TenantFileSchema } from '../src/admin/tenantConfig';
import { ConversationHandlers, type BotReply } from '../src/bot/handlers';
import { DashboardService } from '../src/dashboard/DashboardService';
import { type Intent } from '../src/bot/intents';
import { PaymentAccounts } from '../src/payments/accounts';
import { PaymentService } from '../src/payments/PaymentService';
import { PaystackGateway } from '../src/payments/paystack';
import { CustomerRepository } from '../src/services/customers';
import { TenantDirectory, type TenantProfile } from '../src/services/tenants';

// Runs against a real, migrated Postgres (CI provides one). Skipped without TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
const logger = pino({ level: 'silent' });
const HOURS = { mon: [{ open: '08:00', close: '17:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
const NOW = new Date('2026-10-13T08:00:00Z');

describe.skipIf(!url)('shop checkout and payment accounts (database)', () => {
  let prisma: PrismaClient;
  let customers: CustomerRepository;
  let tenants: TenantDirectory;
  let tenant: TenantProfile;
  let products: Record<'candle' | 'diffuser' | 'butter', string>;
  const generateLink = vi.fn();

  const handlers = (payments = true) =>
    new ConversationHandlers(prisma, customers, {
      menuCooldownMs: 0,
      privacyNoticeUrl: 'https://example.co.za/privacy',
      ...(payments
        ? {
            payments: {
              service: { forTenant: () => ({ generateWhatsAppPaymentLink: generateLink }), webhookUrl: 'https://example.co.za/api/payments/callback' },
              holdMinutes: 30,
              requestTemplate: 'payment_request',
              templateLanguage: 'en',
              logger,
            },
          }
        : {}),
    });

  /** One inbound message, as the webhook processor would run it. */
  async function send(waId: string, intent: Intent, bot = handlers()): Promise<BotReply | null> {
    const customer = await customers.touch(tenant.id, waId, 'Lindiwe', NOW);
    return bot.handle(intent, { tenant, customer, now: NOW });
  }

  const body = (reply: BotReply | null): string => {
    const message = reply?.message as { text?: { body: string }; interactive?: { body: { text: string } } } | undefined;
    return message?.text?.body ?? message?.interactive?.body.text ?? '';
  };
  const buttonIds = (reply: BotReply | null): string[] =>
    ((reply?.message as { interactive?: { action?: { buttons?: Array<{ reply: { id: string } }> } } }).interactive?.action?.buttons ?? []).map((b) => b.reply.id);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    customers = new CustomerRepository(prisma);
    tenants = new TenantDirectory(prisma, logger);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    generateLink.mockReset();
    generateLink.mockImplementation(async (orderId: string, amountZAR: number) => ({
      intentId: 'x',
      reference: 'WATEST',
      amountCents: Math.round(amountZAR * 100),
      linkToken: 't',
      shortUrl: `https://example.co.za/pay/${orderId}`,
      checkoutUrl: 'https://checkout.paystack.com/x',
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    }));
    const row = await prisma.tenant.create({
      data: {
        businessName: 'Ember Lane Scents',
        industry: 'PRODUCT_SELLER',
        waPhoneNumberId: `9${randomBytes(6).readUIntBE(0, 6)}`.slice(0, 15),
        waDisplayPhone: '+27 12 000 0002',
        workingHours: HOURS,
        depositBps: 10_000,
        deliveryEnabled: true,
        deliveryFeeCents: 6000,
        deliveryNote: 'Pretoria and Joburg only',
        collectionEnabled: true,
        addressLine: '4 Jacaranda Ave, Pretoria',
      },
    });
    tenant = (await tenants.byId(row.id)) as TenantProfile;
    const make = (name: string, priceCents: number, stockQuantity: number | null) =>
      prisma.product.create({ data: { tenantId: row.id, name, priceCents, stockQuantity }, select: { id: true } });
    products = {
      candle: (await make('Soy Candle Vanilla', 18000, 2)).id,
      diffuser: (await make('Reed Diffuser Fynbos', 22000, null)).id,
      butter: (await make('Body Butter Marula', 15000, 0)).id,
    };
  });

  it('builds a cart, takes a delivery address, reserves stock and asks for payment', async () => {
    const waId = '27821110001';
    let reply = await send(waId, { name: 'PICK_PRODUCT', productId: products.candle });
    reply = await send(waId, { name: 'PICK_PRODUCT', productId: products.candle });
    reply = await send(waId, { name: 'PICK_PRODUCT', productId: products.diffuser });
    expect(reply?.kind).toBe('CART');
    expect(body(reply)).toContain('2× Soy Candle Vanilla · R360.00');
    expect(body(reply)).toContain('Subtotal: *R580.00*');
    expect(buttonIds(reply)).toEqual(['cart:checkout', 'cart:add', 'cart:empty']);

    // Only two candles in stock: a third tap is capped.
    reply = await send(waId, { name: 'PICK_PRODUCT', productId: products.candle });
    expect(body(reply)).toContain('Only 2 Soy Candle Vanilla available');

    reply = await send(waId, { name: 'CART_CHECKOUT' });
    expect(buttonIds(reply)).toEqual(['ful:delivery', 'ful:collect']);
    expect(body(reply)).toContain('+R60.00');

    reply = await send(waId, { name: 'CHOOSE_FULFILMENT', fulfilment: 'DELIVERY' });
    expect(body(reply)).toContain('delivery address');

    reply = await send(waId, { name: 'UNRECOGNISED', text: 'short' });
    expect(body(reply)).toContain("doesn't look like a full address");

    reply = await send(waId, { name: 'UNRECOGNISED', text: '12 Main Rd\nHatfield\nPretoria 0083' });
    expect(reply?.kind).toBe('PAYMENT');
    expect(generateLink).toHaveBeenCalledWith(expect.any(String), 640, expect.any(String), NOW);

    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: tenant.id }, include: { items: true } });
    expect(order).toMatchObject({ status: 'PENDING_DEPOSIT', fulfilment: 'DELIVERY', deliveryAddress: '12 Main Rd, Hatfield, Pretoria 0083', deliveryFeeCents: 6000, totalCents: 64000 });
    expect(order.items).toHaveLength(2);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products.candle } })).stockQuantity).toBe(0);
    expect(await prisma.cartItem.count({ where: { tenantId: tenant.id } })).toBe(0);
    const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId: tenant.id, waId } });
    expect(customer).toMatchObject({ checkoutStage: 'NONE', savedAddress: '12 Main Rd, Hatfield, Pretoria 0083' });

    // Next time the saved address is offered; collection skips it entirely.
    await send(waId, { name: 'PICK_PRODUCT', productId: products.diffuser });
    await send(waId, { name: 'CART_CHECKOUT' });
    reply = await send(waId, { name: 'CHOOSE_FULFILMENT', fulfilment: 'DELIVERY' });
    expect(buttonIds(reply)).toEqual(['addr:saved', 'addr:new']);
    reply = await send(waId, { name: 'CHOOSE_FULFILMENT', fulfilment: 'COLLECTION' });
    expect(reply?.kind).toBe('PAYMENT');
    const collected = await prisma.order.findFirstOrThrow({ where: { tenantId: tenant.id, fulfilment: 'COLLECTION' } });
    expect(collected).toMatchObject({ totalCents: 22000, deliveryFeeCents: 0, deliveryAddress: null });
  });

  it('hides sold-out products and refuses to add them', async () => {
    const reply = await send('27821110002', { name: 'BOOK' });
    const rows = JSON.stringify(reply?.message);
    expect(rows).toContain('Reed Diffuser Fynbos');
    expect(rows).not.toContain('Body Butter Marula');
    const added = await send('27821110002', { name: 'PICK_PRODUCT', productId: products.butter });
    expect(body(added)).toContain('Body Butter Marula is sold out');
  });

  it('a menu tap while an address is awaited cancels the address step', async () => {
    const waId = '27821110003';
    await send(waId, { name: 'PICK_PRODUCT', productId: products.diffuser });
    await send(waId, { name: 'CHOOSE_FULFILMENT', fulfilment: 'DELIVERY' });
    await send(waId, { name: 'MENU' });
    const reply = await send(waId, { name: 'UNRECOGNISED', text: 'thanks so much, chat later' });
    expect(reply?.kind).toBe('MENU');
    expect(await prisma.order.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('sells the last item once when two customers check out together', async () => {
    await prisma.product.update({ where: { id: products.candle }, data: { stockQuantity: 1 } });
    for (const waId of ['27821110004', '27821110005']) await send(waId, { name: 'PICK_PRODUCT', productId: products.candle });
    const replies = await Promise.all(['27821110004', '27821110005'].map((waId) => send(waId, { name: 'CHOOSE_FULFILMENT', fulfilment: 'COLLECTION' })));
    expect(replies.map((r) => r?.kind).sort()).toEqual(['CART', 'PAYMENT']);
    expect(body(replies.find((r) => r?.kind === 'CART') ?? null)).toContain('just sold out');
    expect(await prisma.order.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products.candle } })).stockQuantity).toBe(0);
  });

  it('returns stock when an unpaid order expires', async () => {
    const waId = '27821110006';
    await send(waId, { name: 'PICK_PRODUCT', productId: products.candle });
    await send(waId, { name: 'CHOOSE_FULFILMENT', fulfilment: 'COLLECTION' });
    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId: tenant.id, waId } });
    await prisma.paymentIntent.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        orderId: order.id,
        provider: 'PAYSTACK',
        reference: `WA${randomBytes(5).toString('hex').toUpperCase()}`,
        linkToken: randomBytes(16).toString('hex'),
        amountCents: order.totalCents,
        checkoutUrl: 'https://checkout.paystack.com/x',
        expiresAt: new Date(NOW.getTime() - 3 * 3_600_000),
        createdAt: new Date(NOW.getTime() - 4 * 3_600_000),
      },
    });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products.candle } })).stockQuantity).toBe(1);

    const service = new PaymentService(
      { prisma, gateways: {}, defaultProvider: null, messenger: {} as never, tenants, logger },
      { publicBaseUrl: 'https://example.co.za', linkTtlMinutes: 30, maxAmountCents: 5_000_000, confirmationTemplate: 'c', templateLanguage: 'en' },
    );
    const summary = await service.reconcile(NOW);
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products.candle } })).stockQuantity).toBe(2);
  });

  it("verifies a Paystack webhook with the business's own key, not the platform's", async () => {
    const key = randomBytes(32);
    const accounts = new PaymentAccounts(prisma, {
      key,
      production: false,
      logger,
      payfast: { verifySourceIp: false, timeoutMs: 1000 },
      paystack: { baseUrl: 'https://api.paystack.test', timeoutMs: 1000, placeholderEmailDomain: 'example.co.za' },
    });
    const tenantKey = 'sk_test_tenantsecret123';
    await accounts.set(tenant.id, 'PAYSTACK', { secretKey: tenantKey });
    expect(await accounts.providers(tenant.id)).toEqual(['PAYSTACK']);
    const stored = await prisma.tenantPaymentAccount.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(stored.credentialsEnc).not.toContain('tenantsecret');

    await send('27821110007', { name: 'PICK_PRODUCT', productId: products.diffuser });
    await send('27821110007', { name: 'CHOOSE_FULFILMENT', fulfilment: 'COLLECTION' }, handlers(false));
    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: tenant.id } });
    await prisma.order.update({ where: { id: order.id }, data: { status: 'PENDING_DEPOSIT' } });
    const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId: tenant.id, waId: '27821110007' } });
    const reference = `WA${randomBytes(5).toString('hex').toUpperCase()}`;
    await prisma.paymentIntent.create({
      data: { tenantId: tenant.id, customerId: customer.id, orderId: order.id, provider: 'PAYSTACK', reference, linkToken: randomBytes(16).toString('hex'), amountCents: 22000, checkoutUrl: 'https://checkout.paystack.com/x', expiresAt: new Date(NOW.getTime() + 3_600_000) },
    });

    const tx = { id: 991, reference, status: 'success', amount: 22000, currency: 'ZAR', domain: 'test' };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: true, data: tx }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const platform = new PaystackGateway({ secretKey: 'sk_test_platformsecret', baseUrl: 'https://api.paystack.test', timeoutMs: 1000, logger, placeholderEmail: () => 'x@example.co.za' });
    const messenger = { send: vi.fn(async () => ({ status: 'sent' })) };
    const service = new PaymentService(
      { prisma, gateways: { PAYSTACK: platform }, defaultProvider: 'PAYSTACK', accounts, messenger: messenger as never, tenants, logger },
      { publicBaseUrl: 'https://example.co.za', linkTtlMinutes: 30, maxAmountCents: 5_000_000, confirmationTemplate: 'c', templateLanguage: 'en' },
    );
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: tx }));
    const context = (secret: string) => ({
      rawBody: raw,
      contentType: 'application/json',
      sourceIp: '127.0.0.1',
      header: (name: string) => (name === 'x-paystack-signature' ? createHmac('sha512', secret).update(raw).digest('hex') : undefined),
    });

    // Signed with the platform key: not authentic for this business's payment.
    await expect(service.handleNotification('PAYSTACK', context('sk_test_platformsecret'), NOW)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    const result = await service.handleNotification('PAYSTACK', context(tenantKey), NOW);
    expect(result).toMatchObject({ status: 'settled', confirmed: true });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/transaction/verify/${reference}`), expect.objectContaining({ headers: { Authorization: `Bearer ${tenantKey}` } }));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CONFIRMED');
    vi.unstubAllGlobals();
  });

  it('exports, then anonymises a customer on request, keeping the order', async () => {
    const waId = '27821110008';
    await send(waId, { name: 'PICK_PRODUCT', productId: products.diffuser });
    await send(waId, { name: 'CHOOSE_FULFILMENT', fulfilment: 'DELIVERY' });
    await send(waId, { name: 'UNRECOGNISED', text: '7 Long St, Cape Town 8001' }, handlers(false));
    const exported = await exportCustomer(prisma, tenant.id, waId);
    expect(exported?.customer).toMatchObject({ whatsappNumber: waId, name: 'Lindiwe', savedDeliveryAddress: '7 Long St, Cape Town 8001' });
    expect(exported?.orders[0]?.items).toEqual([{ product: 'Reed Diffuser Fynbos', quantity: 1, unitPriceCents: 22000 }]);

    // The order is still open: erasing now would strand it.
    expect(await eraseCustomer(prisma, tenant.id, waId)).toMatchObject({ status: 'open_items', orders: 1 });
    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: tenant.id } });
    await new DashboardService(prisma, { send: vi.fn() } as never, logger).setOrderStatus(tenant, order.id, 'CANCELLED', NOW);

    expect(await eraseCustomer(prisma, tenant.id, waId)).toMatchObject({ status: 'erased' });
    expect(await prisma.customer.count({ where: { tenantId: tenant.id, waId } })).toBe(0);
    const erased = await prisma.customer.findFirstOrThrow({ where: { tenantId: tenant.id, erasedAt: { not: null } } });
    expect(erased).toMatchObject({ displayName: null, savedAddress: null });
    expect(erased.waId).toMatch(/^0\d{14}$/);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ deliveryAddress: null, totalCents: 28000 });
  });

  it('cancelling on the dashboard returns stock; stock edits stay within the business', async () => {
    const waId = '27821110009';
    await send(waId, { name: 'PICK_PRODUCT', productId: products.candle });
    await send(waId, { name: 'CHOOSE_FULFILMENT', fulfilment: 'COLLECTION' }, handlers(false));
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products.candle } })).stockQuantity).toBe(1);
    const dashboard = new DashboardService(prisma, { send: vi.fn() } as never, logger);
    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const listed = await dashboard.orders(tenant, 'open');
    expect(listed[0]).toMatchObject({ fulfilment: 'COLLECTION', deliveryAddress: null });
    await dashboard.setOrderStatus(tenant, order.id, 'CANCELLED', NOW);
    await dashboard.setOrderStatus(tenant, order.id, 'CANCELLED', NOW);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products.candle } })).stockQuantity).toBe(2);

    expect(await dashboard.setStock(tenant, products.candle, 9)).toEqual({ ok: true });
    expect(await dashboard.setStock({ ...tenant, id: '00000000-0000-4000-8000-000000000000' }, products.candle, 50)).toEqual({ ok: false });
    expect((await dashboard.products(tenant)).find((p) => p.id === products.candle)?.stock).toBe(9);
  });

  it('tenant-apply sets stock only when a product is first created', async () => {
    const file = TenantFileSchema.parse({
      businessName: 'Apply Test Shop',
      industry: 'PRODUCT_SELLER',
      waPhoneNumberId: `8${Date.now()}`.slice(0, 15),
      waDisplayPhone: '+27 12 000 0003',
      ownerWaId: '27821234569',
      workingHours: HOURS,
      deliveryEnabled: true,
      deliveryFee: 75.5,
      products: [{ name: 'Wax Melts', price: 65, stock: 10 }],
    });
    const { tenantId } = await applyTenantFile(prisma, file);
    await prisma.product.updateMany({ where: { tenantId }, data: { stockQuantity: 4 } });
    await applyTenantFile(prisma, file);
    expect((await prisma.product.findFirstOrThrow({ where: { tenantId } })).stockQuantity).toBe(4);
    expect(await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).toMatchObject({ deliveryEnabled: true, deliveryFeeCents: 7550, collectionEnabled: true });
    expect(TenantFileSchema.safeParse({ ...file, deliveryEnabled: false, collectionEnabled: false }).success).toBe(false);
  });
});
