// Sample rows for demo mode (no DATABASE_URL). Clearly labelled in the UI.
// Names and addresses are placeholders, not real clients.
import type {
  AdminActivity,
  AdminBookingDetail,
  AdminClient,
  AdminDownload,
  AdminFrame,
  AdminJob,
  AdminListing,
  AdminRevision,
  AdminShoot,
  AdminShootFile,
} from "./admin-types";
import type { QcIssue, ShootQcSummary, StaffRole } from "@/db/schema";
import { DEMO_PHOTOS } from "./demo-photos";
import { qcFixKey, type QcFixDone } from "./qc-labels";

const day = (d: number, h = 10, m = 0) => new Date(Date.UTC(2026, 9, d, h + 7, m)).toISOString();

export const DEMO_CLIENTS: AdminClient[] = [
  { id: "demo-c1", email: "avery@example.com", name: "Avery Chen", company: "Harbor Realty", phone: null, team: null, listingCount: 3, createdAt: day(1) },
  { id: "demo-c2", email: "taylor@example.com", name: "Taylor Brooks", company: "Coastal Living Group", phone: null, team: "coastal-living", listingCount: 2, createdAt: day(3) },
  { id: "demo-c3", email: "taylor@example.com", name: "Taylor Brooks", company: "Riviera Estates", phone: null, team: null, listingCount: 2, createdAt: day(6) },
];

// Demo mode only (no database, local): a QA team login and a creative
// specialist login. Sign in as qa@example.com on the demo login to see the
// admin as the QA team sees it, as shooter@example.com to see it as a
// creative specialist (demo-s1 and demo-s6 are their uploads).
export const DEMO_CREATIVE_EMAIL = "shooter@example.com";
export const DEMO_VIDEO_EMAIL = "editor@example.com";
export const DEMO_STAFF: { email: string; name: string; role: StaffRole; addedBy: string; createdAt: string }[] = [
  { email: "qa@example.com", name: "Demo QA", role: "qa", addedBy: "demo", createdAt: day(15, 9) },
  { email: DEMO_CREATIVE_EMAIL, name: "Demo shooter", role: "creative", addedBy: "demo", createdAt: day(15, 9, 5) },
  { email: DEMO_VIDEO_EMAIL, name: "Demo video editor", role: "video", addedBy: "demo", createdAt: day(15, 9, 10) },
];

const client = (id: string) => DEMO_CLIENTS.find((c) => c.id === id)!;

function listing(p: Omit<AdminListing, "clientEmail" | "clientName" | "clientCompany">): AdminListing {
  const c = client(p.clientId);
  return { ...p, clientEmail: c.email, clientName: c.name, clientCompany: c.company };
}

export const DEMO_LISTINGS: AdminListing[] = [
  listing({ id: "demo-l1", address: "1420 Example Alder Drive, Springfield, CA 90000", slug: "1420-example-alder-drive", clientId: "demo-c1", mediaCount: 64, pendingCount: 0, downloadLocked: false, invoiceStatus: "paid", createdAt: day(6), updatedAt: day(10), shootDate: "2026-10-08", deliveryEmailAt: day(9, 15), approvedAt: day(10, 9), coverKey: null, nda: false, activeShoot: null }),
  listing({ id: "demo-l2", address: "88 Example Maple Road, Springfield, CA 90000", slug: "88-example-maple-road", clientId: "demo-c2", mediaCount: 72, pendingCount: 0, downloadLocked: true, invoiceStatus: "open", createdAt: day(9), updatedAt: day(13, 11), shootDate: "2026-10-12", deliveryEmailAt: day(13, 11), approvedAt: null, coverKey: null, nda: false, activeShoot: null }),
  listing({ id: "demo-l3", address: "2305 Example Hazel Road, Springfield, CA 90000", slug: "2305-example-hazel-road", clientId: "demo-c1", mediaCount: 0, pendingCount: 0, downloadLocked: true, invoiceStatus: null, createdAt: day(11), updatedAt: day(15, 16), shootDate: "2026-10-15", deliveryEmailAt: null, approvedAt: null, coverKey: null, nda: false, activeShoot: { id: "demo-s1", status: "processing" } }),
  listing({ id: "demo-l4", address: "610 Example Beech Road, Springfield, CA 90000", slug: "610-example-beech-road", clientId: "demo-c3", mediaCount: 0, pendingCount: 54, downloadLocked: true, invoiceStatus: "open", createdAt: day(10), updatedAt: day(15, 8), shootDate: "2026-10-14", deliveryEmailAt: null, approvedAt: null, coverKey: null, nda: false, activeShoot: { id: "demo-s2", status: "ready_for_review" } }),
  listing({ id: "demo-l5", address: "35 Example Larch Avenue, Springfield, CA 90000", slug: "35-example-larch-avenue", clientId: "demo-c2", mediaCount: 0, pendingCount: 0, downloadLocked: true, invoiceStatus: null, createdAt: day(14), updatedAt: day(14), shootDate: "2026-10-21", deliveryEmailAt: null, approvedAt: null, coverKey: null, nda: true, activeShoot: null }),
  listing({ id: "demo-l6", address: "1900 Example Cypress Road, Springfield, CA 90000", slug: "1900-example-cypress-road", clientId: "demo-c1", mediaCount: 0, pendingCount: 0, downloadLocked: true, invoiceStatus: null, createdAt: day(12), updatedAt: day(16, 9), shootDate: "2026-10-16", deliveryEmailAt: null, approvedAt: null, coverKey: null, nda: false, activeShoot: { id: "demo-s3", status: "failed" } }),
  listing({ id: "demo-l7", address: "1127 Example Yew Road, Springfield, CA 90000", slug: "1127-example-yew-road", clientId: "demo-c3", mediaCount: 0, pendingCount: 0, downloadLocked: true, invoiceStatus: null, createdAt: day(15), updatedAt: day(16, 10, 2), shootDate: "2026-10-16", deliveryEmailAt: null, approvedAt: null, coverKey: null, nda: false, activeShoot: { id: "demo-s6", status: "uploaded" } }),
];

