-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('OZOW');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "AppointmentStatus" ADD VALUE 'PENDING_DEPOSIT';

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'PENDING_DEPOSIT';

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "holdExpiresAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "depositBps" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "appointmentId" UUID,
    "orderId" UUID,
    "provider" "PaymentProvider" NOT NULL,
    "reference" VARCHAR(50) NOT NULL,
    "linkToken" VARCHAR(64) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'ZAR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "providerPaymentId" VARCHAR(100),
    "providerTransactionId" VARCHAR(100),
    "checkoutUrl" VARCHAR(1000),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "settledAt" TIMESTAMPTZ(3),
    "customerNotifiedAt" TIMESTAMPTZ(3),
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_reference_key" ON "payment_intents"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_linkToken_key" ON "payment_intents"("linkToken");

-- CreateIndex
CREATE INDEX "payment_intents_status_createdAt_idx" ON "payment_intents"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_intents_tenantId_appointmentId_idx" ON "payment_intents"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "payment_intents_tenantId_orderId_idx" ON "payment_intents"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_tenantId_id_key" ON "appointments"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenantId_appointmentId_fkey" FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "appointments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A payment intent settles exactly one appointment or one order.
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_single_subject"
  CHECK (num_nonnulls("appointmentId", "orderId") = 1);

-- Amounts are positive whole cents.
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_amount_positive"
  CHECK ("amountCents" > 0);
