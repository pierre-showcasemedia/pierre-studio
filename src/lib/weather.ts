// Weather on the booking calendar (Oct 26 2026: the coordinator's idea, "make
// that standard from now on for all bookings"). Every live booking's event on
// the business MAIN carries the forecast for its own address and shoot hours: a badge
// in front of the title ("⛅ 66°", with the rain chance when there is one), one
// "Weather:" line at the top of the description, and a color when it matters:
// Tomato for rain, Banana for a rain chance or a heavy overcast.
//
// Oct 31 2026 (the owner: "10 times less complicated", "just one or two lines",
// the OVERALL weather, "if its gonna be cloudy, raining, no views"): the hour
// by hour table and the golden hour line are gone. The line is the sky, the
// temperature, the wind when it matters, the rain chance, fog or heavy cloud
// that would hide the views, the twilight outlook when the shoot runs into
// sunset, and the sunset time.
//
// Sources, both free for business use and keyless: the US Census geocoder
// (address to coordinates) and the National Weather Service (api.weather.gov:
// hourly forecast, about 6.5 days out, plus sky cover from the grid data).
// Sunset, golden hour and dusk are worked out here from the coordinates (NOAA's
// solar equations), so they never depend on a third call. Open-Meteo, which
// the coordinator's mockup named, is free for non-commercial use only.
//
// This file fetches and formats; src/lib/google-calendar.ts writes it onto the
// events (refreshBookingWeather) and the minute cron queues the refresh every
// three hours (scheduleWeatherRefresh).
import { BUSINESS_TZ } from "./booking-time";

const UA = "studio-weather (+https://www.weather.gov)";
const TIMEOUT_MS = 12_000;

export type WeatherHour = {
  start: Date;
  end: Date;
  isDaytime: boolean;
  tempF: number | null;
  pop: number; // chance of rain, 0 to 100
  windMph: number | null;
  sky: number | null; // cloud cover, 0 to 100
  text: string; // NWS shortForecast: "Mostly Sunny", "Chance Light Rain"
};

export type SunTimes = { goldenFrom: Date | null; sunset: Date | null; dusk: Date | null };

export type BookingWeather = {
  day: string; // the shoot's local day, YYYY-MM-DD
  badge: string; // "⛅ 66°" or "🌧️ 61° 70%"
  color: "11" | "5" | null; // Google Calendar colorId: 11 Tomato (rain), 5 Banana (watch)
  block: string; // the description line (HTML): starts with WEATHER_HEAD, ends with "(forecast <when>)"
};

export const WEATHER_HEAD = "Weather:";
// The block wherever it sits in a description: the one line (Oct 31 2026),
// the HTML table before it, the first plain text one (Oct 26 2026, "WEATHER
// AT THIS ADDRESS ... Refreshes every 3 hours."), and any of them after Google
// rewrites the HTML on a hand edit. Replaced in place, so an event moves to
// the one line on its next refresh.
export const WEATHER_BLOCK_RE =
  /(?:<(?:b|strong)>\s*Weather:\s*<\/(?:b|strong)>[\s\S]*?\(forecast [^)]*\)|(?:<(?:b|strong)>\s*)?(?:WEATHER AT THIS ADDRESS|Weather at this address)[\s\S]*?National Weather Service(?:\. Refreshes every 3 hours\.)?)(?:\s*<\/(?:i|em)>)?(?:\s|<br\s*\/?>)*/;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  let last: unknown = null;
  // The weather service answers 500 now and then; one more try covers it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, ...headers }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) return await r.json();
      last = new Error(`${new URL(url).host} answered ${r.status}`);
      if (r.status < 500) break;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// ---- Address to coordinates -------------------------------------------------

const geoCache = new Map<string, { lat: number; lon: number } | null>();

