// Role gating over HTTP against a local demo-mode dev server (no database).
//
//   ADMIN_EMAILS=demo@example.com npx next dev -p 3171      # in one shell, no DATABASE_URL
//   node scripts/check-roles-http.mjs http://localhost:3171 .next/dev/server/server-reference-manifest.json
//
// Signs in as the demo admin, the demo Photo QC login (qa@example.com), the
// demo creative specialist (shooter@example.com), the demo video editor
// (editor@example.com) and a demo client, then checks every admin page, the
// studio routes, the reports CSV and the server actions (called directly with
// the Next-Action header, the way a crafted request would). The manifest
// argument is optional; without it the actions are skipped. The static
// counterpart is scripts/check-qa-role.ts.
//
// Homes (src/lib/admin.ts deniedPath): the Photo QC team lands on
// /admin/photo-qc (since Oct 26 2026; it was the dashboard), a creative
// specialist on /admin/upload, a video editor on /admin/video. A page their
// role may not open sends them home with ?denied=1.
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:3171";
const MANIFEST = process.argv[3];
const ADMIN = process.env.CHECK_ADMIN_EMAIL || "demo@example.com";
const QA = "qa@example.com";
const CREATIVE = "shooter@example.com";
const VIDEO = "editor@example.com";
const CLIENT = "avery@example.com";
let fails = 0, passes = 0;
// Money as it renders: ">$600<" or "$1,150" in HTML, "$$600" in the RSC
// payload (React escapes a string that starts with "$"). Not the payload's
// own "$15" row references.
const MONEY = /\$\$\d|\$\$"|>\$(<!-- -->)?\d|\$\d{1,3},\d{3}/;
const ok = (c, what) => { if (c) passes++; else { fails++; console.log(`FAIL ${what}`); } };

