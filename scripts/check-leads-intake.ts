// Checks for the Nov 24 2026 intake additions (offline, no database, no R2):
//   - leads from the website's pricing page (src/lib/leads.ts)
//   - files the client attaches on the booking form (src/lib/intake-files.ts)
//   - visit sources on leads and bookings
//
//   npx tsx scripts/check-leads-intake.ts
export {};
import { readFileSync } from "node:fs";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};
const read = (p: string) => readFileSync(p, "utf8");

async function main() {
  const { normalizeLead, visitLabel } = await import("../src/lib/leads");
  const { bookingAttachments, checkUpload, intakeKey, safeName, INTAKE_MAX_BYTES } = await import("../src/lib/intake-files");

  // 1. Leads
  const id = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  const good = normalizeLead({ submission_id: id.toUpperCase(), name: "  Avery Example ", email: "Avery@Example.com", client_type: "agent", brokerage: "Example Realty", visit: { utm_source: "google", referrer: "x.com", bad: "no" } });
  ok(good.ok && good.lead.id === id && good.lead.email === "avery@example.com" && good.lead.name === "Avery Example", "a lead is kept, trimmed and lower-cased");
  ok(good.ok && good.lead.visit && !("bad" in good.lead.visit) && good.lead.visit.utm_source === "google", "only known visit fields are kept");
  ok(!normalizeLead({ submission_id: "nope", name: "Avery", email: "a@b.co" }).ok, "a lead without a uuid is refused");
  ok(!normalizeLead({ submission_id: id, name: "A", email: "a@b.co" }).ok, "a lead without a name is refused");
  ok(!normalizeLead({ submission_id: id, name: "Avery", email: "not-an-email" }).ok, "a lead without an email is refused");
  const odd = normalizeLead({ submission_id: id, name: "Avery", email: "a@b.co", client_type: "admin" });
  ok(odd.ok && odd.lead.clientType === null, "an unknown client type is dropped");
  ok(visitLabel({ utm_source: "google", utm_medium: "cpc" }) === "google / cpc", "UTM tags read as the source");
  ok(visitLabel({ referrer: "facebook.com" }) === "facebook.com", "else the referring site");
  ok(visitLabel(null) === "Direct", "else Direct");

  const leadRoute = read("src/app/api/studio/leads/route.ts");
  ok(leadRoute.includes("BOOKING_INTAKE_SECRET") && leadRoute.includes("status: 404"), "the leads route hides without the intake secret");
  ok(!/resend|sendEmail|sms|quo/i.test(leadRoute + read("src/lib/leads.ts").replace(/never(Message)?/g, "")), "a lead never emails or texts anyone");
  const page = read("src/app/admin/leads/page.tsx");
  ok(page.includes("await requireAdmin()"), "the Leads page is admin only");

  // 2. Intake files
  ok(safeName("../../etc/passwd", "application/pdf") === "etc-passwd.pdf", "a file name can't climb out of its folder");
  ok(safeName("Plat Map (final).PDF", "application/pdf") === "Plat-Map-final.pdf", "a file name is made safe and keeps its type");
  ok(intakeKey(id, "plat.pdf", "application/pdf", "a1b2c3d4e5") === `intake/${id}/a1b2c3d4e5-plat.pdf`, "the key sits under the submission id");
  ok(intakeKey("nope", "plat.pdf", "application/pdf", "a1b2c3d4e5") === null, "no key without a uuid");
  ok(checkUpload({ submissionId: id, contentType: "application/pdf", size: 1000 }) === null, "a PDF is accepted");
  ok(checkUpload({ submissionId: id, contentType: "text/html", size: 1000 }) !== null, "a web page is refused");
  ok(checkUpload({ submissionId: id, contentType: "image/jpeg", size: INTAKE_MAX_BYTES + 1 }) !== null, "over 25 MB is refused");
  ok(checkUpload({ submissionId: id, contentType: "image/jpeg", size: 0 }) !== null, "an empty file is refused");

  const other = "11111111-2222-4333-8444-555555555555";
  const raw = {
    submissionIds: [id],
    payload: {
      attachments: [
        { key: `intake/${id}/a1b2c3d4e5-plat.pdf`, name: "plat.pdf", kind: "plat" },
        { key: `intake/${other}/a1b2c3d4e5-theirs.pdf`, name: "theirs.pdf" },
        { key: `listings/${id}/photo.jpg`, name: "photo.jpg" },
        { key: `intake/${id}/../../secret`, name: "x" },
        { key: `intake/${id}/deep/er.pdf`, name: "x" },
        "junk",
      ],
    },
  };
  const files = bookingAttachments(raw, id);
  ok(files.length === 1 && files[0].name === "plat.pdf" && files[0].kind === "plat", "a booking opens only its own intake files");
  ok(bookingAttachments({ submissionIds: [id, other], payload: raw.payload }, id).length === 2, "a revised booking also opens its earlier submission's files");
  ok(bookingAttachments(null, id).length === 0 && bookingAttachments({ payload: {} }, id).length === 0, "no payload, no files");

  const upload = read("src/app/api/studio/intake-upload/route.ts");
  ok(upload.includes("BOOKING_INTAKE_SECRET") && upload.includes("status: 404"), "upload addresses only for the website");
  ok(/presignedPutUrl\(key, contentType, 600\)/.test(upload), "an upload address lasts 10 minutes");
  const file = read("src/app/api/studio/intake-file/route.ts");
  ok(file.includes("requireAdminApi") && file.includes("bookingAttachments(b.raw, b.id)"), "opening a file: admins only, and only the booking's own");

  // 3. Schema and migrate route agree
  const migrate = read("src/app/api/portal/migrate/route.ts");
  const schema = read("src/db/schema.ts");
  ok(migrate.includes('CREATE TABLE IF NOT EXISTS "leads"'), "the migrate route creates leads idempotently");
  for (const col of ["kind", "name", "email", "phone", "client_type", "brokerage", "visit", "env", "created_at"]) {
    ok(migrate.includes(`"${col}"`) && schema.includes(`"${col}")`), `leads.${col} in both`);
  }
  ok(schema.includes('export const leads = pgTable("leads"'), "the schema mirrors it");

  console.log(failures ? `${failures} FAILED, ${passes} passed` : `All ${passes} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