const L = (id: string) => DEMO_LISTINGS.find((l) => l.id === id)!;

function shoot(p: Omit<AdminShoot, "address" | "slug" | "clientName" | "clientEmail" | "nda" | "dropboxFolder" | "dropboxSyncedAt"> & Partial<Pick<AdminShoot, "dropboxFolder" | "dropboxSyncedAt">>): AdminShoot {
  const l = L(p.listingId);
  return { dropboxFolder: null, dropboxSyncedAt: null, ...p, address: l.address, slug: l.slug, clientName: l.clientName, clientEmail: l.clientEmail, nda: l.nda };
}

const aura = { indoorModelId: 37, outdoorModelId: 37, modelName: "Aura", modelCredits: 5, skipHdr: false, nda: false };

// Automatic QC results for the demo review shoot (demo-s2): 48 frames, two
// blocked, a handful to fix, the rest clean or minor.
const DEMO_QC: Record<number, { score: number; issues: QcIssue[]; suggestions: string[]; summary: string }> = {
  2: { score: 3, issues: [{ type: "photographer", severity: "block", note: "The photographer and tripod are reflected in the mirror above the vanity, right third of the frame." }], suggestions: ["Clone out the reflection in the vanity mirror.", "Check the second mirror on the left wall for the same reflection."], summary: "Photographer visible in the vanity mirror; do not ship as is." },
  7: { score: 6, issues: [{ type: "blown_window", severity: "fix", note: "The two windows behind the dining table are fully white with no exterior detail." }, { type: "color", severity: "minor", note: "Slight warm cast on the ceiling." }], suggestions: ["Pull the window exposure back so the garden reads.", "Cool the ceiling a touch."], summary: "Blown dining windows need a window pull." },
  11: { score: 7, issues: [{ type: "crooked", severity: "fix", note: "Verticals lean left about two degrees, most visible on the door frame at right." }], suggestions: ["Correct verticals and re-crop."], summary: "Verticals lean left; straighten." },
  19: { score: 4, issues: [{ type: "person", severity: "block", note: "A person in a dark shirt is standing in the doorway at the back of the hall." }], suggestions: ["Remove the person or reshoot the hall."], summary: "Person in the hallway doorway." },
  23: { score: 7, issues: [{ type: "dust", severity: "fix", note: "Three sensor dust spots in the sky, upper left quadrant." }], suggestions: ["Spot heal the sky."], summary: "Dust spots in the sky." },
  28: { score: 8, issues: [{ type: "composition", severity: "minor", note: "A power cord runs along the baseboard under the console, lower left." }], suggestions: ["Clone out the cord."], summary: "Clean frame apart from a cord at lower left." },
  31: { score: 6, issues: [{ type: "artifact", severity: "fix", note: "Text on the framed print above the sofa is warped and unreadable." }, { type: "color", severity: "minor", note: "Green cast in the shadows under the sofa." }], suggestions: ["Replace the print face from the original bracket.", "Neutralize the shadow cast."], summary: "Warped text on the wall art; shadows run green." },
  36: { score: 8, issues: [{ type: "color", severity: "minor", note: "Pool water reads slightly cyan." }], suggestions: ["Shift the water toward a natural blue."], summary: "Clean exterior, pool slightly cyan." },
  40: { score: 7, issues: [{ type: "blown_window", severity: "fix", note: "French doors at the far end are blown to white." }], suggestions: ["Pull the door exposure."], summary: "Blown French doors at the back of the room." },
  44: { score: 8, issues: [{ type: "composition", severity: "minor", note: "Recycling bins visible at the side of the garage, far right edge." }], suggestions: ["Crop or clone the bins."], summary: "Bins at the right edge." },
};

export const DEMO_QC_SUMMARY: ShootQcSummary = {
  total: 54, checked: 54, skipped: 0, blocked: 2, fix: 5, minor: 3, clean: 44, avgScore: 8.4,
  worst: [
    { mediaId: "demo-s2-m2", filename: "610-Beech-Road-03.jpg", score: 3, summary: DEMO_QC[2].summary },
    { mediaId: "demo-s2-m19", filename: "610-Beech-Road-20.jpg", score: 4, summary: DEMO_QC[19].summary },
    { mediaId: "demo-s2-m7", filename: "610-Beech-Road-08.jpg", score: 6, summary: DEMO_QC[7].summary },
    { mediaId: "demo-s2-m31", filename: "610-Beech-Road-32.jpg", score: 6, summary: DEMO_QC[31].summary },
    { mediaId: "demo-s2-m11", filename: "610-Beech-Road-12.jpg", score: 7, summary: DEMO_QC[11].summary },
    { mediaId: "demo-s2-m23", filename: "610-Beech-Road-24.jpg", score: 7, summary: DEMO_QC[23].summary },
  ],
  notes: [],
  model: null,
  finishedAt: day(15, 8, 2),
};

