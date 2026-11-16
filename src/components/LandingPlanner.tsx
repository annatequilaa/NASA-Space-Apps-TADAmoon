import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRightLeft, Plus, Radio, Sun, X } from "lucide-react";
import {
  FORECAST_HOURS,
  HOUR,
  MISSION_HOURS,
  clamp,
  forecast,
  observerModel,
  rankWindow,
  readiness,
  summarize,
  transitions,
  type LandingSite,
  type LoadedDatabase,
  type MissionStats,
  type ObserverModel,
  type SkySample,
  type TransitionEvent,
} from "../lib/astronomy";
import { ForecastChart } from "../lib/chart";
import {
  asClock,
  asInput,
  dayLimits,
  deg,
  formatHours,
  fromInputValue,
  percent,
  statusGlyph,
  todayUtcMidnight,
} from "../lib/format";
import { TerrainScene, mountScene, type TerrainCameraKey } from "../lib/scenes";
import { CompareModal, type SavedScenario } from "./CompareModal";
import { PolarMoonSelector } from "./PolarMoonSelector";

interface LandingPlannerProps {
  database: LoadedDatabase | null;
  active: boolean;
  onPlayheadChange?: (whenMs: number) => void;
}

interface LandingNotice {
  message: string;
  isError: boolean;
}

interface LandingState {
  site: LandingSite;
  time: number;
  hour: number;
  mast: number;
  endurance: number;
  ridge: number;
  model: ObserverModel;
  samples: SkySample[];
  stats: MissionStats;
  eventList: { sun: TransitionEvent[]; earth: TransitionEvent[] };
}

