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

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const normalizeLon = (lon) => (lon % 360 + 360) % 360;
export const add = (a, b) => a.map((value, i) => value + b[i]);
export const sub = (a, b) => a.map((value, i) => value - b[i]);
export const scale = (a, amount) => a.map((value) => value * amount);
export const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
export const norm = (a) => Math.hypot(...a);
export const cross = ([ax, ay, az], [bx, by, bz]) => [
  ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx,
];

const SITE_NAMES = [
  ["Apollo 11", 0.674, 23.473], ["Apollo 12", -3.012, 336.578],
  ["Apollo 14", -3.645, 342.529], ["Apollo 15", 26.132, 3.633],
  ["Apollo 16", -8.973, 15.500], ["Apollo 17", 20.191, 30.772],
  ["Chandrayaan-3", -69.373, 32.319], ["Chang’e 4", -45.446, 177.599],
  ["Chang’e 5", 43.058, 308.084], ["Chang’e 6", -41.639, 206.015],
  ["SLIM", -13.300, 25.250], ["Blue Ghost M1", 18.560, 61.810],
  ["Luna 25 planned", -57.865, 61.360], ["IM-2 planned", -84.800, 29.200],
];

function makeSite(id, name, lat, lon, terrain, quality, borrowedFrom = null) {
  const clamped = terrain ? terrain.horizon_deg.map((value) => Math.abs(value - FLOOR) < 1e-6) : Array(360).fill(false);
  return {
    id, name, lat, lon: normalizeLon(lon), quality, borrowedFrom, clamped,
    horizon: terrain?.horizon_deg ?? Array(360).fill(0),
    floorFraction: clamped.filter(Boolean).length / 360,
    mesh: terrain?.mesh_rel_m ?? null,
    elevation: quality === "Profile" ? terrain.surface_elev_m : null,
    ridgeDistances: terrain?.ridge_dist_m,
    baseHeight: terrain?.horizon_observer_height_m ?? BASE_HEIGHT,
  };
}

export function readSites(data) {
  const sites = Object.entries(data)
    .filter(([, terrain]) => terrain.horizon_deg.some((value) => value !== 0)
      && terrain.horizon_deg.filter((value) => Math.abs(value - FLOOR) < 1e-6).length < 342)
    .map(([fullName, terrain], i) => ({
      ...makeSite(`terrain-${i}`, fullName.split(" (")[0], terrain.lat, terrain.lon, terrain, "Profile"),
      terrain,
    }));
  const reference = SITE_NAMES.map(([name, lat, lon], i) => makeSite(`reference-${i}`, name, lat, lon, null, "Flat"));
  return { sites, reference };
}

export function customSite(lat, lon, sites) {
  let closest, distance = Infinity;
  for (const site of sites) {
    const dLat = (lat - site.lat) * RAD;
    const dLon = (lon - site.lon) * RAD;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat * RAD) * Math.cos(site.lat * RAD) * Math.sin(dLon / 2) ** 2;
    const distanceKm = 2 * MOON_RADIUS_M / 1000 * Math.asin(Math.sqrt(clamp(a, 0, 1)));
    if (distanceKm < distance) {
      closest = site;
      distance = distanceKm;
    }
  }
  const borrow = distance <= 10;
  return makeSite("custom", "Custom coordinates", lat, lon, borrow ? closest.terrain : null,
    borrow ? "Borrowed" : "Flat", borrow ? { name: closest.name, distance } : null);
}

async function responseFor(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  return response;
}

export async function loadData() {
  const [metadata, terrain] = await Promise.all([
    responseFor("./data/metadata.json").then((response) => response.json()),
    responseFor("./data/terrain_profiles.json").then((response) => response.json()),
  ]);
  if (metadata.format !== 1) throw new Error("This website needs ephemeris data in format 1.");
  return { ephemeris: new Ephemeris(metadata), ...readSites(terrain) };
}

export class Ephemeris {
  constructor(metadata) {
    this.metadata = metadata;
    this.blocks = new Map();
    for (const name of ["sky", "orbit"]) {
      this[name] = {
        min: Date.parse(metadata[name].min),
        max: Date.parse(metadata[name].max),
        end: Date.parse(metadata[name].end),
        step: metadata[name].stepHours * HOUR,
        width: metadata[name].width,
        chunks: metadata[name].chunks.map((block) => ({
          ...block, start: Date.parse(block.start), end: Date.parse(block.end), origin: Date.parse(block.origin),
        })),
      };
    }
    this.sky.max += DAY - 60_000;
  }

