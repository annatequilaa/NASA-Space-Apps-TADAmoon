import * as Astronomy from "astronomy-engine";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const FORECAST_HOURS = 720;
export const MISSION_HOURS = 336;
export const RAD = Math.PI / 180;
export const AU_KM = 149_597_870.7;

const BASE_HEIGHT = 2;
const FLOOR = -2;
const SOLAR_MU = 132_712_440_041.9394;
const MOON_MU = 4902.800118;
const MOON_RADIUS_M = 1_737_400;
const MOON_RADIUS_KM = 1737.4;
const SUN_RADIUS_KM = 695_700;

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const normalizeLon = (lon: number) => ((lon % 360) + 360) % 360;
export const add = (a: number[], b: number[]) => a.map((value, i) => value + b[i]);
export const sub = (a: number[], b: number[]) => a.map((value, i) => value - b[i]);
export const scale = (a: number[], amount: number) => a.map((value) => value * amount);
export const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
export const norm = (a: number[]) => Math.hypot(...a);
export const cross = ([ax, ay, az]: number[], [bx, by, bz]: number[]): [number, number, number] => [
  ay * bz - az * by,
  az * bx - ax * bz,
  ax * by - ay * bx,
];

export interface RawTerrainProfile {
  lat: number;
  lon: number;
  surface_elev_m: number;
  horizon_deg: number[];
  horizon_observer_height_m?: number;
  ridge_dist_m?: number[] | number;
  mesh_rel_m?: number[][];
}

export type SiteQuality = "Profile" | "Borrowed" | "Flat";

export interface LandingSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  quality: SiteQuality;
  borrowedFrom: { name: string; distance: number } | null;
  clamped: boolean[];
  horizon: number[];
  floorFraction: number;
  mesh: number[][] | null;
  elevation: number | null;
  ridgeDistances: number[] | number | undefined;
  baseHeight: number;
  terrain?: RawTerrainProfile;
}

const SITE_NAMES: [string, number, number][] = [
  ["Apollo 11", 0.674, 23.473],
  ["Apollo 12", -3.012, 336.578],
  ["Apollo 14", -3.645, 342.529],
  ["Apollo 15", 26.132, 3.633],
  ["Apollo 16", -8.973, 15.5],
  ["Apollo 17", 20.191, 30.772],
  ["Chandrayaan-3", -69.373, 32.319],
  ["Chang’e 4", -45.446, 177.599],
  ["Chang’e 5", 43.058, 308.084],
  ["Chang’e 6", -41.639, 206.015],
  ["SLIM", -13.3, 25.25],
  ["Blue Ghost M1", 18.56, 61.81],
  ["Luna 25 planned", -57.865, 61.36],
  ["IM-2 planned", -84.8, 29.2],
];

function makeSite(
  id: string,
  name: string,
  lat: number,
  lon: number,
  terrain: RawTerrainProfile | null | undefined,
  quality: SiteQuality,
  borrowedFrom: { name: string; distance: number } | null = null,
): LandingSite {
  const clamped = terrain
    ? terrain.horizon_deg.map((value) => Math.abs(value - FLOOR) < 1e-6)
    : Array<boolean>(360).fill(false);
  return {
    id,
    name,
    lat,
    lon: normalizeLon(lon),
    quality,
    borrowedFrom,
    clamped,
    horizon: terrain?.horizon_deg ?? Array<number>(360).fill(0),
    floorFraction: clamped.filter(Boolean).length / 360,
    mesh: terrain?.mesh_rel_m ?? null,
    elevation: quality === "Profile" && terrain ? terrain.surface_elev_m : null,
    ridgeDistances: terrain?.ridge_dist_m,
    baseHeight: terrain?.horizon_observer_height_m ?? BASE_HEIGHT,
  };
}

export function readSites(data: Record<string, RawTerrainProfile>) {
  const sites: LandingSite[] = Object.entries(data)
    .filter(
      ([, terrain]) =>
        terrain.horizon_deg.some((value) => value !== 0) &&
        terrain.horizon_deg.filter((value) => Math.abs(value - FLOOR) < 1e-6).length < 342,
    )
    .map(([fullName, terrain], i) => ({
      ...makeSite(`terrain-${i}`, fullName.split(" (")[0], terrain.lat, terrain.lon, terrain, "Profile"),
      terrain,
    }));
  const reference: LandingSite[] = SITE_NAMES.map(([name, lat, lon], i) =>
    makeSite(`reference-${i}`, name, lat, lon, null, "Flat"),
  );
  return { sites, reference };
}

