import { createHash, randomBytes } from 'node:crypto';
import { type PrismaClient } from '@prisma/client';

export interface DashboardAuthOptions {
  publicBaseUrl: string;
  loginLinkTtlMinutes: number;
  sessionHours: number;
  /** Sessions idle for longer than this are refused, even before they expire. */
  idleMinutes: number;
}

export interface DashboardIdentity {
  sessionId: string;
  tenantId: string;
}

const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/**
 * Passwordless owner login. Possession of the owner's WhatsApp is the
 * credential: the owner messages LOGIN to their business number and gets a
 * single-use link back. Both login tokens and session cookies are stored only
 * as SHA-256 hashes, so a database leak yields nothing usable.
 */
export class DashboardAuth {
  private readonly publicOrigin: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: DashboardAuthOptions,
  ) {
    this.publicOrigin = new URL(options.publicBaseUrl).origin;
  }

  get origin(): string {
    return this.publicOrigin;
  }

  get sessionMaxAgeSeconds(): number {
    return this.options.sessionHours * 3600;
  }

  async issueLoginLink(tenantId: string, now: Date = new Date()): Promise<{ url: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(now.getTime() + this.options.loginLinkTtlMinutes * 60_000);
    await this.prisma.dashboardLoginToken.create({ data: { tenantId, tokenHash: sha256(token), expiresAt } });
    return { url: `${this.publicOrigin}/dashboard/login/${token}`, expiresAt };
  }

  /** Recent login links for a tenant, to rate-limit requests. */
  countRecentLinks(tenantId: string, since: Date): Promise<number> {
    return this.prisma.dashboardLoginToken.count({ where: { tenantId, createdAt: { gt: since } } });
  }

  async isLoginTokenUsable(token: string, now: Date = new Date()): Promise<boolean> {
    const row = await this.prisma.dashboardLoginToken.findUnique({ where: { tokenHash: sha256(token) } });
    return Boolean(row && !row.consumedAt && row.expiresAt > now);
  }

  /** Exchanges a login token for a session. Atomic: a token can only ever be used once. */
  async consumeLoginToken(token: string, now: Date = new Date()): Promise<{ sessionToken: string; tenantId: string } | null> {
    const tokenHash = sha256(token);
    const claimed = await this.prisma.dashboardLoginToken.updateMany({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return null;

    const { tenantId } = await this.prisma.dashboardLoginToken.findUniqueOrThrow({ where: { tokenHash }, select: { tenantId: true } });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { active: true } });
    if (!tenant?.active) return null;

    const sessionToken = newToken();
    await this.prisma.dashboardSession.create({
      data: {
        tenantId,
        tokenHash: sha256(sessionToken),
        expiresAt: new Date(now.getTime() + this.options.sessionHours * 3_600_000),
        lastSeenAt: now,
      },
    });
    return { sessionToken, tenantId };
  }

  async authenticate(sessionToken: string | undefined, now: Date = new Date()): Promise<DashboardIdentity | null> {
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
    const session = await this.prisma.dashboardSession.findUnique({
      where: { tokenHash: sha256(sessionToken) },
      include: { tenant: { select: { active: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= now || !session.tenant.active) return null;
    if (now.getTime() - session.lastSeenAt.getTime() > this.options.idleMinutes * 60_000) return null;

    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.prisma.dashboardSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    return { sessionId: session.id, tenantId: session.tenantId };
  }

  async revoke(sessionId: string, now: Date = new Date()): Promise<void> {
    await this.prisma.dashboardSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
  }
}
