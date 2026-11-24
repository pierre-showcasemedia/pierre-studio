// Shapes the admin pages render. Pure types: safe for client components.
import type { BookingPaymentDetail, BookingPaymentMethod, BookingRaw, BookingStatus, InvoiceLineItem, InvoiceMeta, QcIssue, QcState, RevisionStatus, ShootFileKind, ShootOptions, ShootQcSummary, ShootStatus, StaffRole } from "@/db/schema";
import type { QcFixDone } from "./qc-labels";

export type AdminClient = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  team: string | null;
  teamName?: string | null;
  notes?: string | null;
  discountPercent?: number;
  pricingNote?: string | null;
  listingCount: number;
  createdAt: string;
};

// ---- One portal (Oct 2026): teams, client detail, admins, media manager ----

export type AdminTeam = {
  slug: string;
  name: string | null; // null = no teams row yet; show the slug
  notes: string | null;
  members: AdminClient[];
  listingCount: number;
  lastShoot: string | null; // YYYY-MM-DD
};

export type AdminAdmin = { email: string; name: string | null; source: "env" | "db"; addedBy: string | null; createdAt: string | null; role: StaffRole };

// A media row as the listing editor sees it (every row, hidden ones included).
export type AdminMediaRow = {
  id: string;
  kind: "photo" | "video";
  filename: string;
  r2Key: string;
  bytes: number | null;
  section: string | null;
  revision: boolean;
  sort: number;
  qcState: QcState;
  published: boolean;
  corrected: boolean;
  // Oct 2026: moved to internal only by hand, and whether the frame's shoot
  // has been published (true for a loose file). With the three fields above
  // they decide "Client visible" or "Internal only" (src/lib/visibility.ts).
  held: boolean;
  shootPublished: boolean;
  shootId: string | null;
  createdAt: string;
  thumbUrl: string | null;
  // The media grid (Oct 2026): a larger image for the admin preview (photos)
  // or a playable source (films), a link that downloads the original, and the
  // pixel size when known (demo photos only; the media table has no columns).
  previewUrl: string | null;
  downloadUrl: string | null;
  width: number | null;
  height: number | null;
};

export type AdminListing = {
  id: string;
  address: string;
  slug: string;
  clientId: string;
  clientEmail: string;
  clientName: string | null;
  clientCompany: string | null;
  mediaCount: number; // approved (client-visible) media
  pendingCount: number; // frames waiting for QC
  downloadLocked: boolean;
  invoiceStatus: string | null;
  createdAt: string;
  updatedAt: string;
  shootDate: string | null;
  deliveryEmailAt: string | null;
  approvedAt: string | null;
  coverKey: string | null;
  coverUrl?: string | null;
  nda: boolean;
  activeShoot: { id: string; status: ShootStatus } | null;
};

export type AdminShoot = {
  id: string;
  listingId: string;
  address: string;
  slug: string;
  clientName: string | null;
  clientEmail: string;
  nda: boolean;
  status: ShootStatus;
  options: ShootOptions | null;
  progress: Record<string, unknown> | null;
  fileCount: number;
  photoCount: number;
  error: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  readyAt: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  stepStartedAt: string | null;
  autohdrPhotoshootId: number | null;
  // v1.2
  qcSummary: ShootQcSummary | null;
  qcCheckedAt: string | null;
  // Oct 21 2026: the Dropbox raw mirror. The listing's folder ("/Listings/<address>")
  // once the first file was copied, and when the whole shoot was in.
  dropboxFolder: string | null;
  dropboxSyncedAt: string | null;
  // Nov 18 2026: the same for Google Drive (src/lib/drive-mirror.ts).
  driveFolderId?: string | null;
  driveSyncedAt?: string | null;
};

// kind raw_video (Oct 21 2026) is camera footage: Dropbox only, never editing.
// r2DeletedAt: the raw left R2 after its Dropbox copy was verified (src/lib/r2-raw-cleanup.ts).
export type AdminShootFile = { id: string; filename: string; bytes: number | null; kind: ShootFileKind; uploaded: boolean; dropboxPath: string | null; dropboxSyncedAt: string | null; driveSyncedAt?: string | null; r2DeletedAt?: string | null };

