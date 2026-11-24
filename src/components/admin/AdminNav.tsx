"use client";
// Admin navigation: a sidebar on the left (Oct 26 2026; the owner: "make it a
// sidebar that's hideable, like Claude chats, with icons next to each thing,
// bigger and easier to click"). Replaces the row of tabs in the header and the
// phone bottom bar.
//
//   - Computer and tablet: fixed on the left, icon + label rows. The button at
//     the top folds it to a rail of icons (labels show on hover) and back;
//     the choice is a cookie (SIDEBAR_COOKIE) the layout reads, so the page
//     renders at the right width with no jump.
//   - Phone (Oct 28 2026; the owner: "FULLY optimized on mobile ... easy to run
//     and manage on the go from an iPhone"): a slim top bar with the logo and
//     Upload, and a tab bar along the bottom like an iPhone app (the role's
//     main pages plus More). More slides the whole menu up from the bottom as
//     a sheet; it closes on a tap outside, Escape, or after a navigation.
//
// The Photo QC team (role "qa"; Oct 26 2026: the owner, "they should only have
// access to revisions and photo qc") sees Photo QC and Revisions. A creative
// specialist (Oct 21 2026) sees Upload a shoot, and a video editor (Oct 26
// 2026) the Video board. Every role also has Team SOPs, every SOP (Nov 3 2026;
// the owner: "make SOPs tab visible to everyone"); on a phone it sits in More.
// Reports is admin only. The pages and actions check the role
// themselves; this only hides the doors.
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StaffRole } from "@/db/schema";
import { SIDEBAR_COOKIE } from "@/lib/admin-sidebar";
import { brand } from "@/lib/brand";

type IconName = "home" | "upload" | "calendar" | "grid" | "film" | "revise" | "people" | "team" | "download" | "chart" | "frames" | "gear" | "portal" | "logout" | "panel" | "menu" | "close" | "more" | "book" | "target";
type Item = { href: string; label: string; icon: IconName };
type Group = { label: string | null; items: Item[] };

// Admins: the work first, then people, then records.
export const ADMIN_NAV: readonly Group[] = [
  {
    label: null,
    items: [
      { href: "/admin", label: "Dashboard", icon: "home" },
      { href: "/admin/upload", label: "Upload a shoot", icon: "upload" },
      { href: "/admin/bookings", label: "Bookings", icon: "calendar" },
      { href: "/admin/listings", label: "Listings", icon: "grid" },
      { href: "/admin/photo-qc", label: "Photo QC", icon: "frames" },
      { href: "/admin/video", label: "Video", icon: "film" },
      { href: "/admin/revisions", label: "Revisions", icon: "revise" },
    ],
  },
  {
    label: "People",
    items: [
      { href: "/admin/clients", label: "Clients", icon: "people" },
      { href: "/admin/teams", label: "Teams", icon: "team" },
      { href: "/admin/leads", label: "Leads", icon: "people" },
    ],
  },
  {
    label: "Records",
    items: [
      { href: "/admin/downloads", label: "Downloads", icon: "download" },
      { href: "/admin/reports", label: "Reports", icon: "chart" },
    ],
  },
  {
    label: "Team",
    items: [{ href: "/admin/sops", label: "Team SOPs", icon: "book" }],
  },
];

export const QA_NAV: readonly Group[] = [
  {
    label: null,
    items: [
      { href: "/admin/photo-qc", label: "Photo QC", icon: "frames" },
      { href: "/admin/revisions", label: "Revisions", icon: "revise" },
      { href: "/admin/sops", label: "Team SOPs", icon: "book" },
    ],
  },
];

export const CREATIVE_NAV: readonly Group[] = [
  {
    label: null,
    items: [
      { href: "/admin/upload", label: "Upload a shoot", icon: "upload" },
      { href: "/admin/sops", label: "Team SOPs", icon: "book" },
    ],
  },
];

export const VIDEO_NAV: readonly Group[] = [
  {
    label: null,
    items: [
      { href: "/admin/video", label: "Video", icon: "film" },
      { href: "/admin/sops", label: "Team SOPs", icon: "book" },
    ],
  },
];

const navFor = (role: StaffRole): readonly Group[] => (role === "admin" ? ADMIN_NAV : role === "creative" ? CREATIVE_NAV : role === "video" ? VIDEO_NAV : QA_NAV);

