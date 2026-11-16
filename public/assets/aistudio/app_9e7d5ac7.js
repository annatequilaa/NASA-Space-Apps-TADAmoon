import {
  DAY, HOUR, FORECAST_HOURS, MISSION_HOURS, clamp, customSite, forecast, loadData,
  observerModel, orbitMeasures, rankWindow, readiness, summarize, transitions, triangleGeometry,
} from "./astronomy.js";
import { ForecastChart } from "./chart.js";
import { GeometryScene, OrbitScene, TerrainScene, mountScene } from "./scenes.js";

const byId = (id) => document.getElementById(id);
function setText(id, value) {
  const element = byId(id);
  if (element.textContent !== value) element.textContent = value;
}
const asInput = (when) => new Date(when).toISOString().slice(0, 16);
const asClock = (when) => `${asInput(when).replace("T", " ")} UTC`;
const fromInput = (id) => Date.parse(`${byId(id).value}Z`);
const percent = (value) => `${value.toFixed(0)}%`;
const dayLimits = (range) => `${asInput(range.min).slice(0, 10)} to ${asInput(range.max).slice(0, 10)}`;
const signed = (value, digits = 1) => `${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(digits)}`;
const deg = (value) => `${signed(value)}°`;
const compact = (value) => new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value === 0 ? 0 : value);

let database;
let active = "landing";
const landing = {
  time: null, hour: 0, mast: 2, endurance: 36, ridge: 1000, relief: 3, busy: false, timer: null,
};
const orbit = { time: null, mode: "system", ticket: 0, timer: null, busy: false, ticking: false };
const scenes = {};
const chart = new ForecastChart(byId("forecast-chart"), (hour) => {
  stopLanding();
  seekLanding(hour);
});

function notice(scope, message = "", isError = false) {
  const target = byId(`${scope}-status`);
  target.hidden = !message;
  target.dataset.tone = isError ? "error" : "";
  target.textContent = message;
}

function layoutView(name) {
  if (name === "landing") {
    if (!("landing" in scenes)) scenes.landing = mountScene(TerrainScene, byId("terrain-view"));
    if (landing.model) {
      renderTerrain();
      renderPlayhead();
      chart.render();
    }
  } else if (name === "orbit") {
    if (!("orbit" in scenes)) scenes.orbit = mountScene(OrbitScene, byId("orbit-view"));
    if (database && orbit.time === null && !orbit.busy) {
      const time = landing.time === null ? today() : Math.round((landing.time + landing.hour * HOUR) / 60000) * 60000;
      void showOrbit(clamp(time, database.ephemeris.orbit.min, database.ephemeris.orbit.max));
    } else if (database && orbit.time !== null) {
      renderOrbit();
    }
  } else {
    if (!("geometry" in scenes)) scenes.geometry = mountScene(GeometryScene, byId("geometry-view"));
    showTriangle();
  }
}

function activate(name, focus = false, updateLocation = true) {
  if (!["landing", "orbit", "geometry"].includes(name)) return;
  if (active !== name) {
    stopLanding();
    stopOrbit();
  }
  active = name;
  for (const tab of document.querySelectorAll("[data-tab]")) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", selected);
    tab.tabIndex = selected ? 0 : -1;
    byId(tab.dataset.tab).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  if (updateLocation) history.replaceState(null, "", `#${name}`);
  layoutView(name);
}

for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => activate(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    const names = ["landing", "orbit", "geometry"];
    const i = names.indexOf(active);
    const next = ({ ArrowLeft: (i + 2) % 3, ArrowRight: (i + 1) % 3, Home: 0, End: 2 })[event.key];
    if (next === undefined) return;
    event.preventDefault();
    activate(names[next], true);
  });
}
document.querySelector(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  activate("landing");
  window.scrollTo(0, 0);
});
document.querySelector(".method-link").addEventListener("click", (event) => {
  event.preventDefault();
  const details = byId("method");
  details.open = true;
  details.scrollIntoView();
  details.querySelector("summary").focus({ preventScroll: true });
});
window.addEventListener("hashchange", () => activate(location.hash.slice(1), false, false));

function today() {
  return Math.floor(Date.now() / DAY) * DAY;
}