export const DEMO_SHOOTS: AdminShoot[] = [
  shoot({ id: "demo-s1", listingId: "demo-l3", status: "processing", options: { ...aura, twilight: { enabled: true, count: 6, look: "ember_dusk" }, notes: "Pool house is a separate structure, keep it in.", files: { photos: 183, video: 3 } }, progress: { lastStatus: "in_progress" }, fileCount: 186, photoCount: 41, error: null, createdBy: DEMO_CREATIVE_EMAIL, createdAt: day(15, 15, 40), updatedAt: day(15, 16, 32), submittedAt: day(15, 16, 10), readyAt: null, publishedAt: null, publishedBy: null, stepStartedAt: day(15, 16, 14), autohdrPhotoshootId: 2290411, qcSummary: null, qcCheckedAt: null, dropboxFolder: "/Listings/2305 Example Hazel Road, Springfield, CA 90000" }),
  // Video only (Oct 21 2026): three clips, no photos, straight to Dropbox.
  shoot({ id: "demo-s7", listingId: "demo-l3", status: "video_only", options: { ...aura, twilight: { enabled: false, count: 6, look: "ember_dusk" }, notes: "Drone passes and the walkthrough, ungraded.", files: { photos: 0, video: 3 } }, progress: {}, fileCount: 3, photoCount: 0, error: null, createdBy: DEMO_CREATIVE_EMAIL, createdAt: day(16, 11, 5), updatedAt: day(16, 11, 40), submittedAt: day(16, 11, 12), readyAt: null, publishedAt: null, publishedBy: null, stepStartedAt: day(16, 11, 12), autohdrPhotoshootId: null, qcSummary: null, qcCheckedAt: null, dropboxFolder: "/Listings/2305 Example Hazel Road, Springfield, CA 90000", dropboxSyncedAt: day(16, 11, 40) }),
  shoot({ id: "demo-s2", listingId: "demo-l4", status: "ready_for_review", options: { ...aura, twilight: { enabled: true, count: 6, look: "ember_dusk" }, notes: "" }, progress: { imported: [], qc: { total: 54, done: 54, startedAt: day(15, 7, 50) } }, fileCount: 162, photoCount: 48, error: null, createdBy: "owner@example.com", createdAt: day(14, 17, 5), updatedAt: day(15, 8, 2), submittedAt: day(14, 17, 25), readyAt: day(15, 8, 2), publishedAt: null, publishedBy: null, stepStartedAt: day(15, 8, 2), autohdrPhotoshootId: 2289930, qcSummary: DEMO_QC_SUMMARY, qcCheckedAt: day(15, 8, 2) }),
  shoot({ id: "demo-s3", listingId: "demo-l6", status: "failed", options: { ...aura, twilight: { enabled: false, count: 6, look: "ember_dusk" }, notes: "" }, progress: { failedFrom: "transferring", resetToUploaded: true }, fileCount: 412, photoCount: 6, error: "Upload links kept expiring before the files could be sent (5 fresh sets). Check the editing service, then retry.", createdBy: "alex@example.com", createdAt: day(16, 8, 50), updatedAt: day(16, 9, 12), submittedAt: day(16, 9, 1), readyAt: null, publishedAt: null, publishedBy: null, stepStartedAt: day(16, 9, 2), autohdrPhotoshootId: 2291002, qcSummary: null, qcCheckedAt: null }),
  shoot({ id: "demo-s4", listingId: "demo-l1", status: "published", options: { ...aura, twilight: { enabled: true, count: 6, look: "ember_dusk" }, notes: "", files: { photos: 199, video: 2 } }, progress: {}, fileCount: 201, photoCount: 64, error: null, createdBy: "owner@example.com", createdAt: day(8, 16), updatedAt: day(9, 14), submittedAt: day(8, 16, 20), readyAt: day(9, 7, 30), publishedAt: day(9, 14), publishedBy: "owner@example.com", stepStartedAt: day(9, 14), autohdrPhotoshootId: 2286120, qcSummary: null, qcCheckedAt: null, dropboxFolder: "/Listings/1420 Example Alder Drive, Springfield, CA 90000", dropboxSyncedAt: day(8, 17, 5) }),
  shoot({ id: "demo-s6", listingId: "demo-l7", status: "uploaded", options: { ...aura, twilight: { enabled: true, count: 6, look: "ember_dusk" }, notes: "" }, progress: {}, fileCount: 132, photoCount: 0, error: null, createdBy: DEMO_CREATIVE_EMAIL, createdAt: day(16, 9, 48), updatedAt: day(16, 10, 2), submittedAt: day(16, 10, 2), readyAt: null, publishedAt: null, publishedBy: null, stepStartedAt: day(16, 10, 2), autohdrPhotoshootId: null, qcSummary: null, qcCheckedAt: null }),
  shoot({ id: "demo-s5", listingId: "demo-l2", status: "published", options: { ...aura, twilight: { enabled: true, count: 8, look: "golden_sunset" }, notes: "Agent asked for the ocean view framed from the terrace." }, progress: {}, fileCount: 240, photoCount: 72, error: null, createdBy: "alex@example.com", createdAt: day(12, 15), updatedAt: day(13, 10), submittedAt: day(12, 15, 30), readyAt: day(13, 6, 50), publishedAt: day(13, 10), publishedBy: "owner@example.com", stepStartedAt: day(13, 10), autohdrPhotoshootId: 2288401, qcSummary: null, qcCheckedAt: null }),
];