// The scorecard (Nov 10 2026, /admin/scorecard): under Team for admins, and
// for the one person it is for whatever their role (the layout decides, with
// canSeeScorecard). On a menu with no Team group it goes last.
const SCORECARD_ITEM: Item = { href: "/admin/scorecard", label: "Scorecard", icon: "target" };
const withScorecard = (groups: readonly Group[]): Group[] => {
  const at = groups.findIndex((g) => g.label === "Team");
  const i = at >= 0 ? at : groups.length - 1;
  return groups.map((g, j) => (j === i ? { ...g, items: [...g.items, SCORECARD_ITEM] } : g));
};

// The phone tab bar: the pages each role opens most, then More (everything
// else, Settings, the client portal and Sign out, in the sheet). A tab is
// only ever an item of the role's own menu (tabsFor drops anything else).
const TAB_LABEL: Record<string, string> = { "/admin": "Home", "/admin/upload": "Upload" };
export const PHONE_TABS: Record<StaffRole, readonly string[]> = {
  admin: ["/admin", "/admin/bookings", "/admin/photo-qc", "/admin/listings"],
  qa: ["/admin/photo-qc", "/admin/revisions"],
  creative: ["/admin/upload"],
  video: ["/admin/video"],
};
const tabsFor = (role: StaffRole): Item[] => {
  const all = navFor(role).flatMap((g) => g.items);
  return PHONE_TABS[role].map((href) => all.find((i) => i.href === href)).filter((i): i is Item => Boolean(i));
};

