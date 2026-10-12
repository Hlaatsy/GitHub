-- AlterEnum
ALTER TYPE "MessageCategory" ADD VALUE 'SMS';

-- AlterTable
ALTER TABLE "payment_intents" ADD COLUMN     "payLinkWamid" VARCHAR(128),
ADD COLUMN     "smsFallbackSentAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_payLinkWamid_key" ON "payment_intents"("payLinkWamid");

