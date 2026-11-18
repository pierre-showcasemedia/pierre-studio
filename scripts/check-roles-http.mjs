// Role gating over HTTP against a local demo-mode dev server (no database).
//
//   ADMIN_EMAILS=demo@example.com npx next dev -p 3171      # in one shell, no DATABASE_URL
//   node scripts/check-roles-http.mjs http://localhost:3171 .next/dev/server/server-reference-manifest.json
//
// Signs in as the demo admin, the demo QA login (qa@example.com), the demo
// creative specialist (shooter@example.com) and a demo client, then checks
// every admin page, the studio routes, the reports CSV and the server actions
// (called directly with the Next-Action header, the way a crafted request
// would). The manifest argument is optional; without it the actions are
// skipped. The static counterpart is scripts/check-qa-role.ts.
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:3171";
const MANIFEST = process.argv[3];
const ADMIN = process.env.CHECK_ADMIN_EMAIL || "demo@example.com";
const QA = "qa@example.com";
const CREATIVE = "shooter@example.com";
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

// The QA team works from Photo QC and Revisions, and opens single shoots and
// listings from there (Oct 26 2026: the dashboard and the two lists are admin only).
const STAFF_PAGES = ["/admin/photo-qc", "/admin/revisions", "/admin/shoots/demo-s2", "/admin/shoots/demo-s4", "/admin/shoots/demo-s3", "/admin/listings/demo-l1", "/admin/listings/demo-l4"];
const ADMIN_PAGES = ["/admin", "/admin/shoots", "/admin/listings", "/admin/upload", "/admin/bookings", "/admin/bookings/demo-b1", "/admin/clients", "/admin/clients/demo-c1", "/admin/teams", "/admin/teams/coastal-living", "/admin/downloads", "/admin/settings", "/admin/listings/new", "/admin/listings/demo-l1/delivery-email", "/admin/reports", "/admin/reports?from=2026-01-01&to=2026-12-31"];
// What a creative specialist may open: Upload a shoot and their own uploads
// (demo-s1 and demo-s6 in the demo data).
const CREATIVE_PAGES = ["/admin/upload", "/admin/shoots/demo-s1", "/admin/shoots/demo-s6"];
const QA_DENIED = /\/admin\/photo-qc\?denied=1$/;
const CREATIVE_DENIED = /\/admin\/upload\?denied=1$/;

