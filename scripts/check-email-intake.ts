// Checks for the hello@ email intake (Oct 27 2026, src/lib/email-intake.ts):
// reading a Gmail message (sender, subject, the client's own words above the
// quoted history, photo attachments) and which mail is never read as a
// request (our own, automated, lists, calendar responses, before go-live).
//
//   npx tsx scripts/check-email-intake.ts
//
// No database, no network: refuses to run with DATABASE_URL set.
if (process.env.DATABASE_URL) {
  console.error("Refusing to run with DATABASE_URL set: this check is offline only.");
  process.exit(2);
}
export {};

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function main() {
  const { GO_LIVE, bodyText, htmlToText, parseFrom, parseMessage, skipReason, splitReply } = await import("../src/lib/email-intake");
  const { emailFrom, mailDomain } = await import("../src/lib/brand");
  type Msg = Parameters<typeof parseMessage>[0];
  const at = String(GO_LIVE + 3 * 3600_000);

  // ---- the sender ----
  ok(parseFrom(`"Jane Doe" <Jane.Doe@Example.com>`).email === "jane.doe@example.com", "angle address lower-cased");
  ok(parseFrom(`"Jane Doe" <Jane.Doe@Example.com>`).name === "Jane Doe", "display name without quotes");
  ok(parseFrom("agent@realty.com").email === "agent@realty.com" && parseFrom("agent@realty.com").name === null, "bare address, no name");
  ok(parseFrom(undefined).email === null, "no From header");

  // ---- the client's words vs the quoted history ----
  const gmailReply = [
    "Hi! Can you brighten the kitchen photos and remove the trash cans out front?",
    "",
    "Thanks,",
    "Jane",
    "",
    "On Tue, Oct 27, 2026 at 9:14 AM Studio Name <",
    "portal@example.com> wrote:",
    "",
    "> Your photos for 123 Juniper Dr are ready.",
    "> Open your gallery here.",
  ].join("\n");
  const g = splitReply(gmailReply);
  ok(g.fresh.startsWith("Hi! Can you brighten") && g.fresh.endsWith("Jane"), `Gmail reply: fresh is the client's words (got ${JSON.stringify(g.fresh)})`);
  ok(!g.fresh.includes("wrote:") && !g.fresh.includes("123 Juniper"), "Gmail reply: quoted history not in fresh");
  ok(g.quoted.includes("123 Juniper Dr") && !/^>/m.test(g.quoted), "Gmail reply: quoted kept without > marks");

  const apple = splitReply("Darker twilights please\n\nSent from my iPhone\n\nOn Oct 27, 2026, at 9:14 AM, Studio Name <hello@example.com> wrote:\n\n> Here are the photos for 55 Ocean Ave");
  ok(apple.fresh === "Darker twilights please", `Apple Mail: footer and quote dropped (got ${JSON.stringify(apple.fresh)})`);
  ok(apple.quoted.includes("55 Ocean Ave"), "Apple Mail: quoted names the listing");

  const outlook = splitReply("Please swap photo 12 for a vertical.\n\nFrom: Studio Name <portal@example.com>\nSent: Monday, October 26, 2026 4:02 PM\nTo: Jane\nSubject: Your photos are ready\n\nGallery for 9 Mesa Ln");
  ok(outlook.fresh === "Please swap photo 12 for a vertical.", `Outlook: header block cut (got ${JSON.stringify(outlook.fresh)})`);
  ok(outlook.quoted.includes("9 Mesa Ln"), "Outlook: quoted kept");

  const sig = splitReply("Can we redo the drone shot?\n-- \nJane Doe | Realtor | 555-010-0100");
  ok(sig.fresh === "Can we redo the drone shot?", "signature after -- dropped");
  const plain = splitReply("Just a new email, no history.");
  ok(plain.fresh === "Just a new email, no history." && plain.quoted === "", "no history: everything is fresh");

  // ---- HTML only ----
  ok(htmlToText("<div>Brighten the <b>kitchen</b></div><div>Thanks &amp; regards<br>Jane</div><style>.x{}</style>") === "Brighten the kitchen\nThanks & regards\nJane", "HTML to text");
  const htmlOnly: Msg["payload"] = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>Warmer please</p><div class=\"gmail_quote\">On Mon, Oct 26, 2026 at 1:00 PM Studio wrote:<blockquote>old</blockquote></div>") } }] };
  ok(splitReply(bodyText(htmlOnly)).fresh === "Warmer please", "HTML only: fresh above the quote");
  const both: Msg["payload"] = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("plain wins") } }, { mimeType: "text/html", body: { data: b64("<p>html</p>") } }] };
  ok(bodyText(both) === "plain wins", "text/plain preferred over HTML");

  // ---- a whole message ----
  const msg: Msg = {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    internalDate: at,
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Jane Doe <jane@realty.com>" },
        { name: "To", value: "hello@example.com" },
        { name: "Subject", value: "Re: Your photos are ready: 123 Juniper Dr" },
      ],
      parts: [
        { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64(gmailReply) } }] },
        { mimeType: "image/jpeg", filename: "kitchen.jpg", body: { size: 240_000, attachmentId: "att-big" } },
        { mimeType: "image/png", filename: "logo.png", body: { size: 4_000, attachmentId: "att-logo" } },
        { mimeType: "application/pdf", filename: "notes.pdf", body: { size: 90_000, attachmentId: "att-pdf" } },
      ],
    },
  };
  const e = parseMessage(msg);
  ok(e.fromEmail === "jane@realty.com" && e.fromName === "Jane Doe" && e.to === "hello@example.com", "message: sender and recipient");
  ok(e.subject === "Re: Your photos are ready: 123 Juniper Dr", "message: subject");
  ok(e.fresh.startsWith("Hi! Can you brighten") && e.quoted.includes("123 Juniper Dr"), "message: fresh and quoted");
  ok(e.images.length === 1 && e.images[0].url === "gmail:m1/att-big" && e.images[0].type === "image/jpeg", "message: the photo kept, logo and PDF not");
  ok(e.at.getTime() === Number(at), "message: time from internalDate");
  ok(skipReason(e, { self: "hello@example.com" }) === null, "a client's reply is read");

  // ---- what is never read as a request ----
  const like = (over: Partial<ReturnType<typeof parseMessage>>) => ({ ...e, headers: { ...e.headers }, ...over });
  const self = { self: "hello@example.com" };
  ok(skipReason(like({ at: new Date(GO_LIVE - 60_000) }), self) === "before the email intake went live", "before go-live");
  ok(skipReason(like({ fromEmail: emailFrom().match(/<([^>]+)>/)?.[1] ?? "" }), self) === "our own mail", "the sending address is ours");
  ok(skipReason(like({ fromEmail: `owner@${mailDomain()}` }), self) === "our own mail", "the business domain is ours");
  ok(skipReason(like({ fromEmail: "hello@example.com" }), self) === "our own mail", "hello@ itself");
  ok(skipReason(like({ fromEmail: null }), self) === "no sender", "no sender");
  ok(skipReason(like({ labels: ["INBOX", "CATEGORY_PROMOTIONS"] }), self) === "Gmail promotions", "Promotions tab");
  ok(skipReason(like({ fromEmail: "no-reply@stripe.com" }), self) === "automated sender", "no-reply");
  ok(skipReason(like({ fromEmail: "notifications@zillow.com" }), self) === "automated sender", "notifications@");
  ok(skipReason(like({ fromEmail: "mailer-daemon@googlemail.com" }), self) === "automated sender", "bounce");
  ok(skipReason(like({ headers: { ...e.headers, "auto-submitted": "auto-replied" } }), self) === "auto-reply", "Auto-Submitted");
  ok(skipReason(like({ headers: { ...e.headers, "auto-submitted": "no" } }), self) === null, "Auto-Submitted: no is a person");
  ok(skipReason(like({ subject: "Out of Office: back Monday" }), self) === "auto-reply", "out of office subject");
  ok(skipReason(like({ headers: { ...e.headers, "list-unsubscribe": "<mailto:x>" } }), self) === "mailing list", "List-Unsubscribe");
  ok(skipReason(like({ headers: { ...e.headers, precedence: "bulk" } }), self) === "bulk mail", "Precedence bulk");
  ok(skipReason(like({ subject: "Accepted: 123 Juniper Dr - Jane / Photos @ Tue Oct 27" }), self) === "calendar response", "calendar accept");
  ok(skipReason(like({ hasCalendar: true }), self) === "calendar response", "text/calendar part");
  ok(skipReason(like({ fresh: "", images: [], subject: "" }), self) === "empty", "empty");
  ok(skipReason(like({ fromEmail: "info@realtyone.com" }), self) === null, "info@ at a brokerage is read");

  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
