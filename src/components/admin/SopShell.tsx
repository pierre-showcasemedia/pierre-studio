// The Team SOPs frame (/admin/sops): the department menu on the left, the
// chosen SOP beside it. On a computer the menu is a sticky column; on a
// tablet or phone it folds into an "All SOPs" disclosure above the page
// (it closes again after each pick: keyed by the page). Server only.
import Link from "next/link";
import { sopMenu } from "@/lib/sops";

function Menu({ active }: { active: string | null }) {
  return (
    <nav className="sop-menu" aria-label="Team SOPs">
      <Link href="/admin/sops" className={`sop-menu__home${active === null ? " is-active" : ""}`} aria-current={active === null ? "page" : undefined}>
        All departments
      </Link>
      {sopMenu().map(({ dept, sops }) => (
        <div key={dept.id} className="sop-menu__group">
          <div className="sop-menu__heading" id={`sop-dept-${dept.id}`}>{dept.label}</div>
          <ul aria-labelledby={`sop-dept-${dept.id}`}>
            {sops.map((s) => {
              const on = s.slug === active;
              return (
                <li key={s.slug}>
                  <Link href={`/admin/sops/${s.slug}`} className={`sop-menu__item${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined}>
                    {s.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function SopShell({ active, activeTitle, children }: { active: string | null; activeTitle?: string; children: React.ReactNode }) {
  return (
    <div className="sop-layout">
      <aside className="sop-side">
        <Menu active={active} />
      </aside>
      <details className="sop-picker" key={active ?? "home"}>
        <summary>
          <span className="sop-picker__label">All SOPs</span>
          <span className="sop-picker__current">{activeTitle ?? "Choose an SOP"}</span>
        </summary>
        <Menu active={active} />
      </details>
      <div className="sop-pane">{children}</div>
    </div>
  );
}