  async ensure(name, from, to = from) {
    const blocks = this[name].chunks.filter((block) => block.start <= to && block.end >= from);
    if (!blocks.length) throw new Error("This date is outside the ephemeris range.");
    await Promise.all(blocks.map((block) => this.loadBlock(block, this[name].width)));
  }

  loadBlock(block, width) {
    if (block.values) return block.values;
    if (!this.blocks.has(block.file)) {
      const request = responseFor(`./data/${block.file}`).then((response) => response.arrayBuffer()).then((buffer) => {
        if (buffer.byteLength !== block.rows * width * 4) throw new Error(`Incomplete ephemeris file ${block.file}.`);
        const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
        if (littleEndian) block.values = new Float32Array(buffer);
        else {
          const view = new DataView(buffer);
          block.values = Float32Array.from({ length: block.rows * width }, (_, i) => view.getFloat32(i * 4, true));
        }
        return block.values;
      }).finally(() => this.blocks.delete(block.file));
      this.blocks.set(block.file, request);
    }
    return this.blocks.get(block.file);
  }

  interval(name, when) {
    const { chunks, step, width } = this[name];
    const block = chunks.find(({ start, end }) => when >= start && when < end)
      ?? (when === this[name].end ? chunks.at(-1) : null);
    if (!block?.values) throw new Error("Ephemeris for this date has not loaded.");
    const x = (when - block.origin) / step;
    const index = Math.min(Math.floor(x), block.rows - 2);
    return {
      fraction: x - index,
      days: step / DAY,
      row: (offset, column) => block.values[clamp(index + offset, 0, block.rows - 1) * width + column],
      hasPrevious: index > 0,
      hasNext: index + 2 < block.rows,
    };
  }

  skyAt(when) {
    const { row, fraction: t, hasPrevious, hasNext } = this.interval("sky", when);
    return Array.from({ length: 6 }, (_, i) => {
      const a = row(0, i), b = row(1, i);
      const v0 = hasPrevious ? (b - row(-1, i)) / 2 : b - a;
      const v1 = hasNext ? (row(2, i) - a) / 2 : b - a;
      return hermite(a, b, v0, v1, t)[0];
    });
  }

  orbitAt(when) {
    const { row, fraction: t, days } = this.interval("orbit", when);
    const body = (offset) => {
      const state = [0, 1, 2].map((i) => {
        const j = i + offset;
        return hermite(row(0, j), row(1, j), days * row(0, j + 3), days * row(1, j + 3), t);
      });
      return { position: state.map((s) => s[0]), velocity: state.map((s) => s[1] / days) };
    };
    return { earth: body(0), lunar: body(6) };
  }
}

function hermite(a, b, v0, v1, t) {
  const delta = b - a;
  const c = 3 * delta - 2 * v0 - v1;
  const d = -2 * delta + v0 + v1;
  return [a + t * (v0 + t * (c + t * d)), v0 + t * (2 * c + t * 3 * d)];
}

