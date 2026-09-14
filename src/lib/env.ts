import { z } from "zod";

/**
 * Parsed once, at first import, on the server only. A missing DATABASE_URL should
 * fail loudly at boot rather than as a confusing Prisma error deep inside a
 * request handler.
 *
 * OpenRouter values are optional so that replay mode and the database rounds work
 * without a key present.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("anthropic/claude-sonnet-4.5"),
  AGENT_MODE: z.enum(["live", "replay"]).default("live"),
  ADMIN_SEED_TOKEN: z.string().optional(),
});

const parsed = schema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  DIRECT_URL: process.env.DIRECT_URL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  AGENT_MODE: process.env.AGENT_MODE,
  ADMIN_SEED_TOKEN: process.env.ADMIN_SEED_TOKEN,
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

/** True when the agent can actually reach OpenRouter. */
export const canRunLive =
  env.AGENT_MODE === "live" && Boolean(env.OPENROUTER_API_KEY);