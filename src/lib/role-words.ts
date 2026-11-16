// Role words for the access lines (Oct 2026): "admin", "QA team", "creative
// specialist", "video editor", and the same with an article for "made X an admin". Pure, so
// the activity feed and the Slack hub share one vocabulary without importing
// each other.
export const roleWord = (r: unknown): string => (r === "qa" ? "photo QC" : r === "creative" ? "creative specialist" : r === "video" ? "video editor" : "admin");
export const roleAs = (r: unknown): string => (r === "qa" ? "photo QC" : r === "creative" ? "a creative specialist" : r === "video" ? "a video editor" : "an admin");
export const roleWordCap = (r: unknown): string => {
  const w = roleWord(r);
  return w.charAt(0).toUpperCase() + w.slice(1);
};