const main = async () => {
  const admin = await login(ADMIN);
  const qa = await login(QA);
  const creative = await login(CREATIVE);
  const client = await login(CLIENT);
  ok(admin.landing?.endsWith("/admin"), `admin lands on /admin (${admin.landing})`);
  ok(qa.landing?.endsWith("/admin"), `QA lands on /admin (${qa.landing})`);
  ok(creative.landing?.endsWith("/admin"), `creative lands on /admin (${creative.landing})`);
  ok(client.landing?.endsWith("/portal"), `client lands on /portal (${client.landing})`);

  // ---- Pages ------------------------------------------------------------------------
  for (const p of [...STAFF_PAGES, ...ADMIN_PAGES, "/admin/shoots/demo-s1", "/admin/shoots/demo-s6"]) {
    const a = await get(p, admin.cookie);
    ok(a.status === 200, `admin ${p} 200 (got ${a.status})`);
    const staffPage = STAFF_PAGES.includes(p) || /^\/admin\/shoots\/demo-s[16]$/.test(p);
    const q = await get(p, qa.cookie);
    if (staffPage) ok(q.status === 200, `QA ${p} 200 (got ${q.status})`);
    else if (p === "/admin") ok(q.status === 307 && /\/admin\/photo-qc$/.test(q.headers.get("location") || ""), `QA /admin → /admin/photo-qc (got ${q.status} ${q.headers.get("location")})`);
    else ok(q.status === 307 && QA_DENIED.test(q.headers.get("location") || ""), `QA ${p} → /admin/photo-qc?denied=1 (got ${q.status} ${q.headers.get("location")})`);
    // A 307 must not stream the page's data in its body (the old layout pitfall).
    if (!staffPage) { const body = await q.text(); ok(!/Unpaid|Invoice|avery@example\.com|jordan@example\.com/.test(body) && !MONEY.test(body), `QA ${p} redirect body carries no data`); }
    const c = await get(p, creative.cookie);
    if (CREATIVE_PAGES.includes(p)) ok(c.status === 200, `creative ${p} 200 (got ${c.status})`);
    else if (p === "/admin") ok(c.status === 307 && /\/admin\/upload$/.test(c.headers.get("location") || ""), `creative /admin → /admin/upload (got ${c.status} ${c.headers.get("location")})`);
    else ok(c.status === 307 && CREATIVE_DENIED.test(c.headers.get("location") || ""), `creative ${p} → /admin/upload?denied=1 (got ${c.status} ${c.headers.get("location")})`);
    if (!CREATIVE_PAGES.includes(p)) { const body = await c.text(); ok(!/Unpaid|Invoice|avery@example\.com|jordan@example\.com|Client visible/.test(body) && !MONEY.test(body), `creative ${p} redirect body carries no data`); }
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
  const qaDash = await text("/admin/photo-qc", qa.cookie);
  for (const s of ["Unpaid bookings", "Pay at close", "Requests to confirm", "Recent deliveries", "Upcoming shoots", "Failed side effects", "Delivered, not yet paid"]) ok(!strip(qaDash).includes(s), `QA dashboard has no "${s}"`);
  ok(!MONEY.test(qaDash), "QA dashboard carries no dollar amount");
  ok(/>Photo QC</.test(strip(qaDash)), "QA lands on the Photo QC board");
  ok(strip(await text("/admin/photo-qc?denied=1", qa.cookie)).includes("That page is not part of Photo QC"), "QA sees the denied note");
  const qaNav = strip(qaDash);
  for (const s of ["Dashboard", "Bookings", "Listings", "Clients", "Teams", "Downloads", "Settings", "Upload a shoot", "Reports"]) ok(!new RegExp(`>${s}<`).test(qaNav), `QA nav has no ${s}`);
  ok(/>Photo QC</.test(qaNav) && />Revisions</.test(qaNav), "QA nav has Photo QC and Revisions");
  const qaShoot = strip(await text("/admin/shoots/demo-s4", qa.cookie));
  for (const s of ["Delivery email", "Credits"]) ok(!qaShoot.includes(s), `QA shoot page has no "${s}"`);
  // "Make client visible" only renders once a photo is opened, so it is not in this HTML;
  // the setMediaVisibility action check below covers it.
  for (const s of ["Client visible", "Internal only", "Download internal", "Upload corrected photos"]) ok(qaShoot.includes(s), `QA shoot page shows "${s}"`);
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
  ok(/2305 Hazel Road|1127 Yew Road/.test(crUpload), "creative sees their own uploads listed");
  ok(!/1900 Cypress Road/.test(crUpload), "creative does not see a shoot someone else uploaded");
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
  // level: admin (admins only), uploader (admins and creative specialists), staff (admins and the QA team)
  const routes = [
    ["GET", "/api/studio/models", null, "uploader"],
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
    ["POST", "/api/studio/listings/demo-l1/upload-urls", { files: [{ filename: "a.jpg" }] }, "staff"],
    ["POST", "/api/studio/listings/demo-l1/ingest", { files: ["a.jpg"] }, "staff"],
    ["GET", "/api/studio/thumb/demo-s2-m1", null, "staff"],
    ["GET", "/api/studio/frame/demo-s2-m1?size=full", null, "staff"],
  ];
  for (const [m, path, body, level] of routes) {
    const go = (ck) => (m === "GET" ? call(path, ck) : post(path, ck, body));
    const [a, q, cr, c, n] = [await go(admin.cookie), await go(qa.cookie), await go(creative.cookie), await go(client.cookie), await go("")];
    ok(a.status !== 401 && a.status !== 403, `admin ${m} ${path} passes the gate (got ${a.status})`);
    if (level === "staff") ok(q.status !== 401 && q.status !== 403, `QA ${m} ${path} passes the gate (got ${q.status})`);
    else ok(q.status === 403, `QA ${m} ${path} 403 (got ${q.status})`);
    if (level === "uploader") ok(cr.status !== 401 && cr.status !== 403, `creative ${m} ${path} passes the gate (got ${cr.status})`);
    else ok(cr.status === 403, `creative ${m} ${path} 403 (got ${cr.status})`);
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
    const man = JSON.parse(readFileSync(MANIFEST, "utf8")).node;
    const ids = {};
    // Next 16.4 keeps exportedName on the entry; older versions kept it on each worker.
    for (const [id, v] of Object.entries(man)) ids[v.exportedName ?? Object.values(v.workers)[0].exportedName] = id;
    const act = async (name, args, ck, page = "/admin/listings/demo-l1") => {
      const r = await fetch(`${BASE}${page}`, { method: "POST", redirect: "manual", headers: { "Next-Action": ids[name], "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: BASE, cookie: ck }, body: JSON.stringify(args) });
      const redirect = r.headers.get("x-action-redirect") || r.headers.get("location") || "";
      return { status: r.status, redirect, setCookie: (r.headers.getSetCookie?.() ?? []).join(" "), body: await r.text() };
    };
    const qaDenied = (x) => x.redirect.includes("/admin/photo-qc?denied=1");
    const crDenied = (x) => x.redirect.includes("/admin/upload?denied=1");
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
    ];
    for (const [name, args] of ADMIN_ONLY) {
      if (!ids[name]) { ok(false, `no action id for ${name}`); continue; }
      const q = await act(name, args, qa.cookie);
      ok(qaDenied(q), `QA action ${name} → denied (got ${q.status} ${q.redirect})`);
      const cr = await act(name, args, creative.cookie, "/admin/upload");
      ok(crDenied(cr) || threw(cr), `creative action ${name} → denied (got ${cr.status} ${cr.redirect})`);
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
    }
    // The listing picker: admins and creative specialists, not the QA team.
    const pickQa = await act("pickListings", [""], qa.cookie, "/admin/upload");
    ok(threw(pickQa) || qaDenied(pickQa), `QA action pickListings refused (got ${pickQa.status})`);
    const pickCr = await act("pickListings", [""], creative.cookie, "/admin/upload");
    ok(pickCr.status === 200 && !crDenied(pickCr) && /Alder Drive/.test(pickCr.body), `creative action pickListings returns listings (got ${pickCr.status})`);
    ok(!MONEY.test(pickCr.body), "the listing picker carries no money");
    const pickAdmin = await act("pickListings", [""], admin.cookie, "/admin/upload");
    ok(pickAdmin.status === 200 && /Alder Drive/.test(pickAdmin.body), "admin action pickListings returns listings");
    // Open to the QA team: the gate passes (demo mode then returns early). Closed to a creative specialist.
    const STAFF_OK = [
      ["setMediaVisibility", [{ listingId: "demo-l1", ids: ["x"], to: "internal" }]],
      ["setCover", ["demo-l1", "listings/demo/photos/x.jpg"]], ["setFrameQc", ["demo-s2", ["demo-s2-m1"], "approved"]], ["approveAllFrames", ["demo-s2"]], ["publishShootFrames", [{ shootId: "demo-s2", ids: ["demo-s2-m1"] }]], ["setRevisionStatus", ["demo-r1", "done"]], ["runShootNow", ["demo-s1"]], ["rerunQc", ["demo-s2"]], ["approvePendingForListing", ["demo-l1"]],
      ["rebuildBundles", ["demo-l1"]], ["updateMediaInline", ["x", {}]], ["reorderMedia", ["demo-l1", ["a", "b"]]], ["bulkMediaInline", ["demo-l1", {}]],
      ["makeFrameTwilight", ["demo-s2-m1"]],
    ];
    for (const [name, args] of STAFF_OK) {
      if (!ids[name]) { ok(false, `no action id for ${name}`); continue; }
      const q = await act(name, args, qa.cookie);
      ok(!qaDenied(q) && !q.redirect.includes("/portal/login") && q.status < 500, `QA action ${name} passes the gate (got ${q.status} ${q.redirect})`);
      const cr = await act(name, args, creative.cookie, "/admin/upload");
      ok(crDenied(cr) || threw(cr), `creative action ${name} refused (got ${cr.status} ${cr.redirect})`);
      const c = await act(name, args, client.cookie);
      ok(c.redirect.includes("/portal/login"), `client action ${name} → login (got ${c.status} ${c.redirect})`);
    }
    // Publish answers in place now (no redirect); in demo mode it saves nothing and says so.
    const pub = await act("publishShootFrames", [{ shootId: "demo-s2", ids: ["demo-s2-m1"] }], qa.cookie);
    ok(pub.status === 200 && !pub.redirect && /Demo mode/.test(pub.body), `QA publish (demo) answers in place (got ${pub.status} ${pub.redirect})`);
    const adm = await act("setLock", ["demo-l1", false], admin.cookie);
    ok(!qaDenied(adm) && adm.status < 500, `admin setLock passes (got ${adm.status} ${adm.redirect})`);
  } else {
    console.log("(no manifest given: server actions not checked)");
  }

  console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nAll ${passes} HTTP checks passed`);
  process.exit(fails ? 1 : 0);
};
main().catch((e) => { console.error(e); process.exit(1); });
