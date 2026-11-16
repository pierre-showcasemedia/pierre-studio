import Link from "next/link";
// admin-media.css: the opened frame is the listing preview's full screen frame.
import "@/styles/admin-media.css";
import "@/styles/admin-visibility.css";
import { notFound, redirect } from "next/navigation";
import { revisionRound } from "@/lib/revision-frames";
import { revisionEmailWording } from "@/lib/delivery-email";
import { markRevisionsDone } from "../../actions";
import { hasDb } from "@/db";
import { adminReplacedOriginals, adminShootDetail, siblingShootFrames } from "@/lib/admin-data";
import { MAKE_TWILIGHT_STATUSES, pipelineParked } from "@/lib/pipeline";
import { FALLBACK_LOOKS } from "@/lib/autohdr";
import { twilightLookName, twilightPreset } from "@/lib/twilight-preset";
import { hasQc } from "@/lib/qc";
import { STEP_BLURBS, canPublishFrom, estimateCredits, fmtBytes, fmtWhen, isActive, photoFileCount, railFor } from "@/lib/shoot-status";
import { rerunQc, retryShoot, runShootNow } from "../../actions";
import { publishedBanner } from "@/lib/publish-plan";
import { mirrorShootAgain } from "../../dropbox-actions";
import ShootReview from "@/components/admin/ShootReview";
import QcReport from "@/components/admin/QcReport";
import UploadFinals from "@/components/admin/UploadFinals";
import FinalReviewPanel from "@/components/admin/FinalReviewPanel";
import { reviewReadiness } from "@/lib/qc-labels";
import { staffNames } from "@/lib/qc-fixes";
import CreativeShootView from "@/components/admin/CreativeShootView";
import DropboxMirrorLine from "@/components/admin/DropboxMirrorLine";
import { ShootPill } from "@/components/admin/bits";
import { CREATIVE_DENIED_PATH, VIDEO_DENIED_PATH, isStaffRole, mayOpenShoot, requireTeam } from "@/lib/admin";
import { isClientVisibleRow } from "@/lib/visibility";
import { dropboxMirrorEnabled, hasDropboxApp } from "@/lib/dropbox";
import { finalReviewOpen, lastFinalReviews } from "@/lib/final-review";
import { mirrorSummary } from "@/lib/dropbox-mirror";

// Server actions on this page push the pipeline in after(); give them room.
export const maxDuration = 120;

