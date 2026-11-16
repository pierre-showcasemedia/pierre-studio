"use client";
// The delivery email's team CC (Oct 24 2026): everyone on the booker's team is
// ticked and ready to CC; untick anyone (or press None to send to the client
// only) and tick them back one by one. The ticked boxes post as `teamCc`;
// the send action accepts only people really on that team.
import { useState } from "react";

type Member = { email: string; name: string | null };

export function TeamCcPicker({ teamName, members }: { teamName: string; members: Member[] }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(members.map((m) => m.email)));
  const toggle = (email: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  const all = picked.size === members.length;
  return (
    <fieldset className="field" style={{ maxWidth: 560, border: 0, padding: 0, margin: 0 }}>
      <div className="flex flex-wrap items-center" style={{ gap: 10, justifyContent: "space-between" }}>
        <legend style={{ padding: 0, fontSize: 13, fontWeight: 500 }}>
          CC the team: {teamName} <span className="faint" style={{ fontWeight: 400 }}>· {picked.size} of {members.length}</span>
        </legend>
        <span className="flex" style={{ gap: 6 }}>
          <button type="button" className="btn btn-ghost" style={{ padding: "4px 12px", fontSize: 12 }} onClick={() => setPicked(new Set(members.map((m) => m.email)))} disabled={all}>
            All
          </button>
          <button type="button" className="btn btn-ghost" style={{ padding: "4px 12px", fontSize: 12 }} onClick={() => setPicked(new Set())} disabled={picked.size === 0}>
            None
          </button>
        </span>
      </div>
      <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        {members.map((m) => (
          <label key={m.email} className="flex items-center" style={{ gap: 10, fontSize: 14, cursor: "pointer" }}>
            <input type="checkbox" name="teamCc" value={m.email} checked={picked.has(m.email)} onChange={() => toggle(m.email)} style={{ width: 16, height: 16 }} />
            <span>
              {m.name ? <strong style={{ fontWeight: 500 }}>{m.name}</strong> : null}
              <span className={m.name ? "faint" : undefined} style={{ marginLeft: m.name ? 8 : 0 }}>{m.email}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>
        {picked.size === 0 ? "Sending to the client only." : "Untick anyone who should not get it, or press None to send to the client only."}
      </p>
    </fieldset>
  );
}