export function LandingPlanner({ database, active, onPlayheadChange }: LandingPlannerProps) {
  const terrainHostRef = useRef<HTMLDivElement | null>(null);
  const terrainSceneRef = useRef<TerrainScene | null>(null);
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const forecastChartRef = useRef<ForecastChart | null>(null);
  const playTimerRef = useRef<number | null>(null);
  const initializedRef = useRef(false);

  const [siteId, setSiteId] = useState("");
  const [dateInput, setDateInput] = useState("");
  const [mastInput, setMastInput] = useState("2");
  const [relief, setRelief] = useState(3);
  const [showHorizon, setShowHorizon] = useState(true);
  const [cameraPreset, setCameraPreset] = useState<TerrainCameraKey>("dome");
  const [speed, setSpeed] = useState("12");
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<LandingNotice | null>(null);
  const [state, setState] = useState<LandingState | null>(null);

  const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>([]);
  const [showCompare, setShowCompare] = useState(false);

  const stateRef = useRef<LandingState | null>(null);
  stateRef.current = state;

  const stopPlayback = useCallback(() => {
    if (playTimerRef.current !== null) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    setPlaying(false);
  }, []);

  const seekLanding = useCallback((nextHour: number) => {
    setState((prev) => {
      if (!prev) return prev;
      const clampedHour = clamp(nextHour, 0, FORECAST_HOURS);
      return { ...prev, hour: clampedHour };
    });
  }, []);

  useEffect(() => {
    if (!active) {
      stopPlayback();
      return;
    }
    if (terrainHostRef.current && !terrainSceneRef.current) {
      terrainSceneRef.current = mountScene(TerrainScene, terrainHostRef.current);
    }
    if (chartCanvasRef.current && !forecastChartRef.current) {
      forecastChartRef.current = new ForecastChart(chartCanvasRef.current, (hour) => {
        stopPlayback();
        seekLanding(hour);
      });
    }
    if (stateRef.current) {
      terrainSceneRef.current?.render();
      forecastChartRef.current?.render();
    }
  }, [active, seekLanding, stopPlayback]);

  useEffect(() => {
    return () => {
      stopPlayback();
      terrainSceneRef.current?.dispose();
      terrainSceneRef.current = null;
      forecastChartRef.current?.dispose();
      forecastChartRef.current = null;
    };
  }, [stopPlayback]);

  const applyLandingScenario = useCallback(
    async (opts: {
      site?: LandingSite;
      time?: number;
      mast?: number;
      endurance?: number;
      ridge?: number;
      hour?: number;
    }) => {
      if (!database) return;
      const cur = stateRef.current;
      const site = opts.site ?? cur?.site ?? database.sites[0] ?? database.reference[0];
      const time =
        opts.time ??
        cur?.time ??
        clamp(todayUtcMidnight(), database.ephemeris.sky.min, database.ephemeris.sky.max);
      const mast = opts.mast ?? cur?.mast ?? 2;
      const endurance = opts.endurance ?? cur?.endurance ?? 36;
      const ridge = opts.ridge ?? cur?.ridge ?? 1000;
      const hour = opts.hour ?? 0;

      const epi = database.ephemeris;
      if (!Number.isFinite(time) || time < epi.sky.min || time > epi.sky.max) {
        throw new Error(`Choose a UTC landing date from ${dayLimits(epi.sky)}.`);
      }

      await epi.ensure("sky", time, time + FORECAST_HOURS * HOUR);
      const model = observerModel(epi, site, mast, ridge);
      const samples = forecast(model, time);
      const stats = summarize(samples);
      const eventList = {
        sun: transitions(samples, "sun"),
        earth: transitions(samples, "earth"),
      };

      setState({
        site,
        time,
        hour,
        mast,
        endurance,
        ridge,
        model,
        samples,
        stats,
        eventList,
      });
      setDateInput(asInput(time));
      setSiteId(site.id);
      setMastInput(String(mast));
    },
    [database],
  );

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      if (!database || busy) return;
      stopPlayback();
      setBusy(true);
      setNotice(null);
      try {
        await action();
      } catch (error) {
        setNotice({
          message: error instanceof Error ? error.message : "Could not update landing window.",
          isError: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, database, stopPlayback],
  );

  useEffect(() => {
    if (!database || initializedRef.current) return;
    initializedRef.current = true;
    const defaultSite = database.sites[0] ?? database.reference[0];
    const defaultTime = clamp(
      todayUtcMidnight(),
      database.ephemeris.sky.min,
      database.ephemeris.sky.max,
    );
    setSiteId(defaultSite.id);
    setDateInput(asInput(defaultTime));
    void runAction(() => applyLandingScenario({ site: defaultSite, time: defaultTime }));
  }, [applyLandingScenario, database, runAction]);

  useEffect(() => {
    if (!state) return;
    terrainSceneRef.current?.setSurface(state.site.mesh, relief, state.model.horizon);
    forecastChartRef.current?.update(state.samples);
  }, [state?.site, state?.model, state?.samples, relief]);

  const playheadData = useMemo(() => {
    if (!state) return null;
    const when = state.time + state.hour * HOUR;
    const bodies = state.model.at(when);
    return { when, bodies };
  }, [state]);

  useEffect(() => {
    if (!state || !playheadData) return;
    terrainSceneRef.current?.update(playheadData.bodies);
    forecastChartRef.current?.seek(state.hour);
    onPlayheadChange?.(Math.round(playheadData.when / 60000) * 60000);
  }, [state, playheadData, onPlayheadChange]);

  const resolveSelectedSite = (targetSiteId = siteId): LandingSite => {
    if (!database) throw new Error("Ephemeris data is still loading.");
    const found = [...database.sites, ...database.reference].find((site) => site.id === targetSiteId);
    if (!found) throw new Error("Select a valid landing site.");
    return found;
  };

  const handleSiteChange = (nextId: string) => {
    setSiteId(nextId);
    void runAction(() =>
      applyLandingScenario({
        site: resolveSelectedSite(nextId),
        time: fromInputValue(dateInput),
        mast: Number(mastInput),
      }),
    );
  };

  const handleLandingSubmit = (event: FormEvent) => {
    event.preventDefault();
    void runAction(() =>
      applyLandingScenario({
        site: resolveSelectedSite(),
        time: fromInputValue(dateInput),
        mast: Number(mastInput),
      }),
    );
  };

  const handleFindBestDate = () => {
    void runAction(async () => {
      if (!database || !stateRef.current) return;
      const epi = database.ephemeris;
      const { time, model, endurance } = stateRef.current;
      const maxOffset = Math.min(FORECAST_HOURS, Math.floor((epi.sky.max - time) / HOUR));
      await epi.ensure("sky", time, time + (maxOffset + MISSION_HOURS) * HOUR);
      const samples = forecast(model, time, maxOffset + MISSION_HOURS);
      const best = rankWindow(samples, maxOffset, endurance);
      const bestTime = time + best * HOUR;
      await applyLandingScenario({ time: bestTime });
      setNotice({
        message: `Best modeled start within the search window · ${asClock(bestTime)}`,
        isError: false,
      });
    });
  };

  const handleTogglePlay = () => {
    if (playing) {
      stopPlayback();
      return;
    }
    if (!state) return;
    if (state.hour >= FORECAST_HOURS) seekLanding(0);
    setPlaying(true);
    let previous = performance.now();
    playTimerRef.current = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min((now - previous) / 1000, 0.3);
      previous = now;
      const cur = stateRef.current;
      if (!cur) return;
      const nextHour = Math.min(FORECAST_HOURS, cur.hour + elapsed * Number(speed));
      seekLanding(nextHour);
      if (nextHour >= FORECAST_HOURS) stopPlayback();
    }, 70);
  };

  const handleExportCsv = () => {
    if (!state) return;
    const columns = [
      "utc",
      "days_after_landing",
      "sun_altitude_deg",
      "sun_azimuth_deg",
      "sun_skyline_deg",
      "sun_upper_limb_clearance_deg",
      "sun_disc_fraction",
      "sun_skyline_uncertain",
      "earth_altitude_deg",
      "earth_azimuth_deg",
      "earth_skyline_deg",
      "earth_center_clearance_deg",
      "earth_skyline_uncertain",
    ];
    const rows = state.samples.map(({ sun, earth }, i) =>
      [
        new Date(state.time + i * HOUR).toISOString(),
        (i / 24).toFixed(4),
        sun.alt.toFixed(4),
        sun.az.toFixed(4),
        sun.ridge.toFixed(4),
        sun.clearance.toFixed(4),
        sun.fraction.toFixed(5),
        sun.uncertain,
        earth.alt.toFixed(4),
        earth.az.toFixed(4),
        earth.ridge.toFixed(4),
        earth.clearance.toFixed(4),
        earth.uncertain,
      ].join(","),
    );
    const url = URL.createObjectURL(
      new Blob([[columns.join(","), ...rows].join("\r\n") + "\r\n"], { type: "text/csv" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `lunar-forecast-${asInput(state.time).slice(0, 10)}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const verdict = state
    ? readiness(state.stats, state.endurance, state.site.quality === "Profile")
    : { label: "—", tone: "neutral" as const, why: "—" };

  const handleSaveOption = () => {
    if (!state) return;
    const key = `${state.site.id}:${state.time}:${state.mast}:${state.endurance}:${state.ridge}`;
    const existingIdx = savedScenarios.findIndex((item) => item.id === key);
    if (existingIdx !== -1) {
      setNotice({
        message: `${state.site.name} at ${asClock(state.time)} is already in Scenario 0${existingIdx + 1}.`,
        isError: false,
      });
      return;
    }

    const nextScenario: SavedScenario = {
      id: key,
      site: state.site,
      time: state.time,
      mast: state.mast,
      endurance: state.endurance,
      ridge: state.ridge,
      relief,
      horizon: [...state.model.horizon],
      stats: state.stats,
      samples: state.samples,
      eventList: state.eventList,
      verdict: verdict.label,
    };

    setSavedScenarios((prev) => {
      if (prev.length < 2) {
        return [...prev, nextScenario];
      }
      return [prev[1], nextScenario];
    });
    setNotice({
      message:
        savedScenarios.length < 2
          ? `Saved ${state.site.name} (${asClock(state.time)}) to Scenario 0${savedScenarios.length + 1}.`
          : `Replaced oldest slot with ${state.site.name} (${asClock(state.time)}).`,
      isError: false,
    });
  };

  const handleRemoveSaved = (index: number) => {
    setSavedScenarios((prev) => prev.filter((_, idx) => idx !== index));
    setShowCompare(false);
  };

  const handleLoadSaved = (scenario: SavedScenario) => {
    void runAction(() =>
      applyLandingScenario({
        site: scenario.site,
        time: scenario.time,
        mast: scenario.mast,
        endurance: scenario.endurance,
        ridge: scenario.ridge,
      }),
    );
  };

  const siteCoordsLabel = state
    ? `${Math.abs(state.site.lat).toFixed(4)}° ${state.site.lat < 0 ? "S" : "N"} · ${state.site.lon.toFixed(4)}° E` +
      (state.site.elevation === null ? "" : ` · ${Math.round(state.site.elevation).toLocaleString("en-US")} m`)
    : "—";

  let profileStamp = "Terrain profile";
  let profileTitle: string | undefined;
  if (state) {
    if (state.site.quality === "Profile") {
      profileStamp = `Supplied profile · ${percent(state.site.floorFraction * 100)} at −2°`;
      if (state.mast !== state.site.baseHeight) profileStamp += " · Mast estimate";
    } else if (state.site.quality === "Borrowed" && state.site.borrowedFrom) {
      profileStamp = `Borrowed profile · ${state.site.borrowedFrom.distance.toFixed(1)} km away`;
      profileTitle = state.site.borrowedFrom.name;
    } else {
      profileStamp = "Flat skyline assumption";
    }
  }

  const sunStatus = useMemo(() => {
    if (!playheadData) return { text: "—", tone: "neutral" as const };
    const { sun } = playheadData.bodies;
    if (sun.uncertain) return { text: "Skyline uncertain", tone: "warn" as const };
    if (sun.center >= (sun.radius ?? 0)) return { text: "Full Sun", tone: "good" as const };
    if (sun.clearance > 0) return { text: `${percent(sun.fraction * 100)} of disc`, tone: "warn" as const };
    return { text: "In shadow", tone: "neutral" as const };
  }, [playheadData]);

  const earthStatus = useMemo(() => {
    if (!playheadData) return { text: "—", tone: "neutral" as const };
    const { earth } = playheadData.bodies;
    if (earth.uncertain) return { text: "Skyline uncertain", tone: "warn" as const };
    if (earth.clearance > 0) return { text: "Visible", tone: "good" as const };
    return { text: "Below skyline", tone: "neutral" as const };
  }, [playheadData]);

  const nextEventText = (key: "sun" | "earth") => {
    if (!state) return "—";
    const event = state.eventList[key].find((entry) => entry.hour > state.hour + 1e-7);
    const body = key === "sun" ? "Sun" : "Earth";
    return event
      ? `${body}${event.rises ? "rise" : "set"} in ≈ ${formatHours(event.hour - state.hour)}`
      : "No transition before day 30";
  };

  const hasForecast = !!state;

  return (
    <section id="landing" role="tabpanel" aria-labelledby="tab-landing" hidden={!active}>
      {notice && (
        <p
          id="landing-status"
          className="notice"
          role="status"
          data-tone={notice.isError ? "error" : undefined}
        >
          {notice.message}
        </p>
      )}

      {/* Primary Split: Left Interactive Polar Moon Selector + Right Telemetry & Terrain HUD */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(360px,41%)_minmax(0,59%)]">
        <PolarMoonSelector
          database={database}
          selectedSite={state?.site ?? null}
          siteId={siteId}
          dateInput={dateInput}
          mastInput={mastInput}
          busy={busy}
          onSelectSiteId={handleSiteChange}
          onDateInputChange={setDateInput}
          onMastInputChange={setMastInput}
          onApplyScenario={handleLandingSubmit}
          onFindBestDate={handleFindBestDate}
        />

        <div className="flex min-w-0 flex-col gap-4">
          {/* Wireframed Site Assessment & Critical Metrics Card */}
          <section className="card p-4" aria-label="Site assessment telemetry">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[rgba(235,235,228,0.14)] pb-3">
              <div>
                <div className="font-mono text-[10px] tracking-[0.14em] text-[#a7a7a1] uppercase">
                  <span className="text-[#f4d21f]">02</span> · Site Assessment
                </div>
                <h2 id="scene-site" className="mt-1 text-2xl font-bold tracking-tight text-[#f4f5f5]">
                  {state ? state.site.name : "Select Landing Site"}
                </h2>
                <p className="mono mt-0.5 text-[11px] text-[#a7a7a1]" id="scene-coords">
                  {siteCoordsLabel}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className={`status-tag ${verdict.tone}`} id="mission-verdict">
                  <span aria-hidden="true">{statusGlyph(verdict.tone)}</span>
                  <span>{verdict.label}</span>
                </span>
                <button
                  type="button"
                  id="save-option"
                  className="primary inline-flex items-center gap-1.5"
                  disabled={!hasForecast || busy}
                  onClick={handleSaveOption}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Save Option</span>
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              {/* Power Generation Potential Card */}
              <div className="border border-[rgba(235,235,228,0.18)] bg-[#080808] p-3">
                <div className="flex items-center justify-between gap-2 border-b border-[rgba(235,235,228,0.1)] pb-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] text-[#f4d21f] uppercase">
                    <Sun className="h-3.5 w-3.5" />
                    Power Generation
                  </span>
                  <span className={`status-tag ${sunStatus.tone}`} id="sun-state">
                    <span aria-hidden="true">{statusGlyph(sunStatus.tone)}</span>
                    <span>{sunStatus.text}</span>
                  </span>
                </div>

                <div className="mt-2.5 grid grid-cols-3 gap-2">
                  <div>
                    <span className="block font-mono text-[9px] tracking-[0.08em] text-[#777771] uppercase">
                      Solar Alt
                    </span>
                    <strong id="sun-alt" className="mono text-lg font-bold text-[#f4f5f5]">
                      {playheadData ? deg(playheadData.bodies.sun.alt) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span className="block font-mono text-[9px] tracking-[0.08em] text-[#777771] uppercase">
                      Skyline
                    </span>
                    <strong id="sun-ridge" className="mono text-base text-[#d8d8d2]">
                      {playheadData ? deg(playheadData.bodies.sun.ridge) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span className="block font-mono text-[9px] tracking-[0.08em] text-[#777771] uppercase">
                      Azimuth
                    </span>
                    <strong id="sun-az" className="mono text-base text-[#d8d8d2]">
                      {playheadData ? `${playheadData.bodies.sun.az.toFixed(1)}°` : "—"}
                    </strong>
                  </div>
                </div>

                <div className="mt-3 border-t border-[rgba(235,235,228,0.1)] pt-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[10px] text-[#a7a7a1] uppercase">
                      Sunlight Duration (14d)
                    </span>
                    <strong id="mission-sun" className="mono text-sm font-bold text-[#f4d21f]">
                      {state ? percent(state.stats.sun) : "—"}
                    </strong>
                  </div>
                  <progress
                    id="bar-sun"
                    className="meter-bar sun"
                    max={100}
                    value={state ? state.stats.sun : 0}
                    aria-hidden="true"
                  />
                  <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-[#a7a7a1]">
                    <span>Longest shadow:</span>
                    <strong id="mission-dark" className="text-[#f4f5f5]">
                      {state ? formatHours(state.stats.longest) : "—"}
                    </strong>
                  </div>
                  <p className="event mt-1" id="sun-event">
                    {nextEventText("sun")}
                  </p>
                </div>
              </div>

              {/* Direct-to-Earth Comm Card */}
              <div className="border border-[rgba(235,235,228,0.18)] bg-[#080808] p-3">
                <div className="flex items-center justify-between gap-2 border-b border-[rgba(235,235,228,0.1)] pb-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] text-[#93e5e1] uppercase">
                    <Radio className="h-3.5 w-3.5" />
                    Direct-to-Earth Comm
                  </span>
                  <span className={`status-tag ${earthStatus.tone}`} id="earth-state">
                    <span aria-hidden="true">{statusGlyph(earthStatus.tone)}</span>
                    <span>{earthStatus.text}</span>
                  </span>
                </div>

                <div className="mt-2.5 grid grid-cols-3 gap-2">
                  <div>
                    <span className="block font-mono text-[9px] tracking-[0.08em] text-[#777771] uppercase">
                      Earth Alt
                    </span>
                    <strong id="earth-alt" className="mono text-lg font-bold text-[#f4f5f5]">
                      {playheadData ? deg(playheadData.bodies.earth.alt) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span className="block font-mono text-[9px] tracking-[0.08em] text-[#777771] uppercase">
                      Skyline
                    </span>
                    <strong id="earth-ridge" className="mono text-base text-[#d8d8d2]">
                      {playheadData ? deg(playheadData.bodies.earth.ridge) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span className="block font-mono text-[9px] tracking-[0.08em] text-[#777771] uppercase">
                      Azimuth
                    </span>
                    <strong id="earth-az" className="mono text-base text-[#d8d8d2]">
                      {playheadData ? `${playheadData.bodies.earth.az.toFixed(1)}°` : "—"}
                    </strong>
                  </div>
                </div>

                <div className="mt-3 border-t border-[rgba(235,235,228,0.1)] pt-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[10px] text-[#a7a7a1] uppercase">
                      Earth Visibility (14d)
                    </span>
                    <strong id="mission-earth" className="mono text-sm font-bold text-[#93e5e1]">
                      {state ? percent(state.stats.earth) : "—"}
                    </strong>
                  </div>
                  <progress
                    id="bar-earth"
                    className="meter-bar earth"
                    max={100}
                    value={state ? state.stats.earth : 0}
                    aria-hidden="true"
                  />
                  <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-[#a7a7a1]">
                    <span>Next link event:</span>
                    <strong id="earth-event" className="text-[#f4f5f5]">
                      {nextEventText("earth")}
                    </strong>
                  </div>
                  <p className="mission-caption mt-1" id="mission-reason">
                    {verdict.why}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Wireframed 3D Terrain Profile + 30-Day Clearance Graph */}
          <section className="card viewer" aria-label="Terrain and 30-day skyline forecast">
            <header className="view-head">
              <div>
                <div className="font-mono text-[10px] tracking-[0.14em] text-[#a7a7a1] uppercase">
                  <span className="text-[#f4d21f]">03</span> · Terrain Profile &amp; 30-Day Clearance
                </div>
                <p>Drag 3D terrain to orbit · Scrub timeline to inspect Sun &amp; Earth paths</p>
              </div>
              <div className="segmented" id="terrain-cameras" role="group" aria-label="Terrain camera">
                {(
                  [
                    ["dome", "3D"],
                    ["eye", "Eye level"],
                    ["top", "Overhead"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={cameraPreset === key}
                    onClick={() => {
                      setCameraPreset(key);
                      terrainSceneRef.current?.preset(key);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </header>

            <div
              ref={terrainHostRef}
              id="terrain-view"
              className="scene-host terrain-host !h-[300px]"
              tabIndex={0}
              role="group"
              aria-label="3D lunar terrain, use arrow keys to rotate and plus or minus to zoom"
            >
              <div className="scene-stamp">
                <span id="scene-profile" title={profileTitle}>
                  {profileStamp}
                </span>
              </div>
            </div>

            <div className="viewer-footer">
              <div className="legend" aria-label="Terrain legend">
                <span>
                  <i className="sun" />
                  Sun
                </span>
                <span>
                  <i className="earth" />
                  Earth
                </span>
                <label className="check">
                  <input
                    type="checkbox"
                    id="show-horizon"
                    checked={showHorizon}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setShowHorizon(checked);
                      terrainSceneRef.current?.setHorizonVisible(checked);
                    }}
                  />{" "}
                  Skyline
                </label>
              </div>
              <label className="relief-label">
                Relief{" "}
                <input
                  type="range"
                  id="relief"
                  min={1}
                  max={5}
                  step={0.5}
                  value={relief}
                  onChange={(e) => setRelief(Number(e.target.value))}
                />
                <output id="relief-value" htmlFor="relief">
                  {relief}×
                </output>
              </label>
            </div>

            <div className="transport">
              <button
                type="button"
                className="primary play"
                id="landing-play"
                disabled={!hasForecast || busy}
                onClick={handleTogglePlay}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <div className="scrubber">
                <label htmlFor="timeline" className="sr-only">
                  Days after landing
                </label>
                <input
                  type="range"
                  id="timeline"
                  min={0}
                  max={FORECAST_HOURS}
                  step={0.25}
                  value={state?.hour ?? 0}
                  aria-valuetext={
                    state && playheadData
                      ? `${formatHours(state.hour)} after landing, ${asClock(playheadData.when)}`
                      : undefined
                  }
                  disabled={!hasForecast || busy}
                  onChange={(e) => {
                    stopPlayback();
                    seekLanding(Number(e.target.value));
                  }}
                />
                <div className="timeline-text">
                  <span>Landing</span>
                  <output id="playhead" htmlFor="timeline">
                    {playheadData ? asClock(playheadData.when) : "—"}
                  </output>
                  <span>+30 days</span>
                </div>
              </div>
              <label className="speed">
                <span className="sr-only">Playback speed</span>
                <select id="landing-speed" value={speed} onChange={(e) => setSpeed(e.target.value)}>
                  <option value="3">3 h/s</option>
                  <option value="12">12 h/s</option>
                  <option value="24">1 d/s</option>
                  <option value="72">3 d/s</option>
                </select>
              </label>
            </div>

            <div className="border-t border-[rgba(235,235,228,0.16)]">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
                <div>
                  <h3 className="text-sm font-bold text-[#eeefed]">30-Day Skyline Clearance</h3>
                  <p className="font-mono text-[10px] text-[#8e908b]">
                    Positive angles indicate visibility above modeled skyline
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  id="export-csv"
                  disabled={!hasForecast || busy}
                  onClick={handleExportCsv}
                >
                  Export CSV
                </button>
              </div>
              <div className="chart-frame !h-[188px]">
                <canvas
                  ref={chartCanvasRef}
                  id="forecast-chart"
                  aria-label="Sun upper limb and Earth center clearance versus days after landing."
                />
              </div>
              <div className="legend chart-legend">
                <span>
                  <i className="sun" />
                  Sun upper limb
                </span>
                <span>
                  <i className="earth" />
                  Earth center
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Minimalist Bottom Scenario Dock (Sharp aerospace HUD, zero glassmorphism) */}
      {active && (
        <aside
          className="fixed bottom-3 left-1/2 z-30 w-[min(860px,calc(100%-24px))] -translate-x-1/2 border border-[rgba(235,235,228,0.3)] bg-[#070707] px-3 py-2.5 shadow-[0_12px_36px_rgba(0,0,0,0.88)]"
          aria-label="Saved scenarios comparison dock"
        >
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2 pr-1">
              <span className="font-mono text-[10px] tracking-[0.12em] text-[#a7a7a1] uppercase">
                Saved Scenarios
              </span>
              <span className="border border-[rgba(244,210,31,0.45)] bg-[#111008] px-1.5 py-0.5 font-mono text-[10px] text-[#f4d21f]">
                {savedScenarios.length} / 2
              </span>
            </div>

            <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
              {[0, 1].map((slotIdx) => {
                const item = savedScenarios[slotIdx];
                if (!item) {
                  return (
                    <div
                      key={slotIdx}
                      className="flex h-10 items-center justify-between border border-dashed border-[rgba(235,235,228,0.2)] bg-[#050505] px-2.5 font-mono text-[10px] tracking-[0.08em] text-[#777771] uppercase"
                    >
                      <span>0{slotIdx + 1} · Empty Scenario Slot</span>
                      <span>+</span>
                    </div>
                  );
                }
                return (
                  <div
                    key={item.id}
                    className="flex h-10 items-center justify-between gap-2 border border-[rgba(244,210,31,0.45)] bg-[#0d0d0a] px-2.5"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => handleLoadSaved(item)}
                      title={`Load ${item.site.name} (${asClock(item.time)})`}
                    >
                      <div className="truncate font-mono text-[11px] font-semibold text-[#f4f5f5]">
                        <span className="text-[#f4d21f]">0{slotIdx + 1}</span> · {item.site.name}
                      </div>
                      <div className="truncate font-mono text-[9px] text-[#a7a7a1]">
                        {asClock(item.time)} · Sun {percent(item.stats.sun)}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="flex h-6 w-6 shrink-0 items-center justify-center border border-[rgba(235,235,228,0.2)] text-[#a7a7a1] hover:border-[#f4d21f] hover:text-[#f4d21f]"
                      aria-label={`Remove scenario 0${slotIdx + 1}`}
                      onClick={() => handleRemoveSaved(slotIdx)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              id="compare-scenarios"
              className="primary inline-flex h-10 items-center gap-1.5"
              disabled={savedScenarios.length < 2}
              onClick={() => setShowCompare(true)}
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
              <span>Compare</span>
            </button>
          </div>
        </aside>
      )}

      {showCompare && savedScenarios.length === 2 && (
        <CompareModal
          scenarios={[savedScenarios[0], savedScenarios[1]]}
          onClose={() => setShowCompare(false)}
        />
      )}
    </section>
  );
}