async function login(email) {
  const r = await fetch(`${BASE}/api/portal/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
  const j = await r.json();
  // The login route's brake (src/lib/rate-limit.ts, in memory in demo mode): 5 per email and 20 per address in 15 minutes, so a fresh dev server is good for about four runs.
  if (j.limited) throw new Error(`demo login for ${email} is rate limited: restart the dev server (the demo limits live in its memory) and run again`);
  if (!j.link) throw new Error(`demo login gave no link for ${email}: is the server in demo mode (no DATABASE_URL)?`);
  // The link opens a click-through (/portal/login/continue?token=) that only
  // peeks at the token; its button POSTs the token to /api/portal/verify,
  // which is the one place a session is made.
  const v = await fetch(`${BASE}${j.link}`, { redirect: "manual" });
  const peek = v.headers.get("location") || "";
  const token = new URL(peek, BASE).searchParams.get("token");
  const p = token ? await fetch(`${BASE}/api/portal/verify`, { method: "POST", redirect: "manual", body: new URLSearchParams({ token }) }) : v;
  const cookie = (p.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { cookie, landing: p.headers.get("location") };
}

const get = (path, cookie) => fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "");

// What the Photo QC team may open (Oct 26 2026): the Photo QC board, the
// Revisions tab, the shoot and listing pages they open from there, and
// Team SOPs. The shoot and listing lists are admin only now.
const STAFF_PAGES = ["/admin/photo-qc", "/admin/revisions", "/admin/shoots/demo-s2", "/admin/shoots/demo-s4", "/admin/shoots/demo-s3", "/admin/shoots/demo-s1", "/admin/shoots/demo-s6", "/admin/listings/demo-l1", "/admin/listings/demo-l4", "/admin/sops"];
// Everything else under /admin: full admins only. (The booking page's
// non-admin branch, the photographer view, lets in only the shooter or the
// teammate a pass names; no demo login here is either for demo-b1.)
const ADMIN_PAGES = ["/admin/shoots", "/admin/listings", "/admin/shoots/demo-s1/merge", "/admin/upload", "/admin/video", "/admin/scorecard", "/admin/bookings", "/admin/bookings/demo-b1", "/admin/clients", "/admin/clients/demo-c1", "/admin/teams", "/admin/teams/coastal-living", "/admin/downloads", "/admin/settings", "/admin/listings/new", "/admin/listings/demo-l1/delivery-email", "/admin/reports", "/admin/reports?from=2026-01-01&to=2026-12-31",
  // Showcase Media only: leads from the website's pricing page (Nov 24 2026).
  "/admin/leads"];
// What a creative specialist may open: Upload a shoot, their own uploads
// (demo-s1 and demo-s6 in the demo data) and Team SOPs.
const CREATIVE_PAGES = ["/admin/upload", "/admin/shoots/demo-s1", "/admin/shoots/demo-s6", "/admin/sops"];
// What a video editor may open: the Video board and Team SOPs.
const VIDEO_PAGES = ["/admin/video", "/admin/sops"];
const QA_DENIED = /\/admin\/photo-qc\?denied=1$/;
const CREATIVE_DENIED = /\/admin\/upload\?denied=1$/;
const VIDEO_DENIED = /\/admin\/video\?denied=1$/;
// The body of a redirect must not stream the page's data (the old layout pitfall).
const LEAK = /Unpaid|Invoice|avery@example\.com|jordan@example\.com|Client visible/;

const main = async () => {
  const admin = await login(ADMIN);
  const qa = await login(QA);
  const creative = await login(CREATIVE);
  const video = await login(VIDEO);
  const client = await login(CLIENT);
  ok(admin.landing?.endsWith("/admin"), `admin lands on /admin (${admin.landing})`);
  ok(qa.landing?.endsWith("/admin"), `QA lands on /admin (${qa.landing})`);
  ok(creative.landing?.endsWith("/admin"), `creative lands on /admin (${creative.landing})`);
  ok(video.landing?.endsWith("/admin"), `video editor lands on /admin (${video.landing})`);
  ok(client.landing?.endsWith("/portal"), `client lands on /portal (${client.landing})`);

  // ---- Pages ------------------------------------------------------------------------
  // Each team role: 200 on its own pages, /admin sends it home (no note), and
  // every other page sends it home with ?denied=1 and an empty body.
  const team = [
    ["QA", qa, STAFF_PAGES, "/admin/photo-qc", QA_DENIED],
    ["creative", creative, CREATIVE_PAGES, "/admin/upload", CREATIVE_DENIED],
    ["video", video, VIDEO_PAGES, "/admin/video", VIDEO_DENIED],
  ];
  for (const p of ["/admin", ...STAFF_PAGES, ...ADMIN_PAGES.filter((x) => !STAFF_PAGES.includes(x))]) {
    const a = await get(p, admin.cookie);
    ok(a.status === 200, `admin ${p} 200 (got ${a.status})`);
    for (const [who, s, pages, home, denied] of team) {
      const r = await get(p, s.cookie);
      const at = r.headers.get("location") || "";
      if (pages.includes(p)) ok(r.status === 200, `${who} ${p} 200 (got ${r.status})`);
      else if (p === "/admin") ok(r.status === 307 && at.endsWith(home), `${who} /admin → ${home} (got ${r.status} ${at})`);
      else ok(r.status === 307 && denied.test(at), `${who} ${p} → ${home}?denied=1 (got ${r.status} ${at})`);
      if (!pages.includes(p)) { const body = await r.text(); ok(!LEAK.test(body) && !MONEY.test(body), `${who} ${p} redirect body carries no data`); }
    }
    const cl = await get(p, client.cookie);
    ok(cl.status === 307 && /\/portal\/login$/.test(cl.headers.get("location") || ""), `client ${p} → /portal/login (got ${cl.status})`);
    const n = await get(p, "");
    ok(n.status === 307, `signed out ${p} redirects (got ${n.status})`);
  }

  // ---- What the QA team's pages leave out (and what they show) ---------------------------
  const text = async (p, ck) => (await get(p, ck)).text();
  const qaListing = await text("/admin/listings/demo-l1", qa.cookie);
  const qaListingHtml = strip(qaListing);
  for (const s of ["Orders and downloads", "Danger zone", "Unlock downloads", "Lock downloads", "View as client", "Send delivery email", "Re-send delivery email", "Edit listing", "Invoices", "Portal id", "Upload a shoot"]) ok(!qaListingHtml.includes(s), `QA listing page has no "${s}"`);
  ok(!MONEY.test(qaListing), "QA listing page carries no dollar amount anywhere (HTML or payload)");
  ok(MONEY.test(await text("/admin/listings/demo-l1", admin.cookie)), "the money check does find the admin's invoice amount (the check works)");
  ok(!qaListing.includes("in_demo123"), "QA listing page carries no invoice id anywhere");
  for (const s of ["Client visible", "Internal only", "Upload photos", "When they land", "Download zips"]) ok(qaListingHtml.includes(s), `QA listing page shows "${s}"`);
  // The Photo QC board is the QA team's home (it replaced the QA dashboard on Oct 26 2026).
  const qaBoard = await text("/admin/photo-qc", qa.cookie);
  for (const s of ["Unpaid bookings", "Pay at close", "Requests to confirm", "Recent deliveries", "Upcoming shoots", "Failed side effects", "Delivered, not yet paid"]) ok(!strip(qaBoard).includes(s), `QA home has no "${s}"`);
  ok(!MONEY.test(qaBoard), "QA home carries no dollar amount");
  ok(strip(qaBoard).includes("Photo QC."), "QA home is the Photo QC board");
  ok(strip(await text("/admin/photo-qc?denied=1", qa.cookie)).includes("That page is not part of Photo QC"), "QA sees the denied note");
  const qaNav = strip(qaBoard);
  for (const s of ["Dashboard", "Shoots", "Listings", "Bookings", "Clients", "Teams", "Downloads", "Settings", "Upload a shoot", "Reports", "Video"]) ok(!new RegExp(`>${s}<`).test(qaNav), `QA nav has no ${s}`);
  ok(/>Photo QC</.test(qaNav) && />Revisions</.test(qaNav) && />Team SOPs</.test(qaNav), "QA nav has Photo QC, Revisions and Team SOPs");
  const qaShoot = strip(await text("/admin/shoots/demo-s4", qa.cookie));
  for (const s of ["Delivery email", "Credits"]) ok(!qaShoot.includes(s), `QA shoot page has no "${s}"`);
  // (There is no per-frame "Make visible" any more: frames go live with Publish and come back with Unpublish.)
  for (const s of ["Client visible", "Internal only", "Unpublish", "Download internal", "Upload corrected photos"]) ok(qaShoot.includes(s), `QA shoot page shows "${s}"`);
  ok(/Publish \d+ approved photo/.test(qaShoot), "QA shoot page has the publish button");

  // ---- What a video editor sees -------------------------------------------------------------
  const vBoardRaw = await text("/admin/video", video.cookie);
  const vBoard = strip(vBoardRaw);
  ok(/>Video</.test(vBoard) && />Team SOPs</.test(vBoard), "video nav has Video and Team SOPs");
  for (const s of ["Dashboard", "Shoots", "Listings", "Bookings", "Clients", "Teams", "Downloads", "Settings", "Upload a shoot", "Reports", "Photo QC", "Revisions"]) ok(!new RegExp(`>${s}<`).test(vBoard), `video nav has no ${s}`);
  ok(!MONEY.test(vBoardRaw), "the Video board carries no dollar amount for a video editor");
  ok(!strip(await text("/admin/shoots/demo-s3", qa.cookie)).includes("Retry step"), "QA failed shoot has no Retry step");
  ok(strip(await text("/admin/shoots/demo-s3", admin.cookie)).includes("Retry step"), "admin failed shoot keeps Retry step");

  // ---- What a creative specialist sees ----------------------------------------------------
  const crUploadRaw = await text("/admin/upload", creative.cookie);
  const crUpload = strip(crUploadRaw);
  ok(/>Upload a shoot</.test(crUpload), "creative nav has Upload a shoot");
  for (const s of ["Dashboard", "Bookings", "Listings", "Clients", "Teams", "Revisions", "Downloads", "Reports", "Settings", "Shoots"]) ok(!new RegExp(`>${s}<`).test(crUpload), `creative nav has no ${s}`);
  ok(crUpload.includes("Creative specialist"), "creative sees the role pill");
  ok(crUpload.includes("Your uploads"), "creative upload page lists their uploads");
  ok(!crUpload.includes("New listing"), "creative upload page has no New listing button");
  ok(!MONEY.test(crUploadRaw), "creative upload page carries no dollar amount");
  ok(/2305 Example Hazel Road|1127 Example Yew Road/.test(crUpload), "creative sees their own uploads listed");
  ok(!/1900 Example Cypress Road/.test(crUpload), "creative does not see a shoot someone else uploaded");
  ok(strip(await text("/admin/upload?denied=1", creative.cookie)).includes("That page is for admins"), "creative sees the denied note on Upload a shoot");
  const crShootRaw = await text("/admin/shoots/demo-s1", creative.cookie);
  const crShoot = strip(crShootRaw);
  ok(crShoot.includes("Your upload") && crShoot.includes("Uploaded by you"), "creative shoot page is the read-only view");
  // ("Published" is a step on the pipeline rail; the publish BUTTON reads "Publish to gallery" or "Publish N waiting".)
  for (const s of ["Publish to gallery", "Client visible", "Internal only", "Download", "Delivery email", "Retry step", "Credits", "Run now", "Run QC", "Upload corrected photos", "View as", "Listing</a>"]) ok(!crShoot.includes(s), `creative shoot page has no "${s}"`);
  ok(!/Publish \d+ waiting/.test(crShoot) && !/adm-frame\b/.test(crShoot), "creative shoot page has no publish button and no frames grid");
  ok(!MONEY.test(crShootRaw), "creative shoot page carries no dollar amount");
  ok(crShoot.includes("Uploaded files"), "creative shoot page lists the uploaded files");
  const adminShoot = strip(await text("/admin/shoots/demo-s1", admin.cookie));
  ok(adminShoot.includes("Run now") && !adminShoot.includes("Uploaded by you"), "the admin still gets the full shoot page for the same shoot");

  // ---- Reports (admin only) ------------------------------------------------------------
  const reportsRaw = await text("/admin/reports", admin.cookie);
  const reports = strip(reportsRaw);
  for (const s of ["Revenue by month", "Bookings by status", "Unpaid invoices", "Revisions per client", "Shoots per shooter", "Clients", "Download CSV", "Stripe card", "Pay at close"]) ok(reports.includes(s), `reports page shows "${s}"`);
  ok(MONEY.test(reportsRaw), "reports page shows money (admin)");
  ok((reports.match(/Download CSV/g) || []).length === 7, "seven CSV links, one per section (Shooter pay included)");
  ok(/>Reports</.test(strip(await text("/admin", admin.cookie))), "admin nav has Reports");

  // ---- Studio routes ---------------------------------------------------------------------
  const call = (path, ck, init = {}) => fetch(`${BASE}${path}`, { redirect: "manual", ...init, headers: { ...(init.headers || {}), ...(ck ? { cookie: ck } : {}) } });
  const post = (path, ck, body) => call(path, ck, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // level: admin (admins only), uploader (admins and creative specialists), staff (admins and the QA team),
  // listing (staff, plus a video editor for films only: a photo is refused, checked below)
  const routes = [
    ["GET", "/api/studio/models", null, "uploader"],
    ["POST", "/api/studio/upload-landed", { shootId: "x" }, "uploader"],
    ["POST", "/api/studio/upload-discard", { shootId: "x" }, "uploader"],
    ["POST", "/api/studio/import-drive", { shootId: "x", files: [] }, "uploader"],
    ["GET", "/api/studio/drive/connect", null, "admin"],
    ["GET", "/api/studio/drive/callback?error=access_denied", null, "admin"],
    ["POST", "/api/studio/upload-urls", { listingId: "demo-l1", files: [] }, "uploader"],
    ["POST", "/api/studio/upload-status", { shootId: "x" }, "uploader"],
    ["POST", "/api/studio/import-dropbox", { shootId: "x", files: [] }, "uploader"],
    ["POST", "/api/studio/shoots/demo-s6/submit", {}, "uploader"],
    ["GET", "/api/studio/reports/revenue?from=2026-01-01&to=2026-12-31", null, "admin"],
    ["GET", "/api/studio/reports/unpaid", null, "admin"],
    // The Dropbox raw mirror (Oct 21 2026): connect and callback are admin session routes (demo mode answers 503 / a redirect past the gate).
    ["GET", "/api/studio/dropbox/connect", null, "admin"],
    ["GET", "/api/studio/dropbox/callback?error=access_denied", null, "admin"],
    ["GET", "/api/studio/shoots/demo-s2/download?scope=internal", null, "staff"],
    ["GET", "/api/studio/shoots/demo-s4/download?replaced=00000000-0000-0000-0000-000000000000", null, "staff"],
    ["GET", "/api/studio/listings/demo-l1/download?scope=internal", null, "staff"],
    ["GET", "/api/studio/shoots/demo-s2/status", null, "staff"],
    ["GET", "/api/studio/shoots/demo-s1/status", null, "staff"],
    ["POST", "/api/studio/shoots/demo-s2/finals/upload-urls", { files: [{ filename: "a.jpg" }] }, "staff"],
    ["POST", "/api/studio/shoots/demo-s2/finals/ingest", { files: ["a.jpg"] }, "staff"],
    ["POST", "/api/studio/listings/demo-l1/upload-urls", { files: [{ filename: "a.jpg" }] }, "listing"],
    ["POST", "/api/studio/listings/demo-l1/ingest", { files: ["a.jpg"] }, "listing"],
    ["GET", "/api/studio/thumb/demo-s2-m1", null, "staff"],
    // Showcase Media only: a plat map file a booking sent (Nov 24 2026), admins only.
    ["GET", "/api/studio/intake-file?key=intake/x/plat.pdf&booking=demo-b1", null, "admin"],
    ["GET", "/api/studio/frame/demo-s2-m1?size=full", null, "staff"],
  ];
  for (const [m, path, body, level] of routes) {
    const go = (ck) => (m === "GET" ? call(path, ck) : post(path, ck, body));
    const [a, q, cr, v, c, n] = [await go(admin.cookie), await go(qa.cookie), await go(creative.cookie), await go(video.cookie), await go(client.cookie), await go("")];
    ok(a.status !== 401 && a.status !== 403, `admin ${m} ${path} passes the gate (got ${a.status})`);
    if (level === "staff" || level === "listing") ok(q.status !== 401 && q.status !== 403, `QA ${m} ${path} passes the gate (got ${q.status})`);
    else ok(q.status === 403, `QA ${m} ${path} 403 (got ${q.status})`);
    if (level === "uploader") ok(cr.status !== 401 && cr.status !== 403, `creative ${m} ${path} passes the gate (got ${cr.status})`);
    else ok(cr.status === 403, `creative ${m} ${path} 403 (got ${cr.status})`);
    // A video editor: 403 everywhere, except the listing routes, where the
    // gate lets a film through and the route refuses this photo (no 2xx).
    if (level === "listing") ok(v.status !== 401 && !(v.status >= 200 && v.status < 300 && /"ok":true/.test(await v.clone().text())), `video ${m} ${path} adds no photo (got ${v.status})`);
    else ok(v.status === 403, `video ${m} ${path} 403 (got ${v.status})`);
    ok(c.status === 401, `client ${m} ${path} 401 (got ${c.status})`);
    ok(n.status === 401, `signed out ${m} ${path} 401 (got ${n.status})`);
  }
  const csv = await call("/api/studio/reports/revenue?from=2026-01-01&to=2026-12-31", admin.cookie);
  ok(csv.status === 200 && /^text\/csv/.test(csv.headers.get("content-type") || ""), `revenue CSV is text/csv (got ${csv.status} ${csv.headers.get("content-type")})`);
  ok(/attachment; filename="studio-revenue-2026-01-01-to-2026-12-31\.csv"/.test(csv.headers.get("content-disposition") || ""), "revenue CSV has its filename");
  // (fetch's text() strips the UTF-8 BOM the route sends, per the WHATWG decode; check the bytes to see it.)
  const csvText = await csv.text();
  ok(csvText.startsWith("Month,Stripe card,Pay at close,Other,Gross,Refunds,Net,Paid invoices\r\n"), "revenue CSV header");
  ok(/\r\nTotal,/.test(csvText), "revenue CSV totals row");
  ok((await call("/api/studio/reports/nope", admin.cookie)).status === 404, "unknown report section is 404");
  for (const s of ["bookings", "unpaid", "revisions", "shooters", "clients"]) {
    const r = await call(`/api/studio/reports/${s}`, admin.cookie);
    ok(r.status === 200 && (await r.text()).length > 20, `${s} CSV downloads`);
  }

  // ---- Server actions, called directly --------------------------------------------------
  if (MANIFEST) {
    // Next 16 keeps an action's exportedName (and filename) on the entry
    // itself; older manifests had it on each worker. The dev server adds an
    // action to the manifest once a page that imports it has compiled, which
    // the page checks above have done for every admin page.
    const man = JSON.parse(readFileSync(MANIFEST, "utf8")).node;
    const ids = {}, files = {};
    for (const [id, v] of Object.entries(man)) {
      const name = v.exportedName ?? Object.values(v.workers ?? {})[0]?.exportedName;
      const file = v.filename ?? Object.values(v.workers ?? {})[0]?.filename ?? "?";
      if (!name) continue;
      (files[name] ??= new Set()).add(file);
      ids[name] = id;
    }
    // Two "use server" files can export the same name: refuse to guess.
    for (const [name, f] of Object.entries(files)) if (f.size > 1) delete ids[name];
    const need = (name) => { if (ids[name]) return true; ok(false, files[name]?.size > 1 ? `action ${name} is exported by ${[...files[name]].join(" and ")}: ambiguous` : `no action id for ${name} in the manifest`); return false; };
    // A FormData argument goes the way React sends one: a multipart body whose
    // field "0" holds the arguments, the form as "$K<n>" and its fields as "<n>_<name>".
    const encode = (args) => {
      if (!args.some((a) => a instanceof FormData)) return { body: JSON.stringify(args), type: { "Content-Type": "text/plain;charset=UTF-8" } };
      const fd = new FormData();
      let n = 0;
      const outer = args.map((a) => { if (!(a instanceof FormData)) return a; n++; for (const [k, v] of a) fd.append(`${n}_${k}`, v); return `$K${n}`; });
      fd.append("0", JSON.stringify(outer));
      return { body: fd, type: {} };
    };
    const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
    const act = async (name, args, ck, page = "/admin/listings/demo-l1") => {
      const { body, type } = encode(args);
      const r = await fetch(`${BASE}${page}`, { method: "POST", redirect: "manual", headers: { "Next-Action": ids[name], ...type, Accept: "text/x-component", Origin: BASE, cookie: ck }, body });
      const redirect = r.headers.get("x-action-redirect") || r.headers.get("location") || "";
      return { status: r.status, redirect, setCookie: (r.headers.getSetCookie?.() ?? []).join(" "), body: await r.text() };
    };
    const qaDenied = (x) => x.redirect.includes("/admin/photo-qc?denied=1");
    const crDenied = (x) => x.redirect.includes("/admin/upload?denied=1");
    const vDenied = (x) => x.redirect.includes("/admin/video?denied=1");
    // An assert-style gate throws: the dev server answers 500, or 200 with the
    // error row in the payload (1:E{...}); both mean the action never ran.
    const threw = (x) => x.status >= 500 || /\n1:E\{/.test(x.body) || /"message":"admin only"/.test(x.body);
    const ADMIN_ONLY = [
      ["setLock", ["demo-l1", false]], ["sendDeliveryEmail", ["demo-l1"]], ["retryShoot", ["demo-s3"]],
      ["createClient", [{}]], ["createClientInline", [{ email: "x@example.com" }]], ["createListingInline", [{ clientId: "demo-c1", address: "1 Test St" }]],
      ["confirmTime", ["demo-b1", {}]], ["assignShooter", ["demo-b1", {}]], ["setBookingStatus", ["demo-b1", {}]], ["setInvoiceAmount", ["demo-inv", {}]], ["switchToCard", ["demo-inv"]], ["resendPayLink", ["demo-inv"]], ["markPaid", ["demo-inv", {}]], ["cancelBooking", ["demo-b1", {}]], ["runJob", ["demo-job"]],
      ["updateClient", ["demo-c1", {}]], ["deleteClient", ["demo-c1"]], ["sendClientSignInLink", ["demo-c1"]], ["createTeam", [{}]], ["updateTeam", ["coastal-living", {}]], ["deleteTeam", ["coastal-living"]], ["addTeamMember", ["coastal-living", {}]], ["removeTeamMember", ["coastal-living", "demo-c2"]],
      ["updateListing", ["demo-l1", {}]], ["deleteListing", ["demo-l1", {}]], ["addAdmin", [{}]], ["setAdminRole", ["x@example.com", {}]], ["removeAdmin", ["x@example.com"]], ["portalCounts", []],
      // The Dropbox raw mirror (Oct 21 2026).
      ["disconnectDropbox", []], ["mirrorShootAgain", ["demo-s1"]],
      // The Google Drive mirror, deleting frames, merging shoots, visits, editing a booking, photographers, Slack QC tags, adding or removing a Video card.
      ["disconnectDrive", []], ["driveShootAgain", ["demo-s1"]], ["deleteShootFrames", [{ shootId: "demo-s2", ids: ["demo-s2-m1"] }]], ["mergeShootInto", ["demo-s1", "demo-s2", {}]],
      ["addVisit", ["demo-b1", {}]], ["updateVisit", ["demo-v1", "demo-b1", {}]], ["markVisitDone", ["demo-v1", "demo-b1"]], ["cancelVisit", ["demo-v1", "demo-b1"]], ["createVisitInvoiceForVisit", ["demo-v1", "demo-b1", {}]],
      // (Showcase Media's studio has no photographer roster, so the template's four photographer actions are not here.)
      ["editBooking", ["demo-b1", {}]], ["saveSlackQcTags", [{}]],
      ["addVideoCard", [{}]], ["removeVideoCard", ["demo-v1"]],
    ];
    for (const [name, args] of ADMIN_ONLY) {
      if (!need(name)) continue;
      const q = await act(name, args, qa.cookie);
      ok(qaDenied(q), `QA action ${name} → denied (got ${q.status} ${q.redirect})`);
      const cr = await act(name, args, creative.cookie, "/admin/upload");
      ok(crDenied(cr) || threw(cr), `creative action ${name} → denied (got ${cr.status} ${cr.redirect})`);
      const v = await act(name, args, video.cookie, "/admin/video");
      ok(vDenied(v) || threw(v), `video action ${name} → denied (got ${v.status} ${v.redirect})`);
      const c = await act(name, args, client.cookie);
      ok(c.redirect.includes("/portal/login"), `client action ${name} → login (got ${c.status} ${c.redirect})`);
    }
    // assert-style admin gates throw instead of redirecting.
    for (const [name, args, page] of [["enterViewAs", ["avery@example.com"]], ["exitViewAs", []], ["searchClients", [""]], ["listingsForClient", ["demo-c1"]]]) {
      const q = await act(name, args, qa.cookie, page);
      ok(threw(q) || qaDenied(q), `QA action ${name} refused (got ${q.status} ${q.redirect})`);
      ok(!/studio_portal_view_as/.test(q.setCookie), `QA action ${name} sets no view-as cookie`);
      const cr = await act(name, args, creative.cookie, "/admin/upload");
      ok(threw(cr) || crDenied(cr), `creative action ${name} refused (got ${cr.status} ${cr.redirect})`);
      ok(!/studio_portal_view_as/.test(cr.setCookie), `creative action ${name} sets no view-as cookie`);
      const v = await act(name, args, video.cookie, "/admin/video");
      ok(threw(v) || vDenied(v), `video action ${name} refused (got ${v.status} ${v.redirect})`);
      ok(!/studio_portal_view_as/.test(v.setCookie), `video action ${name} sets no view-as cookie`);
    }
    // The listing picker: admins and creative specialists, not the QA team.
    const pickQa = await act("pickListings", [""], qa.cookie, "/admin/upload");
    ok(threw(pickQa) || qaDenied(pickQa), `QA action pickListings refused (got ${pickQa.status})`);
    const pickV = await act("pickListings", [""], video.cookie, "/admin/upload");
    ok(threw(pickV) || vDenied(pickV), `video action pickListings refused (got ${pickV.status})`);
    const pickCr = await act("pickListings", [""], creative.cookie, "/admin/upload");
    ok(pickCr.status === 200 && !crDenied(pickCr) && /Alder Drive/.test(pickCr.body), `creative action pickListings returns listings (got ${pickCr.status})`);
    ok(!MONEY.test(pickCr.body), "the listing picker carries no money");
    const pickAdmin = await act("pickListings", [""], admin.cookie, "/admin/upload");
    ok(pickAdmin.status === 200 && /Alder Drive/.test(pickAdmin.body), "admin action pickListings returns listings");
    // Open to the QA team: the gate passes (demo mode then returns early). Closed to a creative specialist and a video editor.
    const STAFF_OK = [
      ["setMediaVisibility", [{ listingId: "demo-l1", ids: ["x"], to: "internal" }]],
      ["setCover", ["demo-l1", "listings/demo/photos/x.jpg"]], ["setFrameQc", ["demo-s2", ["demo-s2-m1"], "approved"]], ["approveAllFrames", ["demo-s2"]], ["publishShootFrames", [{ shootId: "demo-s2", ids: ["demo-s2-m1"] }]], ["runShootNow", ["demo-s1"]], ["rerunQc", ["demo-s2"]], ["approvePendingForListing", ["demo-l1"]],
      ["rebuildBundles", ["demo-l1"]], ["updateMediaInline", ["x", {}]], ["reorderMedia", ["demo-l1", ["a", "b"]]], ["bulkMediaInline", ["demo-l1", {}]],
      ["makeFrameTwilight", ["demo-s2-m1"]],
      // The Photo QC team works the photo revisions, the automatic QC flags and the board's status bar (Oct 26 to Nov 6 2026).
      ["setRevisionStatus", ["demo-r1", "done"]], ["setRevisionKind", ["demo-r1", "photo"]], ["markRevisionsDone", [["demo-r1"], "/admin/revisions"]],
      ["setQcFixDone", [{ shootId: "demo-s2", mediaId: "demo-s2-m1", fixKey: "x", done: true }]], ["setPhotoQcStatus", [{ key: "demo-s2", shootId: "demo-s2" }, "review"]],
    ];
    for (const [name, args] of STAFF_OK) {
      if (!need(name)) continue;
      const q = await act(name, args, qa.cookie);
      ok(!qaDenied(q) && !q.redirect.includes("/portal/login") && q.status < 500, `QA action ${name} passes the gate (got ${q.status} ${q.redirect})`);
      const cr = await act(name, args, creative.cookie, "/admin/upload");
      ok(crDenied(cr) || threw(cr), `creative action ${name} refused (got ${cr.status} ${cr.redirect})`);
      const v = await act(name, args, video.cookie, "/admin/video");
      ok(vDenied(v) || threw(v), `video action ${name} refused (got ${v.status} ${v.redirect})`);
      const c = await act(name, args, client.cookie);
      ok(c.redirect.includes("/portal/login"), `client action ${name} → login (got ${c.status} ${c.redirect})`);
    }
    // Publishing is publishShootFrames since Nov 2 2026 (approved frames only); demo mode answers without saving.
    const pub = await act("publishShootFrames", [{ shootId: "demo-s2", ids: ["demo-s2-m1"] }], qa.cookie);
    ok(pub.status === 200 && /"demo":true/.test(pub.body), `QA publish (demo) reaches the action and saves nothing (got ${pub.status})`);
    // The Video board: admins and video editors. Closed to the QA team and a creative specialist.
    const VIDEO_OK = [["moveVideoCard", ["demo-v1", "editing"]], ["moveVideoCardForm", ["demo-v1", "editing"]], ["assignVideoCard", ["demo-v1", form({ assignee: "" })]], ["saveVideoEditorNotes", ["demo-v1", form({ notes: "x" })]], ["saveClientVideoNotes", ["demo-v1", form({ videoNotes: "x" })]]];
    for (const [name, args] of VIDEO_OK) {
      if (!need(name)) continue;
      const v = await act(name, args, video.cookie, "/admin/video");
      ok(!vDenied(v) && !v.redirect.includes("/portal/login") && v.status < 500, `video action ${name} passes the gate (got ${v.status} ${v.redirect})`);
      const q = await act(name, args, qa.cookie, "/admin/video");
      ok(qaDenied(q) || threw(q), `QA action ${name} refused (got ${q.status} ${q.redirect})`);
      const cr = await act(name, args, creative.cookie, "/admin/video");
      ok(crDenied(cr) || threw(cr), `creative action ${name} refused (got ${cr.status} ${cr.redirect})`);
      const c = await act(name, args, client.cookie, "/admin/video");
      ok(c.redirect.includes("/portal/login") || threw(c), `client action ${name} refused (got ${c.status} ${c.redirect})`);
    }
    const adm = await act("setLock", ["demo-l1", false], admin.cookie);
    ok(!qaDenied(adm) && adm.status < 500, `admin setLock passes (got ${adm.status} ${adm.redirect})`);
  } else {
    console.log("(no manifest given: server actions not checked)");
  }

  console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nAll ${passes} HTTP checks passed`);
  process.exit(fails ? 1 : 0);
};
main().catch((e) => { console.error(e); process.exit(1); });
