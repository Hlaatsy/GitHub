-- CreateEnum
CREATE TYPE "IndustryType" AS ENUM ('SALON', 'DECOR_HIRE', 'PRODUCT_SELLER');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('TOP_UP', 'MESSAGE_DEBIT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "MessageCategory" AS ENUM ('SERVICE', 'UTILITY');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "businessName" VARCHAR(120) NOT NULL,
    "industry" "IndustryType" NOT NULL,
    "waPhoneNumberId" VARCHAR(32) NOT NULL,
    "waDisplayPhone" VARCHAR(20) NOT NULL,
    "ownerWaId" VARCHAR(15),
    "metaCatalogId" VARCHAR(32),
    "currency" CHAR(3) NOT NULL DEFAULT 'ZAR',
    "vatRegistered" BOOLEAN NOT NULL DEFAULT false,
    "vatRateBps" INTEGER NOT NULL DEFAULT 1500,
    "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT true,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Africa/Johannesburg',
    "workingHours" JSONB NOT NULL,
    "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
    "defaultSlotMinutes" INTEGER NOT NULL DEFAULT 60,
    "bookingCapacity" INTEGER NOT NULL DEFAULT 1,
    "minLeadMinutes" INTEGER NOT NULL DEFAULT 60,
    "autoConfirmBookings" BOOLEAN NOT NULL DEFAULT false,
    "addressLine" VARCHAR(200),
    "mapsUrl" VARCHAR(500),
    "mediaDownloadEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "waId" VARCHAR(15) NOT NULL,
    "displayName" VARCHAR(80),
    "firstContactAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "marketingConsentAt" TIMESTAMPTZ(3),
    "optedOutAt" TIMESTAMPTZ(3),
    "lastInboundAt" TIMESTAMPTZ(3),
    "lastMenuSentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "description" VARCHAR(200),
    "priceCents" INTEGER NOT NULL,
    "priceUnit" VARCHAR(20),
    "metaRetailerId" VARCHAR(100),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "serviceId" UUID,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'PENDING',
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "reference" VARCHAR(12) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "totalCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_wallets" (
    "tenantId" UUID NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "lowBalanceThresholdCents" INTEGER NOT NULL DEFAULT 1000,
    "lowBalanceNotifiedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_wallets_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "outboundMessageId" UUID,
    "reference" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_messages" (
    "wamid" VARCHAR(128) NOT NULL,
    "tenantId" UUID NOT NULL,
    "messageType" VARCHAR(24) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("wamid")
);

-- CreateTable
CREATE TABLE "outbound_messages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID,
    "wamid" VARCHAR(128) NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "costCents" INTEGER NOT NULL,
    "inReplyTo" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_waPhoneNumberId_key" ON "tenants"("waPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_waId_key" ON "customers"("tenantId", "waId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_id_key" ON "customers"("tenantId", "id");

-- CreateIndex
CREATE INDEX "services_tenantId_active_sortOrder_idx" ON "services"("tenantId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "services_tenantId_id_key" ON "services"("tenantId", "id");

-- CreateIndex
CREATE INDEX "products_tenantId_active_sortOrder_idx" ON "products"("tenantId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_id_key" ON "products"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_metaRetailerId_key" ON "products"("tenantId", "metaRetailerId");

-- CreateIndex
CREATE INDEX "appointments_tenantId_status_startsAt_idx" ON "appointments"("tenantId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "appointments_tenantId_customerId_idx" ON "appointments"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "orders_tenantId_createdAt_idx" ON "orders"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenantId_reference_key" ON "orders"("tenantId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenantId_id_key" ON "orders"("tenantId", "id");

-- CreateIndex
CREATE INDEX "order_items_tenantId_orderId_idx" ON "order_items"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_outboundMessageId_key" ON "wallet_transactions"("outboundMessageId");

-- CreateIndex
CREATE INDEX "wallet_transactions_tenantId_createdAt_idx" ON "wallet_transactions"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "inbound_messages_receivedAt_idx" ON "inbound_messages"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_wamid_key" ON "outbound_messages"("wamid");

-- CreateIndex
CREATE INDEX "outbound_messages_tenantId_createdAt_idx" ON "outbound_messages"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenantId_serviceId_fkey" FOREIGN KEY ("tenantId", "serviceId") REFERENCES "services"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_wallets" ADD CONSTRAINT "tenant_wallets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "outbound_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