// Photos first, then any raw clips (options.files.video, Oct 21 2026). The
// Dropbox copy: every file of a shoot whose dropboxSyncedAt is set, the
// first half of a shoot that has a folder but is not done, none otherwise.
export function demoShootFiles(shoot: AdminShoot): AdminShootFile[] {
  const video = shoot.options?.files?.video ?? 0;
  const photos = Math.min(shoot.fileCount - video, 24);
  const synced = (i: number, total: number) => (shoot.dropboxSyncedAt ? true : shoot.dropboxFolder ? i < Math.ceil(total / 2) : false);
  const total = photos + video;
  const at = (i: number) => (synced(i, total) ? day(16, 10, 20 + i) : null);
  const sub = (kind: string) => (kind === "raw_video" ? "Video" : "Photo");
  const photoRows: AdminShootFile[] = Array.from({ length: photos }, (_, i) => {
    const filename = `DSC0${String(4120 + i).padStart(4, "0")}.ARW`;
    const kind = shoot.options?.skipHdr ? "display" : "raw";
    const when = at(i);
    return { id: `${shoot.id}-f${i}`, filename, bytes: 24_600_000 + (i % 7) * 310_000, kind, uploaded: shoot.status !== "failed" || i < 140, dropboxPath: when && shoot.dropboxFolder ? `${shoot.dropboxFolder}/${sub(kind)}/${filename}` : null, dropboxSyncedAt: when };
  });
  const videoRows: AdminShootFile[] = Array.from({ length: video }, (_, i) => {
    const filename = `C${String(i + 1).padStart(4, "0")}.MOV`;
    const when = at(photos + i);
    return { id: `${shoot.id}-v${i}`, filename, bytes: 1_240_000_000 + i * 310_000_000, kind: "raw_video", uploaded: false, dropboxPath: when && shoot.dropboxFolder ? `${shoot.dropboxFolder}/Video/${filename}` : null, dropboxSyncedAt: when };
  });
  return [...photoRows, ...videoRows];
}

// Demo mode: the Photo QC team has already ticked the first flag of every
// frame that has more than one, so the panel shows a done and an open fix.
function demoFixes(issues: QcIssue[] | undefined): Record<string, QcFixDone> {
  if (!issues || issues.length < 2) return {};
  return { [qcFixKey(issues[0])]: { by: "qa@example.com", name: "Demo QA", at: day(15, 9, 40) } };
}

export function demoFrames(shoot: AdminShoot): AdminFrame[] {
  if (!["ready_for_review", "published", "failed"].includes(shoot.status)) return [];
  const street = shoot.address.split(",")[0].trim().replace(/[^A-Za-z0-9]+/g, "-");
  const published = shoot.status === "published";
  // Nov 3 2026: a stopped shoot (failed) carries the photos the editors
  // delivered by hand, approved and waiting for Publish (925 Example Spruce Road).
  const recovered = shoot.status === "failed";
  const qcOn = shoot.qcSummary != null;
  const main: AdminFrame[] = Array.from({ length: shoot.photoCount }, (_, i) => {
    // Nov 3 2026: on the shoot in review, the editors have re-uploaded three
    // photos (the Revised section): two QC has checked again and found clean,
    // one it has not seen since the upload. The block-flagged photos stay
    // unreviewed in the gallery, Internal only.
    const revised = !published && qcOn && (i === 7 || i === 11 || i === 23);
    const fresh = revised && i === 23;
    const q = qcOn && !revised ? DEMO_QC[i] : undefined;
    return {
      id: `${shoot.id}-m${i}`,
      filename: `${street}-${String(i + 1).padStart(2, "0")}.jpg`,
      r2Key: `listings/${shoot.slug}/edited/${street}-${String(i + 1).padStart(2, "0")}.jpg`,
      section: null,
      // A block flag no longer rejects a photo (Nov 3 2026): it stays unreviewed, Internal only.
      qcState: recovered ? "approved" : published ? (i % 17 === 5 ? "rejected" : "approved") : revised ? "approved" : "pending",
      sort: i,
      bytes: 6_100_000 + (i % 9) * 420_000,
      thumbUrl: null,
      // The card keeps its colour; the opened photo shows a real demo photo.
      largeUrl: DEMO_PHOTOS[i % DEMO_PHOTOS.length].url,
      fullUrl: DEMO_PHOTOS[i % DEMO_PHOTOS.length].url,
      hue: (i * 37) % 360,
      // A published demo shoot holds one frame back by hand (Internal only)
      // and has one corrected final waiting for Publish, so both states show.
      published: published && i !== 11 && i !== 27,
      corrected: recovered || revised || (published && (i % 23 === 4 || i === 27)),
      held: published && i === 11,
      revision: false,
      qcScore: qcOn && !fresh ? q?.score ?? 9 : null,
      qcIssues: qcOn && !fresh ? q?.issues ?? [] : null,
      qcSuggestions: qcOn && !fresh ? q?.suggestions ?? [] : null,
      qcSummary: recovered || fresh ? "Corrected final uploaded by qa@example.com." : qcOn ? q?.summary ?? "Clean frame." : null,
      qcCheckedAt: qcOn && !fresh ? shoot.qcCheckedAt : null,
      qcFixes: qcOn ? demoFixes(q?.issues) : {},
    };
  });
  const tw = shoot.options?.twilight?.enabled ? Math.min(shoot.options.twilight.count, 6) : 0;
  const twilight: AdminFrame[] = Array.from({ length: tw }, (_, i) => ({
    id: `${shoot.id}-t${i}`,
    filename: `${street}-Twilight-${String(i + 1).padStart(2, "0")}.jpg`,
    r2Key: `listings/${shoot.slug}/s/twilight/photos/${street}-Twilight-${String(i + 1).padStart(2, "0")}.jpg`,
    section: "Twilight",
    qcState: published ? "approved" : "pending",
    sort: i,
    bytes: 5_800_000,
    thumbUrl: null,
    largeUrl: DEMO_PHOTOS[(i + 7) % DEMO_PHOTOS.length].url,
    fullUrl: DEMO_PHOTOS[(i + 7) % DEMO_PHOTOS.length].url,
    hue: 230 + i * 6,
    published,
    corrected: false,
    held: false,
    revision: false,
    qcScore: qcOn ? 9 : null,
    qcIssues: qcOn ? [] : null,
    qcSuggestions: qcOn ? [] : null,
    qcSummary: qcOn ? "Clean twilight frame." : null,
    qcCheckedAt: qcOn ? shoot.qcCheckedAt : null,
  }));
  return [...main, ...twilight];
}

