"use client";
// A table row that opens its booking (or listing) when any part of it is
// clicked, like a row in Aryeo's order list. Links, buttons and the status
// select inside keep their own behavior; selecting text never navigates;
// cmd, ctrl or middle click opens a new tab. Keyboard users reach the same
// page through the row's main link, and the row lights up while it has focus.
import { useRouter } from "next/navigation";

const INTERACTIVE = "a, button, select, input, textarea, label, summary, form, [role='button']";

export function BookingRow({ href, className = "", children }: { href: string; className?: string; children: React.ReactNode }) {
  const router = useRouter();
  const skip = (e: React.MouseEvent<HTMLTableRowElement>) => {
    const t = e.target as HTMLElement | null;
    if (!t || t.closest(INTERACTIVE)) return true;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    return Boolean(sel && !sel.isCollapsed && sel.toString().trim());
  };
  return (
    <tr
      className={`bk-row ${className}`.trim()}
      data-href={href}
      onClick={(e) => {
        if (e.button !== 0 || skip(e)) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey) window.open(href, "_blank", "noopener");
        else router.push(href);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && !skip(e)) window.open(href, "_blank", "noopener");
      }}
    >
      {children}
    </tr>
  );
}