function fillSiteSelect() {
  const select = byId("site-select");
  select.replaceChildren();
  for (const [label, sites] of [["Terrain profiles", database.sites], ["Reference sites · flat skyline", database.reference]]) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const site of sites) group.append(new Option(site.name, site.id));
    select.append(group);
  }
  select.append(new Option("Custom coordinates…", "custom"));
}

function defaultDateInput(id, range) {
  const input = byId(id);
  input.min = asInput(range.min);
  input.max = asInput(range.max);
  input.disabled = false;
}

function formatHours(hours) {
  const rounded = Math.round(hours * 60);
  const hoursTotal = Math.floor(rounded / 60);
  const days = Math.floor(hoursTotal / 24);
  if (days > 0) return `${days}d ${hoursTotal % 24}h`;
  if (hoursTotal > 0) return `${hoursTotal}h ${rounded % 60}m`;
  return `${rounded}m`;
}

function toggleLandingControls() {
  const ready = !!database, hasForecast = !!landing.samples;
  for (const id of ["site-select", "landing-date", "mast", "apply-landing"]) byId(id).disabled = !ready || landing.busy;
  for (const id of ["landing-play", "timeline", "find-date", "lock-scenario", "export-csv"]) {
    byId(id).disabled = !hasForecast || landing.busy;
  }
}

function stopLanding() {
  clearInterval(landing.timer);
  landing.timer = null;
  setText("landing-play", "Play");
}

function stopOrbit() {
  clearInterval(orbit.timer);
  orbit.timer = null;
  setText("orbit-play", "Play");
  if (orbit.time !== null) byId("orbit-date").value = asInput(orbit.time);
}

async function withLanding(action) {
  if (!database || landing.busy) return;
  stopLanding();
  landing.busy = true;
  toggleLandingControls();
  notice("landing");
  try {
    await action();
  } catch (error) {
    notice("landing", error.message, true);
  } finally {
    landing.busy = false;
    toggleLandingControls();
  }
}

async function setLanding({ site = landing.site, time = landing.time, mast = landing.mast,
  endurance = landing.endurance, ridge = landing.ridge, hour = 0 } = {}) {
  const epi = database.ephemeris;
  if (!Number.isFinite(time) || time < epi.sky.min || time > epi.sky.max) {
    throw new Error(`Choose a UTC landing date from ${dayLimits(epi.sky)}.`);
  }
  await epi.ensure("sky", time, time + FORECAST_HOURS * HOUR);
  const model = observerModel(epi, site, mast, ridge);
  const samples = forecast(model, time);
  const stats = summarize(samples);
  const eventList = { sun: transitions(samples, "sun"), earth: transitions(samples, "earth") };
  Object.assign(landing, { site, time, hour, mast, endurance, ridge, model, samples, stats, eventList });
  byId("landing-date").value = asInput(time);
  byId("site-select").value = site.id;
  byId("coordinates").hidden = site.id !== "custom";
  byId("latitude").value = site.lat;
  byId("longitude").value = site.lon;
  byId("mast").value = mast;
  renderTerrain();
  renderMission();
  renderComparison();
  chart.update(samples, landing.baseline?.samples);
  seekLanding(hour);
}

function renderTerrain() {
  const { site, model, relief, mast } = landing;
  setText("scene-site", site.name);
  const coords = `${Math.abs(site.lat).toFixed(4)}° ${site.lat < 0 ? "S" : "N"} · ${site.lon.toFixed(4)}° E`;
  const elevation = site.elevation === null ? "" : ` · ${Math.round(site.elevation).toLocaleString("en-US")} m elevation`;
  setText("scene-coords", coords + elevation);
  let quality = "Flat skyline assumption";
  if (site.quality === "Profile") {
    const floor = percent(site.floorFraction * 100);
    quality = `Supplied profile · ${floor} at −2°`;
    if (mast !== site.baseHeight) quality += " · Mast estimate";
  } else if (site.quality === "Borrowed") {
    quality = `Borrowed profile · ${site.borrowedFrom.distance.toFixed(1)} km away`;
    byId("scene-profile").title = site.borrowedFrom.name;
  }
  if (site.quality !== "Borrowed") byId("scene-profile").removeAttribute("title");
  setText("scene-profile", quality);
  scenes.landing?.setSurface(site.mesh, relief, model.horizon);
}

