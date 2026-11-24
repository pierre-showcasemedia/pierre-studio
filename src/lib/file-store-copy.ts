// The team's words that name the file store (studio template, Nov 24 2026):
// the upload wizard's photo box and the Video board's header name the
// business's own file store (business.fileStore), not a fixed "Dropbox". Pure,
// no imports, so the wizard (a client component, which gets the name from the
// upload page's fileStoreName()) and the check script can use it.
export type FileStoreName = "Dropbox" | "Google Drive";

// The photo box under "Photos (sent for editing)".
export function wizardPhotoText(store: FileStoreName, editedOutside: boolean): string {
  return editedOutside
    ? `Optional: raws kept on the shoot and copied to ${store}, never sent to editing. Finished photos go on the listing page.`
    : `Raws and JPGs from Files, your camera roll or an SD card reader, or drop the whole raw folder. These go to editing, and a copy goes to ${store} (a dropped folder keeps its name there). Tap again to add more.`;
}

// The estimate's clip line and the saved banner's clip line.
export const wizardClipCost = (store: FileStoreName, clips: number): string => ` The ${clips} clip${clips === 1 ? "" : "s"} cost nothing: ${clips === 1 ? "it goes" : "they go"} to ${store} only.`;
export const wizardClipsLanded = (store: FileStoreName): string => `, and the video team hears once the clips are in ${store}`;

// The Video board's header.
export function videoBoardLede(store: FileStoreName, open: number, revisions: number): string {
  return `Every shoot with video, from booking to delivered. Cards move on their own: In editing when the footage is in ${store}, In review when a cut is uploaded, Sent to client with the delivery email, Complete 3 days later unless a revision is open. Drag one (or use its menu) to move it by hand, or open it for the music, pace and notes, the raw footage in ${store}, and what this client has asked for before. ${open} open${revisions ? `, ${revisions} with a revision` : ""}.`;
}
