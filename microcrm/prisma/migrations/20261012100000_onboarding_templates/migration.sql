-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'OTHER');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "onboardingTokenExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "onboardingTokenHash" CHAR(64),
ADD COLUMN     "waBusinessAccountId" VARCHAR(32);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "wabaId" VARCHAR(32) NOT NULL,
    "name" VARCHAR(512) NOT NULL,
    "language" VARCHAR(15) NOT NULL,
    "requestedCategory" VARCHAR(20) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "status" "TemplateStatus" NOT NULL,
    "metaTemplateId" VARCHAR(32),
    "rejectedReason" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_wabaId_name_language_key" ON "message_templates"("wabaId", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_onboardingTokenHash_key" ON "tenants"("onboardingTokenHash");

