import { PrismaClient } from '@prisma/client';

/**
 * Single client, reused across hot reloads so tsx watch does not open a
 * new pool on every save. Matters more than usual here: the Supabase
 * project sits in ap-northeast-2 and every connection setup costs ~1.1s
 * from India.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export * from '@prisma/client';