export const DEMO_REVISIONS: AdminRevision[] = [
  {
    id: "demo-r1", listingId: "demo-l1", address: L("demo-l1").address, slug: L("demo-l1").slug, clientId: "demo-c1", clientEmail: "avery@example.com", clientName: "Avery Chen",
    notes: "Everything else is perfect. Thank you.", filenames: [DEMO_PHOTOS[13].filename, DEMO_PHOTOS[14].filename, DEMO_PHOTOS[7].filename], createdAt: day(16, 8, 12), status: "new", resolvedAt: null, resolvedBy: null,
    submittedAt: day(16, 8, 20), unsent: 1,
    items: [
      { id: "demo-ri1", mediaId: "demo-p14", filename: DEMO_PHOTOS[13].filename, note: "Could the kitchen come up a touch brighter? The island reads a little dark on my screen.", createdAt: day(16, 8, 12), updatedAt: day(16, 8, 12), sent: true, thumbUrl: DEMO_PHOTOS[13].url },
      { id: "demo-ri2", mediaId: "demo-p15", filename: DEMO_PHOTOS[14].filename, note: "Same as the kitchen shot: a little brighter, please.", createdAt: day(16, 8, 15), updatedAt: day(16, 8, 15), sent: true, thumbUrl: DEMO_PHOTOS[14].url },
      { id: "demo-ri3", mediaId: "demo-p8", filename: DEMO_PHOTOS[7].filename, note: "Please remove the garden hose on the left.", createdAt: day(16, 9, 2), updatedAt: day(16, 9, 2), sent: false, thumbUrl: DEMO_PHOTOS[7].url },
    ],
  },
  { id: "demo-r2", listingId: "demo-l2", address: L("demo-l2").address, slug: L("demo-l2").slug, clientId: "demo-c2", clientEmail: "taylor@example.com", clientName: "Taylor Brooks", notes: "Please remove the garden hose from the side yard shot and the recycling bins by the garage.", filenames: ["88-Maple-Road-03.jpg", "88-Maple-Road-61.jpg"], createdAt: day(14, 13, 40), status: "in_progress", resolvedAt: null, resolvedBy: null, items: [], submittedAt: day(14, 13, 40), unsent: 0 },
  { id: "demo-r3", listingId: "demo-l1", address: L("demo-l1").address, slug: L("demo-l1").slug, clientId: "demo-c1", clientEmail: "avery@example.com", clientName: "Avery Chen", notes: "The twilight of the front looks great. Can we get one more from the driveway angle?", filenames: ["1420-Alder-Drive-Twilight-01.jpg"], createdAt: day(9, 17, 2), status: "done", resolvedAt: day(10, 8, 30), resolvedBy: "owner@example.com", items: [], submittedAt: day(9, 17, 2), unsent: 0 },
];

export const DEMO_DOWNLOADS: AdminDownload[] = [
  { at: day(16, 7, 48), clientEmail: "avery@example.com", filename: "Full-res bundle (all photos)", address: L("demo-l1").address, listingId: "demo-l1", slug: L("demo-l1").slug },
  { at: day(15, 18, 2), clientEmail: "avery@example.com", filename: "1420-Alder-Drive-07.jpg", address: L("demo-l1").address, listingId: "demo-l1", slug: L("demo-l1").slug },
  { at: day(15, 18, 1), clientEmail: "avery@example.com", filename: "1420-Alder-Drive-02.jpg", address: L("demo-l1").address, listingId: "demo-l1", slug: L("demo-l1").slug },
  { at: day(14, 9, 20), clientEmail: "assistant@example.com", filename: "MLS bundle (all photos, 2048px)", address: L("demo-l1").address, listingId: "demo-l1", slug: L("demo-l1").slug },
  { at: day(13, 12, 5), clientEmail: "avery@example.com", filename: "1420-Alder-Drive-Twilight-01.jpg", address: L("demo-l1").address, listingId: "demo-l1", slug: L("demo-l1").slug },
  { at: day(11, 10, 30), clientEmail: "avery@example.com", filename: "1420-Alder-Drive-33.jpg → Dropbox", address: L("demo-l1").address, listingId: "demo-l1", slug: L("demo-l1").slug },
  { at: day(10, 16, 44), clientEmail: "avery@example.com", filename: "Full-res bundle (all photos)", address: L("demo-l1").address, listingId: "demo-l1", slug: L("demo-l1").slug },
  { at: day(9, 15, 12), clientEmail: "avery@example.com", filename: "1420-Alder-Drive-01.jpg", address: L("demo-l1").address, listingId: "demo-l1", slug: L("demo-l1").slug },
];

