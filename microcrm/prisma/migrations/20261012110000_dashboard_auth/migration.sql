-- CreateTable
CREATE TABLE "dashboard_login_tokens" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_login_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_login_tokens_tokenHash_key" ON "dashboard_login_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "dashboard_login_tokens_tenantId_createdAt_idx" ON "dashboard_login_tokens"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_sessions_tokenHash_key" ON "dashboard_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "dashboard_sessions_tenantId_idx" ON "dashboard_sessions"("tenantId");

-- AddForeignKey
ALTER TABLE "dashboard_login_tokens" ADD CONSTRAINT "dashboard_login_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_sessions" ADD CONSTRAINT "dashboard_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

