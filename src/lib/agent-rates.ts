// Pierre's PRIVATE agent rate sheets (Nov 2026 PDF
// "Showcase-RealEstateServicesPriceList-WORKING-Nov2026"). Studio only: never
// copy this into the website's src/lib/pricing.ts, which ships in the public
// site's code. The website books everyone at the public rates; for these
// clients Pierre edits the invoice in the studio to their rate before sending.
// Every amount is US cents. null = no price on the sheet: quoted, ask Pierre.
// Server-side reference data only; nothing imports it into a client page.

export type RateLine = { item: string; cents: number | null; note?: string };
export type RateSheet = { id: string; name: string; who: string; lines: readonly RateLine[]; notes: readonly string[] };

// Shared by the two Stark-style sheets (Stark Preferred and Preferred Agent).
const SHARED_PREFERRED: readonly RateLine[] = [
  { item: "Free basic floor plan, up to 3,000 scanned sq ft", cents: 0 },
  { item: "Floor plan, large property 3,001 to 5,000 sq ft", cents: 30_00 },
  { item: "Floor plan, large property 5,001 to 7,500 sq ft", cents: 50_00 },
  { item: "Floor plan, large property 7,501 to 10,000 sq ft", cents: 75_00 },
  { item: "Additional images", cents: 4_00, note: "each" },
  { item: "Aerial photos", cents: 69_00 },
  { item: "Matterport 3D tour, up to 1,200 scanned sq ft", cents: 125_00 },
  { item: "Matterport 3D tour, 1,201 to 3,000 scanned sq ft", cents: 150_00 },
  { item: "Matterport 3D tour, 3,001 to 5,000 scanned sq ft", cents: 200_00 },
  { item: "Matterport 3D tour, 5,001 to 7,500 scanned sq ft", cents: 300_00 },
  { item: "Showcase Walkthrough Video (60 to 90 sec)", cents: 175_00 },
  { item: "Complete Walkthrough Video (2+ min), up to 2,500 sq ft", cents: 225_00 },
  { item: "Complete Walkthrough Video (2+ min), 2,501 to 5,000 sq ft", cents: 255_00 },
  { item: "Complete Walkthrough Video (2+ min), 5,001 to 7,500 sq ft", cents: 280_00 },
  { item: "Complete Walkthrough Video (2+ min), 7,501 to 10,000 sq ft", cents: 310_00 },
  { item: "Agent guided tour", cents: 69_00 },
  { item: "Advanced video imaging", cents: 30_00, note: "per clip" },
  { item: "Virtual staging, 1 to 3 photos", cents: 30_00, note: "each" },
  { item: "Virtual staging, 4+ photos", cents: 25_00, note: "each" },
  { item: "Virtual twilight, 1 to 3 images", cents: 20_00, note: "each" },
  { item: "Virtual twilight, 4+ images", cents: 15_00, note: "each" },
];

const SHARED_NOTES = [
  "Travel: free within 25 miles, then $0.50 a mile round trip.",
  "Cancelling or rescheduling with less than 24 hours notice: 50%, plus any travel fees if Pierre is already on the way.",
];

export const AGENT_RATE_SHEETS: readonly RateSheet[] = [
  {
    id: "stark_preferred",
    name: "Stark Preferred",
    who: "Stark Company Realtors agents",
    lines: [
      { item: "Stark Basic Photos, up to 25 images (floor plan extra)", cents: 150_00 },
      { item: "Stark Showcase Photography, up to 40 images", cents: 169_00 },
      { item: "Stark Aerial Video (edited)", cents: 130_00 },
      { item: "Stark Aerial Bundle (aerial photos and video)", cents: 195_00 },
      ...SHARED_PREFERRED,
    ],
    notes: SHARED_NOTES,
  },
  {
    id: "preferred_agent",
    name: "Preferred Agent",
    who: "Preferred agents (any brokerage)",
    lines: [
      { item: "Preferred Showcase Photography, up to 40 images", cents: 169_00 },
      { item: "Aerial Video (edited)", cents: 130_00 },
      { item: "Aerial Bundle (aerial photos and video)", cents: 195_00 },
      ...SHARED_PREFERRED,
    ],
    notes: SHARED_NOTES,
  },
  {
    id: "hometeam4u",
    name: "HomeTeam4U",
    who: "HomeTeam4U agents",
    lines: [
      { item: "Showcase Photography, up to 40 photos, free floor plan up to 3,000 sq ft, 1 virtual twilight photo", cents: null, note: "sheet says $150 to 165: ask Pierre" },
      { item: "Additional images", cents: 3_00, note: "each" },
      { item: "Walkthrough Package, up to 1,200 sq ft", cents: 464_00 },
      { item: "Walkthrough Package, 1,201 to 3,000 sq ft", cents: 514_00 },
      { item: "Walkthrough Package, 3,001 to 6,000 sq ft", cents: 640_00 },
      { item: "Walkthrough Package, 6,001 to 7,999 sq ft", cents: 865_00 },
      { item: "Twilight photography (6 to 8 images)", cents: 125_00 },
      { item: "Advanced video imaging", cents: 30_00, note: "per clip" },
      { item: "Virtual staging, 1 to 3 photos", cents: 30_00, note: "each" },
      { item: "Virtual staging, 4+ photos", cents: 25_00, note: "each" },
      { item: "Virtual twilight, 1 to 3 images", cents: 20_00, note: "each" },
      { item: "Virtual twilight, 4+ images", cents: 15_00, note: "each" },
    ],
    notes: [
      "Walkthrough Package: Showcase Photography up to 40, Zillow 3D tour with floor plan, 1 virtual twilight, drone photos and unedited drone clips, unedited walkthrough clips with or without the agent, 1 advanced AI imaging clip; additional images $3.",
      "Travel: free within 30 miles (the HomeTeam4U agreement), then $0.50 a mile round trip.",
      "Cancelling or rescheduling with less than 24 hours notice: 50%, plus any travel fees if Pierre is already on the way.",
      "The sheet says: \"Prices do not have the $150 Stark covered fee deducted.\" Ask Pierre what this means for billing.",
    ],
  },
];