export const DEMO_ACTIVITY: AdminActivity[] = [
  { id: "a1", actorEmail: null, action: "shoot.failed", listingId: "demo-l6", shootId: "demo-s3", clientId: null, meta: { step: "transferring", error: "Upload links expired before the transfer finished." }, createdAt: day(16, 9, 12), address: L("demo-l6").address },
  { id: "a2", actorEmail: "alex@example.com", action: "shoot.submitted", listingId: "demo-l6", shootId: "demo-s3", clientId: null, meta: { fileCount: 412 }, createdAt: day(16, 9, 1), address: L("demo-l6").address },
  { id: "a3", actorEmail: "avery@example.com", action: "client.revision_requested", listingId: "demo-l1", shootId: null, clientId: "demo-c1", meta: {}, createdAt: day(16, 8, 12), address: L("demo-l1").address },
  { id: "a4", actorEmail: null, action: "shoot.processing", listingId: "demo-l3", shootId: "demo-s1", clientId: null, meta: { imageCount: 41 }, createdAt: day(15, 16, 32), address: L("demo-l3").address },
  { id: "a5", actorEmail: DEMO_CREATIVE_EMAIL, action: "shoot.submitted", listingId: "demo-l3", shootId: "demo-s1", clientId: null, meta: { fileCount: 186 }, createdAt: day(15, 16, 10), address: L("demo-l3").address },
  { id: "a6", actorEmail: null, action: "shoot.ready", listingId: "demo-l4", shootId: "demo-s2", clientId: null, meta: { photoCount: 48, twilightCount: 6 }, createdAt: day(15, 8, 2), address: L("demo-l4").address },
  { id: "a6b", actorEmail: null, action: "shoot.qc_done", listingId: "demo-l4", shootId: "demo-s2", clientId: null, meta: { line: "54 frames checked, 2 blocked, 5 to fix, 3 minor, score 8.4" }, createdAt: day(15, 8, 1), address: L("demo-l4").address },
  { id: "a7", actorEmail: "taylor@example.com", action: "client.revision_requested", listingId: "demo-l2", shootId: null, clientId: "demo-c2", meta: {}, createdAt: day(14, 13, 40), address: L("demo-l2").address },
  { id: "a8", actorEmail: "owner@example.com", action: "listing.delivery_email", listingId: "demo-l2", shootId: null, clientId: "demo-c2", meta: { to: "taylor@example.com" }, createdAt: day(13, 11), address: L("demo-l2").address },
  { id: "a9", actorEmail: "owner@example.com", action: "shoot.published", listingId: "demo-l2", shootId: "demo-s5", clientId: null, meta: { approved: 72, rejected: 4 }, createdAt: day(13, 10), address: L("demo-l2").address },
  { id: "a10", actorEmail: "owner@example.com", action: "revision.status", listingId: "demo-l1", shootId: null, clientId: "demo-c1", meta: { status: "done" }, createdAt: day(10, 8, 30), address: L("demo-l1").address },
  { id: "a11", actorEmail: "avery@example.com", action: "client.approved", listingId: "demo-l1", shootId: null, clientId: "demo-c1", meta: {}, createdAt: day(10, 9), address: L("demo-l1").address },
  { id: "a12", actorEmail: "owner@example.com", action: "listing.unlocked", listingId: "demo-l1", shootId: null, clientId: "demo-c1", meta: {}, createdAt: day(9, 15, 30), address: L("demo-l1").address },
  { id: "a13", actorEmail: "owner@example.com", action: "listing.delivery_email", listingId: "demo-l1", shootId: null, clientId: "demo-c1", meta: { to: "avery@example.com" }, createdAt: day(9, 15), address: L("demo-l1").address },
  { id: "a14", actorEmail: "owner@example.com", action: "shoot.published", listingId: "demo-l1", shootId: "demo-s4", clientId: null, meta: { approved: 64, rejected: 3 }, createdAt: day(9, 14), address: L("demo-l1").address },
  { id: "a15", actorEmail: "team@example.com", action: "admin.view_as", listingId: null, shootId: null, clientId: "demo-c1", meta: { as: "avery@example.com" }, createdAt: day(9, 13, 20), address: null },
];

// ---- Bookings (step two): sample bookings so /admin/bookings can be
// reviewed with no database. One card booking with an open Stripe invoice,
// one pay-at-close booking waiting for a quote, one unconfirmed request whose
// date has passed (the "Date passed" flag) and one confirmed shoot with a
// shooter. The last two sit on listings of their own, added to the demo
// listings by admin-data (allListings), so the demo listing rows stay as they are.
export const DEMO_BOOKING_LISTINGS: AdminListing[] = [
  listing({ id: "demo-l8", address: "1550 Example Rowan Road, Springfield, CA 90000", slug: "1550-example-rowan-road", clientId: "demo-c1", mediaCount: 0, pendingCount: 0, downloadLocked: true, invoiceStatus: "open", createdAt: day(17, 16, 32), updatedAt: day(17, 16, 32), shootDate: "2026-10-17", deliveryEmailAt: null, approvedAt: null, coverKey: null, nda: false, activeShoot: null }),
  listing({ id: "demo-l9", address: "2121 Example Juniper Drive, Springfield, CA 90000", slug: "2121-example-juniper-drive", clientId: "demo-c2", mediaCount: 0, pendingCount: 0, downloadLocked: false, invoiceStatus: "paid", createdAt: day(16, 11), updatedAt: day(18, 9), shootDate: "2026-10-22", deliveryEmailAt: null, approvedAt: null, coverKey: null, nda: false, activeShoot: null }),
];

const BL = (id: string) => DEMO_BOOKING_LISTINGS.find((l) => l.id === id) ?? L(id);

function booking(p: Omit<AdminBookingDetail, "address" | "slug" | "nda" | "listingLocked" | "client" | "datePassed" | "movedByClient"> & { movedByClient?: AdminBookingDetail["movedByClient"] }): AdminBookingDetail {
  const l = BL(p.listingId);
  const c = client(l.clientId);
  // datePassed is worked out when the rows are read (admin-data withFlags).
  return { ...p, movedByClient: p.movedByClient ?? null, address: l.address, slug: l.slug, nda: l.nda, listingLocked: l.downloadLocked, datePassed: false, client: { id: c.id, name: c.name, email: c.email, phone: c.phone, company: c.company } };
}