export default async function ShootPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ firstLive?: string; dest?: string; hidden?: string; deleted?: string; retried?: string; ran?: string; qc?: string; mirror?: string; error?: string; merged?: string }> }) {
  // The gate, here and not only in the layout: Next renders layout and page
  // concurrently, so a page that fetched first would still stream its data.
  // Admins and the QA team. The QA team does everything here except Retry
  // step (it can start a fresh, paid editing run) and the delivery email. A
  // creative specialist (Oct 21 2026) opens only a shoot they uploaded
  // (mayOpenShoot) and gets the read-only view; any other shoot sends them
  // back to Upload a shoot before anything renders.
  const staff = await requireTeam();
  // A video editor never opens a shoot page; nothing is read first.
  if (staff.role === "video") redirect(VIDEO_DENIED_PATH);
  const admin = staff.role === "admin";
  const { id } = await params;
  const sp = await searchParams;
  const data = await adminShootDetail(id);
  if (!data) notFound();
  const { shoot, files, frames } = data;
  if (!mayOpenShoot(staff, shoot.createdBy)) redirect(CREATIVE_DENIED_PATH);
  const demo = !hasDb();
  // "Make twilight" in the opened frame (admins and the Photo QC team): greyed out with the reason until it can run.
  const twilightTeam = isStaffRole(staff.role);
  const twilightReady = twilightTeam && !demo ? await twilightPreset() : null;
  const makeTwilight = !twilightTeam
    ? null
    : { reason: demo ? "Demo mode: nothing runs." : !twilightReady ? "Set the Champagne preset in Settings → Virtual twilight first." : !(MAKE_TWILIGHT_STATUSES as readonly string[]).includes(shoot.status) ? "Available once editing has finished pulling this shoot in." : null };
  // The Dropbox raw mirror (Oct 21 2026): how many of this shoot's files are
  // in Dropbox, and whether the mirror is set up on this deployment at all.
  const mirror = mirrorSummary(files);
  const mirrorState = demo ? "on" : dropboxMirrorEnabled() ? "on" : hasDropboxApp() ? "elsewhere" : "off";
  if (staff.role === "creative") return <CreativeShootView shoot={shoot} files={files} mirror={mirror} mirrorState={mirrorState} />;
  const replacedOriginals = await adminReplacedOriginals({ shootId: shoot.id });
  const o = shoot.options;
  const videoOnly = shoot.status === "video_only";
  // Demo mode has no pipeline to park; only a real database can be parked.
  const parked = !demo && shoot.status === "uploaded" && pipelineParked();
  const rail = railFor(shoot.status, (shoot.progress?.failedFrom as string | undefined) ?? null, Boolean(o?.twilight?.enabled));
  const credits = estimateCredits(o, photoFileCount(shoot), shoot.photoCount);
  const uploaded = files.filter((f) => f.uploaded).length;
  const mirrorN = sp.mirror && sp.mirror !== "demo" ? Number(sp.mirror) : null;
  const look = twilightLookName(o?.twilight?.look, FALLBACK_LOOKS);
  const twilightFrames = frames.filter((f) => f.section === "Twilight").length;
  const notes = (shoot.progress?.notes as string[] | undefined) ?? [];
  const name = shoot.address.split(",")[0];
  const active = isActive(shoot.status);
  const framesIn = shoot.status === "ready_for_review" || shoot.status === "published";
  // Approved, not live, not held back by hand: what the Publish bar in the
  // grid sends (Nov 2 2026: only approved photos ever publish; rejected and
  // unreviewed photos stay internal). Held frames are left alone.
  // A frame marked published on a shoot never published is waiting too.
  const shootPublished = Boolean(shoot.publishedAt);
  const waiting = frames.filter((f) => f.qcState === "approved" && (!f.published || !shootPublished) && !f.held).length;
  const liveCount = frames.filter((f) => isClientVisibleRow({ ...f, shootId: shoot.id }, shootPublished)).length;
  const firstLiveN = sp.firstLive ? Number(sp.firstLive) : null;
  const qcConfigured = demo ? true : hasQc();
  const canRerunQc = framesIn || (shoot.status === "failed" && shoot.progress?.failedFrom === "qc");
  const qcProgress = (shoot.progress?.qc as { done?: number; total?: number } | undefined) ?? null;
  // Send for final review (Oct 28 2026, src/lib/final-review.ts): the editors' last send, open until the next Publish.
  // The listing's other shoots and their frame names (Nov 2 2026): the corrected
  // photos box says when a drop belongs on one of them instead.
  const [finalReviews, siblings] = await Promise.all([lastFinalReviews([shoot.id]), siblingShootFrames(shoot.listingId, shoot.id)]);
  const finalReview = finalReviews.get(shoot.id) ?? null;
  const reviewOpen = finalReviewOpen(finalReview, shoot.publishedAt);
  const reviewers = "the final review team";
  // Nov 3 2026: what the Send for final review panel warns about (unticked
  // QC flags, revised photos QC has not seen), and who sent the last one.
  const readiness = reviewReadiness(frames);
  const reviewBy = finalReview?.by ? (await staffNames([finalReview.by])).get(finalReview.by.toLowerCase()) ?? finalReview.by : null;
  // Approved corrected frames on the shoot: the grid's Revised section has Publish finals only.
  const finalsN = frames.filter((f) => f.corrected && f.qcState === "approved").length;
  // The client's revision round (Oct 30 2026, src/lib/revision-frames.ts):
  // the photos they asked to change, in their own section at the top.
  const round = videoOnly ? null : await revisionRound({ id: shoot.id, listingId: shoot.listingId }, frames);
  const roundWho = round?.asks.length ? (round.asks.length > 1 ? `${round.asks.length} revision requests` : round.asks[0].clientName ?? round.asks[0].clientEmail) : "The client";
  const roundPhotos = round ? `${round.total} photo${round.total === 1 ? "" : "s"}` : "";
  const roundState = !round
    ? ""
    : [round.fixed ? `${round.fixed} fixed and ready to check` : "", round.waiting ? `${round.waiting} waiting for the fix` : "", round.live ? `${round.live} fixed and live` : ""].filter(Boolean).join(", ");
  const roundSummary = round ? `${roundWho} asked for changes on ${roundPhotos}${round.asks[0] ? `, ${fmtWhen(round.asks[0].askedAt)}` : ""}. ${roundState.charAt(0).toUpperCase()}${roundState.slice(1)}.` : "";
  const roundEmailHref = round && round.live > 0 ? `/admin/listings/${shoot.listingId}/delivery-email?${new URLSearchParams(revisionEmailWording(shoot.address, round.live)).toString()}` : null;
  const hiddenN = sp.hidden ? Number(sp.hidden) : 0;
  const deletedN = sp.deleted ? Number(sp.deleted) : null;

  return (
    <section className="wrap adm-page shoot-page">
      {/* Every shoot has its card on the Photo QC board (Oct 26 2026). */}
      <Link href="/admin/photo-qc" className="adm-link muted" style={{ fontSize: 12.5 }}>← Photo QC</Link>
      <div className="adm-head" style={{ marginTop: 14 }}>
        <div>
          <div className="flex flex-wrap items-center" style={{ gap: 10, marginBottom: 10 }}>
            <span className="kicker" style={{ margin: 0 }}>Shoot</span>
            <ShootPill s={shoot.status} />
            {shoot.nda && <span className="adm-pill" style={{ background: "rgba(11,12,15,.08)" }}>NDA</span>}
          </div>
          <h1 className="adm-title">{name}</h1>
          <p className="adm-lede">
            <Link href={`/admin/listings/${shoot.listingId}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{shoot.clientName ?? shoot.clientEmail}</Link>
            {" · "}uploaded by {shoot.createdBy} · {fmtWhen(shoot.submittedAt ?? shoot.createdAt)}
          </p>
        </div>
        <div className="adm-actions">
          {/* Publishing happens in the grid's Publish bar, which counts from what is on screen (Nov 2 2026). */}
          {canPublishFrom(shoot.status) && (waiting > 0 || shoot.status === "ready_for_review") && (
            <a href="#publish" className="btn btn-primary" title="Only approved photos go to the client. Rejected and unreviewed photos stay internal only.">Publish approved ↓</a>
          )}
          {admin && shoot.status === "published" && waiting === 0 && <Link href={`/admin/listings/${shoot.listingId}/delivery-email`} className="btn btn-primary">Delivery email →</Link>}
          {admin && shoot.status === "failed" && (
            <form action={retryShoot.bind(null, shoot.id)}>
              <button type="submit" className="btn btn-primary">Retry step →</button>
            </form>
          )}
          {active && !parked && (
            <form action={runShootNow.bind(null, shoot.id)}>
              <button type="submit" className="btn btn-ghost" title="Push the pipeline forward now instead of waiting for the scheduler.">Run now</button>
            </form>
          )}
          {canRerunQc && (
            <form action={rerunQc.bind(null, shoot.id)}>
              <button type="submit" className="btn btn-ghost" title={qcConfigured ? "Check every frame again with the automatic QC pass." : "QC pass skipped: key not set"} disabled={!qcConfigured}>{shoot.qcSummary ? "Run QC again" : "Run QC"}</button>
            </form>
          )}
          <Link href={`/admin/listings/${shoot.listingId}`} className="btn btn-ghost">Listing</Link>
        </div>
      </div>

      {firstLiveN != null && !Number.isNaN(firstLiveN) && (
        <div className="adm-banner adm-banner--ok flex flex-wrap items-center justify-between" style={{ marginTop: 18, gap: 10 }}>
          <span>Published. {publishedBanner({ live: firstLiveN, dest: sp.dest === "revised" ? "revised" : "gallery", hidden: hiddenN })} {admin ? "The delivery email is next." : "An admin sends the delivery email."}</span>
          {admin && <Link href={`/admin/listings/${shoot.listingId}/delivery-email`} className="btn btn-primary">Delivery email →</Link>}
        </div>
      )}
      {admin && sp.merged && (() => {
        const [k, x] = sp.merged.split(".").map((v) => Number(v));
        return <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Merged the other shoot into this one: {Number.isFinite(k) ? k : 0} client visible photos kept, {Number.isFinite(x) ? x : 0} internal only frames deleted. The files stay in storage and the download zips are rebuilding.</p>;
      })()}
      {deletedN != null && !Number.isNaN(deletedN) && <p className="adm-banner adm-banner--ok" style={{ marginTop: 18 }}>Deleted {deletedN} frame{deletedN === 1 ? "" : "s"} from this shoot. The files stay in storage.</p>}
      {round && (
        <div className="adm-banner adm-banner--warn rev-banner" style={{ marginTop: 18 }}>
          <div>
            <strong style={{ fontWeight: 600 }}>Revision.</strong> {roundSummary}{" "}
            {round.fixed > 0
              ? "Give them a last look, then Publish fixed."
              : round.waiting > 0
                ? "The Photo QC team uploads each fix under Upload corrected photos with the same filename; it lands here."
                : admin
                  ? "Everything is live. Email the client, then mark the revision done."
                  : "Everything is live. An admin emails the client."}
          </div>
          <div className="adm-actions" style={{ marginTop: 10 }}>
            <a href="#revision" className={`btn ${round.fixed > 0 ? "btn-primary" : "btn-ghost"}`}>{round.fixed > 0 ? `Check the ${round.fixed} fixed ↓` : `See the ${roundPhotos} ↓`}</a>
            {admin && roundEmailHref && <Link href={roundEmailHref} className={`btn ${round.fixed === 0 && round.waiting === 0 ? "btn-primary" : "btn-ghost"}`}>Email the client →</Link>}
            {round.asks.length > 0 && (
              <form action={markRevisionsDone.bind(null, round.asks.map((a) => a.id), `/admin/shoots/${shoot.id}`)}>
                <button type="submit" className="btn btn-ghost" title="Marks the request done on Revisions. A fix that is not live yet stays in this section until it is published.">Mark revision done</button>
              </form>
            )}
          </div>
        </div>
      )}
      {/* Send for final review (Nov 3 2026): the editors' last step, who sent it and when. */}
      {!videoOnly && (framesIn || reviewOpen) && (
        <FinalReviewPanel
          shootId={shoot.id}
          demo={demo}
          reviewers={reviewers}
          readiness={readiness}
          last={finalReview ? { by: reviewBy ?? "the editors", at: finalReview.at.toISOString(), corrected: finalReview.corrected } : null}
          open={reviewOpen}
          enabled={framesIn}
        />
      )}
      {!admin && shoot.status === "failed" && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>This shoot stopped. An admin can retry the step from here.</p>}
      {sp.retried === "demo" && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>Demo mode: nothing was retried.</p>}
      {sp.ran && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>{sp.ran === "demo" ? "Demo mode: nothing ran." : "Pipeline pushed forward. This page refreshes as the shoot moves."}</p>}
      {sp.qc && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>{sp.qc === "demo" ? "Demo mode: QC did not run." : "QC is running again. Results land here frame by frame."}</p>}
      {sp.mirror === "demo" && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>Demo mode: nothing was queued for Dropbox.</p>}
      {mirrorN != null && !Number.isNaN(mirrorN) && <p className="adm-banner adm-banner--info" style={{ marginTop: 18 }}>{mirrorN ? `Copying ${mirrorN} file${mirrorN === 1 ? "" : "s"} to Dropbox again. This page refreshes as they land.` : "Every file of this shoot is already in Dropbox."}</p>}
      {sp.error && <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>{sp.error}</p>}
      {parked && <p className="adm-banner adm-banner--warn" style={{ marginTop: 18 }}>Editing account not connected. Files are safe; processing starts once it is.</p>}
      {shoot.status === "failed" && shoot.error && (
        <p className="adm-banner adm-banner--bad" style={{ marginTop: 18 }}>
          Stopped at &ldquo;{String(shoot.progress?.failedFrom ?? "")}&rdquo;: {shoot.error}
        </p>
      )}
      {shoot.status !== "failed" && shoot.error && <p className="adm-banner adm-banner--warn" style={{ marginTop: 18 }}>{shoot.error}</p>}
      {notes.filter((n) => !n.startsWith("QC ")).map((n) => <p key={n} className="adm-banner adm-banner--info" style={{ marginTop: 10 }}>{n}</p>)}

      <div className="adm-card adm-card--lg shoot-info" style={{ marginTop: 24 }}>
        <div className="adm-rail">
          {rail.map((s) => (
            <div key={s.key} className={`adm-rail__step is-${s.state}`}>
              <div className="adm-rail__track" />
              <div className="adm-rail__name">{s.label}</div>
            </div>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 14, marginBottom: 0 }}>
          {STEP_BLURBS[shoot.status]}
          {framesIn && (
            <>
              {" "}Everything stays Internal only until you publish the approved photos.
              {liveCount ? ` ${liveCount} frame${liveCount === 1 ? " is" : "s are"} client visible now.` : ""}
            </>
          )}
        </p>
      </div>

      {!videoOnly && (
        <div className="shoot-info">
          <QcReport status={shoot.status} summary={shoot.qcSummary} progress={qcProgress} frames={frames} notes={notes} qcConfigured={qcConfigured} />
        </div>
      )}

      <dl className="adm-kv adm-card shoot-info" style={{ marginTop: 14 }}>
        {!videoOnly && <div><dt>Model</dt><dd>{o?.nda ? "Aura (NDA)" : o?.modelName ?? "Aura"}{o && o.indoorModelId !== o.outdoorModelId ? ` · indoor ${o.indoorModelId}, outdoor ${o.outdoorModelId}` : ""}{o?.skipHdr ? " · finished JPGs" : ""}</dd></div>}
        {!videoOnly && <div><dt>Twilight</dt><dd>{o?.twilight?.enabled ? `${o.twilight.count} frames · ${look}${twilightFrames ? ` · ${twilightFrames} done` : ""}` : "Off"}</dd></div>}
        <div><dt>Files</dt><dd className="adm-mono">{mirror.video ? `${mirror.photos} photo${mirror.photos === 1 ? "" : "s"} · ${mirror.video} clip${mirror.video === 1 ? "" : "s"}` : `${shoot.fileCount} uploaded`}{!videoOnly && shoot.status !== "draft" && shoot.status !== "uploaded" ? ` · ${uploaded} sent to editing` : ""}</dd></div>
        {!videoOnly && <div><dt>Frames</dt><dd className="adm-mono">{shoot.photoCount || (frames.length ? frames.length : "pending")}{frames.some((f) => f.corrected) ? ` · ${frames.filter((f) => f.corrected).length} corrected` : ""}</dd></div>}
        {admin && !videoOnly && <div><dt>Credits</dt><dd className="adm-mono">{credits.exact ? "" : "about "}{credits.total}{credits.twilight ? ` (${credits.edit} edit + ${credits.twilight} twilight)` : ""}</dd></div>}
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>Dropbox</dt>
          <dd>
            <DropboxMirrorLine mirror={mirror} state={mirrorState} folder={shoot.dropboxFolder} syncedAt={shoot.dropboxSyncedAt} admin={admin}>
              {admin && shoot.status !== "draft" && mirrorState !== "off" && mirror.synced < mirror.total && (
                <form action={mirrorShootAgain.bind(null, shoot.id)} style={{ display: "inline" }}>
                  <button type="submit" className="adm-chip" title="Queues every file that is not in Dropbox yet and starts on them now.">Copy to Dropbox again</button>
                </form>
              )}
            </DropboxMirrorLine>
          </dd>
        </div>
        {admin && !demo && files.length > 0 && (
          <div style={{ gridColumn: "1 / -1" }}>
            <dt>R2</dt>
            <dd className="muted" style={{ fontSize: 13 }}>
              {(() => {
                // Raws leave R2 once Dropbox's copy is verified (size and content hash); photos only after editing is done.
                const gone = files.filter((f) => f.r2DeletedAt).length;
                if (gone === files.length) return `All ${files.length} raws removed from R2 after the Dropbox check. Dropbox keeps them.`;
                return `${files.length - gone} of ${files.length} raws still in R2${gone ? ` · ${gone} removed after the Dropbox check` : ""}. They leave R2 once Dropbox's copy is verified${videoOnly ? "" : " and editing is done"}.`;
              })()}
            </dd>
          </div>
        )}
        <div><dt>Timing</dt><dd className="adm-mono" style={{ fontSize: 12 }}>submitted {fmtWhen(shoot.submittedAt) || "no"}{shoot.readyAt ? ` · ready ${fmtWhen(shoot.readyAt)}` : ""}{shoot.qcCheckedAt ? ` · QC ${fmtWhen(shoot.qcCheckedAt)}` : ""}{shoot.publishedAt ? ` · published ${fmtWhen(shoot.publishedAt)}` : ""}</dd></div>
        {o?.notes && <div style={{ gridColumn: "1 / -1" }}><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{o.notes}</dd></div>}
        {shoot.autohdrPhotoshootId && <div><dt>Editing ref</dt><dd className="adm-mono">{shoot.autohdrPhotoshootId}</dd></div>}
      </dl>

      {!videoOnly && (
        <div className="adm-section" id="frames">
          <div className="adm-section-head">
            <div className="kicker">Frames{frames.length ? ` · ${frames.length}` : ""}</div>
            {framesIn && <span className="muted" style={{ fontSize: 12.5 }}>Only approved photos ever reach the client. Rejected photos drop to the Rejected section at the bottom and are never visible; unreviewed photos stay internal until approved.{finalsN ? " The editors' revised photos arrive approved: reject what should not ship, then Publish." : ""}</span>}
          </div>
          <ShootReview key={`${shoot.updatedAt}:${frames.length}:${frames.filter((f) => f.qcCheckedAt).length}`} shootId={shoot.id} listingId={shoot.listingId} status={shoot.status} frames={frames} demo={demo} shootPublished={shootPublished} twilight={makeTwilight} admin={admin} revision={round ? { frames: round.frames, summary: roundSummary } : null} />
        </div>
      )}

      {!videoOnly && (
        <div className="adm-section" id="finals">
          <div className="adm-section-head">
            <div className="kicker">Upload corrected photos</div>
            <span className="muted" style={{ fontSize: 12.5 }}>Editors: Download all for editing, fix the frames and tick each QC flag, drop the corrected JPGs here with the same filenames (they land in Revised), Run QC again, then Send for final review at the top.</span>
          </div>
          <div className="adm-card">
            <UploadFinals shootId={shoot.id} listingId={shoot.listingId} demo={demo} frameNames={frames.map((f) => f.filename)} enabled={framesIn || shoot.status === "failed"} reviewers={reviewers} siblings={siblings} />
          </div>
        </div>
      )}

      {replacedOriginals.length > 0 && (
        <details className="adm-section shoot-files" style={{ marginTop: 32 }}>
          <summary className="kicker" style={{ cursor: "pointer" }}>Replaced originals · {replacedOriginals.length} · internal only</summary>
          <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>The files a corrected upload replaced, kept in storage. Clients never see these.</p>
          <div className="adm-table-wrap" style={{ marginTop: 12 }}>
            <div className="adm-table-scroll">
              <table className="adm-table">
                <tbody>
                  {replacedOriginals.map((r) => (
                    <tr key={r.id}>
                      <td className="adm-mono">{r.filename}</td>
                      <td className="adm-mono muted" style={{ whiteSpace: "nowrap" }}>replaced {fmtWhen(r.at)}{r.by ? ` · ${r.by}` : ""}</td>
                      <td style={{ textAlign: "right" }}><a href={r.href} className="adm-chip adm-chip--quiet">Download original</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}

      <details className="adm-section shoot-files" style={{ marginTop: 32 }}>
        <summary className="kicker" style={{ cursor: "pointer" }}>Uploaded files · {files.length}{shoot.fileCount > files.length ? ` of ${shoot.fileCount} shown` : ""}</summary>
        <div className="adm-table-wrap" style={{ marginTop: 12 }}>
          <div className="adm-table-scroll">
            <table className="adm-table">
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td className="adm-mono">{f.filename}</td>
                    <td className="adm-mono muted">{fmtBytes(f.bytes)}</td>
                    <td className="muted">{f.kind === "raw_video" ? "raw video" : f.kind}</td>
                    <td className="muted">{f.kind === "raw_video" ? "not for editing" : f.uploaded ? "sent to editing" : "in storage"}</td>
                    <td className="muted" style={{ textAlign: "right", whiteSpace: "nowrap" }} title={f.dropboxPath ?? undefined}>{f.dropboxSyncedAt ? "in Dropbox" : mirrorState === "off" ? "" : "not in Dropbox yet"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {admin && !demo && (
        <div className="adm-section" style={{ marginTop: 40 }}>
          <div className="adm-section-head"><div className="kicker">Danger zone</div></div>
          <div className="adm-card" style={{ display: "grid", gap: 12, borderRadius: 14, borderColor: "rgba(215,52,42,.35)" }}>
            <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
              Two shoots on this listing that should be one? Merge keeps the photos the client sees now, from both shoots, on the shoot you keep, deletes every other frame of both (files stay in storage) and deletes this shoot. You see a preview first.
            </p>
            <div className="adm-actions">
              <Link href={`/admin/shoots/${shoot.id}/merge`} className="adm-chip">Merge into another shoot…</Link>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
