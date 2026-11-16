// the studio data model. One client (an agent) has many listings; each
// listing has many media files and is linked to its Stripe invoice(s).
// Schema changes ship through /api/portal/migrate (the DDL list there is the
// source of truth); keep this file in step with it.
// Downloads stay locked until the linked invoice is paid.
//
// v1.1 adds the team side: shoots (one upload run through editing), their
// files, a QC state on media, revision request status, and an activity log.
import { pgTable, text, timestamp, boolean, integer, bigint, uuid, jsonb, date, index, uniqueIndex, check, primaryKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { PhotoQcColumn } from "../lib/photo-qc";
import type { BundleProgress } from "../lib/bundles";

export const clients = pgTable("clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(), // matched to Stripe customer + magic-link login
  name: text("name"),
  company: text("company"),
  phone: text("phone"),
  stripeCustomerId: text("stripe_customer_id"),
  // Team slug (e.g. "smith-team"). Every client sharing a team sees every team
  // member's listings: one gallery, many emails.
  team: text("team"),
  // Short internal notes for the team (the brain holds the long version).
  notes: text("notes"),
  // Oct 26 2026: what this client wants from a video (pace, music, cuts,
  // what they asked to change before), kept by the team on the Video card so
  // the next edit starts where the last revision ended. Team only.
  videoNotes: text("video_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One row per team slug: the display name behind clients.team. A team can
// exist in clients.team without a row here (older data); the admin pages
// treat the slug as the name until one is set.
export const teams = pgTable("teams", {
  slug: text("slug").primaryKey(),
  name: text("name"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Admins added from /admin/settings, on top of ADMIN_EMAILS (which can never
// be removed from the UI, so nobody locks everyone out).
// Oct 2026: role. "admin" = everything; "qa" = the QA team (shoots, listings,
// frames, finals, visibility and publish; no money, clients, settings, view
// as, deletes or delivery emails); "creative" = a creative specialist, the
// shooter: Upload a shoot and the shoots they uploaded, nothing else (Oct 21
// 2026); "video" = a video editor (the video editor's team, Oct 26 2026): the Video
// board and the cards on it, nothing else. ADMIN_EMAILS are always "admin".
// Any other stored value is read as "qa". A plain text column with no check
// constraint, so a new value needs no migration. See src/lib/admin-allow.ts.
export const STAFF_ROLES = ["admin", "qa", "creative", "video"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
// How the admin names each role (settings, the header pill, activity lines).
// The "qa" role reads "Photo QC" since Oct 26 2026 (the stored value is unchanged).
export const ROLE_LABELS: Record<StaffRole, string> = { admin: "Admin", qa: "Photo QC", creative: "Creative specialist", video: "Video editor" };
export const admins = pgTable("admins", {
  email: text("email").primaryKey(),
  name: text("name"),
  addedBy: text("added_by"),
  role: text("role").default("admin").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const listings = pgTable("listings", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  address: text("address").notNull(), // "100 Example Lane, Springfield, CA 90000"
  slug: text("slug").notNull().unique(), // "100-example-lane"
  shootDate: timestamp("shoot_date"),
  coverKey: text("cover_key"), // R2 key of the cover image
  // Downloads locked until payment clears. The Stripe webhook flips this on
  // invoice.paid; an admin can override manually.
  downloadLocked: boolean("download_locked").default(true).notNull(),
  // Unguessable token for the public preview-only share page (/share/<token>).
  // DB-generated default; no downloads are ever minted through this route.
  shareToken: text("share_token").unique(),
  // When the delivery email was last sent, and when the client approved the
  // gallery ("Completed"). Approval comes from the portal's Approve button.
  deliveryEmailAt: timestamp("delivery_email_at"),
  approvedAt: timestamp("approved_at"),
  // External links shown under the gallery ("Zillow 3D Tour", property site…).
  // JSON string: [{ "label": string, "url": string }]
  links: text("links"),
  // NDA listing: hidden from partner views, its editing shoot is named
  // NDA_PHOTOSHOOT_NAME and runs on Aura only. Set from the upload wizard.
  nda: boolean("nda").default(false).notNull(),
  // Step one: the split address from the booking form (address stays the
  // display string). Used for Titus project.address and the calendar.
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  // Short internal notes for the team (access quirks, what the client asked for).
  notes: text("notes"),
  // Oct 21 2026: the Dropbox folder this listing's raw files are mirrored
  // into ("/Listings/<address as it was>"), set on the first mirror and kept
  // when the address is edited later, so nothing is orphaned (src/lib/dropbox.ts).
  dropboxFolder: text("dropbox_folder"),
  // Oct 26 2026: a view link to the listing's Dropbox Video folder (made by
  // the dropbox.folder job when the app may share), for the Video card.
  dropboxVideoLink: text("dropbox_video_link"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const QC_STATES = ["pending", "approved", "rejected"] as const;
export type QcState = (typeof QC_STATES)[number];

// v1.2: automatic QC pass. One issue per thing found in a frame.
export const QC_ISSUE_TYPES = ["person", "photographer", "reflection", "artifact", "blown_window", "crooked", "dust", "color", "composition", "other"] as const;
export type QcIssueType = (typeof QC_ISSUE_TYPES)[number];
export const QC_SEVERITIES = ["block", "fix", "minor"] as const;
export type QcSeverity = (typeof QC_SEVERITIES)[number];
export type QcIssue = { type: QcIssueType; severity: QcSeverity; note: string };

// Per-shoot roll-up stored on shoots.qc_summary when the pass finishes.
export type ShootQcSummary = {
  total: number; // frames the pass looked at
  checked: number; // frames that came back with a result
  skipped: number; // frames not checked (budget, errors)
  blocked: number; // frames with at least one block issue (auto-rejected until Nov 3 2026; now only flagged)
  fix: number; // frames with a fix issue and no block
  minor: number; // frames with only minor issues
  clean: number; // frames with no issues
  avgScore: number | null;
  worst: { mediaId: string; filename: string; score: number | null; summary: string | null }[];
  notes: string[];
  model: string | null;
  finishedAt: string;
};

export const media = pgTable("media", {
  id: uuid("id").defaultRandom().primaryKey(),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  kind: text("kind", { enum: ["photo", "video"] }).notNull(),
  r2Key: text("r2_key").notNull(), // object key in the R2 bucket
  filename: text("filename").notNull(), // download filename shown to the client
  bytes: bigint("bytes", { mode: "number" }), // bigint: 4K films exceed int32
  // Named delivery section ("Revised", "Twilight"). Null = main gallery.
  // Each section renders separately and can carry its own zip bundle.
  section: text("section"),
  // Revised deliverables (post-delivery edit rounds). Shown in their own
  // "Revised" section in the portal, only when any exist for the listing.
  revision: boolean("revision").default(false).notNull(),
  sort: integer("sort").default(0).notNull(),
  // v1.1: which shoot produced this frame, and whether QC has approved it.
  // Default "approved" so legacy media (uploaded by script) stays visible.
  // Client-facing queries only ever show approved media.
  shootId: uuid("shoot_id"),
  qcState: text("qc_state", { enum: QC_STATES }).default("approved").notNull(),
  // The editing service's photo id, so a frame can be re-run later.
  editorImageId: text("editor_image_id"),
  // v1.2: client visibility is a separate, explicit gate. Legacy rows (script
  // uploads) default to true; pipeline rows are born false and only "Publish"
  // on the shoot page flips them. Client queries require approved AND published.
  published: boolean("published").default(true).notNull(),
  // v1.2: a corrected frame an admin uploaded as a final (replaced or added).
  // Never sent to editing; shown with a "corrected" badge in the grid.
  corrected: boolean("corrected").default(false).notNull(),
  // Oct 2026: held back by hand ("Internal only"). Always paired with
  // published=false; Publish never flips a held frame, so a frame the team
  // moved to internal stays internal until someone makes it client visible
  // again. Not part of the client rule itself (src/lib/media-visibility.ts):
  // published=false already hides it. Default false keeps every older row as
  // it was.
  held: boolean("held").default(false).notNull(),
  // v1.2: automatic QC pass results for this frame.
  qcScore: integer("qc_score"),
  qcIssues: jsonb("qc_issues").$type<QcIssue[]>(),
  qcSuggestions: jsonb("qc_suggestions").$type<string[]>(),
  qcSummary: text("qc_summary"),
  qcCheckedAt: timestamp("qc_checked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Oct 27 2026: the copy in Dropbox under <listing>/FINAL DELIVERY once the
  // file was delivered (src/lib/dropbox-mirror.ts). Key and bytes say which
  // version was copied: a replaced final keeps its key with new bytes.
  dropboxFinalPath: text("dropbox_final_path"),
  dropboxFinalKey: text("dropbox_final_key"),
  dropboxFinalBytes: bigint("dropbox_final_bytes", { mode: "number" }),
  dropboxFinalAt: timestamp("dropbox_final_at"),
});

// Nov 2 2026: a Photo QC tick on one automatic QC flag of a frame ("this fix
// is done"). A row is a tick; unticking deletes it. fix_key is the flag
// itself (src/lib/qc-labels.ts qcFixKey: its type and normalized note), so a
// re-run that finds the same flag on the same photo keeps the tick, and a new
// or reworded flag starts unticked. Rows go with their frame.
export const qcFixChecks = pgTable("qc_fix_checks", {
  id: uuid("id").defaultRandom().primaryKey(),
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  fixKey: text("fix_key").notNull(),
  checkedBy: text("checked_by").notNull(), // the staff email
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("qc_fix_checks_media_key_idx").on(t.mediaId, t.fixKey)]);

// Booking intake (step one, docs/booking-to-payment.md): the invoice row is
// generalized across providers. Legacy Stripe webhook rows keep working: the
// old columns stay, stripe_invoice_id is nullable + unique (NULLs distinct, so
// Titus rows never collide) and amount_cents mirrors amount_due.
// A booking paid another way (check, ACH transfer or cash; method "other",
// Oct 2026) has NO provider: provider stays null, nothing is ever issued at
// Stripe or Titus for it, and an admin settles it with Mark paid.
export const INVOICE_PROVIDERS = ["stripe", "titus"] as const;
export type InvoiceProvider = (typeof INVOICE_PROVIDERS)[number];
// needs_quote | open | processing | review | paid | paid_manual | canceled | refunded | void
// (plus Stripe's own draft | uncollectible for webhook-synced legacy rows).
export const INVOICE_STATUSES = ["needs_quote", "open", "processing", "review", "paid", "paid_manual", "canceled", "refunded", "void", "draft", "uncollectible"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_METHODS = ["card", "pay_at_close", "other"] as const;
export type InvoiceMethod = (typeof INVOICE_METHODS)[number];
export type InvoiceLineItem = { id: string; name: string; cents: number; priced: boolean };
// Quote context kept next to the line items: what the website said, what we
// computed, and why the invoice may be waiting on a human.
export type InvoiceMeta = {
  pricingVersion?: string;
  pricingHash?: string;
  tier?: number;
  computedTotalCents?: number;
  websiteTotalCents?: number | null;
  estimatedTotalLabel?: string | null;
  pending?: boolean;
  inquire?: boolean;
  mismatch?: boolean;
  revisedAfterIssue?: boolean;
  previousAmountCents?: number | null;
  requestedAmountCents?: number | null;
  note?: string;
  // Step two (payments): what the provider told us when it was paid.
  // "addon" (Oct 21 2026, Edit booking): a second invoice for items added
  // after the booking's invoice was paid. It never locks or unlocks the
  // gallery; the booking's own invoice governs the lock.
  invoiceType?: string; // production (default) | exclusivity_monthly (never unlocks) | addon | additional_shoot (neither locks nor unlocks)
  stripePaymentIntent?: string | null;
  stripeCharge?: string | null;
  payNowMethod?: string | null; // card | us_bank_account | ... (the payments channel's method label)
  paidManualNote?: string | null;
  paidManualBy?: string | null;
  loanDecision?: string | null; // Titus: awaiting-approval | approved | denied
  // Step two, admin "Set amount" on a needs_quote invoice (type only, no DDL).
  quotedCents?: number | null;
  quotedBy?: string | null;
  quotedAt?: string | null;
  previousNote?: string | null; // the note "Set amount" replaced (the intake's needs_quote reason)
  // Provider objects this row used to hold (a reissued Stripe invoice, a Titus
  // checkout switched to card): a late webhook about one of these is only noted.
  replacedProviderIds?: string[];
  // Edit booking (Oct 21 2026): an add-on invoice remembers the invoice it
  // adds to, and the item names it bills or that were removed.
  addonOf?: string | null;
  addedItems?: string[];
  removedItems?: string[];
  editedBy?: string | null;
  editedAt?: string | null;
  // Additional shoots (Oct 27 2026): an invoice made for one booking_visits
  // row ("Create new invoice?" on Add second shoot), invoiceType
  // "additional_shoot". Like an add-on it never locks or unlocks the gallery.
  visitId?: string | null;
  visitKind?: string | null;
  createdBy?: string | null;
};

export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  stripeInvoiceId: text("stripe_invoice_id").unique(), // legacy key; equals provider_id for Stripe rows
  listingId: uuid("listing_id").references(() => listings.id),
  clientEmail: text("client_email"),
  propertyAddress: text("property_address"), // from invoice metadata: used to auto-match listings
  status: text("status").notNull(),
  amountDue: integer("amount_due"), // cents (legacy; kept equal to amount_cents)
  hostedInvoiceUrl: text("hosted_invoice_url"), // legacy; Stripe hosted invoice link
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // ---- step one: provider-agnostic invoice ----
  provider: text("provider", { enum: INVOICE_PROVIDERS }),
  providerId: text("provider_id"), // Stripe in_… or Titus checkout id
  hostedUrl: text("hosted_url"), // Stripe hosted_invoice_url or Titus checkoutUrl
  orderId: text("order_id"), // what the provider calls our order (= listing id for Titus)
  amountCents: integer("amount_cents"),
  currency: text("currency").default("usd"),
  method: text("method", { enum: INVOICE_METHODS }),
  paidAt: timestamp("paid_at"),
  refundedCents: integer("refunded_cents"),
  description: text("description"),
  lineItems: jsonb("line_items").$type<InvoiceLineItem[]>(),
  meta: jsonb("meta").$type<InvoiceMeta>(),
  clientId: uuid("client_id").references(() => clients.id),
  // No FK: bookings.invoice_id holds the FK side of the pair (a circular pair
  // would force a null-then-update inside the intake batch).
  bookingId: uuid("booking_id"),
  idempotencyVersion: integer("idempotency_version").default(1).notNull(),
  lastEvent: jsonb("last_event").$type<Record<string, unknown>>(),
  lastCheckedAt: timestamp("last_checked_at"),
  env: text("env"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("invoices_booking_idx").on(t.bookingId),
  index("invoices_provider_idx").on(t.provider, t.providerId),
]);

// Every successful signed-URL mint is logged here: the admin's download feed.
export const downloads = pgTable("downloads", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Nullable + SET NULL so refreshing a listing's media manifest never
  // erases download history; filename is denormalized for the admin feed.
  mediaId: uuid("media_id").references(() => media.id, { onDelete: "set null" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  clientEmail: text("client_email").notNull(),
  filename: text("filename"),
  at: timestamp("at").defaultNow().notNull(),
});

export const REVISION_STATUSES = ["new", "in_progress", "done"] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];
export const REVISION_KINDS = ["photo", "video"] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

// Client revision requests from the portal's "Request revision" button.
// filenames is the comma-joined list of photos the client had selected.
export const revisionRequests = pgTable("revision_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  clientEmail: text("client_email").notNull(),
  notes: text("notes").notNull(),
  filenames: text("filenames"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // v1.1: new → in_progress → done, changed inline from /admin/revisions.
  status: text("status", { enum: REVISION_STATUSES }).default("new").notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: text("resolved_by"),
  // When the client last sent this request to the business (null = still adding
  // per-photo notes; older requests count as sent when made).
  submittedAt: timestamp("submitted_at"),
  // Oct 21 2026, revision intake (src/lib/revision-intake.ts): where the
  // request came from (null = the portal; "quo" = a text to the business line;
  // "email" = hello@), the client's own words, and whether the intake was
  // unsure (listing or photos) and why. "Needs a look" on /admin/revisions.
  source: text("source"),
  sourceText: text("source_text"),
  needsReview: boolean("needs_review").default(false).notNull(),
  reviewNote: text("review_note"),
  // Oct 26 2026: every revision is tagged PHOTO or VIDEO. Video requests come
  // from the film review in the gallery (timestamped comments, video_comments)
  // or from a text the intake read as being about a video.
  mediaKind: text("media_kind", { enum: REVISION_KINDS }).default("photo").notNull(),
});

// One note per photo on a revision request (Oct 2026): the client taps
// "Request revision" on a photo in the lightbox and types what to change.
export const revisionItems = pgTable("revision_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  requestId: uuid("request_id").notNull().references(() => revisionRequests.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  mediaId: uuid("media_id"),
  filename: text("filename").notNull(),
  note: text("note").notNull(),
  clientEmail: text("client_email").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("revision_items_request_idx").on(t.requestId),
  uniqueIndex("revision_items_request_media_idx").on(t.requestId, t.mediaId),
]);

// Timestamped comments on a film (Oct 26 2026), the gallery's film review:
// the client pauses the film, writes what to change at that moment, and the
// note lands here at once (the ledger). request_id stays null until the
// client presses Send revision request; then every unsent comment on the
// listing goes out together as ONE video revision request.
export const videoComments = pgTable("video_comments", {
  id: uuid("id").defaultRandom().primaryKey(),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  mediaId: uuid("media_id").notNull(),
  filename: text("filename").notNull(),
  clientEmail: text("client_email").notNull(),
  atMs: integer("at_ms").notNull(), // where in the film, in milliseconds
  note: text("note").notNull(),
  requestId: uuid("request_id").references(() => revisionRequests.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("video_comments_listing_idx").on(t.listingId, t.clientEmail),
  index("video_comments_request_idx").on(t.requestId),
]);

// The Video board (Oct 26 2026): one card per shoot with video, for the video editor's
// editing team. Made when a booking with a film or reel comes in (key
// booking:<id>) or when raw video is uploaded for a listing that has no card
// yet (key shoot:<id>). Stages run left to right; a video revision puts the
// card back In queue with the request linked. See src/lib/video-board.ts.
export const VIDEO_STAGES = ["queue", "editing", "review", "sent", "complete"] as const;
export type VideoStage = (typeof VIDEO_STAGES)[number];
export const videoProjects = pgTable("video_projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  bookingId: uuid("booking_id"),
  shootId: uuid("shoot_id"),
  stage: text("stage", { enum: VIDEO_STAGES }).default("queue").notNull(),
  assignee: text("assignee"), // an email on the team, or null
  editorNotes: text("editor_notes"), // the editing team's own notes on this card
  revisionRequestId: uuid("revision_request_id"), // the open video revision, if any
  revisionRound: integer("revision_round").default(0).notNull(),
  footageAt: timestamp("footage_at"), // when raw video for this card was uploaded
  stageChangedAt: timestamp("stage_changed_at").defaultNow().notNull(),
  stageChangedBy: text("stage_changed_by"),
  env: text("env"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [index("video_projects_listing_idx").on(t.listingId), index("video_projects_stage_idx").on(t.env, t.stage)]);

// The Photo QC status bar (Nov 6 2026, src/lib/photo-qc.ts): the board
// column admins and the Photo QC team moved a card to by hand. One row per
// card: card_key "shoot:<id>" (a shoot's card) or "revision:<id>" (a
// revision's own card), with exactly one of shoot_id / revision_id set. No
// row: the column the pipeline says.
export const photoQcPicks = pgTable("photo_qc_picks", {
  cardKey: text("card_key").primaryKey(),
  shootId: uuid("shoot_id").references(() => shoots.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").references(() => revisionRequests.id, { onDelete: "cascade" }),
  status: text("status").$type<PhotoQcColumn>().notNull(), // a PHOTO_QC_COLUMNS key
  setBy: text("set_by"), // the staff email
  setAt: timestamp("set_at").defaultNow().notNull(),
}, (t) => [check("photo_qc_picks_one_card", sql`(${t.shootId} IS NULL) <> (${t.revisionId} IS NULL)`)]);

// ---- v1.1 team side ------------------------------------------------------

// One shoot = one upload run through editing. The pipeline cron advances
// status one bounded step per run; see src/lib/pipeline.ts.
export const SHOOT_STATUSES = [
  "draft", // wizard open, files landing in R2
  "uploaded", // submitted; waiting for the editing account
  "transferring", // copying files from R2 to the editing service
  "committing",
  "processing", // editing in progress upstream
  "importing", // pulling finished frames into R2 + media rows (QC pending)
  "twilight", // virtual twilight on the chosen exteriors
  "qc", // v1.2: automatic QC pass on every frame before a human looks
  "ready_for_review",
  "published",
  "failed",
  // Oct 21 2026: a shoot with raw video and no photos. Nothing goes to
  // editing; the clips are copied to Dropbox and that is the whole job.
  // Plain text column with no check constraint, so no DDL for the value.
  "video_only",
] as const;
export type ShootStatus = (typeof SHOOT_STATUSES)[number];

export type ShootOptions = {
  indoorModelId: number;
  outdoorModelId: number;
  modelName?: string;
  modelCredits?: number;
  skipHdr: boolean; // finished JPGs: upload as kind "display"
  twilight: { enabled: boolean; count: number; look: string };
  nda: boolean;
  notes?: string;
  source?: "device" | "dropbox" | "mixed";
  // Oct 21 2026: how many of the shoot's files are photos (raw or display)
  // and how many are raw video, written at submit so lists can estimate
  // credits from the photos alone without loading every file row.
  files?: { photos: number; video: number };
};

// What a shoot_files row is. raw and display go to editing; raw_video
// (Oct 21 2026) is camera footage that only ever goes to Dropbox.
export const SHOOT_FILE_KINDS = ["raw", "display", "raw_video"] as const;
export type ShootFileKind = (typeof SHOOT_FILE_KINDS)[number];

export const shoots = pgTable("shoots", {
  id: uuid("id").defaultRandom().primaryKey(),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  createdBy: text("created_by").notNull(),
  status: text("status", { enum: SHOOT_STATUSES }).default("draft").notNull(),
  options: jsonb("options").$type<ShootOptions>(),
  // Step cursors so a step can span several cron runs (imported ids,
  // twilight jobs, upload slots). Shape is owned by src/lib/pipeline.ts.
  progress: jsonb("progress").$type<Record<string, unknown>>(),
  autohdrPhotoshootId: integer("autohdr_photoshoot_id"),
  autohdrJobId: text("autohdr_job_id"),
  fileCount: integer("file_count").default(0).notNull(),
  photoCount: integer("photo_count").default(0).notNull(),
  error: text("error"),
  // Short lease so overlapping cron runs never work the same shoot twice.
  leaseUntil: timestamp("lease_until"),
  stepStartedAt: timestamp("step_started_at"),
  submittedAt: timestamp("submitted_at"),
  readyAt: timestamp("ready_at"),
  publishedAt: timestamp("published_at"),
  publishedBy: text("published_by"),
  // v1.2: roll-up of the automatic QC pass (counts by severity, worst frames).
  qcSummary: jsonb("qc_summary").$type<ShootQcSummary>(),
  qcCheckedAt: timestamp("qc_checked_at"),
  // Oct 21 2026: when the last of this shoot's files landed in Dropbox (the
  // one hub line is posted by whichever mirror job sets it first).
  dropboxSyncedAt: timestamp("dropbox_synced_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const shootFiles = pgTable("shoot_files", {
  id: uuid("id").defaultRandom().primaryKey(),
  shootId: uuid("shoot_id").notNull().references(() => shoots.id),
  filename: text("filename").notNull(),
  // shoots/<shootId>/raw/<safe filename>, or shoots/<shootId>/raw-video/<safe filename> for raw video
  r2Key: text("r2_key").notNull(),
  bytes: bigint("bytes", { mode: "number" }),
  contentType: text("content_type"),
  kind: text("kind", { enum: SHOOT_FILE_KINDS }).default("raw").notNull(),
  autohdrUploadedAt: timestamp("autohdr_uploaded_at"),
  // Oct 21 2026: the Dropbox mirror (src/lib/dropbox-mirror.ts). The path the
  // copy landed at and when; null until the dropbox.mirror job finishes.
  dropboxPath: text("dropbox_path"),
  dropboxSyncedAt: timestamp("dropbox_synced_at"),
  // Oct 27 2026: the folder it was dropped in, from the dropped folder down
  // ("2311 Elm Street - 413 raw", "video/A001"). The copy keeps that path
  // inside the listing folder; null = a loose file (Photo or Video).
  dropboxDir: text("dropbox_dir"),
  // Oct 27 2026: raws leave R2 once Dropbox holds a verified copy
  // (src/lib/r2-raw-cleanup.ts): when the R2 object was deleted, and the
  // Dropbox content hash both sides matched on.
  r2DeletedAt: timestamp("r2_deleted_at"),
  dropboxHash: text("dropbox_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Who did what. Written by admin actions, the pipeline and the client
// routes (approve, request revision). Read newest-first on the dashboard.
export const activity = pgTable("activity", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorEmail: text("actor_email"), // null = the pipeline
  action: text("action").notNull(),
  listingId: uuid("listing_id"),
  shootId: uuid("shoot_id"),
  clientId: uuid("client_id"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- Step one: booking intake (docs/booking-to-payment.md) ----------------

// requested reads "Unconfirmed" in the admin; delivered (Oct 2026) is set by
// hand once the gallery is out. A text column with no check constraint, so a
// new value needs no migration.
export const BOOKING_STATUSES = ["requested", "confirmed", "shot", "delivered", "canceled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
// "other" (Oct 2026): the client pays another way, by check, ACH transfer or
// cash (bookings.payment_detail says which). Its invoice has no provider and
// is settled by an admin's Mark paid.
export const BOOKING_PAYMENT_METHODS = ["card", "pay_at_close", "other"] as const;
export type BookingPaymentMethod = (typeof BOOKING_PAYMENT_METHODS)[number];
export const BOOKING_PAYMENT_DETAILS = ["check", "ach", "cash"] as const;
export type BookingPaymentDetail = (typeof BOOKING_PAYMENT_DETAILS)[number];

// What the form told us about the property (names, never prices). Kept loose
// on purpose: the website owns the option lists.
export type BookingProperty = {
  street: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  status?: string | null; // Vacant / Staged, ...
  listingType?: string | null; // For Sale, For Lease, Short-Term Rental
  offMarket?: string | null; // Yes / No
  listingAgreement?: string | null; // Yes / No: a signed listing agreement for the property (form key listing_agreement, since Oct 17 2026)
  facing?: string | null; // compass direction; the form stopped asking on Oct 17 2026, rows from before keep it
  viewHome?: string | null; // Yes / No
  views?: string[] | null;
  homeownerHome?: string | null; // Yes / No
  videoStyle?: string | null;
  musicLink?: string | null;
  timeWindow?: string | null; // the website's time of day (morning, midday, afternoon) when it sends no start time
};
// The latest normalized payload plus every submission id that mapped here.
export type BookingRaw = {
  submissionIds: string[];
  payload: Record<string, unknown>;
  summary?: string | null; // the website's booking_summary (may contain prices; admin only)
  estimatedTotalLabel?: string | null;
  websiteTotalCents?: number | null;
};

// One booking form submission. id = the website's submission_id, so a retry of
// the same form session is a no-op. content_key (sha256 of email|street|date)
// turns a fresh submission for the same shoot into a revision of this row.
export const bookings = pgTable("bookings", {
  id: uuid("id").primaryKey(),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  invoiceId: uuid("invoice_id").references(() => invoices.id),
  contentKey: text("content_key").notNull(),
  calendarVersion: integer("calendar_version").default(1).notNull(),
  source: text("source").default("website").notNull(),
  market: text("market"), // the service area the client picked on the website
  status: text("status", { enum: BOOKING_STATUSES }).default("requested").notNull(),
  paymentMethod: text("payment_method", { enum: BOOKING_PAYMENT_METHODS }),
  // Which other way (check | ach | cash) when payment_method is "other"; null otherwise.
  paymentDetail: text("payment_detail", { enum: BOOKING_PAYMENT_DETAILS }),
  desiredDate: date("desired_date", { mode: "string" }),
  startTime: text("start_time"),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  launchDate: date("launch_date", { mode: "string" }),
  sqft: integer("sqft"),
  tier: integer("tier"),
  serviceIds: jsonb("service_ids").$type<string[]>(),
  addonIds: jsonb("addon_ids").$type<string[]>(),
  // The website's selection with quantities ([{ id, qty, option }]); service_ids
  // and addon_ids stay the ids alone. src/lib/studio-pricing.ts prices both.
  items: jsonb("items").$type<{ id: string; qty?: number | null; option?: string | null }[]>(),
  // The client type the website priced with (agent, homeowner, builder, other).
  clientType: text("client_type"),
  servicesLabel: text("services_label"), // names only, never prices
  customRequest: text("custom_request"),
  accessNotes: text("access_notes"),
  property: jsonb("property").$type<Record<string, unknown>>(),
  signedName: text("signed_name"),
  signedAt: timestamp("signed_at"),
  photographerEmail: text("photographer_email"),
  calendarEventId: text("calendar_event_id"),
  calendarSyncedAt: timestamp("calendar_synced_at"),
  // The client moved the shoot from the portal (when, and the time it was
  // before); cleared when an admin confirms the new time.
  clientRescheduledAt: timestamp("client_rescheduled_at"),
  clientRescheduledFrom: text("client_rescheduled_from"),
  clientNotes: text("client_notes"), // the form's "Additional details" (client-typed, since Oct 2026)
  // The team's own note on this booking, from the status card (Oct 22 2026).
  // Internal only: never in a client email, the portal or the shoot brief.
  internalNote: text("internal_note"),
  tonomoJobId: text("tonomo_job_id"),
  // The latest normalized payload plus every submission id that mapped here.
  raw: jsonb("raw").$type<BookingRaw>(),
  env: text("env"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("bookings_content_key_idx").on(t.contentKey),
  index("bookings_listing_idx").on(t.listingId),
  index("bookings_client_idx").on(t.clientId),
  index("bookings_created_idx").on(t.createdAt),
]);

// Additional shoots on one booking (Oct 27 2026, the owner: "a second shoot date
// ... return trips, reschedules, pickup shots"). Each is its own event on the
// hello@ calendar (id <prefix>v<visit hex>) with its own shooter as the one guest,
// scheduled from the booking page; the booking's own time stays where it is.
// Text columns, no check constraints: a new kind or status needs no migration.
export const VISIT_KINDS = ["return_trip", "pickup", "reshoot", "twilight", "other"] as const;
export type VisitKind = (typeof VISIT_KINDS)[number];
export const VISIT_STATUSES = ["scheduled", "done", "canceled"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const bookingVisits = pgTable("booking_visits", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull(),
  env: text("env"),
  kind: text("kind", { enum: VISIT_KINDS }).default("return_trip").notNull(),
  note: text("note"),
  desiredDate: date("desired_date", { mode: "string" }).notNull(), // local day
  startTime: text("start_time").notNull(), // "HH:MM" local
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  photographerEmail: text("photographer_email"),
  status: text("status", { enum: VISIT_STATUSES }).default("scheduled").notNull(),
  calendarVersion: integer("calendar_version").default(1).notNull(),
  calendarEventId: text("calendar_event_id"),
  calendarSyncedAt: timestamp("calendar_synced_at"),
  createdBy: text("created_by"),
  // Oct 27 2026: the visit's own invoice, when "Create new invoice?" was
  // ticked (or Create invoice was used later). No FK, like invoices.booking_id:
  // the invoice row carries meta.visitId back, and deleting either side never
  // has to unpick the other first.
  invoiceId: uuid("invoice_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("booking_visits_booking_idx").on(t.bookingId),
  index("booking_visits_due_idx").on(t.env, t.status, t.startsAt),
]);

export const JOB_KINDS = [
  "calendar.upsert",
  "calendar.cancel",
  // Oct 27 2026: an additional shoot on a booking (a return trip, pickup
  // shots, a reshoot, a twilight) as its own event on the same calendar
  // (booking_visits, src/lib/booking-visits.ts, src/lib/google-calendar.ts).
  "calendar.visit_upsert",
  "calendar.visit_cancel",
  // Oct 26 2026: the forecast for the shoot's address onto its calendar event
  // (badge, weather block, rain color), every 3 hours (src/lib/weather.ts).
  "calendar.weather",
  "email.booking",
  "email.pay_link",
  "slack.booking",
  "slack.paid",
  "slack.payment", // step two: one line with amounts for the private payments channel
  "slack.issue",
  "stripe.invoice.create",
  "titus.checkout.create",
  "payments.reconcile",
  "bundle.rebuild", // rebuild a listing's "download all" zips (src/lib/bundles.ts)
  "email.shooter_invite", // the shooter's calendar invite (iCalendar REQUEST or CANCEL), src/lib/shooter-invite.ts
  "email.shoot_brief", // 30 minutes before the shoot: the brief to the shooter, cc SHOOT_BRIEF_CC (src/lib/shoot-brief.ts)
  // Oct 21 2026: the client's time emails (src/lib/booking-time-email.ts).
  "email.time_confirmed", // an admin confirmed (or moved) the time: "Your shoot time is confirmed" / "Your new time is confirmed" / "Your shoot has moved", with shoot.ics
  "email.rescheduled", // the client moved the shoot from the portal: "Your shoot has been rescheduled", no .ics
  // Oct 21 2026: one raw file (photo or video) copied from R2 into the business's
  // Dropbox under /Listings/<address>/Raw/... (src/lib/dropbox-mirror.ts).
  "dropbox.mirror",
  // Oct 21 2026: turn a client's texts into a revision request when they ask
  // for one (src/lib/revision-intake.ts). One job per stored text; the job
  // waits for the burst to end and files the whole conversation at once.
  "inbound.revision",
  // Oct 26 2026: the listing's folder in the business's Dropbox the moment a shoot is
  // booked (/Listings/<address>), and its Photo and Video folders the moment
  // media is uploaded (src/lib/dropbox-mirror.ts).
  "dropbox.folder",
  // Oct 26 2026: a booking with a film or reel gets its card on the Video
  // board (src/lib/video-board.ts).
  "video.card",
  // Oct 26 2026: one hub line per upload (src/lib/upload-runs.ts). The
  // backstop for a run that never said it was done, and the marker row that
  // claims the run's one summary line.
  "slack.upload_check",
  // Oct 27 2026: delivered finals into Dropbox under <listing>/FINAL DELIVERY
  // (src/lib/dropbox-mirror.ts). The sweep finds a listing's client-visible
  // files whose copy is missing or out of date and queues one copy per file.
  "dropbox.final_sweep",
  "dropbox.final",
  // Oct 27 2026: raws leave R2 once Dropbox holds a verified copy
  // (src/lib/r2-raw-cleanup.ts). The sweep queues one check per file.
  "r2.raw_sweep",
  "r2.raw_cleanup",
  // Oct 27 2026: "Make twilight" on one frame: the Champagne preset on that
  // photo, the result added to the shoot's Twilight section (src/lib/pipeline.ts).
  "twilight.frame",
  // Nov 1 2026: a shoot's raw video is all in Dropbox: one line in
  // #video-editing tagging the video editor (src/lib/slack.ts), once per shoot.
  "slack.video_editing",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_STATUSES = ["queued", "running", "done", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
// Everything a handler needs is re-read from the database by id; the payload
// only carries the version (so a stale job can tell it was superseded) and
// small flags like "this is a correction".
export type JobPayload = {
  version?: number;
  bookingId?: string;
  invoiceId?: string;
  listingId?: string;
  updated?: boolean; // slack.booking / email.booking: a revision, not a new booking
  note?: string;
  text?: string; // slack.payment: the finished line (may carry amounts; payments channel only)
  again?: boolean; // email.pay_link: "Here is your link again"
  channel?: "hub" | "bookings"; // slack.issue: where the note goes (default hub; "bookings" = #bookings when set, else the hub)
  // A batch job's objects and a cursor into it; n and bytes are kept at the
  // top so status can read them without the list.
  objects?: { key: string; url: string; size: number | null; contentType?: string | null }[];
  cursor?: number;
  n?: number;
  bytes?: number;
  waits?: number; // how often a job has waited for originals to land
  slug?: string; // the listing
  // email.shooter_invite: who gets it and whether it adds or removes the event.
  email?: string;
  method?: "REQUEST" | "CANCEL";
  // email.time_confirmed: which confirmation the client gets (src/lib/booking-time-email.ts).
  variant?: "confirmed" | "reconfirmed" | "moved";
  // dropbox.mirror: which file, and the upload session cursor a long copy
  // leaves behind when a tick runs out (the next tick resumes at offset).
  shootFileId?: string;
  inboundId?: string; // inbound.revision: the stored text that queued the job
  shootId?: string;
  session?: { id: string; offset: number; path: string; startedAt: string };
  subfolders?: boolean; // dropbox.folder: also the Photo and Video folders (an upload), not only the address folder (a booking); shootId = that upload
  run?: string; // slack.upload_check: the upload run (src/lib/upload-runs.ts)
  visitId?: string; // calendar.visit_upsert / visit_cancel / weather, email.shoot_brief: the additional shoot (booking_visits)
  mediaId?: string; // dropbox.final: the delivered file
  r2Key?: string; // dropbox.final: the object it was queued for
  since?: string; // dropbox.final_sweep without a listing: delivery emails sent since (ISO)
  hashOffset?: number; // r2.raw_cleanup: bytes of the R2 object hashed so far
  blockHashes?: string; // r2.raw_cleanup: the 4 MiB block digests so far (hex, joined)
  // twilight.frame: the preset run once started, the photo's day version to
  // point back at, and when it started (a run that never ends gives up).
  workflowUuid?: string;
  prevVersion?: string;
  runStartedAt?: string;
  requestedBy?: string; // twilight.frame: the admin who pressed Make twilight
  videoLinks?: boolean; // dropbox.folder: the half-hourly pass asking for Video share links (Nov 5 2026)
  // bundle.rebuild: where the rebuild stands, from the moment it has read the
  // rows (the list of files, which zip, which part); the result once it is
  // done. A row without it has not begun (src/lib/bundles.ts, Nov 10 2026).
  bundle?: BundleProgress;
};

// Side effects run from here, never inline: enqueued in the same transaction
// as the booking, drained in after() and by the minute cron (src/lib/jobs.ts).
// env keeps the production cron off preview rows (one shared database).
export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind", { enum: JOB_KINDS }).notNull(),
  payload: jsonb("payload").$type<JobPayload>(),
  status: text("status", { enum: JOB_STATUSES }).default("queued").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(8).notNull(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  leaseUntil: timestamp("lease_until"),
  lastError: text("last_error"),
  idempotencyKey: text("idempotency_key").notNull().unique(), // `${kind}:${id}:${version}`
  env: text("env").notNull(),
  listingId: uuid("listing_id"),
  bookingId: uuid("booking_id"),
  invoiceId: uuid("invoice_id"),
  alertedAt: timestamp("alerted_at"), // the one Slack alert per job
  doneAt: timestamp("done_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("jobs_due_idx").on(t.env, t.status, t.runAt),
  index("jobs_booking_idx").on(t.bookingId),
]);

// Every provider webhook delivery, stored before it is acted on (step two
// writes these; the table ships now so the schema is complete).
// Inbound client messages (Oct 21 2026). Texts to the Quo line arrive
// through /api/inbound/quo, and since Oct 27 2026 mail to hello@ through the
// minute cron (src/lib/email-intake.ts, read only); both are stored here BEFORE
// anything acts on them; the revision intake reads status "new" rows and
// records what it decided in result. Read only toward Quo: nothing here ever
// texts back (brain/Client Communication.md).
export const INBOUND_SOURCES = ["quo", "email"] as const;
// new → processing (claimed by the intake) → filed | ignored (not a revision)
// | needs_review (a revision we could not place: no client or no listing).
export const INBOUND_STATUSES = ["new", "processing", "ignored", "filed", "needs_review", "error"] as const;
export type InboundMedia = { url: string; type: string | null };
export const inboundMessages = pgTable("inbound_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  source: text("source", { enum: INBOUND_SOURCES }).notNull(),
  externalId: text("external_id").notNull(), // the Quo message id, or the Gmail message id (source "email")
  eventId: text("event_id"),
  conversationId: text("conversation_id"),
  fromAddr: text("from_addr"), // E.164 phone or email
  toAddr: text("to_addr"),
  body: text("body"),
  media: jsonb("media").$type<InboundMedia[]>(),
  sentAt: timestamp("sent_at"),
  env: text("env"),
  clientId: uuid("client_id"),
  listingId: uuid("listing_id"),
  status: text("status", { enum: INBOUND_STATUSES }).default("new").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  processedAt: timestamp("processed_at"),
  error: text("error"),
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("inbound_messages_source_external_uq").on(t.source, t.externalId),
  index("inbound_messages_status_idx").on(t.status),
]);

export const paymentEvents = pgTable("payment_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider", { enum: INVOICE_PROVIDERS }).notNull(),
  providerEventId: text("provider_event_id").notNull(),
  type: text("type"),
  objectId: text("object_id"),
  invoiceId: uuid("invoice_id"),
  status: text("status"),
  signatureOk: boolean("signature_ok"),
  stale: boolean("stale").default(false).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  env: text("env"),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
  error: text("error"),
  // What processing decided ("already paid", "belongs to the preview
  // environment"); error stays for failures only.
  note: text("note"),
}, (t) => [
  uniqueIndex("payment_events_provider_event_uq").on(t.provider, t.providerEventId),
]);

// Tiny key/value store: cron heartbeat ("cron.last_tick") and the like.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---- Scorecard (Nov 10 2026) --------------------------------------------------

// One row per thing a person's scorecard keeps (/admin/scorecard,
// src/lib/scorecard.ts): a day's checklist with hours and miles ("day",
// key YYYY-MM-DD), a week's review ("week", the Monday), a mark on a shoot
// ("shoot", the booking id), an action-list task ("task", a uuid), a month's
// eligible revenue or check-in ("revenue" / "checkin", YYYY-MM) and a
// milestone's goals ("milestone"). Kept in one table on
// purpose: a few hundred rows a year per person, and a new kind needs no
// migration.
export const scorecardEntries = pgTable("scorecard_entries", {
  person: text("person").notNull(),
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.person, t.kind, t.key] })]);

// ---- Sign-in hardening (Oct 21 2026) ----------------------------------------

// One-time magic-link tokens (src/lib/login-tokens.ts). Only the SHA-256 of
// the token is stored; a row is consumed by setting used_at exactly once.
// The pay token in emails stays a stateless JWT (src/lib/portal-auth.ts).
export const loginTokens = pgTable("login_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  email: text("email").notNull(),
  next: text("next"), // in-portal path bound at issue time, or null
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [index("login_tokens_expires_idx").on(t.expiresAt)]);

// Fixed-window counters for the sign-in request (src/lib/rate-limit.ts):
// one row per key (hashed email, caller address), swept as they age out.
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").default(0).notNull(),
  windowStart: timestamp("window_start").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [index("rate_limits_window_idx").on(t.windowStart)]);

export const clientsRelations = relations(clients, ({ many }) => ({ listings: many(listings) }));
export const listingsRelations = relations(listings, ({ one, many }) => ({
  client: one(clients, { fields: [listings.clientId], references: [clients.id] }),
  media: many(media),
  invoices: many(invoices),
  revisionRequests: many(revisionRequests),
  shoots: many(shoots),
  bookings: many(bookings),
  videoProjects: many(videoProjects),
}));
export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  listing: one(listings, { fields: [bookings.listingId], references: [listings.id] }),
  client: one(clients, { fields: [bookings.clientId], references: [clients.id] }),
  invoice: one(invoices, { fields: [bookings.invoiceId], references: [invoices.id] }),
  visits: many(bookingVisits),
}));
export const bookingVisitsRelations = relations(bookingVisits, ({ one }) => ({
  booking: one(bookings, { fields: [bookingVisits.bookingId], references: [bookings.id] }),
}));
export const revisionRequestsRelations = relations(revisionRequests, ({ one, many }) => ({
  listing: one(listings, { fields: [revisionRequests.listingId], references: [listings.id] }),
  items: many(revisionItems),
  videoComments: many(videoComments),
}));
export const videoCommentsRelations = relations(videoComments, ({ one }) => ({
  listing: one(listings, { fields: [videoComments.listingId], references: [listings.id] }),
  request: one(revisionRequests, { fields: [videoComments.requestId], references: [revisionRequests.id] }),
}));
export const videoProjectsRelations = relations(videoProjects, ({ one }) => ({
  listing: one(listings, { fields: [videoProjects.listingId], references: [listings.id] }),
  booking: one(bookings, { fields: [videoProjects.bookingId], references: [bookings.id] }),
}));
export const revisionItemsRelations = relations(revisionItems, ({ one }) => ({
  request: one(revisionRequests, { fields: [revisionItems.requestId], references: [revisionRequests.id] }),
}));
export const mediaRelations = relations(media, ({ one }) => ({
  listing: one(listings, { fields: [media.listingId], references: [listings.id] }),
  shoot: one(shoots, { fields: [media.shootId], references: [shoots.id] }),
}));
export const invoicesRelations = relations(invoices, ({ one }) => ({
  listing: one(listings, { fields: [invoices.listingId], references: [listings.id] }),
  client: one(clients, { fields: [invoices.clientId], references: [clients.id] }),
  booking: one(bookings, { fields: [invoices.bookingId], references: [bookings.id] }),
}));
export const downloadsRelations = relations(downloads, ({ one }) => ({
  media: one(media, { fields: [downloads.mediaId], references: [media.id] }),
  listing: one(listings, { fields: [downloads.listingId], references: [listings.id] }),
}));
export const shootsRelations = relations(shoots, ({ one, many }) => ({
  listing: one(listings, { fields: [shoots.listingId], references: [listings.id] }),
  files: many(shootFiles),
  media: many(media),
}));
export const shootFilesRelations = relations(shootFiles, ({ one }) => ({
  shoot: one(shoots, { fields: [shootFiles.shootId], references: [shoots.id] }),
}));
export const activityRelations = relations(activity, ({ one }) => ({
  listing: one(listings, { fields: [activity.listingId], references: [listings.id] }),
  shoot: one(shoots, { fields: [activity.shootId], references: [shoots.id] }),
}));
