// One Video card (Oct 26 2026): only what the video needs. The booking form's
// video side (services, speed, music, the client's notes), the Dropbox Video
// folder with the raw clips, the cuts on the listing (upload one here,
// internal only), the video revisions with their timestamps, and what this
// client has told us about video before (their video notes, the client file,
// past video bookings and revisions). No money, no contact details, no photos.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireVideo } from "@/lib/admin";
import { videoAssignees } from "@/lib/admin-allow";
import { fmtTimecode, STAGE_LABELS, VIDEO_STAGES, videoCardDetail, type VideoComment } from "@/lib/video-board";
import { fmtDay, fmtWhen } from "@/lib/shoot-status";
import { fmtTime12 } from "@/lib/booking-time";
import { PageHead } from "@/components/admin/bits";
import RefreshOnReturn from "@/components/admin/RefreshOnReturn";
import { VideoCutUpload } from "@/components/admin/VideoCutUpload";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { assignVideoCard, moveVideoCardForm, removeVideoCard, saveClientVideoNotes, saveVideoEditorNotes } from "../actions";
import "@/styles/admin-video.css";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

const SAVED: Record<string, string> = { stage: "Moved.", assignee: "Saved who has it.", notes: "Editing notes saved.", client: "The client's video notes are saved." };
const REV_LABEL: Record<string, string> = { new: "New", in_progress: "In progress", done: "Done" };