export const DEMO_BOOKINGS: AdminBookingDetail[] = [
  booking({
    id: "demo-b1", listingId: "demo-l5", when: "Tue, Oct 21 at 9:00 AM", desiredDate: "2026-10-21", startTime: "09:00", startsAt: null, endsAt: null,
    servicesLabel: "Photos and video", addonsLabel: "Twilight photos", paymentMethod: "card",
    invoice: { id: "demo-inv-b1", status: "open", amountCents: 240000, provider: "stripe", providerId: "in_demo_b1", hostedUrl: null, method: "card", paidAt: null, refundedCents: null, description: "35 Example Larch Avenue · Photos and video", lineItems: [{ id: "photos", name: "Photos", cents: 60000, priced: true }, { id: "photos_video", name: "Photos and video", cents: 150000, priced: true }, { id: "twilight", name: "Twilight photos", cents: 30000, priced: true }], idempotencyVersion: 1, lastEvent: { type: "invoice.finalized", at: day(14, 10, 1) }, lastCheckedAt: day(16, 9), meta: { pricingVersion: "sample-v1", tier: 0, computedTotalCents: 240000, websiteTotalCents: 240000 }, createdAt: day(14, 10) },
    calendarSynced: false, calendarEventId: null, photographerEmail: "alex@example.com", status: "requested", market: "Home area", deadJobs: 0, createdAt: day(14, 10), updatedAt: day(14, 10, 1),
    launchDate: "2026-10-24", sqft: 1900, tier: 0, serviceIds: ["photos", "photos_video"], addonIds: ["twilight"], items: [], clientType: "agent", customRequest: null, accessNotes: "Lockbox on the side gate, code with the agent.", property: { street: "35 Example Larch Avenue", city: "Springfield", state: "CA", zip: "90000", status: "Vacant / Staged", listingType: "For Sale", offMarket: "No", listingAgreement: "Yes", viewHome: "Yes", views: ["Ocean"], homeownerHome: "No", videoStyle: "Medium" }, signedName: "Taylor Brooks", signedAt: day(14, 10), clientNotes: null, internalNote: null, calendarVersion: 1, calendarSyncedAt: null, source: "website", env: "development", raw: null,
  }),
  booking({
    id: "demo-b2", listingId: "demo-l3", when: "Thu, Oct 23", desiredDate: "2026-10-23", startTime: null, startsAt: null, endsAt: null,
    servicesLabel: "Photos", addonsLabel: "Virtual staging", paymentMethod: "pay_at_close",
    invoice: { id: "demo-inv-b2", status: "needs_quote", amountCents: 90000, provider: "titus", providerId: null, hostedUrl: null, method: "pay_at_close", paidAt: null, refundedCents: null, description: "2305 Example Hazel Road · Photos", lineItems: [{ id: "photos", name: "Photos", cents: 90000, priced: true }, { id: "virtual_staging", name: "Virtual staging (3 images)", cents: 0, priced: false }], idempotencyVersion: 1, lastEvent: null, lastCheckedAt: null, meta: { pricingVersion: "sample-v1", tier: 2, computedTotalCents: 90000, websiteTotalCents: 90000, pending: true, note: "per image add-on" }, createdAt: day(15, 14) },
    calendarSynced: false, calendarEventId: null, photographerEmail: null, status: "requested", market: "Home area", deadJobs: 1, createdAt: day(15, 14), updatedAt: day(15, 14),
    launchDate: null, sqft: 3600, tier: 2, serviceIds: ["photos"], addonIds: ["virtual_staging"], items: [], clientType: "agent", customRequest: "Three staged rooms: living, primary and the office.", accessNotes: null, property: { street: "2305 Example Hazel Road", city: "Springfield", state: "CA", zip: "90000", status: "Occupied", listingType: "For Sale", offMarket: "Yes", homeownerHome: "Yes" }, signedName: "Avery Chen", signedAt: day(15, 14), clientNotes: null, internalNote: null, calendarVersion: 1, calendarSyncedAt: null, source: "website", env: "development", raw: null,
  }),
  // A same-day request sent after its own slot and never confirmed: it stays
  // in Upcoming with "Date passed, set a new time".
  booking({
    id: "demo-b3", listingId: "demo-l8", when: "Sat, Oct 17 at 3:30 PM", desiredDate: "2026-10-17", startTime: "15:30", startsAt: day(17, 15, 30), endsAt: day(17, 17, 30),
    servicesLabel: "Property video only", addonsLabel: null, paymentMethod: "card",
    invoice: { id: "demo-inv-b3", status: "open", amountCents: 75000, provider: "stripe", providerId: "in_demo_b3", hostedUrl: null, method: "card", paidAt: null, refundedCents: null, description: "1550 Example Rowan Road · Property video only", lineItems: [{ id: "video", name: "Property video only", cents: 75000, priced: true }], idempotencyVersion: 1, lastEvent: { type: "invoice.finalized", at: day(17, 16, 33) }, lastCheckedAt: day(17, 16, 33), meta: { pricingVersion: "sample-v1", tier: 0, computedTotalCents: 75000, websiteTotalCents: 75000 }, createdAt: day(17, 16, 32) },
    calendarSynced: false, calendarEventId: null, photographerEmail: null, status: "requested", market: "Home area", deadJobs: 0, createdAt: day(17, 16, 32), updatedAt: day(17, 16, 33),
    launchDate: null, sqft: 2100, tier: 0, serviceIds: ["video"], addonIds: [], items: [], clientType: "agent", customRequest: null, accessNotes: "Agent meets you at the front door.", property: { street: "1550 Example Rowan Road", city: "Springfield", state: "CA", zip: "90000", status: "Vacant / Staged", listingType: "For Sale", offMarket: "No", homeownerHome: "No" }, signedName: "Avery Chen", signedAt: day(17, 16, 32), clientNotes: null, internalNote: null, calendarVersion: 1, calendarSyncedAt: null, source: "website", env: "development", raw: null,
  }),
  // Confirmed, paid, with a shooter who has the calendar invite.
  booking({
    id: "demo-b4", listingId: "demo-l9", when: "Thu, Oct 22 at 10:00 AM", desiredDate: "2026-10-22", startTime: "10:00", startsAt: day(22, 10), endsAt: day(22, 11, 30),
    servicesLabel: "Photos", addonsLabel: "Twilight photos", paymentMethod: "card",
    invoice: { id: "demo-inv-b4", status: "paid", amountCents: 90000, provider: "stripe", providerId: "in_demo_b4", hostedUrl: null, method: "card", paidAt: day(18, 9), refundedCents: null, description: "2121 Example Juniper Drive · Photos", lineItems: [{ id: "photos", name: "Photos", cents: 60000, priced: true }, { id: "twilight", name: "Twilight photos", cents: 30000, priced: true }], idempotencyVersion: 1, lastEvent: { type: "invoice.paid", at: day(18, 9) }, lastCheckedAt: day(18, 9), meta: { pricingVersion: "sample-v1", tier: 0, computedTotalCents: 90000, websiteTotalCents: 90000 }, createdAt: day(16, 11) },
    calendarSynced: false, calendarEventId: null, photographerEmail: "alex@example.com", status: "confirmed", market: "Home area", deadJobs: 0, createdAt: day(16, 11), updatedAt: day(18, 9, 5),
    launchDate: "2026-10-26", sqft: 1800, tier: 0, serviceIds: ["photos"], addonIds: ["twilight"], items: [], clientType: "agent", customRequest: null, accessNotes: "Gate code with the agent. Park on the street.", property: { street: "2121 Example Juniper Drive", city: "Springfield", state: "CA", zip: "90000", status: "Vacant / Staged", listingType: "For Sale", offMarket: "No", viewHome: "Yes", views: ["Ocean"], homeownerHome: "No" }, signedName: "Taylor Brooks", signedAt: day(16, 11), clientNotes: null, internalNote: null, calendarVersion: 3, calendarSyncedAt: null, source: "website", env: "development", raw: null,
  }),
];

