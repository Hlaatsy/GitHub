import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const weekdayHours = [{ open: '08:00', close: '17:00' }];

async function main(): Promise<void> {
  const salon = await prisma.tenant.upsert({
    where: { waPhoneNumberId: '100000000000001' },
    update: {},
    create: {
      businessName: 'Glow Studio Soweto',
      industry: 'SALON',
      waPhoneNumberId: '100000000000001',
      waDisplayPhone: '+27 11 000 0001',
      ownerWaId: '27820000001',
      addressLine: '12 Vilakazi St, Orlando West, Soweto',
      workingHours: {
        mon: weekdayHours,
        tue: weekdayHours,
        wed: weekdayHours,
        thu: weekdayHours,
        fri: weekdayHours,
        sat: [{ open: '08:00', close: '14:00' }],
        sun: [],
      },
      bookingCapacity: 2,
      wallet: { create: { balanceCents: 5000 } },
      services: {
        create: [
          { name: 'Wash & Blow', durationMinutes: 45, priceCents: 25000, sortOrder: 1 },
          { name: 'Box Braids', durationMinutes: 240, priceCents: 85000, sortOrder: 2 },
          { name: 'Gel Manicure', durationMinutes: 60, priceCents: 30000, sortOrder: 3 },
        ],
      },
    },
  });

  const decor = await prisma.tenant.upsert({
    where: { waPhoneNumberId: '100000000000002' },
    update: {},
    create: {
      businessName: 'Ubuhle Decor Hire',
      industry: 'DECOR_HIRE',
      waPhoneNumberId: '100000000000002',
      waDisplayPhone: '+27 31 000 0002',
      ownerWaId: '27830000002',
      workingHours: { mon: weekdayHours, tue: weekdayHours, wed: weekdayHours, thu: weekdayHours, fri: weekdayHours },
      wallet: { create: { balanceCents: 2000 } },
      products: {
        create: [
          { name: 'Tiffany Chair', priceCents: 3500, priceUnit: 'per day', sortOrder: 1 },
          { name: 'Gold Charger Plate', priceCents: 1200, priceUnit: 'per day', sortOrder: 2 },
          { name: 'Floral Arch', priceCents: 95000, priceUnit: 'per event', sortOrder: 3 },
          { name: 'Fairy Light Backdrop', priceCents: 45000, priceUnit: 'per event', sortOrder: 4 },
          { name: 'Round Table + Cloth', priceCents: 9500, priceUnit: 'per day', sortOrder: 5 },
        ],
      },
    },
  });

  console.log(`Seeded tenants ${salon.id} (salon) and ${decor.id} (decor hire)`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