export type AdminFrame = {
  id: string;
  filename: string;
  r2Key: string;
  section: string | null;
  qcState: QcState;
  sort: number;
  bytes: number | null;
  thumbUrl: string | null;
  // Nov 2 2026, the opened photo: the 2048px derivative that fills the viewer
  // and the original behind Z (one image pixel per screen pixel). Signed like
  // the thumb; demo frames point at the demo photos.
  largeUrl: string | null;
  fullUrl: string | null;
  hue: number; // demo-mode placeholder colour
  // v1.2: publish gate + automatic QC
  published: boolean;
  corrected: boolean;
  held: boolean; // Oct 2026: moved to internal only by hand
  revision: boolean; // Nov 2026: in the client's Revised images section
  qcScore: number | null;
  qcIssues: QcIssue[] | null;
  qcSuggestions: string[] | null;
  qcSummary: string | null;
  qcCheckedAt: string | null;
  // Nov 2 2026: the Photo QC team's "done" ticks on this frame's flags, by
  // fix key (src/lib/qc-labels.ts qcFixKey, src/lib/qc-fixes.ts).
  qcFixes?: Record<string, QcFixDone>;
};

export type AdminRevision = {
  id: string;
  listingId: string;
  address: string;
  slug: string;
  clientId: string;
  clientEmail: string;
  clientName: string | null;
  notes: string;
  filenames: string[];
  createdAt: string;
  status: RevisionStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  // Per-photo notes from the gallery lightbox (Oct 2026), oldest first.
  items: AdminRevisionItem[];
  // When the client last sent the request (null = still adding notes).
  submittedAt: string | null;
  // Notes written since that send (the client has not sent them yet).
  unsent: number;
  // Oct 21 2026, revision intake: null = the portal, "quo" = a text, "email";
  // the client's own words; whether the intake was unsure and why.
  source?: string | null;
  sourceText?: string | null;
  needsReview?: boolean;
  reviewNote?: string | null;
  // Oct 26 2026: PHOTO or VIDEO, and a video request's timestamped notes from
  // the film review (oldest film first, then by time).
  mediaKind?: "photo" | "video";
  videoComments?: { id: string; filename: string; atMs: number; note: string }[];
};

// A text that asked for a revision the intake could not place (no client, or
// no clear listing): shown at the top of /admin/revisions until dismissed.
export type AdminUnplacedText = {
  id: string;
  source: string;
  from: string | null;
  receivedAt: string;
  body: string;
  photos: number;
  clientName: string | null;
  clientEmail: string | null;
  reason: string;
  summary: string;
};

export type AdminRevisionItem = { id: string; mediaId: string | null; filename: string; note: string; createdAt: string; updatedAt: string; sent: boolean; thumbUrl?: string | null };

export type AdminDownload = {
  at: string;
  clientEmail: string;
  filename: string;
  address: string;
  listingId: string;
  slug: string;
};

export type AdminActivity = {
  id: string;
  actorEmail: string | null;
  action: string;
  listingId: string | null;
  shootId: string | null;
  clientId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  address: string | null;
};

export type AdminMedia = { id: string; kind: string; filename: string; bytes: number | null; r2Key: string; section: string | null; qcState: QcState; shootId: string | null; published: boolean; corrected: boolean; held: boolean };

// The original a corrected final replaced (kept in storage under
// shoots/<id>/replaced/), from the media.replaced activity row. Internal only:
// downloads through the shoot route, admins and the QA team.
export type AdminReplacedOriginal = { id: string; shootId: string; filename: string; at: string; by: string | null; href: string };
// Provider-agnostic since step one of the booking intake: Stripe rows carry
// stripeInvoiceId (= providerId), Titus rows only providerId. Amount and URL
// read the new columns first and fall back to the legacy ones.
export type AdminInvoice = {
  id: string;
  provider: string | null; // stripe | titus | null (legacy webhook row before migrate ran)
  providerId: string | null;
  stripeInvoiceId: string | null;
  status: string;
  method: string | null; // card | pay_at_close | other
  amountCents: number | null;
  hostedUrl: string | null;
  bookingId: string | null;
  createdAt: string | null;
};

export type AdminClientDetail = {
  client: AdminClient;
  team: AdminTeam | null;
  listings: AdminListing[];
  bookings: AdminBookingRow[];
  invoices: (AdminInvoice & { address: string | null })[];
  downloads: AdminDownload[];
  revisions: AdminRevision[];
  activity: AdminActivity[];
};

export type Attention = {
  processing: number;
  review: number;
  revisionsOpen: number;
  deliveredUnpaid: number;
  publishedNoEmail: number;
  failed: number;
  // Step two (bookings and payments): invoices open or waiting for a quote on
  // a booking whose shoot is still ahead (or undated), pay-at-close invoices
  // in processing or review, and side-effect jobs that gave up (dead).
  unpaidBookings: number;
  paymentsInReview: number;
  failedJobs: number;
  // Bookings still Unconfirmed (status requested), past-dated ones included.
  toConfirm: number;
};

