-- CreateEnum
CREATE TYPE "Fulfilment" AS ENUM ('DELIVERY', 'COLLECTION');

-- CreateEnum
CREATE TYPE "CheckoutStage" AS ENUM ('NONE', 'AWAITING_ADDRESS');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "checkoutStage" "CheckoutStage" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "erasedAt" TIMESTAMPTZ(3),
ADD COLUMN     "savedAddress" VARCHAR(300);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryAddress" VARCHAR(300),
ADD COLUMN     "deliveryFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fulfilment" "Fulfilment";

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "stockQuantity" INTEGER;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "collectionEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "deliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deliveryFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryNote" VARCHAR(120);

-- CreateTable
CREATE TABLE "tenant_payment_accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "credentialsEnc" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_payment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_payment_accounts_tenantId_provider_key" ON "tenant_payment_accounts"("tenantId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_tenantId_customerId_productId_key" ON "cart_items"("tenantId", "customerId", "productId");

-- AddForeignKey
ALTER TABLE "tenant_payment_accounts" ADD CONSTRAINT "tenant_payment_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Stock can never go negative: reservations use conditional decrements, this is the backstop.
ALTER TABLE "products" ADD CONSTRAINT "products_stock_not_negative" CHECK ("stockQuantity" IS NULL OR "stockQuantity" >= 0);
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" BETWEEN 1 AND 99);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_delivery_fee_not_negative" CHECK ("deliveryFeeCents" >= 0);
