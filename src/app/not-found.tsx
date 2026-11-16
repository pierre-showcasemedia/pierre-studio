import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <Nav />
      <main>
        <section className="section" style={{ textAlign: "center", minHeight: "60vh", display: "flex", alignItems: "center" }}>
          <div className="wrap">
            <div className="kicker" style={{ marginBottom: 18 }}>Page not found</div>
            <h1 className="h1" style={{ maxWidth: "18ch", margin: "0 auto" }}>We could not find that page.</h1>
            <p className="muted" style={{ marginTop: 20, maxWidth: "44ch", marginLeft: "auto", marginRight: "auto", fontSize: 15.5 }}>
              The link may have expired or moved. Your galleries are all in your client portal.
            </p>
            <div style={{ marginTop: 32, display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
              <Link href="/portal" className="btn btn-primary">Go to your portal →</Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
