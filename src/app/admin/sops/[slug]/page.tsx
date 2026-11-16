import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SopBody } from "@/components/admin/SopBody";
import { SopShell } from "@/components/admin/SopShell";
import { requireTeam } from "@/lib/admin";
import { sopMarkdown } from "@/lib/sop-content";
import { parseSop } from "@/lib/sop-markdown";
import { SOP_SNAPSHOT, departmentsOf, sopBySlug, sopMenu } from "@/lib/sops";
import "@/styles/admin-sops.css";

export const metadata: Metadata = { title: "Team SOPs" };

// One Team SOP (Nov 3 2026), one shareable link each: /admin/sops/<slug>.
// Everyone on the team, every SOP (Nov 3 2026).
export default async function TeamSop({ params }: { params: Promise<{ slug: string }> }) {
  await requireTeam();
  const { slug } = await params;
  const sop = sopBySlug(slug);
  if (!sop) notFound();
  const md = await sopMarkdown(sop.slug);
  if (md === null) notFound();
  const blocks = parseSop(md);
  const depts = departmentsOf(sop.slug);

  // Previous and next within the SOP's first department.
  const home = sopMenu().find((d) => d.dept.id === depts[0]?.id);
  const at = home ? home.sops.findIndex((s) => s.slug === sop.slug) : -1;
  const prev = home && at > 0 ? home.sops[at - 1] : null;
  const next = home && at >= 0 && at < home.sops.length - 1 ? home.sops[at + 1] : null;

  return (
    <section className="wrap adm-page">
      <SopShell active={sop.slug} activeTitle={sop.title}>
        <article className="sop-article">
          <header className="sop-article__head">
            <div className="kicker">{depts.map((d) => d.label).join(" · ")}</div>
            <h1 className="adm-title">{sop.title}</h1>
            <p className="adm-lede">{sop.summary}</p>
            <div className="sop-sources">
              <span className="sop-sources__label">In the studio</span>
              {sop.sources.map((s) => <code key={s}>{s}</code>)}
            </div>
            <p className="sop-snapshot">
              General SOPs for this studio ({SOP_SNAPSHOT.commit}, {SOP_SNAPSHOT.date}). Change them in <code>src/content/sops</code>.
            </p>
          </header>
          <SopBody blocks={blocks} />
          {(prev || next) && (
            <nav className="sop-pager" aria-label={`More in ${home?.dept.label}`}>
              {prev ? <Link href={`/admin/sops/${prev.slug}`} className="sop-pager__link"><span>Previous</span>{prev.title}</Link> : <span />}
              {next ? <Link href={`/admin/sops/${next.slug}`} className="sop-pager__link sop-pager__link--next"><span>Next in {home?.dept.label}</span>{next.title}</Link> : <span />}
            </nav>
          )}
        </article>
      </SopShell>
    </section>
  );
}
