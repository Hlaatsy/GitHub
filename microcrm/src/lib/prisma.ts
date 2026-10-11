import { Prisma, PrismaClient } from '@prisma/client';

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({ log: ['warn', 'error'] });
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Serializable transaction aborted by a concurrent conflicting write. */
export function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}