export function customSite(lat: number, lon: number, sites: LandingSite[]): LandingSite {
  let closest: LandingSite | undefined;
  let distance = Infinity;
  for (const site of sites) {
    const dLat = (lat - site.lat) * RAD;
    const dLon = (lon - site.lon) * RAD;
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(lat * RAD) * Math.cos(site.lat * RAD) * Math.sin(dLon / 2) ** 2;
    const distanceKm = ((2 * MOON_RADIUS_M) / 1000) * Math.asin(Math.sqrt(clamp(a, 0, 1)));
    if (distanceKm < distance) {
      closest = site;
      distance = distanceKm;
    }
  }
  const borrow = distance <= 10 && closest !== undefined;
  return makeSite(
    "custom",
    "Custom coordinates",
    lat,
    lon,
    borrow ? closest!.terrain : null,
    borrow ? "Borrowed" : "Flat",
    borrow ? { name: closest!.name, distance } : null,
  );
}

function rz(v: [number, number, number], a: number): [number, number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

function rx(v: [number, number, number], a: number): [number, number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}

/**
 * Compute Moon-centered apparent Sun and Earth vectors in the Mean Earth / Polar Axis (MOON_ME) frame
 * using astronomy-engine's solar/lunar vectors and Cassini + physical libration Euler angles.
 */
function computeSkySampleKm(whenMs: number): [number, number, number, number, number, number] {
  const date = new Date(whenMs);
  const time = Astronomy.MakeTime(date);
  const t = time.tt / 36525.0;
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t2 * t2;

  const I = RAD * 1.543;
  const f = RAD * normalizeLon(93.272095 + 483202.0175233 * t - 0.0036539 * t2 - t3 / 3526000 + t4 / 863310000);
  const omega = RAD * normalizeLon(125.0445479 - 1934.1362891 * t + 0.0020754 * t2 + t3 / 467441 - t4 / 60616000);
  const m = RAD * normalizeLon(357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + t3 / 24490000);
  const mdash = RAD * normalizeLon(134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + t3 / 69699 - t4 / 14712000);
  const d = RAD * normalizeLon(297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868 - t4 / 113065000);
  const e = 1.0 - 0.002516 * t - 0.0000074 * t2;
  const k1 = RAD * (119.75 + 131.849 * t);
  const k2 = RAD * (72.56 + 20.186 * t);

  const rho =
    (-0.02752 * Math.cos(mdash) -
      0.02245 * Math.sin(f) +
      0.00684 * Math.cos(mdash - 2 * f) -
      0.00293 * Math.cos(2 * f) -
      0.00085 * Math.cos(2 * f - 2 * d) -
      0.00054 * Math.cos(mdash - 2 * d) -
      0.0002 * Math.sin(mdash + f) -
      0.0002 * Math.cos(mdash + 2 * f) -
      0.0002 * Math.cos(mdash - f) +
      0.00014 * Math.cos(mdash + 2 * f - 2 * d)) *
    RAD;
  const sigma =
    (-0.02816 * Math.sin(mdash) +
      0.02244 * Math.cos(f) -
      0.00682 * Math.sin(mdash - 2 * f) -
      0.00279 * Math.sin(2 * f) -
      0.00083 * Math.sin(2 * f - 2 * d) +
      0.00069 * Math.sin(mdash - 2 * d) +
      0.0004 * Math.cos(mdash + f) -
      0.00025 * Math.sin(2 * mdash) -
      0.00023 * Math.sin(mdash + 2 * f) +
      0.0002 * Math.cos(mdash - f) +
      0.00019 * Math.sin(mdash - f) +
      0.00013 * Math.sin(mdash + 2 * f - 2 * d) -
      0.0001 * Math.cos(mdash - 3 * f)) *
    RAD;
  const tau =
    (0.0252 * e * Math.sin(m) +
      0.00473 * Math.sin(2 * mdash - 2 * f) -
      0.00467 * Math.sin(mdash) +
      0.00396 * Math.sin(k1) +
      0.00276 * Math.sin(2 * mdash - 2 * d) +
      0.00196 * Math.sin(omega) -
      0.00183 * Math.cos(mdash - f) +
      0.00115 * Math.sin(mdash - 2 * d) -
      0.00096 * Math.sin(mdash - d) +
      0.00046 * Math.sin(2 * f - 2 * d) -
      0.00039 * Math.sin(mdash - f) -
      0.00032 * Math.sin(mdash - m - d) +
      0.00027 * Math.sin(2 * mdash - m - 2 * d) +
      0.00023 * Math.sin(k2) -
      0.00014 * Math.sin(2 * d) +
      0.00014 * Math.cos(2 * mdash - 2 * f) -
      0.00012 * Math.sin(mdash - 2 * f) -
      0.00012 * Math.sin(2 * mdash) +
      0.00011 * Math.sin(2 * mdash - 2 * m - 2 * d)) *
    RAD;

  const rotEct = Astronomy.Rotation_EQJ_ECT(time);
  const gm = Astronomy.GeoMoon(time);
  const sunGeo = Astronomy.GeoVector(Astronomy.Body.Sun, time, true);

  const sunEqj = new Astronomy.Vector(sunGeo.x - gm.x, sunGeo.y - gm.y, sunGeo.z - gm.z, time);
  const earthEqj = new Astronomy.Vector(-gm.x, -gm.y, -gm.z, time);

  const toMoonME = (eqjVec: Astronomy.Vector): [number, number, number] => {
    const ect = Astronomy.RotateVector(rotEct, eqjVec);
    let v: [number, number, number] = [ect.x * AU_KM, ect.y * AU_KM, ect.z * AU_KM];
    const node = omega + sigma / Math.sin(I);
    v = rz(v, -node);
    v = rx(v, I + rho);
    v = rz(v, -(f + Math.PI + tau - sigma / Math.sin(I)));
    return v;
  };

  const s = toMoonME(sunEqj);
  const er = toMoonME(earthEqj);
  return [s[0], s[1], s[2], er[0], er[1], er[2]];
}

function computeOrbitSample(whenMs: number): number[] {
  const dtDays = 0.01;
  const dtMs = dtDays * DAY;
  const eNow = Astronomy.HelioVector(Astronomy.Body.Earth, new Date(whenMs));
  const ePlus = Astronomy.HelioVector(Astronomy.Body.Earth, new Date(whenMs + dtMs));
  const eMinus = Astronomy.HelioVector(Astronomy.Body.Earth, new Date(whenMs - dtMs));
  const moonState = Astronomy.GeoMoonState(new Date(whenMs));
  return [
    eNow.x,
    eNow.y,
    eNow.z,
    (ePlus.x - eMinus.x) / (2 * dtDays),
    (ePlus.y - eMinus.y) / (2 * dtDays),
    (ePlus.z - eMinus.z) / (2 * dtDays),
    moonState.x,
    moonState.y,
    moonState.z,
    moonState.vx,
    moonState.vy,
    moonState.vz,
  ];
}

interface EphemerisBlock {
  start: number;
  end: number;
  origin: number;
  rows: number;
  values?: Float32Array;
}

interface EphemerisChannel {
  min: number;
  max: number;
  end: number;
  step: number;
  width: number;
  chunks: EphemerisBlock[];
}

function buildSkyChunks(): EphemerisBlock[] {
  const chunks: EphemerisBlock[] = [];
  const step = 6 * HOUR;
  const endBound = Date.parse("2049-12-02T00:00:00Z");
  const startBound = Date.parse("1900-01-01T00:00:00Z");
  for (let year = 1900; year < 2050; year += 1) {
    const start = Date.UTC(year, 0, 1);
    const stop = Math.min(Date.UTC(year + 1, 0, 1), endBound);
    const origin = Math.max(startBound, start - 2 * step);
    const last = Math.min(endBound, stop + 2 * step);
    const rows = Math.round((last - origin) / step) + 1;
    chunks.push({ start, end: stop, origin, rows });
  }
  return chunks;
}

function buildOrbitChunks(): EphemerisBlock[] {
  const chunks: EphemerisBlock[] = [];
  const step = DAY;
  const startBound = Date.parse("1550-01-01T00:00:00Z");
  const endBound = Date.parse("2550-12-31T00:00:00Z");
  for (let year = 1550; year <= 2550; year += 5) {
    const start = Date.UTC(year, 0, 1);
    const stop = Math.min(Date.UTC(year + 5, 0, 1), endBound);
    if (start >= endBound) break;
    const origin = Math.max(startBound, start - step);
    const last = Math.min(endBound, stop + step);
    const rows = Math.round((last - origin) / step) + 1;
    chunks.push({ start, end: stop, origin, rows });
  }
  return chunks;
}

export class Ephemeris {
  metadata = {
    format: 1,
    moonRadiusKm: MOON_RADIUS_KM,
    sunRadiusKm: SUN_RADIUS_KM,
  };
  sky: EphemerisChannel;
  orbit: EphemerisChannel;

  constructor() {
    this.sky = {
      min: Date.parse("1900-01-01T00:00:00Z"),
      max: Date.parse("2049-11-01T00:00:00Z") + DAY - 60_000,
      end: Date.parse("2049-12-02T00:00:00Z"),
      step: 6 * HOUR,
      width: 6,
      chunks: buildSkyChunks(),
    };
    this.orbit = {
      min: Date.parse("1550-01-01T00:00:00Z"),
      max: Date.parse("2550-12-31T00:00:00Z"),
      end: Date.parse("2550-12-31T00:00:00Z"),
      step: DAY,
      width: 12,
      chunks: buildOrbitChunks(),
    };
  }

  async ensure(name: "sky" | "orbit", from: number, to = from) {
    const channel = this[name];
    const blocks = channel.chunks.filter((block) => block.start <= to && block.end >= from);
    if (!blocks.length) throw new Error("This date is outside the ephemeris range.");
    for (const block of blocks) {
      if (block.values) continue;
      const values = new Float32Array(block.rows * channel.width);
      for (let r = 0; r < block.rows; r++) {
        const when = block.origin + r * channel.step;
        const row = name === "sky" ? computeSkySampleKm(when) : computeOrbitSample(when);
        values.set(row, r * channel.width);
      }
      block.values = values;
    }
  }

  interval(name: "sky" | "orbit", when: number) {
    const channel = this[name];
    const { chunks, step, width } = channel;
    const block =
      chunks.find(({ start, end }) => when >= start && when < end) ??
      (when >= channel.end - 1 ? chunks[chunks.length - 1] : null);
    if (!block?.values) throw new Error("Ephemeris for this date has not loaded.");
    const x = (when - block.origin) / step;
    const index = clamp(Math.floor(x), 0, block.rows - 2);
    return {
      fraction: x - index,
      days: step / DAY,
      row: (offset: number, column: number) =>
        block.values![clamp(index + offset, 0, block.rows - 1) * width + column],
      hasPrevious: index > 0,
      hasNext: index + 2 < block.rows,
    };
  }

  skyAt(when: number): number[] {
    const { row, fraction: t, hasPrevious, hasNext } = this.interval("sky", when);
    return Array.from({ length: 6 }, (_, i) => {
      const a = row(0, i);
      const b = row(1, i);
      const v0 = hasPrevious ? (b - row(-1, i)) / 2 : b - a;
      const v1 = hasNext ? (row(2, i) - a) / 2 : b - a;
      return hermite(a, b, v0, v1, t)[0];
    });
  }

  orbitAt(when: number): OrbitPositions {
    const { row, fraction: t, days } = this.interval("orbit", when);
    const body = (offset: number): BodyState => {
      const state = [0, 1, 2].map((i) => {
        const j = i + offset;
        return hermite(row(0, j), row(1, j), days * row(0, j + 3), days * row(1, j + 3), t);
      });
      return { position: state.map((s) => s[0]), velocity: state.map((s) => s[1] / days) };
    };
    return { earth: body(0), lunar: body(6) };
  }
}

export interface BodyState {
  position: number[];
  velocity: number[];
}

export interface OrbitPositions {
  earth: BodyState;
  lunar: BodyState;
}

export interface LoadedDatabase {
  ephemeris: Ephemeris;
  sites: LandingSite[];
  reference: LandingSite[];
}

export async function loadData(): Promise<LoadedDatabase> {
  const response = await fetch("/data/terrain_profiles.json");
  if (!response.ok) {
    throw new Error(`Could not load terrain profiles (HTTP ${response.status}).`);
  }
  const terrain = (await response.json()) as Record<string, RawTerrainProfile>;
  return { ephemeris: new Ephemeris(), ...readSites(terrain) };
}

function hermite(a: number, b: number, v0: number, v1: number, t: number): [number, number] {
  const delta = b - a;
  const c = 3 * delta - 2 * v0 - v1;
  const d = -2 * delta + v0 + v1;
  return [a + t * (v0 + t * (c + t * d)), v0 + t * (2 * c + t * 3 * d)];
}

export function orbitMeasures({ earth, lunar }: OrbitPositions) {
  const moon = add(earth.position, lunar.position);
  const r = scale(moon, AU_KM);
  const v = scale(add(earth.velocity, lunar.velocity), AU_KM / 86400);
  const e = sub(scale(cross(v, cross(r, v)), 1 / (SOLAR_MU + MOON_MU)), scale(r, 1 / norm(r)));
  return {
    sunEarth: norm(earth.position) * AU_KM,
    earthMoon: norm(lunar.position) * AU_KM,
    sunMoon: norm(moon) * AU_KM,
    eccentricity: norm(e),
  };
}

function circularSample(profile: number[], azimuth: number): number {
  const a = Math.floor(azimuth) % 360;
  const f = azimuth - Math.floor(azimuth);
  return profile[a] * (1 - f) + profile[(a + 1) % 360] * f;
}

export interface BodySkyReading {
  alt: number;
  az: number;
  range: number;
  radius?: number;
  ridge: number;
  center: number;
  clearance: number;
  uncertain: boolean;
  fraction: number;
}

export interface SkySample {
  sun: BodySkyReading;
  earth: BodySkyReading;
}

export interface ObserverModel {
  at: (when: number) => SkySample;
  horizon: number[];
}

export function observerModel(
  ephemeris: Ephemeris,
  site: LandingSite,
  mast: number,
  assumedRidgeDistance: number,
): ObserverModel {
  const p = site.lat * RAD;
  const l = site.lon * RAD;
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = cross(up, east);
  const origin = scale(up, ephemeris.metadata.moonRadiusKm + ((site.elevation ?? 0) + mast) / 1000);
  const dip = (height: number) => Math.acos(MOON_RADIUS_M / (MOON_RADIUS_M + height)) / RAD;
  const dh = mast - site.baseHeight;
  const horizon = site.horizon.map((value, i) => {
    if (Math.abs(dh) < 0.01 || site.quality === "Flat") return value;
    const distance = Array.isArray(site.ridgeDistances) ? site.ridgeDistances[i] : site.ridgeDistances;
    const adjusted =
      value > 0
        ? Math.atan(Math.tan(value * RAD) - dh / (distance ?? assumedRidgeDistance)) / RAD
        : value - (dip(mast) - dip(site.baseHeight));
    return dh > 0 ? clamp(adjusted, Math.min(value, -dip(mast)), value) : Math.max(adjusted, value);
  });

  function altAz(vector: number[]): BodySkyReading {
    const offset = sub(vector, origin);
    const u = dot(offset, up);
    const e = dot(offset, east);
    const n = dot(offset, north);
    return {
      alt: Math.atan2(u, Math.hypot(e, n)) / RAD,
      az: normalizeLon(Math.atan2(e, n) / RAD),
      range: norm(offset),
      ridge: 0,
      center: 0,
      clearance: 0,
      uncertain: false,
      fraction: 0,
    };
  }

  function at(when: number): SkySample {
    const sky = ephemeris.skyAt(when);
    const sun = altAz(sky.slice(0, 3));
    const earth = altAz(sky.slice(3));
    sun.radius = Math.asin(ephemeris.metadata.sunRadiusKm / sun.range) / RAD;
    for (const body of [sun, earth]) {
      body.ridge = circularSample(horizon, body.az);
      body.center = body.alt - body.ridge;
      body.clearance = body.center + (body.radius ?? 0);
      const limb = body.alt + (body.radius ?? 0);
      body.uncertain = site.clamped[Math.round(body.az) % 360] && limb <= FLOOR && limb > FLOOR - 3;
    }
    const x = clamp(sun.center / sun.radius!, -1, 1);
    sun.fraction = (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / Math.PI;
    return { sun, earth };
  }

  return { at, horizon };
}

export function forecast(model: ObserverModel, start: number, hours = FORECAST_HOURS): SkySample[] {
  return Array.from({ length: hours + 1 }, (_, i) => model.at(start + i * HOUR));
}

function crossing(a: number, b: number): number {
  return a / (a - b);
}

export interface TransitionEvent {
  hour: number;
  rises: boolean;
}

export function transitions(samples: SkySample[], key: "sun" | "earth"): TransitionEvent[] {
  const result: TransitionEvent[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1][key].clearance;
    const b = samples[i][key].clearance;
    if (a > 0 !== b > 0) result.push({ hour: i - 1 + crossing(a, b), rises: b > 0 });
  }
  return result;
}

export interface MissionStats {
  sun: number;
  earth: number;
  disc: number;
  longest: number;
  uncertain: number;
}

export function summarize(samples: SkySample[], offset = 0): MissionStats {
  let dark = 0;
  let longest = 0;
  let shadowRun = 0;
  let blocked = 0;
  let fraction = 0;
  let uncertain = 0;
  for (let i = offset; i < offset + MISSION_HOURS; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const s0 = a.sun.clearance;
    const s1 = b.sun.clearance;
    const e0 = a.earth.clearance;
    const e1 = b.earth.clearance;
    const sunDark = blockedFraction(s0, s1);
    const earthDark = blockedFraction(e0, e1);
    dark += sunDark;
    blocked += earthDark;
    fraction += (a.sun.fraction + b.sun.fraction) / 2;
    shadowRun += sunDark;
    longest = Math.max(longest, shadowRun);
    if (s1 > 0) shadowRun = 0;
    if (a.sun.uncertain || a.earth.uncertain) uncertain++;
  }
  return {
    sun: 100 * (1 - dark / MISSION_HOURS),
    earth: 100 * (1 - blocked / MISSION_HOURS),
    disc: (100 * fraction) / MISSION_HOURS,
    longest,
    uncertain: (100 * uncertain) / MISSION_HOURS,
  };
}

function blockedFraction(a: number, b: number): number {
  if (a > 0 === b > 0) return a > 0 ? 0 : 1;
  const t = crossing(a, b);
  return a > 0 ? 1 - t : t;
}

export interface ReadinessVerdict {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
  why: string;
}

export function readiness(stats: MissionStats, endurance: number, profileHere: boolean): ReadinessVerdict {
  if (!profileHere) {
    return {
      label: "Unverified",
      tone: "neutral",
      why: "A local terrain profile is needed to verify this estimate.",
    };
  }
  if (stats.longest > endurance) {
    return {
      label: "Shadow exceeds limit",
      tone: "bad",
      why: "The longest shadow exceeds the modeled battery endurance.",
    };
  }
  if (stats.disc < 30 || stats.earth < 30 || stats.longest > 0.75 * endurance || stats.uncertain > 0) {
    return {
      label: "Limited margin",
      tone: "warn",
      why: "Sunlight, Earth visibility, terrain uncertainty, or battery margin limits this window.",
    };
  }
  return {
    label: "Within limits",
    tone: "good",
    why: "This window meets the modeled lighting, visibility, and battery thresholds.",
  };
}

export function rankWindow(samples: SkySample[], maxOffset: number, endurance: number): number {
  let best = { score: -Infinity, offset: 0 };
  for (let i = 0; i <= maxOffset; i += 2) {
    const stats = summarize(samples, i);
    const penalty = stats.longest > endurance ? 1000 : 0;
    const score = 2 * stats.disc + 0.5 * stats.earth - 1.5 * stats.longest - penalty;
    if (score > best.score) best = { score, offset: i };
  }
  return best.offset;
}

export interface TriangleResult {
  area: number;
  incenter: number[];
  normal: number[];
  scale: number;
}

export function triangleGeometry(points: number[][]): TriangleResult | null {
  const [a, b, c] = points;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const longest = Math.max(norm(ab), norm(ac), norm(sub(c, b)));
  if (!Number.isFinite(longest) || longest === 0) return null;
  const u = scale(ab, 1 / longest);
  const v = scale(ac, 1 / longest);
  const areaVector = cross(u, v);
  const doubleArea = norm(areaVector);
  if (doubleArea <= 1e-12) return null;
  const sideA = norm(sub(v, u));
  const sideB = norm(v);
  const sideC = norm(u);
  const normalizedCenter = scale(add(scale(u, sideB), scale(v, sideC)), 1 / (sideA + sideB + sideC));
  const incenter = add(a, scale(normalizedCenter, longest));
  const normal = scale(areaVector, (areaVector[1] < 0 ? -1 : 1) / doubleArea);
  return { area: (doubleArea / 2) * longest ** 2, incenter, normal, scale: longest };
}
