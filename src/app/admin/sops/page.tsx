import Link from "next/link";
import type { Metadata } from "next";
import { PageHead } from "@/components/admin/bits";
import { SopShell } from "@/components/admin/SopShell";
import { ROLE_LABELS } from "@/db/schema";
import { requireTeam } from "@/lib/admin";
import { SOP_SNAPSHOT, sopMenu } from "@/lib/sops";
import "@/styles/admin-sops.css";
import { brand } from "@/lib/brand";

export const metadata: Metadata = { title: "Team SOPs" };

// Team SOPs, the front page (Nov 3 2026): every department and its SOPs. On a
// phone this list is the menu. Everyone on the team reads every SOP (Nov 3
// 2026, the owner); clients and signed-out visitors go to the portal login.
export default async function TeamSops() {
  const staff = await requireTeam();
  const depts = sopMenu();
  return (
    <section className="wrap adm-page">
      <PageHead
        eyebrow={ROLE_LABELS[staff.role]}
        title="Team SOPs."
        lede={`How ${brand.name} runs a job, by department. Pick a department's SOP from the menu; each one has its own link to share with the team.`}
      />
      <SopShell active={null}>
        <p className="sop-snapshot">
          General SOPs for this studio ({SOP_SNAPSHOT.commit}, {SOP_SNAPSHOT.date}). Change them in <code>src/content/sops</code>.
        </p>
        <aside className="sop-call sop-call--note">
          <div className="sop-call__tag">How to read these</div>
          <p>Each SOP lists the brain files it came from. Red <strong>Gap</strong> notes mark topics the brain does not cover yet. Amber notes flag a <strong>stale reference</strong> in the brain or a <strong>pending brain update</strong> the team has discussed but not written down. Client names, contact details and addresses are left out.</p>
        </aside>
        <div className="sop-depts">
          {depts.map(({ dept, sops }) => (
            <section key={dept.id} className="adm-card sop-dept">
              <div className="kicker">{dept.label}</div>
              <p className="sop-dept__blurb">{dept.blurb}</p>
              <ul>
                {sops.map((s) => (
                  <li key={s.slug}>
                    <Link href={`/admin/sops/${s.slug}`}>{s.title}</Link>
                    <span className="sop-dept__summary">{s.summary}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </SopShell>
    </section>
  );
}
