import { createHash, randomBytes, randomInt } from 'node:crypto';
import { type PaymentProvider, type PrismaClient } from '@prisma/client';
import { formatWorkingHours } from '../domain/workingHours';
import { type Logger } from '../lib/logger';
import { formatZar } from '../lib/money';
import { maskMsisdn } from '../lib/msisdn';
import { formatTime } from '../lib/time';
import { formatPaymentLinkMessage } from '../payments/messages';
import { type PaymentService } from '../payments/PaymentService';
import { type OutboundMessenger } from '../services/messenger';
import { type TenantDirectory, type TenantProfile } from '../services/tenants';

export type StepState = 'done' | 'waiting' | 'todo' | 'blocked';

export interface ChecklistStep {
  key: 'connect' | 'hours' | 'catalog' | 'wallet' | 'templates' | 'payments' | 'test_payment';
  title: string;
  state: StepState;
  /** Plain text; rendered escaped. */
  detail: string[];
}

export interface Checklist {
  businessName: string;
  steps: ChecklistStep[];
  canSendTestPayment: boolean;
  /** Something is in flight; the page refreshes itself. */
  waiting: boolean;
}

const PROVIDER_NAMES: Record<PaymentProvider, string> = { OZOW: 'Ozow', PAYFAST: 'PayFast', PAYSTACK: 'Paystack' };

export type TestPaymentResult = 'sent' | 'already_waiting' | 'blocked' | 'failed';

export interface OnboardingDeps {
  prisma: PrismaClient;
  tenants: TenantDirectory;
  messenger: OutboundMessenger;
  /** Null when the platform has no payment provider configured. */
  payments: PaymentService | null;
  logger: Logger;
}

export interface OnboardingOptions {
  publicBaseUrl: string;
  linkTtlHours: number;
  testAmountCents: number;
  templateLanguage: string;
  requestTemplate: string;
  /** Templates that must be approved before go-live. */
  requiredTemplates: readonly string[];
}

const SERVICE_WINDOW_MS = 24 * 60 * 60_000;
/** Treat the window as closing a little early, so a send never races its expiry. */
const WINDOW_SAFETY_MS = 10 * 60_000;
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Walks a business owner from "number connected" to "first real payment
 * confirmed", reading every step's state live from the database so the page
 * always reflects what actually works.
 */
export class OnboardingService {
  private readonly publicOrigin: string;

  constructor(
    private readonly deps: OnboardingDeps,
    private readonly options: OnboardingOptions,
  ) {
    this.publicOrigin = new URL(options.publicBaseUrl).origin;
  }

