// The one rule for what a client may see (v1.2). A media row is client-facing
// only when all three hold:
//   1. qc_state = 'approved'   (QC, automatic or human, let it through)
//   2. published = true        (an admin clicked Publish since it landed)
//   3. its shoot, if any, has been published at least once
// Rule 3 covers rows written by older code with the column default (true)
// before an admin ever published the shoot. Legacy script uploads have no
// shoot and are governed by 1 and 2 alone.
//
// Every client-facing query goes through clientVisibleMedia(); the admin side
// reads the raw rows and shows the gate state instead: since Oct 2026 every
// frame there reads "Client visible" or "Internal only" with a reason
// (src/lib/visibility.ts, the same rule in a pure module). media.held (moved
// to internal by hand) is not part of this rule: a held frame always has
// published=false, which already hides it.
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";

export type GateRow = { qcState: string; published: boolean; shootId: string | null };
export type ShootGate = { id: string; publishedAt: Date | null };

// SQL half of the rule (1 and 2), for relational `where` clauses.
export function clientMediaWhere() {
  return and(eq(schema.media.qcState, "approved"), eq(schema.media.published, true));
}

// JS half (3): filter rows against the listing's shoots.
export function clientVisibleMedia<T extends GateRow>(rows: T[], shoots: ShootGate[]): T[] {
  const ok = new Set(shoots.filter((s) => s.publishedAt).map((s) => s.id));
  return rows.filter((m) => m.qcState === "approved" && m.published && (!m.shootId || ok.has(m.shootId)));
}

export function isClientVisible(m: GateRow, shoots: ShootGate[]): boolean {
  return clientVisibleMedia([m], shoots).length === 1;
}
