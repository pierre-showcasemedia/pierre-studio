// The agent's headshot and logo (#16): the pure checks in
// src/lib/profile-images.ts. No database, no network.
//
//   npx tsx scripts/check-profile-images.ts
import { isProfileKey, isProfileKind, PROFILE_IMAGE_MAX_BYTES, profileImageKey, profileImageRefusal, sniffImageType } from "../src/lib/profile-images";

let failures = 0;
let passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL ${what}`);
  }
};
const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const webp = new Uint8Array([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBPVP8 ")]);
ok(sniffImageType(jpeg) === "jpeg", "a JPEG is read as JPEG");
ok(sniffImageType(png) === "png", "a PNG is read as PNG");
ok(sniffImageType(webp) === "webp", "a WebP is read as WebP");
ok(sniffImageType(ascii('<svg xmlns="http://www.w3.org/2000/svg">')) === null, "an SVG is refused");
ok(sniffImageType(ascii("GIF89a......")) === null, "a GIF is refused");
ok(sniffImageType(ascii("%PDF-1.7")) === null, "a PDF is refused");
ok(sniffImageType(bytes(0xff, 0xd8)) === null, "a cut-off header is refused");
ok(sniffImageType(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")])) === null, "a RIFF that is not WebP is refused");

ok(profileImageRefusal({ size: 1000, head: jpeg }) === null, "a small JPEG goes ahead");
ok(profileImageRefusal({ size: PROFILE_IMAGE_MAX_BYTES, head: png }) === null, "exactly the limit goes ahead");
ok(/4 MB/.test(profileImageRefusal({ size: PROFILE_IMAGE_MAX_BYTES + 1, head: png }) ?? ""), "over the limit is refused");
ok(profileImageRefusal({ size: 0, head: new Uint8Array() }) !== null, "an empty file is refused");
ok(profileImageRefusal({ size: 1000, head: ascii("<html>") }) !== null, "a page named .jpg is refused");
for (const k of ["headshot", "logo"]) ok(isProfileKind(k), `${k} is a kind`);
ok(!isProfileKind("cover") && !isProfileKind(null), "nothing else is a kind");

const key = profileImageKey("1b2c-3d", "headshot", "ab12");
ok(key === "clients/1b2c-3d/profile/headshot-ab12.jpg", `the headshot key (${key})`);
ok(profileImageKey("1b2c", "logo", "x").endsWith(".png"), "a logo is a PNG");
ok(!profileImageKey("../../x", "logo", "../y").includes(".."), "ids and nonces cannot climb out of the folder");
ok(isProfileKey(key, "1b2c-3d") && !isProfileKey("listings/a/edited/b.jpg", "1b2c-3d") && !isProfileKey(key, "other") && !isProfileKey(null, "1b2c-3d"), "only this client's profile keys are ever removed");

// Client-facing copy rules on the refusal lines.
for (const line of [profileImageRefusal({ size: 0, head: jpeg }), profileImageRefusal({ size: 1, head: ascii("x") }), profileImageRefusal({ size: PROFILE_IMAGE_MAX_BYTES + 1, head: jpeg })]) {
  ok(line && !/[—!]|--/.test(line), `plain copy: ${line}`);
}

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `All ${passes} checks passed`);
process.exit(failures ? 1 : 0);
