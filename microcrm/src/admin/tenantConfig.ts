import { type Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { WorkingHoursSchema } from '../domain/workingHours';

// "Configuration as code" for a business: one JSON file describes it, and
// applying the file creates or updates it. Catalog items are matched by name;
// items no longer in the file are deactivated (never deleted, so past
// bookings and orders keep their references).

const rands = z
  .number()
  .nonnegative()
  .max(1_000_000)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'at most two decimal places')
  .transform((value) => Math.round(value * 100));

export const TenantFileSchema = z
  .object({
    businessName: z.string().min(1).max(120),
    industry: z.enum(['SALON', 'DECOR_HIRE', 'PRODUCT_SELLER']),
    waPhoneNumberId: z.string().regex(/^\d{5,32}$/),
    waDisplayPhone: z.string().min(5).max(20),
    waBusinessAccountId: z.string().regex(/^\d{5,32}$/).optional(),
    ownerWaId: z.string().regex(/^[1-9]\d{7,14}$/, 'digits only, with country code, e.g. 27821234567'),
    timezone: z.string().default('Africa/Johannesburg'),
    addressLine: z.string().max(200).optional(),
    mapsUrl: z.string().url().startsWith('https://').max(500).optional(),
    workingHours: WorkingHoursSchema,
    slotIntervalMinutes: z.number().int().min(5).max(240).default(30),
    defaultSlotMinutes: z.number().int().min(5).max(720).default(60),
    bookingCapacity: z.number().int().min(1).max(50).default(1),
    minLeadMinutes: z.number().int().min(0).max(10_080).default(60),
    autoConfirmBookings: z.boolean().default(false),
    depositPercent: z.number().min(0).max(100).default(0),
    /** Gateway for this business's deposits; omit to use the platform default. */
    paymentProvider: z.enum(['OZOW', 'PAYFAST', 'PAYSTACK']).optional(),
    metaCatalogId: z.string().regex(/^\d{5,32}$/).optional(),
    /** Shops: how customers get their order. At least one must be on. */
    deliveryEnabled: z.boolean().default(false),
    deliveryFee: rands.default(0),
    /** Shown at checkout, e.g. "Pretoria and Joburg only, 2-3 working days". */
    deliveryNote: z.string().max(120).optional(),
    collectionEnabled: z.boolean().default(true),
    services: z
      .array(z.object({ name: z.string().min(1).max(60), durationMinutes: z.number().int().min(5).max(720), price: rands }))
      .default([]),
    products: z
      .array(
        z.object({
          name: z.string().min(1).max(60),
          description: z.string().max(200).optional(),
          price: rands,
          priceUnit: z.string().max(20).optional(),
          metaRetailerId: z.string().max(100).optional(),
          /**
           * Units on hand; omit for "don't track". Applied only when the product is
           * first created: afterwards stock moves with orders and is adjusted on
           * the dashboard, so re-applying the file never overwrites it.
           */
          stock: z.number().int().min(0).max(100_000).optional(),
        }),
      )
      .default([]),
    /** Only used when the business is first created. */
    openingWalletBalance: rands.default(0),
  })
  .superRefine((file, ctx) => {
    const dupes = (names: string[]) => names.filter((name, index) => names.indexOf(name) !== index);
    for (const name of dupes(file.services.map((s) => s.name))) ctx.addIssue({ code: 'custom', path: ['services'], message: `duplicate service "${name}"` });
    for (const name of dupes(file.products.map((p) => p.name))) ctx.addIssue({ code: 'custom', path: ['products'], message: `duplicate product "${name}"` });
    try {
      new Intl.DateTimeFormat('en', { timeZone: file.timezone });
    } catch {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: `unknown time zone ${file.timezone}` });
    }
    if (file.industry !== 'SALON' && !file.deliveryEnabled && !file.collectionEnabled) {
      ctx.addIssue({ code: 'custom', path: ['collectionEnabled'], message: 'turn on delivery, collection, or both' });
    }
  });