function Comments({ list }: { list: VideoComment[] }) {
  if (!list.length) return null;
  const films = new Set(list.map((c) => c.filename)).size;
  return (
    <ol className="vc-comments">
      {list.map((c, i) => (
        <li key={i} className="vc-comment">
          <span className="vc-tc" title={c.filename}>{fmtTimecode(c.atMs)}</span>
          <span>
            {films > 1 && <span className="adm-mono faint" style={{ display: "block", fontSize: 11 }}>{c.filename}</span>}
            {c.note}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default async function VideoCardPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  const staff = await requireVideo();
  const { id } = await params;
  const sp = await searchParams;
  const c = await videoCardDetail(id);
  if (!c) notFound();
  const admin = staff.role === "admin";
  const assignees = await videoAssignees();
  const here = c.history.revisions.filter((r) => r.listingId === c.listingId);
  const elsewhere = c.history.revisions.filter((r) => r.listingId !== c.listingId);
  const openRev = here.find((r) => r.id === c.revision?.id && r.status !== "done") ?? null;
  const when = c.shootDate ? `${fmtDay(c.shootDate)}${c.startTime ? ` at ${fmtTime12(c.startTime)}` : ""}` : null;

  return (
    <section className="wrap adm-page" style={{ maxWidth: 1240 }}>
      <RefreshOnReturn />
      <Link href="/admin/video" className="faint" style={{ fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase" }}>← Video board</Link>
      <PageHead eyebrow={`Video · ${STAGE_LABELS[c.stage]}`} title={<>{c.street}.</>} lede={[c.clientName, when ? `Shot ${when}` : null, c.launchDate ? `Launch ${fmtDay(c.launchDate)}` : null].filter(Boolean).join(" · ")} />

      {sp.saved && SAVED[sp.saved] && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>{SAVED[sp.saved]}</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}
      {c.nda && <p className="adm-banner adm-banner--warn" style={{ marginTop: 18 }}>NDA property: never post, share, demo or use this footage anywhere outside the edit.</p>}

      <div className="adm-card" style={{ marginTop: 22 }}>
        <div className="vc-h">Stage</div>
        <div className="vc-stages">
          {VIDEO_STAGES.map((s) => (
            <form key={s} action={moveVideoCardForm.bind(null, c.id, s)}>
              <button type="submit" className={`adm-chip${c.stage === s ? " adm-chip--on" : " adm-chip--quiet"}`} disabled={c.stage === s}>{STAGE_LABELS[s]}</button>
            </form>
          ))}
        </div>
        <p className="faint" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
          The card moves on its own: In editing once the footage is in Dropbox, In review when a cut is uploaded here, Sent to client when the delivery email goes out with a film live, Complete 3 days after that unless a revision is open. Sent to client never emails anyone; an admin sends the delivery. Moving to In editing marks an open revision in progress, and Sent to client or Complete marks it done.
        </p>
      </div>

      <div className="vc-grid">
        <div className="vc-stack">
          {openRev && (
            <section className="adm-card adm-card--lg" style={{ borderColor: "rgba(215,52,42,.45)" }}>
              <div className="vc-h" style={{ color: "var(--color-live)" }}>Revision {c.revision?.round} · {REV_LABEL[openRev.status] ?? openRev.status}</div>
              <div className="faint adm-mono" style={{ fontSize: 11.5 }}>{fmtWhen(openRev.createdAt)}{openRev.source === "quo" ? " · by text" : openRev.source === "email" ? " · by email" : " · from the gallery"}</div>
              {openRev.notes.trim() && <p className="vc-quote">{openRev.notes}</p>}
              <Comments list={openRev.comments} />
            </section>
          )}

          <section className="adm-card adm-card--lg">
            <div className="vc-h">The video, from the booking form</div>
            {c.booking ? (
              <dl className="vc-rows">
                <div className="vc-row"><dt>Services</dt><dd className="vc-big">{c.services.join(", ") || "None listed"}</dd></div>
                <div className="vc-row"><dt>Video speed</dt><dd>{c.speed ?? "Not chosen"}</dd></div>
                <div className="vc-row"><dt>Music</dt><dd>{c.booking.music ? (/^https?:\/\//i.test(c.booking.music) ? <a href={c.booking.music} target="_blank" rel="noreferrer" className="adm-link">{c.booking.music}</a> : c.booking.music) : "None given: our pick, licensed"}</dd></div>
                {c.launchDate && <div className="vc-row"><dt>Launch date</dt><dd>{fmtDay(c.launchDate)}</dd></div>}
                {c.booking.formNotes && <div className="vc-row"><dt>Client notes</dt><dd>{c.booking.formNotes}</dd></div>}
                {c.booking.customRequest && <div className="vc-row"><dt>Custom request</dt><dd>{c.booking.customRequest}</dd></div>}
              </dl>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>This shoot did not come through the booking form, so there is no speed or music on file. Check the client&rsquo;s notes on the right.</p>
            )}
          </section>

          <section className="adm-card adm-card--lg">
            <div className="vc-h">Raw footage</div>
            <div className="vc-dbx">
              {c.dropbox.url ? (
                <a href={c.dropbox.url} target="_blank" rel="noreferrer" className="vc-dbx__btn">{c.dropbox.shared ? "Open the Video folder in Dropbox ↗" : `Open the Video folder (${brand.shortName} Dropbox members) ↗`}</a>
              ) : (
                <span className="vc-dbx__btn" aria-disabled="true">No Dropbox folder yet</span>
              )}
              <span className="muted" style={{ fontSize: 13.5 }}>
                {c.clips.count ? `${c.clips.count} clip${c.clips.count === 1 ? "" : "s"} uploaded, ${c.clips.inDropbox} in Dropbox` : c.footage ? "Footage uploaded" : "No footage uploaded yet"}
              </span>
            </div>
            <p className="faint" style={{ margin: "10px 0 0", fontSize: 12.5, lineHeight: 1.6 }}>
              {!c.dropbox.connected
                ? "Dropbox is not connected yet. Uploaded clips are safe in Studio and copy into the Video folder as soon as an admin connects it in Settings."
                : c.dropbox.url && !c.dropbox.shared
                  ? `No share link yet, so this button only works for people signed in to ${brand.shortName}’s Dropbox. Studio asks Dropbox for a share link every 30 minutes and swaps it in here as soon as Dropbox allows one. Until then, the folder is ${c.dropbox.folder ?? "the Video folder"}.`
                  : c.dropbox.folder
                    ? c.dropbox.folder
                    : "The folder is made when the shoot is booked, and the Video folder when the first media is uploaded."}
            </p>
          </section>

          <section className="adm-card adm-card--lg">
            <div className="vc-h">Cuts on this listing · {c.filmFiles.length}</div>
            {c.filmFiles.length > 0 && (
              <div style={{ display: "grid", gap: 16, marginBottom: 16 }}>
                {c.filmFiles.map((f) => (
                  <div key={f.id} className="vc-film">
                    {f.url ? <video src={f.url} controls preload="metadata" playsInline /> : null}
                    <div className="vc-film__foot">
                      <span className="adm-mono">{f.filename}</span>
                      <span className="adm-pill" style={f.published ? { background: "rgba(26,127,75,.10)", color: "#1A7F4B" } : { background: "rgba(95,100,110,.12)", color: "#3F444D" }}>{f.published ? "Client visible" : "Internal only"}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <VideoCutUpload listingId={c.listingId} cardId={c.id} />
            {admin && (
              <p className="faint" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
                To show a cut to the client, make it client visible on the <Link href={`/admin/listings/${c.listingId}`} className="adm-link">listing</Link>, then send the delivery email from there.
              </p>
            )}
          </section>

          {here.filter((r) => r.id !== openRev?.id).length > 0 && (
            <section className="adm-card adm-card--lg">
              <div className="vc-h">Earlier revisions on this listing</div>
              <div className="vc-hist">
                {here.filter((r) => r.id !== openRev?.id).map((r) => (
                  <div key={r.id} className="vc-hist__item">
                    <div className="vc-hist__when">{fmtWhen(r.createdAt)} · {REV_LABEL[r.status] ?? r.status}</div>
                    {r.notes.trim() && <p className="vc-quote">{r.notes}</p>}
                    <Comments list={r.comments} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="vc-stack">
          <section className="adm-card adm-card--lg">
            <div className="vc-h">Who has it</div>
            <form action={assignVideoCard.bind(null, c.id)} className="flex flex-wrap items-end" style={{ gap: 8 }}>
              <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
                <SearchSelect name="assignee" defaultValue={c.assignee ?? ""} options={assignees.map((e) => ({ value: e, label: e }))} emptyLabel="Nobody yet" title="Who has it" searchPlaceholder="Search the team" ariaLabel="Assign this card" />
              </div>
              <button type="submit" className="adm-chip">Save</button>
            </form>
          </section>

          <section className="adm-card adm-card--lg">
            <div className="vc-h">What {c.client?.name ?? "this client"} wants from video</div>
            <form action={saveClientVideoNotes.bind(null, c.id)} style={{ display: "grid", gap: 8 }}>
              <textarea name="videoNotes" className="vc-textarea" defaultValue={c.client?.videoNotes ?? ""} placeholder="Pace, music, cuts they like, what they asked to change last time. Kept on the client for every future video." maxLength={4000} />
              <button type="submit" className="adm-chip" style={{ justifySelf: "start" }}>Save the client&rsquo;s video notes</button>
            </form>

            {c.history.brainLines.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div className="vc-h">From the client file</div>
                <ul className="vc-lines">{c.history.brainLines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </div>
            )}

            {c.history.pastBookings.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div className="vc-h">Their past video bookings</div>
                <div className="vc-hist">
                  {c.history.pastBookings.map((b, i) => (
                    <div key={i} className="vc-hist__item" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                      <div className="vc-hist__when">{b.date ? fmtDay(b.date) : "No date"} · {b.street}</div>
                      <div>{b.services.join(", ")}</div>
                      <div className="muted">Speed: {b.speed ?? "not chosen"}{b.music ? ` · Music: ${b.music}` : ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {elsewhere.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div className="vc-h">Video revisions they asked for before</div>
                <div className="vc-hist">
                  {elsewhere.map((r) => (
                    <div key={r.id} className="vc-hist__item">
                      <div className="vc-hist__when">{fmtWhen(r.createdAt)} · {r.street}</div>
                      {r.notes.trim() && <p className="vc-quote">{r.notes}</p>}
                      <Comments list={r.comments} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!c.history.brainLines.length && !c.history.pastBookings.length && !elsewhere.length && !c.client?.videoNotes && (
              <p className="faint" style={{ margin: "12px 0 0", fontSize: 13 }}>Nothing on file yet. Anything they say about video goes in the box above.</p>
            )}
          </section>

          <section className="adm-card adm-card--lg">
            <div className="vc-h">Editing notes</div>
            <form action={saveVideoEditorNotes.bind(null, c.id)} style={{ display: "grid", gap: 8 }}>
              <textarea name="notes" className="vc-textarea" defaultValue={c.editorNotes ?? ""} placeholder="Selects, song picked, what is left to do. Team only." maxLength={4000} />
              <button type="submit" className="adm-chip" style={{ justifySelf: "start" }}>Save notes</button>
            </form>
          </section>

          {admin && (
            <form action={removeVideoCard.bind(null, c.id)}>
              <button type="submit" className="adm-chip adm-chip--quiet" title="Takes this card off the board. The listing, the footage and the revisions stay.">Remove this card</button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