export async function geocode(address: string): Promise<{ lat: number; lon: number } | null> {
  const key = address.trim().toLowerCase();
  if (!key) return null;
  if (geoCache.has(key)) return geoCache.get(key) ?? null;
  const q = new URLSearchParams({ address: address.trim(), benchmark: "Public_AR_Current", format: "json" });
  const j = (await getJson(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${q}`)) as {
    result?: { addressMatches?: { coordinates?: { x?: number; y?: number } }[] };
  };
  const c = j.result?.addressMatches?.[0]?.coordinates;
  const hit = c && typeof c.x === "number" && typeof c.y === "number" ? { lat: c.y, lon: c.x } : null;
  geoCache.set(key, hit);
  return hit;
}

// ---- The forecast -------------------------------------------------------------

const pointCache = new Map<string, { hourly: string; grid: string }>();

// "2026-10-26T18:00:00+00:00/PT6H" → [start, end).
function parseValidTime(v: string): [number, number] | null {
  const [iso, dur] = v.split("/");
  const start = Date.parse(iso);
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(dur ?? "");
  if (Number.isNaN(start) || !m) return null;
  const ms = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
  return [start, start + ms];
}

export async function hourlyForecast(lat: number, lon: number): Promise<WeatherHour[]> {
  const at = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const geo = { accept: "application/geo+json" };
  let point = pointCache.get(at);
  if (!point) {
    const p = (await getJson(`https://api.weather.gov/points/${at}`, geo)) as { properties?: { forecastHourly?: string; forecastGridData?: string } };
    if (!p.properties?.forecastHourly || !p.properties.forecastGridData) throw new Error("the weather service has no forecast for this spot");
    point = { hourly: p.properties.forecastHourly, grid: p.properties.forecastGridData };
    pointCache.set(at, point);
  }
  const h = (await getJson(`${point.hourly}?units=us`, geo)) as {
    properties?: { periods?: { startTime: string; endTime: string; isDaytime: boolean; temperature: number | null; probabilityOfPrecipitation?: { value: number | null }; windSpeed?: string; shortForecast?: string }[] };
  };
  // Cloud cover is only in the grid data. Without it the hours still show.
  let sky: { from: number; to: number; value: number }[] = [];
  try {
    const g = (await getJson(point.grid, geo)) as { properties?: { skyCover?: { values?: { validTime: string; value: number | null }[] } } };
    sky = (g.properties?.skyCover?.values ?? []).flatMap((v) => {
      const span = parseValidTime(v.validTime);
      return span && typeof v.value === "number" ? [{ from: span[0], to: span[1], value: v.value }] : [];
    });
  } catch {
    sky = [];
  }
  return (h.properties?.periods ?? []).map((p) => {
    const start = new Date(p.startTime);
    const wind = /(\d+)(?:\D+(\d+))?/.exec(p.windSpeed ?? "");
    const cover = sky.find((s) => s.from <= start.getTime() && start.getTime() < s.to);
    return {
      start,
      end: new Date(p.endTime),
      isDaytime: p.isDaytime,
      tempF: typeof p.temperature === "number" ? p.temperature : null,
      pop: p.probabilityOfPrecipitation?.value ?? 0,
      windMph: wind ? Number(wind[2] ?? wind[1]) : null,
      sky: cover ? Math.round(cover.value) : null,
      text: (p.shortForecast ?? "").trim(),
    };
  });
}

// ---- Sunset, golden hour, dusk (NOAA's general solar position equations) -----

// When the sun's center is at `zenith` degrees in the evening of `ymd` (local
// date) at lat/lon. 90.833 is sunset, 84 the start of golden hour (6° up), 96
// civil dusk. Null where the sun never gets there that day.
export function eveningSunAt(lat: number, lon: number, ymd: string, zenith: number): Date | null {
  const [y, m, d] = ymd.split("-").map(Number);
  const dayOfYear = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const rad = (x: number) => (x * Math.PI) / 180;
  const cosHa = Math.cos(rad(zenith)) / (Math.cos(rad(lat)) * Math.cos(decl)) - Math.tan(rad(lat)) * Math.tan(decl);
  if (cosHa < -1 || cosHa > 1) return null;
  const ha = (Math.acos(cosHa) * 180) / Math.PI;
  const minutesUtc = 720 - 4 * (lon - ha) - eqTime;
  return new Date(Date.UTC(y, m - 1, d) + minutesUtc * 60_000);
}

export function sunTimes(lat: number, lon: number, ymd: string): SunTimes {
  return { goldenFrom: eveningSunAt(lat, lon, ymd, 84), sunset: eveningSunAt(lat, lon, ymd, 90.833), dusk: eveningSunAt(lat, lon, ymd, 96) };
}

// ---- Words and the block ------------------------------------------------------

const RAINY = /thunder|rain|shower|drizzle|sleet|snow/i;

export function hourEmoji(h: Pick<WeatherHour, "text" | "pop" | "isDaytime" | "sky">): string {
  const t = h.text.toLowerCase();
  if (/thunder/.test(t)) return "⛈️";
  if (RAINY.test(t)) return h.pop >= 50 ? "🌧️" : "🌦️";
  if (/fog|haze|smoke/.test(t)) return "🌫️";
  if (!h.isDaytime) return /cloudy/.test(t) && !/partly/.test(t) ? "☁️" : "🌙";
  if (/^(sunny|clear)$/.test(t)) return "☀️";
  if (/mostly (sunny|clear)/.test(t)) return "🌤️";
  if (/partly/.test(t)) return "⛅";
  if (/cloudy|overcast/.test(t)) return "☁️";
  if (h.sky == null) return "⛅";
  return h.sky < 20 ? "☀️" : h.sky < 50 ? "🌤️" : h.sky < 80 ? "⛅" : "☁️";
}

// Worst first: the badge shows the worst sky of the shoot hours.
const SEVERITY = ["⛈️", "🌧️", "🌦️", "🌫️", "☁️", "⛅", "🌤️", "🌙", "☀️"];

const fmtClock = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "2-digit" }).format(d);
const localHour = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", hourCycle: "h23" }).format(d)) % 24;
const fmtStamp = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(d).replace(",", "");

// "11am", for "clearing by 11am".
const hourLabel = (d: Date) => {
  const h = localHour(d);
  return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
};

