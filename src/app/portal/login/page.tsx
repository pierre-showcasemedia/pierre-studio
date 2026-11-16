import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Reveal from "@/components/Reveal";
import { sessionEmail } from "@/lib/portal-auth";
import { brand, supportEmail } from "@/lib/brand";
import LoginForm from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false },
  openGraph: {
    siteName: `${brand.name}`,
    title: `Client portal | ${brand.name}`,
    description: "Sign in with your email to view and download your listing media.",
    type: "website",
    locale: "en_US",
  },
};

export default async function PortalLoginPage() {
  if (await sessionEmail()) redirect("/portal");
  return (
    <>
      <Nav />
      <main>
        <section className="section" style={{ minHeight: "62vh" }}>
          <div className="wrap" style={{ maxWidth: 560, textAlign: "center" }}>
            <Reveal>
              <div className="kicker" style={{ marginBottom: 16 }}>Client portal</div>
              <h1 className="h2">Your listings, your media.</h1>
              <p className="muted" style={{ marginTop: 18, fontSize: 15.5, lineHeight: 1.7 }}>
                Enter the email your invoices go to and we&rsquo;ll send you a sign-in link.
                No password to remember.
              </p>
              <LoginForm supportEmail={supportEmail()} />
            </Reveal>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
