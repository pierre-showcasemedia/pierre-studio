// Team SOPs (/admin/sops): general procedures for how this studio works, in
// four departments. This file is the index: every SOP's title, the
// departments it sits under (one SOP may sit under two), and the parts of the
// studio it describes. The words are markdown, one file per SOP, in
// src/content/sops/<slug>.md (read by src/lib/sop-content.ts, which fills in
// {{name}} and the other business words, rendered by src/lib/sop-markdown.ts).
// How to change them: src/content/sops/README.md.
//
// Who reads it: everyone on the team (requireTeam: admins, the Photo QC team,
// creative specialists and video editors), every SOP. Clients and signed-out
// visitors never reach /admin. Pure data, no imports: the static checks
// (scripts/check-sops.ts, scripts/check-qa-role.ts) read it directly.

export type DepartmentId = "project-management" | "sales" | "qa-delivery" | "creative";

export type Department = { id: DepartmentId; label: string; blurb: string; sops: readonly string[] };

export type Sop = {
  slug: string;
  title: string;
  summary: string;
  sources: readonly string[]; // the parts of the studio it describes
};

// The version of these SOPs.
export const SOP_SNAPSHOT = { date: "Nov 15, 2026", commit: "studio-universal" } as const;

export const SOPS: readonly Sop[] = [
  // Project management
  { slug: "job-end-to-end", title: "Booking to delivery, end to end", summary: "The job in seven steps, from the website's booking form to a paid, delivered gallery.", sources: ["/admin/bookings", "/admin/upload", "/admin/listings"] },
  { slug: "booking-admin", title: "A booking's page", summary: "Every action on a booking: confirm time, assign shooter, set amount, mark paid, edit and cancel.", sources: ["/admin/bookings/<id>"] },
  { slug: "scheduling", title: "Scheduling", summary: "One calendar event per shoot, client notes on every event, and shooter assignment.", sources: ["/admin/bookings/<id>", "src/lib/google-calendar.ts"] },
  { slug: "rescheduling", title: "Rescheduling and cancellations", summary: "What each way of changing a shoot time sends the client.", sources: ["/admin/bookings/<id>", "/portal"] },
  { slug: "payments", title: "Payments", summary: "What unlocks a gallery, quoted bookings and fixing a stuck payment.", sources: ["/admin/bookings/<id>", "src/lib/payments.ts"] },
  { slug: "shooter-pay", title: "Shooter pay", summary: "The Shooter pay report: what counts, where the rates live and what Rate not set means.", sources: ["/admin/reports#pay", "src/lib/business.ts"] },
  // Sales
  { slug: "client-communication", title: "Client communication", summary: "How we write to clients, and the only messages that go out on their own.", sources: ["src/lib/business.ts"] },
  { slug: "booking-form", title: "Booking form", summary: "What the website's form asks, how it is priced and what the client gets.", sources: ["/book on the website", "src/lib/booking-intake.ts"] },
  { slug: "website-changes", title: "Changing prices", summary: "Changing a price on the website and the studio together.", sources: ["src/lib/booking-pricing.ts", "scripts/check-pricing.ts"] },
  // QA and delivery
  { slug: "photo-qc", title: "Photo QC", summary: "The automatic QC pass, a person's review, fixes and Publish.", sources: ["/admin/shoots/<id>"] },
  { slug: "delivery", title: "Delivery and downloads", summary: "Delivering on time, the delivery email and what unlocks downloads.", sources: ["/admin/listings/<id>", "/portal"] },
  { slug: "revisions", title: "Revisions", summary: "From a client's request to the corrected photos in the gallery.", sources: ["/admin/revisions"] },
  { slug: "nda", title: "NDA properties", summary: "Keeping a confidential property out of everything but the client's delivery.", sources: ["/admin/upload"] },
  // Creative specialists
  { slug: "shoot-prep", title: "Shoot prep", summary: "The shoot brief, the night before and the same-day upload.", sources: ["/admin/upload"] },
  { slug: "editing", title: "Editing", summary: "How editing runs, corrected finals and the gallery's sections.", sources: ["/admin/shoots/<id>"] },
  { slug: "return-shoots", title: "Return shoots", summary: "Return trips, pickups, reshoots and twilight returns on the same booking.", sources: ["/admin/bookings/<id>"] },
];

// The four departments in the side menu, each SOP in reading order.
export const DEPARTMENTS: readonly Department[] = [
  {
    id: "project-management",
    label: "Project management",
    blurb: "Running the job from booking to payment: scheduling, payments and shooter pay.",
    sops: ["job-end-to-end", "booking-admin", "scheduling", "rescheduling", "payments", "shooter-pay"],
  },
  {
    id: "sales",
    label: "Sales",
    blurb: "Client communication, the booking form and prices.",
    sops: ["client-communication", "booking-form", "website-changes"],
  },
  {
    id: "qa-delivery",
    label: "QA & delivery",
    blurb: "Photo QC, delivery and revisions.",
    sops: ["job-end-to-end", "photo-qc", "delivery", "revisions", "nda"],
  },
  {
    id: "creative",
    label: "Creative specialists",
    blurb: "On the shoot and in the edit.",
    sops: ["shoot-prep", "editing", "nda", "return-shoots"],
  },
];

const BY_SLUG = new Map(SOPS.map((s) => [s.slug, s]));

export const sopBySlug = (slug: string): Sop | undefined => BY_SLUG.get(slug);

// The side menu: every department with its SOPs, the same for every role.
export function sopMenu(): { dept: Department; sops: Sop[] }[] {
  return DEPARTMENTS.map((dept) => ({
    dept,
    sops: dept.sops.map((s) => BY_SLUG.get(s)).filter((s): s is Sop => Boolean(s)),
  })).filter((d) => d.sops.length > 0);
}

// The departments an SOP sits under, in menu order.
export const departmentsOf = (slug: string): Department[] => DEPARTMENTS.filter((d) => d.sops.includes(slug));
