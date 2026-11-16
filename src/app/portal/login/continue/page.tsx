// The click-through behind the sign-in link (Nov 5 2026).
//
// GET /api/portal/verify?token= sends a one-time login token here instead of
// spending it. This page only peeks at the token (valid, used, expired) and
// shows one button; pressing it POSTs the token back to /api/portal/verify,
// which is the only place a login token is consumed and a session made. Mail
// security at a client's brokerage (Microsoft 365, Nov 5
// 2026) opens every link in an email before the person does; it follows a
// link but never presses a button, so the link is still fresh when they tap.
// A link that is already used or expired goes to the sign-in page with the
// plain note, exactly as before. Under /portal/login/ so the sign-in proxy
// lets it through without a session.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Reveal from "@/components/Reveal";
import { peekLoginToken } from "@/lib/login-tokens";

export const metadata: Metadata = {
  title: "Continue to your portal",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ContinuePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const clean = token.trim();
  const state = await peekLoginToken(clean);
  if (state !== "valid") redirect(`/portal/login?error=${state === "used" ? "used" : "expired"}`);
  return (
    <>
      <Nav />
      <main>
        <section className="section" style={{ minHeight: "62vh" }}>
          <div className="wrap" style={{ maxWidth: 560, textAlign: "center" }}>
            <Reveal>
              <div className="kicker" style={{ marginBottom: 16 }}>Client portal</div>
              <h1 className="h2">One tap and you&rsquo;re in.</h1>
              <p className="muted" style={{ marginTop: 18, fontSize: 15.5, lineHeight: 1.7 }}>
                Your sign-in link brought you here. Press the button to open your portal.
                Nothing is used up until you do, so the link stays good even if your email
                opened it on the way to you.
              </p>
              <form method="post" action="/api/portal/verify" style={{ marginTop: 34 }}>
                <input type="hidden" name="token" value={clean} />
                <button type="submit" className="btn btn-primary">Continue to your portal &rarr;</button>
              </form>
            </Reveal>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