function Icon({ name }: { name: IconName }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "home": return <svg viewBox="0 0 24 24" {...p}><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></svg>;
    case "upload": return <svg viewBox="0 0 24 24" {...p}><path d="M12 16V5m0 0l-4 4m4-4l4 4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" /></svg>;
    case "grid": return <svg viewBox="0 0 24 24" {...p}><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></svg>;
    case "people": return <svg viewBox="0 0 24 24" {...p}><circle cx="9" cy="8" r="3.5" /><path d="M3 19c0-3 2.7-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 14c2 .5 3 2 3 4.5" /></svg>;
    case "team": return <svg viewBox="0 0 24 24" {...p}><circle cx="8.5" cy="8" r="3.2" /><path d="M2.5 19c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2" /><circle cx="16.5" cy="9" r="2.6" /><path d="M16 14.3c3 0 5.5 1.9 5.5 4.7" /></svg>;
    case "revise": return <svg viewBox="0 0 24 24" {...p}><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.6M20 4v4.6h-4.6M20 12a8 8 0 0 1-13.7 5.6L4 15.4M4 20v-4.6h4.6" /></svg>;
    case "download": return <svg viewBox="0 0 24 24" {...p}><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" /></svg>;
    case "frames": return <svg viewBox="0 0 24 24" {...p}><rect x="3.5" y="6" width="13" height="11" rx="1.5" /><path d="M7.5 3.5h12a1 1 0 0 1 1 1V14M3.5 14l3.6-3.4 3.2 3 2.2-2 3 2.9" /></svg>;
    case "calendar": return <svg viewBox="0 0 24 24" {...p}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M8 3v4M16 3v4M8 14h3" /></svg>;
    case "chart": return <svg viewBox="0 0 24 24" {...p}><path d="M4 20h16M6 16v-5M11 16V7M16 16v-3M21 16V5" /></svg>;
    case "film": return <svg viewBox="0 0 24 24" {...p}><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M10 9.5v5l4.3-2.5z" /></svg>;
    case "gear": return <svg viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
    case "portal": return <svg viewBox="0 0 24 24" {...p}><path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>;
    case "logout": return <svg viewBox="0 0 24 24" {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" /></svg>;
    case "panel": return <svg viewBox="0 0 24 24" {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></svg>;
    case "menu": return <svg viewBox="0 0 24 24" {...p}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
    case "close": return <svg viewBox="0 0 24 24" {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>;
    case "book": return <svg viewBox="0 0 24 24" {...p}><path d="M5 4.5h9.5a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2z" /><path d="M5 18a2 2 0 0 1 2-2h9.5M19 7v13M9 8.5h4M9 11.5h4" /></svg>;
    case "target": return <svg viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /></svg>;
    case "more": return <svg viewBox="0 0 24 24" {...p}><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" /></svg>;
  }
}

function isActive(pathname: string, href: string, role: StaffRole) {
  // A shoot page sits under Photo QC (where its card is). A creative
  // specialist's only item is Upload; the shoot they just uploaded sits under
  // it. The Photo QC team reaches a listing from a revision: Revisions stays lit.
  if (href === "/admin") return pathname === "/admin";
  if (href === "/admin/photo-qc") return pathname.startsWith("/admin/photo-qc") || (role !== "creative" && pathname.startsWith("/admin/shoots"));
  if (role === "qa" && href === "/admin/revisions") return pathname.startsWith("/admin/revisions") || pathname.startsWith("/admin/listings");
  if (role === "creative" && href === "/admin/upload") return pathname.startsWith("/admin/upload") || pathname.startsWith("/admin/shoots");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminSidebar({
  role,
  email,
  roleLabel,
  openRevisions,
  railed: railedAtLoad,
  demo,
  scorecard = false,
  logo,
}: {
  role: StaffRole;
  email: string;
  roleLabel: string;
  openRevisions: number;
  railed: boolean; // folded to icons (the cookie, read by the layout)
  demo: boolean;
  scorecard?: boolean; // show Scorecard (admins and the person it is for)
  logo: { src: string; w: number; h: number };
}) {
  const pathname = usePathname() || "/admin";
  const [railed, setRailed] = useState(railedAtLoad);
  // Phone: the menu sheet is open over the page. It belongs to the page it was
  // opened on, so any navigation closes it.
  const [drawerAt, setDrawerAt] = useState<string | null>(null);
  const drawer = drawerAt === pathname;
  const setDrawer = useCallback((open: boolean | ((was: boolean) => boolean)) => {
    setDrawerAt((at) => {
      const was = at === pathname;
      const next = typeof open === "function" ? open(was) : open;
      return next ? pathname : null;
    });
  }, [pathname]);
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null); // the rail's hover label
  const menuBtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  // The shell's width follows the fold (globals.css reads data-side).
  useEffect(() => {
    document.querySelector(".adm-shell")?.setAttribute("data-side", railed ? "rail" : "open");
  }, [railed]);

  const toggleRail = useCallback(() => {
    setTip(null);
    setRailed((r) => {
      const next = !r;
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "rail" : "open"}; path=/admin; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);

  // Phone sheet: closes when a link in it is tapped (onClick on the aside),
  // on Escape (focus goes back to More), and after any navigation.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawer(false);
        menuBtn.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [drawer, setDrawer]);

  // Cmd/Ctrl + \ folds and unfolds it, like a code editor's side panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRail]);

  // On the rail, the item's name shows beside its icon (hover or keyboard focus).
  const showTip = (target: EventTarget | null) => {
    if (!railed || drawer || window.innerWidth < 760) return;
    const item = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tip]");
    if (!item) return setTip(null);
    const r = item.getBoundingClientRect();
    setTip({ label: item.dataset.tip ?? "", top: r.top + r.height / 2, left: r.right + 12 });
  };

  const nav = scorecard ? withScorecard(navFor(role)) : navFor(role);
  const row = (it: Item) => {
    const on = isActive(pathname, it.href, role);
    const badge = it.href === "/admin/revisions" && openRevisions > 0 ? openRevisions : 0;
    return (
      <Link key={it.href} href={it.href} className={`adm-nav__item${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined} data-tip={it.label}>
        {/* The active mark glides to the new item on navigation (view transition). */}
        {on && <span aria-hidden className="adm-nav__ink" />}
        <span className="adm-nav__icon">
          <Icon name={it.icon} />
          {badge > 0 && <span className="adm-nav__dot" aria-hidden />}
        </span>
        <span className="adm-nav__label">{it.label}</span>
        {badge > 0 && <span className="adm-badge adm-nav__badge" aria-label={`${badge} open`}>{badge}</span>}
      </Link>
    );
  };

  const tabs = tabsFor(role);
  const onTab = tabs.some((t) => isActive(pathname, t.href, role));
  const moreDot = role === "admin" && openRevisions > 0;
  const uploadShortcut = (role === "admin" || role === "creative") && !pathname.startsWith("/admin/upload");

  return (
    <>
      {/* Phone: the slim bar across the top. */}
      <header className="adm-topbar" style={{ viewTransitionName: "adm-header" }}>
        <Link href={role === "admin" ? "/admin" : tabs[0]?.href ?? "/admin"} aria-label={`${brand.name} admin`} className="adm-topbar__logo">
          <Image src={logo.src} alt={`${brand.name}`} width={Math.round(logo.w * 0.85)} height={Math.round(logo.h * 0.85)} style={{ width: "auto", height: Math.round(logo.h * 0.85) }} priority />
        </Link>
        <span className="adm-topbar__end">
          {demo && <span className="adm-nav__demo">Demo</span>}
          {uploadShortcut && (
            <Link href="/admin/upload" className="adm-topbar__upload" aria-label="Upload a shoot">
              <Icon name="upload" />
              <span>Upload</span>
            </Link>
          )}
        </span>
      </header>

      {/* Phone: the tab bar along the bottom, in thumb reach. */}
      <nav className="adm-tabbar" aria-label="Main" style={{ viewTransitionName: "adm-tabbar" }}>
        {tabs.map((t) => {
          const on = isActive(pathname, t.href, role) && !drawer;
          const badge = t.href === "/admin/revisions" && openRevisions > 0 ? openRevisions : 0;
          return (
            <Link key={t.href} href={t.href} className={`adm-tab${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined}>
              <span className="adm-tab__icon">
                <Icon name={t.icon} />
                {badge > 0 && <span className="adm-tab__badge" aria-label={`${badge} open`}>{badge > 99 ? "99+" : badge}</span>}
              </span>
              <span className="adm-tab__label">{TAB_LABEL[t.href] ?? t.label}</span>
            </Link>
          );
        })}
        <button ref={menuBtn} type="button" className={`adm-tab${drawer || !onTab ? " is-active" : ""}`} aria-label="More: the full menu" aria-expanded={drawer} aria-controls="adm-side" onClick={() => setDrawer((d) => !d)}>
          <span className="adm-tab__icon">
            <Icon name="more" />
            {moreDot && <span className="adm-tab__dot" aria-hidden />}
          </span>
          <span className="adm-tab__label">More</span>
        </button>
      </nav>

      {drawer && <div className="adm-scrim" onClick={() => setDrawer(false)} aria-hidden />}

      <aside
        ref={panel}
        id="adm-side"
        className={`adm-side${drawer ? " is-drawer-open" : ""}`}
        aria-label="Admin menu"
        style={{ viewTransitionName: "adm-side" }}
        onClick={(e) => {
          if (drawer && (e.target as HTMLElement).closest("a")) setDrawer(false);
        }}
        onMouseOver={(e) => showTip(e.target)}
        onMouseLeave={() => setTip(null)}
        onFocus={(e) => showTip(e.target)}
        onBlur={() => setTip(null)}
      >
        <span className="adm-side__grab" aria-hidden />
        <div className="adm-side__head">
          <Link href="/admin" aria-label={`${brand.name} admin`} className="adm-side__brand">
            <Image className="adm-side__logo" src={logo.src} alt={`${brand.name}`} width={logo.w} height={logo.h} priority />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="adm-side__mark" src="/icon.png" alt="" width={30} height={30} />
          </Link>
          <button type="button" className="adm-iconbtn adm-side__fold" onClick={toggleRail} aria-label={railed ? "Expand the menu" : "Collapse the menu"} title={railed ? "Expand the menu (⌘\\)" : "Collapse the menu (⌘\\)"}>
            <Icon name="panel" />
          </button>
          <button type="button" className="adm-iconbtn adm-side__close" onClick={() => { setDrawer(false); menuBtn.current?.focus(); }} aria-label="Close the menu">
            <Icon name="close" />
          </button>
        </div>

        <nav className="adm-nav" aria-label="Admin">
          {nav.map((g, i) => (
            <div key={g.label ?? i} className="adm-nav__group">
              {g.label && <div className="adm-nav__heading">{g.label}</div>}
              {g.items.map(row)}
            </div>
          ))}
        </nav>

        <div className="adm-side__foot">
          {demo && <div className="adm-nav__demo adm-side__demo">Demo data</div>}
          {role === "admin" && row({ href: "/admin/settings", label: "Settings", icon: "gear" })}
          <Link href="/portal" className="adm-nav__item" data-tip="Client portal">
            <span className="adm-nav__icon"><Icon name="portal" /></span>
            <span className="adm-nav__label">Client portal</span>
          </Link>
          <div className="adm-side__me" title={email} data-tip={`${email} · ${roleLabel}`}>
            <span className="adm-side__avatar" aria-hidden>{email.slice(0, 1).toUpperCase()}</span>
            <span className="adm-side__who">
              <span className="adm-side__email">{email}</span>
              <span className="adm-side__role">{roleLabel}</span>
            </span>
          </div>
          <form action="/api/portal/logout" method="post">
            <button type="submit" className="adm-nav__item" data-tip="Sign out">
              <span className="adm-nav__icon"><Icon name="logout" /></span>
              <span className="adm-nav__label">Sign out</span>
            </button>
          </form>
        </div>
      </aside>
      {tip && railed && (
        <div className="adm-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          {tip.label}
        </div>
      )}
    </>
  );
}