function setPill(id, text, tone) {
  const pill = byId(id);
  pill.className = `pill ${tone}`;
  setText(id, text);
}

function renderPlayhead() {
  if (!landing.model) return;
  const { hour, time, model, eventList } = landing;
  const when = time + hour * HOUR;
  const bodies = model.at(when);
  setText("playhead", asClock(when));
  byId("timeline").setAttribute("aria-valuetext", `${formatHours(hour)} after landing, ${asClock(when)}`);
  byId("timeline").value = hour;
  for (const [key, data] of Object.entries(bodies)) {
    setText(`${key}-alt`, deg(data.alt));
    setText(`${key}-ridge`, deg(data.ridge));
    setText(`${key}-az`, `${data.az.toFixed(1)}°`);
    const event = eventList[key].find((entry) => entry.hour > hour + 1e-7);
    const body = key === "sun" ? "Sun" : "Earth";
    const next = event
      ? `${body}${event.rises ? "rise" : "set"} in ≈ ${formatHours(event.hour - hour)}`
      : "No transition before day 30";
    setText(`${key}-event`, next);
  }
  const { sun, earth } = bodies;
  if (sun.uncertain) setPill("sun-state", "Skyline uncertain", "warn");
  else if (sun.center >= sun.radius) setPill("sun-state", "Full Sun", "good");
  else if (sun.clearance > 0) setPill("sun-state", `${percent(sun.fraction * 100)} of disc`, "warn");
  else setPill("sun-state", "In shadow", "neutral");
  if (earth.uncertain) setPill("earth-state", "Skyline uncertain", "warn");
  else if (earth.clearance > 0) setPill("earth-state", "Visible", "good");
  else setPill("earth-state", "Below skyline", "neutral");

  scenes.landing?.update(bodies);
  chart.seek(hour);
}

function seekLanding(hour) {
  if (!landing.model) return;
  landing.hour = clamp(hour, 0, FORECAST_HOURS);
  renderPlayhead();
}

function renderMission() {
  const { stats, endurance, site } = landing;
  const verdict = readiness(stats, endurance, site.quality === "Profile");
  setText("mission-sun", percent(stats.sun));
  setText("mission-earth", percent(stats.earth));
  setText("mission-dark", formatHours(stats.longest));
  setText("mission-battery", `${endurance} h modeled battery endurance`);
  setText("mission-reason", verdict.why);
  setPill("mission-verdict", verdict.label, verdict.tone);
  byId("bar-sun").style.width = `${stats.sun}%`;
  byId("bar-earth").style.width = `${stats.earth}%`;
}

function snapshot() {
  const { site, time, mast, stats, samples, endurance, ridge } = landing;
  return { site, time, mast, stats, samples, endurance, ridge,
    verdict: readiness(stats, endurance, site.quality === "Profile").label };
}

function renderComparison() {
  const a = landing.baseline;
  byId("comparison").hidden = !a;
  byId("baseline-legend").hidden = !a;
  if (!a) return;
  const b = snapshot();
  const describeSite = (scenario) => {
    const { site } = scenario;
    return site.id === "custom" ? `${site.name} (${site.lat.toFixed(2)}°, ${site.lon.toFixed(2)}°)` : site.name;
  };
  const delta = (key, unit) => `${signed(b.stats[key] - a.stats[key], 1)} ${unit}`;
  const rows = [
    ["Landing site", describeSite(a), describeSite(b)],
    ["Landing time", asClock(a.time), asClock(b.time)],
    ["Mast height", `${a.mast} m`, `${b.mast} m`],
    ["Battery endurance", `${a.endurance} h`, `${b.endurance} h`],
    ["Assumed ridge distance", `${a.ridge} m`, `${b.ridge} m`],
    ["Any sunlight", percent(a.stats.sun), percent(b.stats.sun), delta("sun", "pp")],
    ["Direct Earth visibility", percent(a.stats.earth), percent(b.stats.earth), delta("earth", "pp")],
    ["Longest shadow", formatHours(a.stats.longest), formatHours(b.stats.longest), delta("longest", "h")],
    ["Modeled window", a.verdict, b.verdict],
  ];
  const tbody = byId("comparison-rows");
  tbody.replaceChildren(...rows.map(([label, before, after, difference]) => {
    const row = document.createElement("tr");
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = label;
    row.append(heading);
    row.insertCell().textContent = before;
    const value = row.insertCell();
    value.textContent = after;
    if (difference) {
      const change = document.createElement("span");
      change.className = "delta";
      change.textContent = difference;
      value.append(change);
    }
    return row;
  }));
}

