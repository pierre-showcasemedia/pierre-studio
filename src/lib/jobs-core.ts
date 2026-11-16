// Shared by the job queue (jobs.ts), the intake batch and every handler, so
// handlers never import the drainer and the intake never imports a handler.
import { AsyncLocalStorage } from "node:async_hooks";
import type { JobKind, JobPayload } from "@/db/schema";
import { db, schema } from "@/db";

// Rows (jobs, invoices, bookings, payment events) carry the environment that
// wrote them. Preview and production share one database, so the production
// cron drains production rows only and a preview drains its own.
export type Env = "production" | "preview" | "development";
export function currentEnv(): Env {
  const v = (process.env.VERCEL_ENV || "").trim();
  if (v === "production" || v === "preview") return v;
  return "development";
}

// One row per logical side effect per version: `${kind}:${id}:${version}`.
export function jobKey(kind: JobKind, id: string, version = 1): string {
  return `${kind}:${id}:${version}`;
}

export type JobSpec = {
  kind: JobKind;
  idempotencyKey: string;
  payload?: JobPayload;
  listingId?: string | null;
  bookingId?: string | null;
  invoiceId?: string | null;
  runAt?: Date;
};

export function jobRows(specs: JobSpec[]): (typeof schema.jobs.$inferInsert)[] {
  const env = currentEnv();
  return specs.map((s) => ({
    kind: s.kind,
    idempotencyKey: s.idempotencyKey,
    payload: s.payload ?? {},
    listingId: s.listingId ?? null,
    bookingId: s.bookingId ?? null,
    invoiceId: s.invoiceId ?? null,
    runAt: s.runAt ?? new Date(),
    env,
  }));
}

// Enqueue outside the intake batch (a webhook, a job handler, an admin action).
// The idempotency key makes a repeat a no-op; returns how many rows were new.
export async function enqueueJobs(specs: JobSpec[]): Promise<number> {
  if (!specs.length) return 0;
  const rows = await db().insert(schema.jobs).values(jobRows(specs)).onConflictDoNothing({ target: schema.jobs.idempotencyKey }).returning({ id: schema.jobs.id });
  return rows.length;
}

// When the drain that is running the current handler must have returned by.
// Set by drainJobs before each job; a handler that works in chunks (the
// Dropbox mirror streaming a 4 GB clip) reads it to stop in time, save its
// cursor and defer, so a tick never cuts a chunk short. Infinity outside a
// drain (a script, a test).
//
// Oct 27 2026: held per drain (AsyncLocalStorage), not in a module variable.
// Several drains now run at once in one instance (the cron's Dropbox pass and
// each upload's copy drain), and a shared variable let one drain's deadline
// stop another's copy early or run it past its own.
const deadlineStore = new AsyncLocalStorage<number>();
export function runWithDrainDeadline<T>(at: number, fn: () => Promise<T>): Promise<T> {
  return deadlineStore.run(at, fn);
}
export function drainDeadline(): number {
  return deadlineStore.getStore() ?? Number.POSITIVE_INFINITY;
}

// Thrown by a handler whose provider is not configured in this environment
// (no Stripe key, no calendar account, a step that is not built yet). The job
// stays queued, the attempt is not counted, the team hears about it once.
export class NotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not configured`);
    this.name = "NotConfiguredError";
  }
}

// Thrown by a handler that has to wait for something else (an invoice that is
// not issued yet). Re-run after `ms`; the attempt is not counted; no alert.
export class DeferError extends Error {
  readonly ms: number;
  constructor(message: string, ms = 120_000) {
    super(message);
    this.name = "DeferError";
    this.ms = ms;
  }
}

// Thrown by a handler when there is nothing left to do (the booking was
// canceled before its email went out, the invoice it would link is void). The
// job is marked done with the reason as its note: no retry, no alert.
export class SkipJobError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipJobError";
  }
}

// Thrown by a handler for a failure no retry can fix (an amount outside the
// provider's range). The job dies at once with the one hub alert, instead of
// eight attempts over four hours.
export class FatalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalJobError";
  }
}