export function orbitMeasures({ earth, lunar }) {
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

function circularSample(profile, azimuth) {
  const a = Math.floor(azimuth);
  const f = azimuth - a;
  return profile[a] * (1 - f) + profile[(a + 1) % 360] * f;
}

export function observerModel(ephemeris, site, mast, assumedRidgeDistance) {
  const p = site.lat * RAD, l = site.lon * RAD;
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = cross(up, east);
  const origin = scale(up, ephemeris.metadata.moonRadiusKm + ((site.elevation ?? 0) + mast) / 1000);
  const dip = (height) => Math.acos(MOON_RADIUS_M / (MOON_RADIUS_M + height)) / RAD;
  const dh = mast - site.baseHeight;
  const horizon = site.horizon.map((value, i) => {
    if (Math.abs(dh) < 0.01 || site.quality === "Flat") return value;
    const distance = Array.isArray(site.ridgeDistances) ? site.ridgeDistances[i] : site.ridgeDistances;
    const adjusted = value > 0
      ? Math.atan(Math.tan(value * RAD) - dh / (distance ?? assumedRidgeDistance)) / RAD
      : value - (dip(mast) - dip(site.baseHeight));
    return dh > 0 ? clamp(adjusted, Math.min(value, -dip(mast)), value) : Math.max(adjusted, value);
  });

  function altAz(vector) {
    const offset = sub(vector, origin);
    const u = dot(offset, up), e = dot(offset, east), n = dot(offset, north);
    return {
      alt: Math.atan2(u, Math.hypot(e, n)) / RAD,
      az: normalizeLon(Math.atan2(e, n) / RAD),
      range: norm(offset),
    };
  }

  function at(when) {
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
    const x = clamp(sun.center / sun.radius, -1, 1);
    sun.fraction = (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / Math.PI;
    return { sun, earth };
  }

  return { at, horizon };
}

export function forecast(model, start, hours = FORECAST_HOURS) {
  return Array.from({ length: hours + 1 }, (_, i) => model.at(start + i * HOUR));
}

function crossing(a, b) {
  return a / (a - b);
}

export function transitions(samples, key) {
  const result = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1][key].clearance, b = samples[i][key].clearance;
    if ((a > 0) !== (b > 0)) result.push({ hour: i - 1 + crossing(a, b), rises: b > 0 });
  }
  return result;
}

export function summarize(samples, offset = 0) {
  let dark = 0, longest = 0, shadowRun = 0, blocked = 0, fraction = 0;
  let uncertain = 0;
  for (let i = offset; i < offset + MISSION_HOURS; i++) {
    const a = samples[i], b = samples[i + 1];
    const s0 = a.sun.clearance, s1 = b.sun.clearance, e0 = a.earth.clearance, e1 = b.earth.clearance;
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
    disc: 100 * fraction / MISSION_HOURS,
    longest,
    uncertain: 100 * uncertain / MISSION_HOURS,
  };
}

function blockedFraction(a, b) {
  if ((a > 0) === (b > 0)) return a > 0 ? 0 : 1;
  const t = crossing(a, b);
  return a > 0 ? 1 - t : t;
}

export function readiness(stats, endurance, profileHere) {
  if (!profileHere) return { label: "Unverified", tone: "neutral", why: "A local terrain profile is needed to verify this estimate." };
  if (stats.longest > endurance) return { label: "Shadow exceeds limit", tone: "bad", why: "The longest shadow exceeds the modeled battery endurance." };
  if (stats.disc < 30 || stats.earth < 30 || stats.longest > 0.75 * endurance || stats.uncertain > 0) {
    return { label: "Limited margin", tone: "warn", why: "Sunlight, Earth visibility, terrain uncertainty, or battery margin limits this window." };
  }
  return { label: "Within limits", tone: "good", why: "This window meets the modeled lighting, visibility, and battery thresholds." };
}

export function rankWindow(samples, maxOffset, endurance) {
  let best = { score: -Infinity, offset: 0 };
  for (let i = 0; i <= maxOffset; i += 2) {
    const stats = summarize(samples, i);
    const penalty = stats.longest > endurance ? 1000 : 0;
    const score = 2 * stats.disc + 0.5 * stats.earth - 1.5 * stats.longest - penalty;
    if (score > best.score) best = { score, offset: i };
  }
  return best.offset;
}

export function triangleGeometry(points) {
  const [a, b, c] = points;
  const ab = sub(b, a), ac = sub(c, a), bc = sub(c, b);
  const longest = Math.max(norm(ab), norm(ac), norm(bc));
  if (!Number.isFinite(longest) || longest === 0) return null;
  const u = scale(ab, 1 / longest), v = scale(ac, 1 / longest);
  const areaVector = cross(u, v);
  const doubleArea = norm(areaVector);
  if (doubleArea <= 1e-12) return null;
  const sideA = norm(sub(v, u)), sideB = norm(v), sideC = norm(u);
  const normalizedCenter = scale(add(scale(u, sideB), scale(v, sideC)), 1 / (sideA + sideB + sideC));
  const incenter = add(a, scale(normalizedCenter, longest));
  const normal = scale(areaVector, (areaVector[1] < 0 ? -1 : 1) / doubleArea);
  return { area: (doubleArea / 2) * longest ** 2, incenter, normal, scale: longest };
}