export type TenantFile = z.infer<typeof TenantFileSchema>;

export interface ApplyResult {
  tenantId: string;
  created: boolean;
  catalog: { added: number; updated: number; deactivated: number };
}

export async function applyTenantFile(prisma: PrismaClient, file: TenantFile): Promise<ApplyResult> {
  return prisma.$transaction(async (tx) => {
    const settings = {
      businessName: file.businessName,
      industry: file.industry,
      waDisplayPhone: file.waDisplayPhone,
      waBusinessAccountId: file.waBusinessAccountId ?? null,
      ownerWaId: file.ownerWaId,
      timezone: file.timezone,
      addressLine: file.addressLine ?? null,
      mapsUrl: file.mapsUrl ?? null,
      workingHours: file.workingHours as Prisma.InputJsonValue,
      slotIntervalMinutes: file.slotIntervalMinutes,
      defaultSlotMinutes: file.defaultSlotMinutes,
      bookingCapacity: file.bookingCapacity,
      minLeadMinutes: file.minLeadMinutes,
      autoConfirmBookings: file.autoConfirmBookings,
      depositBps: Math.round(file.depositPercent * 100),
      paymentProvider: file.paymentProvider ?? null,
      metaCatalogId: file.metaCatalogId ?? null,
      deliveryEnabled: file.deliveryEnabled,
      deliveryFeeCents: file.deliveryFee,
      deliveryNote: file.deliveryNote ?? null,
      collectionEnabled: file.collectionEnabled,
    };

    const existing = await tx.tenant.findUnique({ where: { waPhoneNumberId: file.waPhoneNumberId }, select: { id: true } });
    const tenant = existing
      ? await tx.tenant.update({ where: { id: existing.id }, data: settings, select: { id: true } })
      : await tx.tenant.create({
          data: { ...settings, waPhoneNumberId: file.waPhoneNumberId, wallet: { create: { balanceCents: file.openingWalletBalance } } },
          select: { id: true },
        });

    const catalog = { added: 0, updated: 0, deactivated: 0 };

    const services = await tx.service.findMany({ where: { tenantId: tenant.id } });
    for (const [index, wanted] of file.services.entries()) {
      const match = services.find((s) => s.name === wanted.name);
      const data = { durationMinutes: wanted.durationMinutes, priceCents: wanted.price, active: true, sortOrder: index };
      if (match) {
        await tx.service.update({ where: { id: match.id }, data });
        catalog.updated++;
      } else {
        await tx.service.create({ data: { tenantId: tenant.id, name: wanted.name, ...data } });
        catalog.added++;
      }
    }
    const keepServices = new Set(file.services.map((s) => s.name));
    catalog.deactivated += (
      await tx.service.updateMany({ where: { tenantId: tenant.id, active: true, name: { notIn: [...keepServices] } }, data: { active: false } })
    ).count;

    const products = await tx.product.findMany({ where: { tenantId: tenant.id } });
    for (const [index, wanted] of file.products.entries()) {
      const match = products.find((p) => p.name === wanted.name);
      const data = {
        description: wanted.description ?? null,
        priceCents: wanted.price,
        priceUnit: wanted.priceUnit ?? null,
        metaRetailerId: wanted.metaRetailerId ?? null,
        active: true,
        sortOrder: index,
      };
      if (match) {
        await tx.product.update({ where: { id: match.id }, data });
        catalog.updated++;
      } else {
        await tx.product.create({ data: { tenantId: tenant.id, name: wanted.name, ...data, stockQuantity: wanted.stock ?? null } });
        catalog.added++;
      }
    }
    const keepProducts = new Set(file.products.map((p) => p.name));
    catalog.deactivated += (
      await tx.product.updateMany({ where: { tenantId: tenant.id, active: true, name: { notIn: [...keepProducts] } }, data: { active: false } })
    ).count;

    return { tenantId: tenant.id, created: !existing, catalog };
  });
}