// The one line: "Sunny, 64 to 67°, breezy. Rain chance 29%. Sunset 5:06 PM."
function summary(during: WeatherHour[], shown: WeatherHour[], shoot: { start: Date; end: Date }, sun: SunTimes): string {
  const sky = mostCommon(during.map((h) => h.text)) || "Forecast";
  const winds = during.map((h) => h.windMph).filter((w): w is number => w != null);
  const wind = winds.length ? Math.max(...winds) : 0;
  const temps = during.map((h) => h.tempF).filter((t): t is number => t != null);
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const temp = temps.length ? (lo === hi ? `${lo}°` : `${lo} to ${hi}°`) : "";
  const out = [`${sky.charAt(0).toUpperCase()}${sky.slice(1).toLowerCase()}${temp ? `, ${temp}` : ""}${wind >= 25 ? ", windy" : wind >= 15 ? ", breezy" : ""}.`];
  const maxPop = Math.max(...during.map((h) => h.pop));
  out.push(maxPop >= 40 ? `Rain likely (${maxPop}%).` : maxPop >= 10 ? `Rain chance ${maxPop}%.` : "No rain.");
  // The views: fog or a heavy overcast hides them.
  const foggy = during.filter((h) => /fog|haze/i.test(h.text));
  const skies = during.map((h) => h.sky).filter((s): s is number => s != null);
  const meanSky = skies.length ? skies.reduce((x, y) => x + y, 0) / skies.length : null;
  if (foggy.length) {
    const clears = shown.find((h) => h.start > foggy[foggy.length - 1].start && !/fog|haze/i.test(h.text));
    out.push(clears ? `Fog early, clearing by ${hourLabel(clears.start)}.` : "Fog, views likely hidden.");
  } else if (meanSky != null && meanSky >= 85) out.push("Heavy cloud, views may be flat.");
  if (sun.sunset && sun.sunset.getTime() >= shoot.start.getTime() - 3600_000 && sun.sunset.getTime() <= shoot.end.getTime() + 3600_000) {
    const at = shown.find((h) => h.start <= sun.sunset! && sun.sunset! < h.end);
    if (at) {
      const cover = at.sky ?? (/cloudy/i.test(at.text) && !/partly/i.test(at.text) ? 85 : /partly/i.test(at.text) ? 45 : 10);
      out.push(at.pop >= 30 ? "Rain possible at sunset." : cover < 30 ? "Clear at sunset, good for twilight." : cover < 70 ? "Some clouds at sunset, good twilight color." : "Cloudy at sunset, flat twilight likely.");
    }
  }
  if (sun.sunset) out.push(`Sunset ${fmtClock(sun.sunset)}.`);
  return out.join(" ");
}

const mostCommon = (xs: string[]) => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

// The badge, color and line for one shoot, from the hourly forecast. Pure
// (the clock comes in as `now`), so scripts/check-weather.ts runs it offline.
// Null when the forecast does not reach the shoot yet.
export function describeWeather(
  hours: WeatherHour[],
  shoot: { day: string; start: Date; end: Date },
  sun: SunTimes,
  now: Date = new Date()
): BookingWeather | null {
  // The weather service calls 6 PM "night" in October; the sun decides here.
  const lit = sun.sunset ? sun.sunset.getTime() : null;
  hours = hours.map((h) => (lit != null && !h.isDaytime && h.start.getTime() < lit && h.start.getTime() > lit - 12 * 3600_000 ? { ...h, isDaytime: true } : h));
  const during = hours.filter((h) => h.start < shoot.end && h.end > shoot.start);
  if (!during.length) return null;
  // An hour either side of the shoot, for when the fog clears and the sky at sunset.
  const shown = hours.filter((h) => h.end.getTime() > shoot.start.getTime() - 3600_000 && h.start.getTime() <= shoot.end.getTime() + 3600_000).slice(0, 16);
  const maxPop = Math.max(...during.map((h) => h.pop));
  const skies = during.map((h) => h.sky).filter((s): s is number => s != null);
  const meanSky = skies.length ? skies.reduce((a, b) => a + b, 0) / skies.length : null;
  const rainy = maxPop >= 40 || during.some((h) => RAINY.test(h.text) && h.pop >= 30);
  const watch = !rainy && (maxPop >= 20 || (meanSky != null && meanSky >= 75));
  const emoji = during.map(hourEmoji).sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b))[0];
  const temp = during[0].tempF;
  const badge = `${emoji}${temp != null ? ` ${temp}°` : ""}${maxPop >= 20 ? ` ${maxPop}%` : ""}`;
  const block = `<b>${WEATHER_HEAD}</b> ${emoji} ${summary(during, shown, shoot, sun)} <i>(forecast ${fmtStamp(now)})</i>`;
  return { day: shoot.day, badge, color: rainy ? "11" : watch ? "5" : null, block };
}

// Everything for one address and shoot window, or null when the forecast does
// not reach it (more than about 6 days out) or the address does not geocode.
export async function weatherForShoot(address: string, shoot: { day: string; start: Date; end: Date }): Promise<BookingWeather | null> {
  const at = await geocode(address);
  if (!at) return null;
  const hours = await hourlyForecast(at.lat, at.lon);
  return describeWeather(hours, shoot, sunTimes(at.lat, at.lon, shoot.day));
}
