// Where a shoot is, as one string a phone can navigate to (Nov 2026, a manager:
// "any calendar event that is a shoot has a clickable address so the creative
// specialist on the go in the field can navigate to it easily and quickly").
//
// Google Calendar turns an event's `location` into a tap-to-open-in-Maps link
// on phones, so every shoot event (the booking's own and each additional
// shoot's, src/lib/google-calendar.ts) carries the full street address there,
// and a Google Maps directions link sits at the top of its description.
//
// The listing's `address` is the display string ("100 Example Lane, Santa
// Barbara, CA 90000" from the booking form), but listings made in the admin or
// renamed by an operator can hold the street alone, or street and city. The
// split city / state / zip the form sends fill what the display string leaves
// out, never contradicting it: the state and zip are added only when the
// address's own city is the stored one (or there is none), so a renamed
// listing never gets a stale zip from somewhere else. Pure: no database, no
// network.

export type AddressParts = {
  address?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const STATE_TAIL = /(?:^|\s)[A-Z]{2}\.?(?:\s+\d{5}(?:-\d{4})?)?$/;
const ZIP = /\b\d{5}(?:-\d{4})?\b/;

// The listing's address made whole from its split parts, or (no listing) the
// booking form's property fields. "" when there is nothing to go on.
export function shootAddress(listing: AddressParts | null | undefined, property?: AddressParts | Record<string, unknown> | null): string {
  const p = (property ?? {}) as Record<string, unknown>;
  const base = clean(listing?.address) || clean(p.address) || clean(p.street) || clean(listing?.street);
  if (!base) return "";
  const city = clean(listing?.city) || clean(p.city);
  const state = (clean(listing?.state) || clean(p.state)).toUpperCase();
  const zip = clean(listing?.zip) || clean(p.zip);

  const parts = base.split(",").map(clean).filter(Boolean);
  if (parts.length === 1 && city && !same(parts[0], city)) parts.push(city);
  // Only fill the state and zip for the city we know them for.
  const addrCity = parts.length > 1 ? parts[1].replace(STATE_TAIL, "").trim() : "";
  if (city && addrCity && !same(addrCity, city)) return parts.join(", ");
  if (parts.length > 1) {
    const hasZip = ZIP.test(parts.slice(1).join(", "));
    const hasState = parts.slice(1).some((x) => STATE_TAIL.test(x));
    const last = parts.length - 1;
    if (!hasState && !hasZip) {
      const tail = [state, zip].filter(Boolean).join(" ");
      if (tail) parts.push(tail);
    } else if (hasState && !hasZip && zip) parts[last] = `${parts[last]} ${zip}`;
  }
  return parts.join(", ");
}

// Google's cross-platform directions link: opens the Maps app on a phone (or
// maps.google.com) with the route from wherever the shooter is.
export function directionsUrl(address: string): string | null {
  const a = clean(address);
  return a ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a)}` : null;
}

// The first line of a shoot event's description. A bare URL on its own line:
// Google Calendar links it in a plain text description, and asHtml()
// (google-calendar.ts) turns it into an <a> when the description becomes HTML.
export const DIRECTIONS_LABEL = "Directions: ";
export function directionsLine(address: string): string | null {
  const url = directionsUrl(address);
  return url ? `${DIRECTIONS_LABEL}${url}` : null;
}