export const DEMO_JOBS: Record<string, AdminJob[]> = {
  "demo-b1": [
    { id: "demo-j1", kind: "stripe.invoice.create", status: "done", attempts: 1, maxAttempts: 8, lastError: null, runAt: day(14, 10), doneAt: day(14, 10, 1), alertedAt: null, createdAt: day(14, 10), idempotencyKey: "stripe.invoice.create:demo-inv-b1:1" },
    { id: "demo-j2", kind: "email.booking", status: "done", attempts: 1, maxAttempts: 8, lastError: null, runAt: day(14, 10), doneAt: day(14, 10, 1), alertedAt: null, createdAt: day(14, 10), idempotencyKey: "email.booking:demo-b1:1" },
    { id: "demo-j3", kind: "slack.booking", status: "done", attempts: 1, maxAttempts: 8, lastError: null, runAt: day(14, 10), doneAt: day(14, 10), alertedAt: null, createdAt: day(14, 10), idempotencyKey: "slack.booking:demo-b1:1" },
    { id: "demo-j4", kind: "calendar.upsert", status: "queued", attempts: 0, maxAttempts: 8, lastError: "the booking calendar sync (production only, or GOOGLE_CALENDAR_SYNC=on)", runAt: day(16, 10, 30), doneAt: null, alertedAt: null, createdAt: day(14, 10), idempotencyKey: "calendar.upsert:demo-b1:1" },
  ],
  "demo-b2": [
    { id: "demo-j5", kind: "email.booking", status: "done", attempts: 1, maxAttempts: 8, lastError: null, runAt: day(15, 14), doneAt: day(15, 14), alertedAt: null, createdAt: day(15, 14), idempotencyKey: "email.booking:demo-b2:1" },
    { id: "demo-j6", kind: "slack.booking", status: "dead", attempts: 8, maxAttempts: 8, lastError: "webhook responded 404", runAt: day(15, 20), doneAt: null, alertedAt: day(15, 14, 2), createdAt: day(15, 14), idempotencyKey: "slack.booking:demo-b2:1" },
    { id: "demo-j7", kind: "calendar.upsert", status: "queued", attempts: 0, maxAttempts: 8, lastError: "the booking calendar sync (production only, or GOOGLE_CALENDAR_SYNC=on)", runAt: day(16, 10, 30), doneAt: null, alertedAt: null, createdAt: day(15, 14), idempotencyKey: "calendar.upsert:demo-b2:1" },
  ],
  "demo-b3": [
    { id: "demo-j8", kind: "stripe.invoice.create", status: "done", attempts: 1, maxAttempts: 8, lastError: null, runAt: day(17, 16, 32), doneAt: day(17, 16, 33), alertedAt: null, createdAt: day(17, 16, 32), idempotencyKey: "stripe.invoice.create:demo-inv-b3:1" },
    { id: "demo-j9", kind: "email.booking", status: "done", attempts: 1, maxAttempts: 8, lastError: null, runAt: day(17, 16, 32), doneAt: day(17, 16, 33), alertedAt: null, createdAt: day(17, 16, 32), idempotencyKey: "email.booking:demo-b3:1" },
    { id: "demo-j10", kind: "calendar.upsert", status: "queued", attempts: 0, maxAttempts: 8, lastError: "the booking calendar sync (production only, or GOOGLE_CALENDAR_SYNC=on)", runAt: day(17, 17, 2), doneAt: null, alertedAt: null, createdAt: day(17, 16, 32), idempotencyKey: "calendar.upsert:demo-b3:1" },
  ],
  "demo-b4": [
    { id: "demo-j11", kind: "email.shooter_invite", status: "done", attempts: 1, maxAttempts: 8, lastError: null, runAt: day(18, 9, 5), doneAt: day(18, 9, 5), alertedAt: null, createdAt: day(18, 9, 5), idempotencyKey: "email.shooter_invite:demo-b4:3:alex@example.com:request" },
    { id: "demo-j12", kind: "calendar.upsert", status: "queued", attempts: 0, maxAttempts: 8, lastError: "the booking calendar sync (production only, or GOOGLE_CALENDAR_SYNC=on)", runAt: day(18, 9, 35), doneAt: null, alertedAt: null, createdAt: day(18, 9, 5), idempotencyKey: "calendar.upsert:demo-b4:3" },
  ],
};