// One row of the dashboard's "Upcoming shoots": a booking (confirmed or
// unconfirmed, next 14 days local, plus unconfirmed requests whose time has
// passed) or a listing with a shoot date and no booking (older the previous portal rows).
export type AdminUpcomingShoot = {
  key: string;
  kind: "booking" | "listing";
  href: string;
  bookingId: string | null;
  listingId: string;
  clientId: string;
  date: string | null; // YYYY-MM-DD, local calendar date
  time: string | null; // HH:MM, local wall clock
  address: string;
  nda: boolean;
  clientName: string | null;
  clientEmail: string;
  shooter: string | null;
  status: BookingStatus | null; // null for a listing row
  datePassed: boolean;
  returnShoot?: boolean; // an additional shoot on a booking (Oct 28 2026)
};

export type ListingSort = "newest_shoot" | "client" | "status" | "updated";
export type ListingQuery = { q?: string; sort?: ListingSort; clientId?: string; status?: string };
export type DownloadSort = "date" | "client" | "listing";
export type DownloadQuery = { clientId?: string; listingId?: string; from?: string; to?: string; sort?: DownloadSort };

// ---- Bookings (step two, docs/booking-to-payment.md) ------------
// Money renders only under /admin, so these shapes carry amounts; the Slack
// hub and the calendar never read them.

export type AdminBookingInvoice = {
  id: string;
  status: string; // needs_quote | open | processing | review | paid | paid_manual | canceled | refunded | void | …
  amountCents: number | null;
  provider: string | null; // stripe | titus
  providerId: string | null; // Stripe in_… or the Titus checkout id
  hostedUrl: string | null; // Stripe hosted invoice or Titus checkoutUrl
  method: string | null; // card | pay_at_close | other
  paidAt: string | null;
  refundedCents: number | null;
  description: string | null;
  lineItems: InvoiceLineItem[];
  idempotencyVersion: number;
  lastEvent: Record<string, unknown> | null;
  lastCheckedAt: string | null;
  meta: InvoiceMeta | null;
  createdAt: string | null;
};

export type AdminBookingRow = {
  id: string;
  when: string | null; // "Mon, Oct 20 at 9:00 AM" from desired_date + start_time (local wall clock)
  desiredDate: string | null; // YYYY-MM-DD
  startTime: string | null; // HH:MM
  startsAt: string | null; // the confirmed instant, once an admin confirmed the time
  endsAt: string | null;
  address: string;
  slug: string;
  listingId: string;
  nda: boolean;
  listingLocked: boolean;
  client: { id: string; name: string | null; email: string; phone: string | null; company: string | null };
  servicesLabel: string | null;
  addonsLabel: string | null;
  paymentMethod: BookingPaymentMethod | null;
  paymentDetail?: BookingPaymentDetail | null; // with "other": check | ach | cash
  invoice: AdminBookingInvoice | null;
  calendarSynced: boolean; // calendar_event_id present (step three fills it)
  calendarEventId: string | null;
  photographerEmail: string | null;
  status: BookingStatus;
  market: string | null;
  deadJobs: number; // side-effect jobs for this booking that gave up
  // Still Unconfirmed and the requested time is behind us (local): the row
  // stays in Upcoming with "Date passed, set a new time" instead of vanishing.
  datePassed: boolean;
  // The client moved the shoot from the portal and no admin has confirmed the
  // new time yet: when, and the time it was before.
  movedByClient: { at: string; from: string | null } | null;
  createdAt: string;
  updatedAt: string;
  // Set on a return shoot's row in Upcoming (Oct 28 2026): the row stands for
  // one scheduled additional shoot on this booking (src/lib/booking-visits.ts),
  // on its own date, with its own shooter and invoice. It opens the booking.
  visit?: { id: string; kindLabel: string; note: string | null } | null;
};

export type AdminJob = {
  id: string;
  kind: string;
  status: string; // queued | running | done | dead
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  doneAt: string | null;
  alertedAt: string | null;
  createdAt: string;
  idempotencyKey: string;
};

// The detail page: the row plus everything the form said.
export type AdminBookingDetail = AdminBookingRow & {
  launchDate: string | null;
  sqft: number | null;
  tier: number | null;
  serviceIds: string[];
  addonIds: string[];
  items: { id: string; qty?: number | null; option?: string | null }[]; // with quantities
  clientType: string | null;
  customRequest: string | null;
  accessNotes: string | null;
  property: Record<string, unknown> | null;
  signedName: string | null;
  signedAt: string | null;
  clientNotes: string | null; // the form's "Additional details"
  internalNote: string | null; // the team's note from the status card, never shown to the client
  calendarVersion: number;
  calendarSyncedAt: string | null;
  source: string;
  env: string | null;
  raw: BookingRaw | null;
};

export type BookingFilter = "upcoming" | "to_confirm" | "rescheduled" | "needs_quote" | "unpaid" | "review" | "failed" | "all";
export type BookingQuery = { filter?: BookingFilter; q?: string };
