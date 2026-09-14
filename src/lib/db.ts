import { PrismaClient } from "@prisma/client";

/**
 * Serverless functions create a new module instance per cold start. Without this
 * singleton, each invocation opens a fresh pool and Neon's connection limit is
 * exhausted within a handful of requests.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Neon's free tier autosuspends the compute after a few minutes of inactivity.
 * The first query after suspension can fail outright rather than waiting for the
 * cold start. Wrap entry-point queries so the demo survives being opened days
 * after it was last touched.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 400
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
      }
    }
  }

  throw lastError;
}