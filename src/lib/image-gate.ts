// How much image work one server instance does at a time (Nov 10 2026).
//
// Why this exists. Uploading corrected finals to 3330 Example Cedar Road failed
// file after file with "Unexpected token '<', "<!DOCTYPE "... is not valid
// JSON". The hosting logs show the cause: "instance was killed because it ran
// out of available memory", 37 times between Oct 28 and Nov 10, on the two
// ingest routes, the cron and whatever else was in flight on that instance.
// An instance has about 2 GB and serves many requests at once, and nothing
// limited how many full-size photos it decoded together: every ingest call
// worked on three photos, each decoded three times, two people uploading at
// once doubled that, and the admin grid asks for missing thumbnails all at
// the same moment. The photos were 100 megapixel finals (12288 x 8192).
// Measured on those files: about 650 MB for one old call, and 3 GB when the
// photos are progressive JPEGs. When an instance dies, every request on it
// gets the platform's HTML error page, which the browser then failed to read.
//
// The rule now: image work waits its turn. Two gates, both per instance and
// shared by every route in it (they live on globalThis, so a second copy of
// this module in another bundle still uses the same ones):
//
//   withOriginalSlot  at most ORIGINALS originals held in memory at once
//                     (the download and everything done with the bytes);
//   withPixelBudget   decodes in flight add up to at most PIXEL_BUDGET
//                     megapixels: one 100 MP photo on its own, two 61 MP
//                     frames together, five 24 MP ones. A progressive JPEG
//                     counts double (its decoder keeps the whole image's
//                     coefficients). Anything bigger than the budget runs
//                     alone. First come, first served, so a big photo is
//                     never starved by a stream of small ones.
//
// Always take them in that order (slot, then budget); nothing takes the
// budget and then asks for a slot, so they cannot lock each other.
//
// Memory is logged when it runs high, so the next squeeze shows up in the
// hosting logs as a warning with numbers before it becomes an outage.

type Waiter = { cost: number; go: () => void };

export class Gate {
  private used = 0;
  private readonly queue: Waiter[] = [];
  constructor(readonly capacity: number) {}

  get inUse(): number {
    return this.used;
  }
  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(cost: number, fn: () => Promise<T>): Promise<T> {
    // Never more than the whole gate, so an oversize job runs alone instead of waiting forever.
    const c = Math.min(this.capacity, Math.max(1, Number.isFinite(cost) ? cost : this.capacity));
    if (this.queue.length || this.used + c > this.capacity) {
      await new Promise<void>((go) => this.queue.push({ cost: c, go }));
    } else {
      this.used += c;
    }
    try {
      return await fn();
    } finally {
      this.used -= c;
      this.pump();
    }
  }

  // Strictly in order: the head of the line goes as soon as it fits.
  private pump() {
    while (this.queue.length && this.used + this.queue[0].cost <= this.capacity) {
      const w = this.queue.shift()!;
      this.used += w.cost;
      w.go();
    }
  }
}

const num = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

// Megapixels decoding at once, and originals in memory at once, per instance.
export const PIXEL_BUDGET = num(process.env.IMAGE_PIXEL_BUDGET_MP, 125, 10, 2000);
export const ORIGINALS = num(process.env.IMAGE_ORIGINALS_AT_ONCE, 3, 1, 32);
// Log a warning above this much resident memory (MB). The instance has about 2 GB.
const WARN_RSS_MB = num(process.env.IMAGE_WARN_RSS_MB, 1300, 100, 100000);

type Gates = { pixels: Gate; originals: Gate; warnedAt: number };
const KEY = Symbol.for("studio.image-gates.v1");
function gates(): Gates {
  const g = globalThis as unknown as Record<symbol, Gates | undefined>;
  return (g[KEY] ??= { pixels: new Gate(PIXEL_BUDGET), originals: new Gate(ORIGINALS), warnedAt: 0 });
}

function watchMemory(what: string) {
  const g = gates();
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  if (rss < WARN_RSS_MB || Date.now() - g.warnedAt < 30_000) return;
  g.warnedAt = Date.now();
  console.warn(`[image-gate] memory is high after ${what}: ${rss} MB resident, ${g.pixels.inUse} of ${PIXEL_BUDGET} MP decoding, ${g.pixels.waiting} waiting, ${g.originals.inUse} originals held, ${g.originals.waiting} waiting`);
}

// What a decode costs against the budget: megapixels, doubled for a
// progressive JPEG. Unknown size (a header that cannot be read) costs the
// whole budget, so it runs alone and fails on its own.
export function pixelCost(meta: { width?: number; height?: number; isProgressive?: boolean }): number {
  if (!meta.width || !meta.height) return PIXEL_BUDGET;
  const mp = (meta.width * meta.height) / 1_000_000;
  return Math.max(1, mp * (meta.isProgressive ? 2 : 1));
}

export async function withPixelBudget<T>(cost: number, fn: () => Promise<T>): Promise<T> {
  try {
    return await gates().pixels.run(cost, fn);
  } finally {
    watchMemory("a decode");
  }
}

// Hold one original in memory: wrap the download and all the work on its bytes.
export async function withOriginalSlot<T>(fn: () => Promise<T>): Promise<T> {
  return gates().originals.run(1, fn);
}

// For the health page and the check script.
export function imageGateState(): { pixelBudget: number; pixelsInUse: number; pixelsWaiting: number; originals: number; originalsInUse: number; originalsWaiting: number; rssMb: number } {
  const g = gates();
  return { pixelBudget: PIXEL_BUDGET, pixelsInUse: g.pixels.inUse, pixelsWaiting: g.pixels.waiting, originals: ORIGINALS, originalsInUse: g.originals.inUse, originalsWaiting: g.originals.waiting, rssMb: Math.round(process.memoryUsage().rss / 1048576) };
}