  /** Issues a fresh private link, invalidating any earlier one. Only its hash is stored. */
  async issueLink(tenantId: string, now: Date = new Date()): Promise<{ url: string; expiresAt: Date }> {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.options.linkTtlHours * 3_600_000);
    await this.deps.prisma.tenant.update({
      where: { id: tenantId },
      data: { onboardingTokenHash: hashToken(token), onboardingTokenExpiresAt: expiresAt },
    });
    return { url: `${this.publicOrigin}/onboarding/${token}`, expiresAt };
  }

  async resolve(token: string, now: Date = new Date()): Promise<TenantProfile | null> {
    const row = await this.deps.prisma.tenant.findUnique({
      where: { onboardingTokenHash: hashToken(token) },
      select: { id: true, onboardingTokenExpiresAt: true, active: true },
    });
    if (!row?.active || !row.onboardingTokenExpiresAt || row.onboardingTokenExpiresAt <= now) return null;
    return this.deps.tenants.byId(row.id);
  }

  async checklist(tenant: TenantProfile, now: Date = new Date()): Promise<Checklist> {
    const { prisma, payments } = this.deps;
    const isSalon = tenant.industry === 'SALON';

    const [owner, catalogCount, wallet, templates, testOrder] = await Promise.all([
      tenant.ownerWaId
        ? prisma.customer.findUnique({ where: { tenantId_waId: { tenantId: tenant.id, waId: tenant.ownerWaId } }, select: { lastInboundAt: true } })
        : null,
      isSalon
        ? prisma.service.count({ where: { tenantId: tenant.id, active: true } })
        : prisma.product.count({ where: { tenantId: tenant.id, active: true } }),
      prisma.tenantWallet.findUnique({ where: { tenantId: tenant.id } }),
      tenant.waBusinessAccountId
        ? prisma.messageTemplate.findMany({
            where: { wabaId: tenant.waBusinessAccountId, language: this.options.templateLanguage, name: { in: [...this.options.requiredTemplates] } },
          })
        : [],
      prisma.order.findFirst({
        where: { tenantId: tenant.id, isTest: true },
        orderBy: { createdAt: 'desc' },
        include: { paymentIntents: { orderBy: { createdAt: 'desc' }, take: 1 } },
      }),
    ]);

    const steps: ChecklistStep[] = [];

    // 1. The webhook works end to end: the owner's own message reached us.
    const connected = Boolean(owner?.lastInboundAt);
    steps.push({
      key: 'connect',
      title: 'Connect your WhatsApp number',
      state: !tenant.ownerWaId ? 'blocked' : connected ? 'done' : 'todo',
      detail: !tenant.ownerWaId
        ? ['No owner phone number is on file. Ask support to add yours.']
        : connected
          ? [`We received your message from ${maskMsisdn(tenant.ownerWaId)}.`]
          : [`From your own phone (${maskMsisdn(tenant.ownerWaId)}), send "HI" to ${tenant.waDisplayPhone} on WhatsApp.`],
    });

    // 2. Opening hours drive the slot list and the Location/Hours reply.
    const hours = formatWorkingHours(tenant.workingHours);
    const hasHours = hours.some((line) => !line.endsWith('Closed'));
    steps.push({
      key: 'hours',
      title: 'Set your opening hours',
      state: hasHours ? 'done' : 'todo',
      detail: hasHours ? hours : ['No opening hours yet, so customers cannot book. Ask support to set them.'],
    });

    // 3. Something to book or buy.
    steps.push({
      key: 'catalog',
      title: isSalon ? 'Add your services and prices' : 'Add your products and prices',
      state: catalogCount > 0 ? 'done' : 'todo',
      detail: [catalogCount > 0 ? `${catalogCount} active ${isSalon ? 'service' : 'product'}${catalogCount === 1 ? '' : 's'}.` : 'Nothing listed yet.'],
    });

    // 4. Every reply is paid for from the wallet.
    const funded = Boolean(wallet && wallet.balanceCents >= wallet.lowBalanceThresholdCents);
    steps.push({
      key: 'wallet',
      title: 'Fund your message wallet',
      state: funded ? 'done' : 'todo',
      detail: wallet
        ? [`Balance ${formatZar(wallet.balanceCents)}${funded ? '.' : `: top up to at least ${formatZar(wallet.lowBalanceThresholdCents)}.`}`]
        : ['No wallet yet. Ask support to open one.'],
    });

    // 5. Meta must approve the templates used outside the 24-hour window.
    const byName = new Map(templates.map((t) => [t.name, t]));
    const templateLines = this.options.requiredTemplates.map((name) => {
      const row = byName.get(name);
      if (!row) return `${name}: not submitted yet`;
      const reclassified = row.category !== row.requestedCategory ? ` (Meta set the category to ${row.category})` : '';
      return `${name}: ${row.status.toLowerCase()}${row.rejectedReason ? `, ${row.rejectedReason}` : ''}${reclassified}`;
    });
    const allApproved = this.options.requiredTemplates.every((name) => byName.get(name)?.status === 'APPROVED');
    const anyPending = this.options.requiredTemplates.some((name) => byName.get(name)?.status === 'PENDING');
    steps.push({
      key: 'templates',
      title: 'Get your WhatsApp templates approved',
      state: !tenant.waBusinessAccountId ? 'blocked' : allApproved ? 'done' : anyPending ? 'waiting' : 'todo',
      detail: tenant.waBusinessAccountId
        ? [...templateLines, ...(allApproved ? [] : ['Meta usually reviews within a day.'])]
        : ['Your WhatsApp Business Account ID is not on file. Ask support to add it.'],
    });

    // 6. A payment account, and deposits switched on.
    const setup = payments ? await payments.paymentSetup(tenant.id) : null;
    const paymentsOn = Boolean(setup) && tenant.depositBps > 0;
    const providerName = setup ? PROVIDER_NAMES[setup.provider] : '';
    steps.push({
      key: 'payments',
      title: 'Turn on online payments',
      state: !setup ? 'blocked' : paymentsOn ? 'done' : 'todo',
      detail: !setup
        ? ['No payment account is linked yet. Send support your PayFast or Paystack details so customers can pay you directly.']
        : paymentsOn
          ? [
              `Customers pay ${tenant.depositBps / 100}% upfront through ${providerName}.`,
              setup.ownAccount ? `Money goes straight into your own ${providerName} account.` : `Money is collected into the platform's ${providerName} account and paid over to you.`,
            ]
          : ['Choose how much customers pay upfront (for example 50%, or 100% for shop orders). Ask support to set it.'],
    });

    // 7. A real payment, end to end, to the owner's own phone.
    const intent = testOrder?.paymentIntents[0];
    const prerequisites = connected && funded && paymentsOn;
    const ownerInWindow = Boolean(owner?.lastInboundAt && now.getTime() - owner.lastInboundAt.getTime() < SERVICE_WINDOW_MS - WINDOW_SAFETY_MS);
    const requestApproved = byName.get(this.options.requestTemplate)?.status === 'APPROVED';
    const amount = formatZar(this.options.testAmountCents);

    let testState: StepState;
    let testDetail: string[];
    if (intent?.status === 'SUCCEEDED' && testOrder?.status === 'CONFIRMED' && intent.customerNotifiedAt) {
      testState = 'done';
      testDetail = [
        `Paid ${formatZar(intent.amountCents)} and confirmed at ${formatTime(intent.settledAt ?? now, tenant.timezone)}.`,
        'Payment link, bank settlement, booking confirmation and WhatsApp receipt all work.',
      ];
    } else if (intent?.status === 'SUCCEEDED') {
      testState = 'waiting';
      testDetail = ['Payment received. Sending your WhatsApp confirmation…'];
    } else if (intent?.status === 'PENDING' && intent.expiresAt > now && testOrder?.status === 'PENDING_DEPOSIT') {
      testState = 'waiting';
      testDetail = [`A ${formatZar(intent.amountCents)} payment link is waiting in your WhatsApp. Pay it like a customer would; this page updates by itself.`];
    } else if (!prerequisites) {
      testState = 'blocked';
      testDetail = ['Finish the steps above first: number connected, wallet funded and deposits on.'];
    } else if (!ownerInWindow && !requestApproved) {
      testState = 'todo';
      testDetail = [`Send "HI" to ${tenant.waDisplayPhone} again first (WhatsApp only allows a free-form link within 24 hours of your last message), then press the button.`];
    } else {
      testState = 'todo';
      testDetail = [
        `We will send a real ${amount} payment link to your WhatsApp. Pay it like a customer would and watch each step complete.`,
        ...(intent && intent.status !== 'PENDING' ? [`Your last test ended as ${intent.status.toLowerCase()}; you can try again.`] : []),
      ];
    }
    steps.push({ key: 'test_payment', title: 'Make your first test payment', state: testState, detail: testDetail });

    return {
      businessName: tenant.businessName,
      steps,
      canSendTestPayment: testState === 'todo' && prerequisites && (ownerInWindow || requestApproved),
      waiting: steps.some((step) => step.state === 'waiting'),
    };
  }

  /** Creates a test order for the owner and sends its pay link through the normal customer path. */
  async sendTestPayment(tenant: TenantProfile, now: Date = new Date()): Promise<TestPaymentResult> {
    const { prisma, payments, messenger, logger } = this.deps;
    const checklist = await this.checklist(tenant, now);
    const test = checklist.steps.find((step) => step.key === 'test_payment');
    if (test?.state === 'waiting') return 'already_waiting';
    if (!checklist.canSendTestPayment || !payments || !tenant.ownerWaId) return 'blocked';

    const owner = await prisma.customer.findUniqueOrThrow({
      where: { tenantId_waId: { tenantId: tenant.id, waId: tenant.ownerWaId } },
      select: { id: true, waId: true, lastInboundAt: true },
    });
    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        customerId: owner.id,
        reference: testReference(),
        totalCents: this.options.testAmountCents,
        status: 'PENDING_DEPOSIT',
        isTest: true,
      },
      select: { id: true, reference: true },
    });

    let intentId: string | null = null;
    try {
      const link = await payments
        .forTenant(tenant.id)
        .generateWhatsAppPaymentLink(order.id, this.options.testAmountCents / 100, payments.webhookUrl, now);
      intentId = link.intentId;
      const inServiceWindow = Boolean(owner.lastInboundAt && now.getTime() - owner.lastInboundAt.getTime() < SERVICE_WINDOW_MS - WINDOW_SAFETY_MS);
      const message = formatPaymentLinkMessage(
        link,
        {
          businessName: tenant.businessName,
          timeZone: tenant.timezone,
          summary: `Test payment ${order.reference} for your WhatsApp setup`,
          templateLanguage: this.options.templateLanguage,
          requestTemplate: this.options.requestTemplate,
        },
        { inServiceWindow },
      );
      const outcome = await messenger.send(tenant, owner, message, { now });
      if (outcome.status !== 'sent') throw new Error(`pay link not sent: ${outcome.status}`);
      await prisma.paymentIntent.update({ where: { id: link.intentId }, data: { payLinkWamid: outcome.wamid } });
      logger.info({ tenantId: tenant.id, orderId: order.id }, 'onboarding test payment link sent');
      return 'sent';
    } catch (error) {
      logger.error({ err: error, tenantId: tenant.id, orderId: order.id }, 'onboarding test payment failed');
      await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
      if (intentId) {
        // The link never reached the owner: close it so the page does not wait on it.
        await prisma.paymentIntent.updateMany({ where: { id: intentId, status: 'PENDING' }, data: { status: 'FAILED', failureReason: 'Pay link not delivered' } });
      }
      return 'failed';
    }
  }
}

function testReference(): string {
  let reference = 'TEST';
  for (let index = 0; index < 6; index++) reference += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return reference;
}
