// Neon Postgres via Drizzle. Every portal route guards on hasDb() first —
// without DATABASE_URL the portal renders demo data instead of crashing.
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!_db) _db = drizzle(neon(process.env.DATABASE_URL), { schema });
  return _db;
}

export * as schema from "./schema";
