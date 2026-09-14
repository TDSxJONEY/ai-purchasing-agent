import type { NextRequest } from "next/server";
import { env } from "./env";

export function adminAuthorized(req: NextRequest | Request): boolean {
  const expected = env.ADMIN_SEED_TOKEN;
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }

  const header =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    req.headers.get("x-admin-token") ??
    "";

  return header === expected;
}
