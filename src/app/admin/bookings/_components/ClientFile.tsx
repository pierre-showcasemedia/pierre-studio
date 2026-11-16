// "Client file" on the booking page: the client's standing notes from the business
// brain and the studio's own notes (src/lib/client-file.ts). Server component.
import Link from "next/link";
import { SectionHead } from "@/components/admin/bits";
import { hasClientNotes, type ClientFile as ClientFileData } from "@/lib/client-file";

const WHY: Record<ClientFileData["brainState"], string> = {
  matched: "",
  no_match: "No client file in the brain yet.",
  error: "The client file could not be read this time.",
  off: "Client file not connected (BRAIN_GITHUB_TOKEN).",
};

export function ClientFile({ file, clientId, clientName }: { file: ClientFileData; clientId: string; clientName: string | null }) {
  const brain = file.brain;
  const empty = !hasClientNotes(file);
  return (
    <div className="adm-section">
      <SectionHead title="Client file" />
      <div className="adm-card" style={{ display: "grid", gap: 16 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          What every shoot for {brain?.note.client ?? clientName ?? "this client"} needs. The shooter gets the same notes in the shoot brief 30 minutes before the start, and they sit on the calendar event.
          {brain ? <span className="faint"> Matched the brain file by {brain.matchedBy}.</span> : WHY[file.brainState] ? <span className="faint"> {WHY[file.brainState]}</span> : null}
        </p>
        {brain && brain.beforeEveryShoot.length > 0 && (
          <div>
            <div className="kicker" style={{ marginBottom: 6 }}>Before every shoot</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
              {brain.beforeEveryShoot.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        )}
        {brain && brain.accessOnSite.length > 0 && (
          <div>
            <div className="kicker" style={{ marginBottom: 6 }}>Access and on site</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
              {brain.accessOnSite.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="kicker" style={{ marginBottom: 6 }}>Team notes</div>
          {file.studioNotes ? (
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{file.studioNotes}</p>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>None yet.</p>
          )}
          <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>
            <Link href={`/admin/clients/${clientId}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Edit on the client page</Link>
            {empty && !brain ? " to add preferences, access or billing notes that should follow every shoot." : "."}
          </p>
        </div>
      </div>
    </div>
  );
}