function selectedSite() {
  const id = byId("site-select").value;
  if (id === "custom") {
    const lat = byId("latitude").valueAsNumber, lon = byId("longitude").valueAsNumber;
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 360)) {
      throw new Error("Enter a latitude from −90° to 90° and a longitude from −180° to 360°.");
    }
    return customSite(lat, lon, database.sites);
  }
  return [...database.sites, ...database.reference].find((site) => site.id === id);
}

byId("landing-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void withLanding(() => setLanding({ site: selectedSite(), time: fromInput("landing-date"),
    mast: Number(byId("mast").value) }));
});
byId("site-select").addEventListener("change", () => {
  const isCustom = byId("site-select").value === "custom";
  byId("coordinates").hidden = !isCustom;
  if (isCustom) {
    byId("latitude").focus();
    return;
  }
  void withLanding(() => setLanding({ site: selectedSite() }));
});
byId("coordinates").addEventListener("submit", (event) => {
  event.preventDefault();
  void withLanding(() => setLanding({ site: selectedSite(), time: fromInput("landing-date"),
    mast: Number(byId("mast").value) }));
});
byId("model-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void withLanding(() => setLanding({ endurance: byId("endurance").valueAsNumber,
    ridge: byId("ridge-distance").valueAsNumber, hour: landing.hour }));
});
byId("find-date").addEventListener("click", () => {
  void withLanding(async () => {
    const epi = database.ephemeris;
    const { time, model, endurance } = landing;
    const maxOffset = Math.min(FORECAST_HOURS, Math.floor((epi.sky.max - time) / HOUR));
    await epi.ensure("sky", time, time + (maxOffset + MISSION_HOURS) * HOUR);
    const samples = forecast(model, time, maxOffset + MISSION_HOURS);
    const best = rankWindow(samples, maxOffset, endurance);
    await setLanding({ time: time + best * HOUR });
    notice("landing", `Best modeled start within the search window · ${asClock(landing.time)}`);
  });
});
byId("landing-play").addEventListener("click", () => {
  if (landing.timer) {
    stopLanding();
    return;
  }
  if (landing.hour >= FORECAST_HOURS) seekLanding(0);
  setText("landing-play", "Pause");
  let previous = performance.now();
  landing.timer = setInterval(() => {
    const now = performance.now();
    const elapsed = Math.min((now - previous) / 1000, 0.3);
    seekLanding(landing.hour + elapsed * Number(byId("landing-speed").value));
    previous = now;
    if (landing.hour >= FORECAST_HOURS) stopLanding();
  }, 70);
});
byId("timeline").addEventListener("input", (event) => {
  stopLanding();
  seekLanding(event.currentTarget.valueAsNumber);
});
byId("terrain-cameras").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-camera]");
  if (!button) return;
  for (const item of button.parentElement.children) item.setAttribute("aria-pressed", item === button);
  scenes.landing?.preset(button.dataset.camera);
});
byId("show-horizon").addEventListener("change", (event) => scenes.landing?.setHorizonVisible(event.currentTarget.checked));
byId("relief").addEventListener("input", (event) => {
  landing.relief = event.currentTarget.valueAsNumber;
  setText("relief-value", `${landing.relief}×`);
  if (landing.model) renderTerrain();
});
byId("lock-scenario").addEventListener("click", () => {
  landing.baseline = snapshot();
  renderComparison();
  chart.update(landing.samples, landing.baseline.samples);
});
byId("clear-scenario").addEventListener("click", () => {
  landing.baseline = null;
  renderComparison();
  chart.update(landing.samples);
  byId("lock-scenario").focus();
});
byId("export-csv").addEventListener("click", () => {
  const columns = [
    "utc", "days_after_landing", "sun_altitude_deg", "sun_azimuth_deg", "sun_skyline_deg",
    "sun_upper_limb_clearance_deg", "sun_disc_fraction", "sun_skyline_uncertain",
    "earth_altitude_deg", "earth_azimuth_deg", "earth_skyline_deg", "earth_center_clearance_deg", "earth_skyline_uncertain",
  ];
  const rows = landing.samples.map(({ sun, earth }, i) => [
    new Date(landing.time + i * HOUR).toISOString(), (i / 24).toFixed(4),
    sun.alt.toFixed(4), sun.az.toFixed(4), sun.ridge.toFixed(4), sun.clearance.toFixed(4), sun.fraction.toFixed(5),
    sun.uncertain, earth.alt.toFixed(4), earth.az.toFixed(4), earth.ridge.toFixed(4), earth.clearance.toFixed(4), earth.uncertain,
  ].join(","));
  const url = URL.createObjectURL(new Blob([[columns.join(","), ...rows].join("\r\n") + "\r\n"], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `lunar-forecast-${asInput(landing.time).slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

function setOrbitControls() {
  for (const id of ["orbit-date", "apply-orbit", "orbit-back", "orbit-forward", "orbit-play"]) {
    byId(id).disabled = !database || orbit.busy;
  }
}

function orbitPathStart(when, range, length) {
  return clamp(when - length, range.min, range.end - length);
}

async function prepareOrbit(when) {
  const epi = database.ephemeris;
  const start = orbitPathStart(when, epi.orbit, 365 * DAY);
  await epi.ensure("orbit", start, Math.max(start + 365 * DAY, when));
}

function renderOrbit() {
  const { ephemeris: epi } = database;
  const positions = epi.orbitAt(orbit.time);
  const scene = scenes.orbit;
  if (scene && (orbit.pathTime === undefined || Math.abs(orbit.time - orbit.pathTime) > 3 * DAY)) {
    const start = orbitPathStart(orbit.time, epi.orbit, 365 * DAY);
    const lunarStart = orbitPathStart(orbit.time, epi.orbit, 28 * DAY);
    const earthPath = Array.from({ length: 183 }, (_, i) => epi.orbitAt(start + i / 182 * 365 * DAY).earth.position);
    const moonPath = Array.from({ length: 113 }, (_, i) => epi.orbitAt(lunarStart + i * DAY / 4).lunar.position);
    scene.updatePaths(earthPath, moonPath);
    orbit.pathTime = orbit.time;
  }
  scene?.update(positions);

  const { sunEarth, earthMoon, sunMoon, eccentricity } = orbitMeasures(positions);
  const km = (distance, rounding) => `≈ ${(Math.round(distance / rounding) * rounding).toLocaleString("en-US")} km`;
  setText("sun-earth", km(sunEarth, 10));
  setText("earth-moon", km(earthMoon, 10));
  setText("sun-moon", km(sunMoon, 10));
  setText("eccentricity", eccentricity.toFixed(4));
  setText("orbit-time", asClock(orbit.time));
}

async function showOrbit(when, moving = false) {
  if (!database) return;
  const range = database.ephemeris.orbit;
  if (!Number.isFinite(when) || when < range.min || when > range.max) {
    notice("orbit", `Choose a UTC date from ${dayLimits(range)}. The final day ends at 00:00 UTC.`, true);
    return;
  }
  const ticket = ++orbit.ticket;
  if (!moving) {
    orbit.busy = true;
    setOrbitControls();
  }
  try {
    await prepareOrbit(when);
    if (orbit.ticket !== ticket || (moving && !orbit.timer)) return;
    orbit.time = when;
    if (!moving) {
      byId("orbit-date").value = asInput(when);
      notice("orbit");
    }
    renderOrbit();
  } catch (error) {
    if (orbit.ticket === ticket) {
      stopOrbit();
      notice("orbit", error.message, true);
    }
  } finally {
    if (!moving && orbit.ticket === ticket) {
      orbit.busy = false;
      setOrbitControls();
    }
  }
}

byId("orbit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const time = fromInput("orbit-date");
  stopOrbit();
  void showOrbit(time);
});
for (const [id, days] of [["orbit-back", -1], ["orbit-forward", 1]]) {
  byId(id).addEventListener("click", () => {
    if (orbit.time === null) return;
    stopOrbit();
    const range = database.ephemeris.orbit;
    void showOrbit(clamp(orbit.time + days * DAY, range.min, range.max));
  });
}
byId("orbit-cameras").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-orbit-camera]");
  if (!button) return;
  orbit.mode = button.dataset.orbitCamera;
  for (const item of button.parentElement.children) item.setAttribute("aria-pressed", item === button);
  setText("orbit-scene-title", orbit.mode === "pair" ? "Earth–Moon view" : "Solar system view");
  scenes.orbit?.setMode(orbit.mode);
  if (orbit.time !== null) renderOrbit();
});
byId("orbit-lines").addEventListener("change", (event) => {
  scenes.orbit?.setLines(event.currentTarget.checked);
  if (orbit.time !== null) renderOrbit();
});
byId("orbit-play").addEventListener("click", () => {
  if (orbit.timer) {
    stopOrbit();
    return;
  }
  if (orbit.time === null) return;
  if (orbit.time >= database.ephemeris.orbit.max) {
    notice("orbit", "The simulation reached its final date. Select an earlier date to play.");
    return;
  }
  setText("orbit-play", "Pause");
  notice("orbit");
  let previous = performance.now();
  orbit.timer = setInterval(async () => {
    if (orbit.ticking) return;
    orbit.ticking = true;
    const now = performance.now();
    const elapsed = Math.min((now - previous) / 1000, 0.25);
    previous = now;
    const max = database.ephemeris.orbit.max;
    await showOrbit(Math.min(max, orbit.time + elapsed * Number(byId("orbit-speed").value) * DAY), true);
    if (orbit.time >= max) stopOrbit();
    orbit.ticking = false;
  }, 65);
});

function showTriangle() {
  const form = byId("triangle-form");
  const coordinates = new FormData(form);
  const points = ["a", "b", "c"].map((point) => ["x", "y", "z"].map((axis) => {
    const raw = coordinates.get(point + axis);
    return raw === "" ? NaN : Number(raw);
  }));
  const valid = points.flat().every((value) => Number.isFinite(value) && Math.abs(value) <= 1e12);
  const result = valid ? triangleGeometry(points) : null;
  if (!result) {
    notice("geometry", valid ? "The points are collinear or repeated. Enter three non-collinear points."
      : "Enter finite coordinates between −1 trillion and +1 trillion.", true);
  } else notice("geometry");
  setText("triangle-area", result ? compact(result.area) : "—");
  const formatted = (values) => `(${values.map(compact).join(", ")})`;
  setText("triangle-center", result ? formatted(result.incenter) : "—");
  setText("triangle-normal", result ? formatted(result.normal) : "—");
  scenes.geometry?.update(points, result);
}
byId("triangle-form").addEventListener("submit", (event) => {
  event.preventDefault();
  showTriangle();
});
byId("reset-triangle").addEventListener("click", () => {
  byId("triangle-form").reset();
  showTriangle();
});
byId("geometry-camera").addEventListener("click", () => scenes.geometry?.reset());

async function initialize() {
  const initial = location.hash.slice(1);
  if (["landing", "orbit", "geometry"].includes(initial)) activate(initial, false, false);
  else layoutView(active);
  try {
    if (location.protocol === "file:") throw new Error("Open the project with pipenv run start, then visit 127.0.0.1:8000.");
    database = await loadData();
    fillSiteSelect();
    defaultDateInput("landing-date", database.ephemeris.sky);
    defaultDateInput("orbit-date", database.ephemeris.orbit);
    const ready = clamp(today(), database.ephemeris.sky.min, database.ephemeris.sky.max);
    landing.site = database.sites[0] ?? database.reference[0];
    await withLanding(() => setLanding({ time: ready }));
    setOrbitControls();
    if (active === "orbit") layoutView("orbit");
    notice("app");
  } catch (error) {
    notice("app", error.message, true);
  }
}
void initialize();
