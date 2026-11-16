import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { DAY, clamp, orbitMeasures, type LoadedDatabase } from "../lib/astronomy";
import { asClock, asInput, dayLimits, fromInputValue, todayUtcMidnight } from "../lib/format";
import { OrbitScene, mountScene, type OrbitCameraMode } from "../lib/scenes";

interface OrbitSimulatorProps {
  database: LoadedDatabase | null;
  active: boolean;
  landingPlayheadTime: number | null;
}

interface OrbitNotice {
  message: string;
  isError: boolean;
}

export function OrbitSimulator({ database, active, landingPlayheadTime }: OrbitSimulatorProps) {
  const orbitHostRef = useRef<HTMLDivElement | null>(null);
  const orbitSceneRef = useRef<OrbitScene | null>(null);
  const timerRef = useRef<number | null>(null);
  const ticketRef = useRef(0);
  const pathTimeRef = useRef<number | null>(null);
  const tickingRef = useRef(false);
  const timeRef = useRef<number | null>(null);
  const playingRef = useRef(false);

  const [orbitTime, setOrbitTime] = useState<number | null>(null);
  const [dateInput, setDateInput] = useState("");
  const [mode, setMode] = useState<OrbitCameraMode>("system");
  const [speed, setSpeed] = useState("1");
  const [showLines, setShowLines] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OrbitNotice | null>(null);
  const [measures, setMeasures] = useState<{
    sunEarth: number;
    earthMoon: number;
    sunMoon: number;
    eccentricity: number;
  } | null>(null);

  timeRef.current = orbitTime;
  playingRef.current = playing;

  const stopOrbit = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPlaying(false);
    playingRef.current = false;
    if (timeRef.current !== null) {
      setDateInput(asInput(timeRef.current));
    }
  }, []);

  const renderOrbitAt = useCallback(
    (when: number) => {
      if (!database) return;
      const epi = database.ephemeris;
      const positions = epi.orbitAt(when);
      const scene = orbitSceneRef.current;
      if (scene && (pathTimeRef.current === null || Math.abs(when - pathTimeRef.current) > 3 * DAY)) {
        const start = clamp(when - 365 * DAY, epi.orbit.min, epi.orbit.end - 365 * DAY);
        const lunarStart = clamp(when - 28 * DAY, epi.orbit.min, epi.orbit.end - 28 * DAY);
        const earthPath = Array.from({ length: 183 }, (_, i) => epi.orbitAt(start + (i / 182) * 365 * DAY).earth.position);
        const moonPath = Array.from({ length: 113 }, (_, i) => epi.orbitAt(lunarStart + (i * DAY) / 4).lunar.position);
        scene.updatePaths(earthPath, moonPath);
        pathTimeRef.current = when;
      }
      scene?.update(positions);
      setMeasures(orbitMeasures(positions));
    },
    [database],
  );

  const showOrbit = useCallback(
    async (when: number, moving = false) => {
      if (!database) return;
      const range = database.ephemeris.orbit;
      if (!Number.isFinite(when) || when < range.min || when > range.max) {
        setNotice({
          message: `Choose a UTC date from ${dayLimits(range)}. The final day ends at 00:00 UTC.`,
          isError: true,
        });
        return;
      }
      const ticket = ++ticketRef.current;
      if (!moving) setBusy(true);
      try {
        const start = clamp(when - 365 * DAY, range.min, range.end - 365 * DAY);
        await database.ephemeris.ensure("orbit", start, Math.max(start + 365 * DAY, when));
        if (ticketRef.current !== ticket || (moving && !playingRef.current)) return;
        setOrbitTime(when);
        timeRef.current = when;
        if (!moving) {
          setDateInput(asInput(when));
          setNotice(null);
        }
        renderOrbitAt(when);
      } catch (error) {
        if (ticketRef.current === ticket) {
          stopOrbit();
          setNotice({
            message: error instanceof Error ? error.message : "Could not load orbit data.",
            isError: true,
          });
        }
      } finally {
        if (!moving && ticketRef.current === ticket) {
          setBusy(false);
        }
      }
    },
    [database, renderOrbitAt, stopOrbit],
  );

  // Mount OrbitScene & initialize when tab becomes active
  useEffect(() => {
    if (!active) {
      stopOrbit();
      return;
    }
    if (orbitHostRef.current && !orbitSceneRef.current) {
      orbitSceneRef.current = mountScene(OrbitScene, orbitHostRef.current);
      orbitSceneRef.current?.setLines(showLines);
      orbitSceneRef.current?.setMode(mode);
    }
    if (database && timeRef.current === null && !busy) {
      const initialTime = clamp(
        landingPlayheadTime ?? todayUtcMidnight(),
        database.ephemeris.orbit.min,
        database.ephemeris.orbit.max,
      );
      void showOrbit(initialTime);
    } else if (database && timeRef.current !== null) {
      renderOrbitAt(timeRef.current);
    }
  }, [active, busy, database, landingPlayheadTime, mode, renderOrbitAt, showLines, showOrbit, stopOrbit]);

  useEffect(() => {
    return () => {
      stopOrbit();
      orbitSceneRef.current?.dispose();
      orbitSceneRef.current = null;
    };
  }, [stopOrbit]);

  const handleOrbitSubmit = (event: FormEvent) => {
    event.preventDefault();
    stopOrbit();
    void showOrbit(fromInputValue(dateInput));
  };

  const stepDays = (days: number) => {
    if (!database || timeRef.current === null) return;
    stopOrbit();
    const range = database.ephemeris.orbit;
    void showOrbit(clamp(timeRef.current + days * DAY, range.min, range.max));
  };

  const handleTogglePlay = () => {
    if (playing) {
      stopOrbit();
      return;
    }
    if (!database || timeRef.current === null) return;
    if (timeRef.current >= database.ephemeris.orbit.max) {
      setNotice({
        message: "The simulation reached its final date. Select an earlier date to play.",
        isError: false,
      });
      return;
    }
    setPlaying(true);
    playingRef.current = true;
    setNotice(null);
    let previous = performance.now();
    timerRef.current = window.setInterval(async () => {
      if (tickingRef.current || !database || timeRef.current === null) return;
      tickingRef.current = true;
      const now = performance.now();
      const elapsed = Math.min((now - previous) / 1000, 0.25);
      previous = now;
      const max = database.ephemeris.orbit.max;
      const next = Math.min(max, timeRef.current + elapsed * Number(speed) * DAY);
      await showOrbit(next, true);
      if (next >= max) stopOrbit();
      tickingRef.current = false;
    }, 65);
  };

  const formatKm = (distance: number, rounding = 10) =>
    `≈ ${(Math.round(distance / rounding) * rounding).toLocaleString("en-US")} km`;

  const ready = !!database;
  const orbitMin = database ? asInput(database.ephemeris.orbit.min) : undefined;
  const orbitMax = database ? asInput(database.ephemeris.orbit.max) : undefined;

  return (
    <section id="orbit" role="tabpanel" aria-labelledby="tab-orbit" hidden={!active}>
      <div className="intro">
        <div>
          <h1>Sun, Earth &amp; Moon</h1>
          <p>Follow their changing positions and distances through the solar-lunar ephemeris.</p>
        </div>
      </div>

      <div className="card input-panel">
        <form id="orbit-form" className="input-row orbit-inputs" onSubmit={handleOrbitSubmit}>
          <label className="field-label">
            Simulation date &amp; time <span className="unit">UTC</span>
            <input
              type="datetime-local"
              id="orbit-date"
              min={orbitMin}
              max={orbitMax}
              required
              disabled={!ready || busy}
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" id="apply-orbit" disabled={!ready || busy}>
            Apply
          </button>
          <div className="control-group">
            <button
              type="button"
              id="orbit-back"
              className="secondary"
              disabled={!ready || busy}
              onClick={() => stepDays(-1)}
            >
              −1 day
            </button>
            <button
              type="button"
              id="orbit-forward"
              className="secondary"
              disabled={!ready || busy}
              onClick={() => stepDays(1)}
            >
              +1 day
            </button>
          </div>
        </form>
      </div>

      {notice && (
        <p id="orbit-status" className="notice" role="status" data-tone={notice.isError ? "error" : undefined}>
          {notice.message}
        </p>
      )}

      <div className="split">
        <section className="card viewer">
          <header className="view-head">
            <div>
              <h2 id="orbit-scene-title">{mode === "pair" ? "Earth–Moon view" : "Solar system view"}</h2>
              <p className="mono" id="orbit-time">
                {orbitTime !== null ? asClock(orbitTime) : "—"}
              </p>
            </div>
            <div className="segmented" id="orbit-cameras" role="group" aria-label="Orbit camera">
              {(
                [
                  ["system", "System"],
                  ["pair", "Earth–Moon"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={mode === key}
                  onClick={() => {
                    setMode(key);
                    orbitSceneRef.current?.setMode(key);
                    if (timeRef.current !== null) renderOrbitAt(timeRef.current);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </header>

          <div
            ref={orbitHostRef}
            id="orbit-view"
            className="scene-host orbit-host"
            tabIndex={0}
            role="group"
            aria-label="3D orbital simulation, use arrow keys to rotate and plus or minus to zoom"
          >
            <div className="scene-stamp">
              <span id="orbit-scale">Moon offset ×30 · enlarged bodies</span>
            </div>
          </div>

          <div className="transport orbit-transport">
            <button
              type="button"
              className="primary play"
              id="orbit-play"
              disabled={!ready || busy}
              onClick={handleTogglePlay}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <label className="speed">
              Speed{" "}
              <select id="orbit-speed" value={speed} onChange={(e) => setSpeed(e.target.value)}>
                <option value="1">1 day/s</option>
                <option value="5">5 days/s</option>
                <option value="20">20 days/s</option>
              </select>
            </label>
            <label className="check">
              <input
                id="orbit-lines"
                type="checkbox"
                checked={showLines}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setShowLines(checked);
                  orbitSceneRef.current?.setLines(checked);
                  if (timeRef.current !== null) renderOrbitAt(timeRef.current);
                }}
              />{" "}
              Distance lines
            </label>
          </div>
        </section>

        <aside className="card telemetry orbit-readouts">
          <h2>Distances</h2>
          <dl>
            <div>
              <dt>Sun → Earth</dt>
              <dd id="sun-earth">{measures ? formatKm(measures.sunEarth) : "—"}</dd>
            </div>
            <div>
              <dt>Earth → Moon</dt>
              <dd id="earth-moon">{measures ? formatKm(measures.earthMoon) : "—"}</dd>
            </div>
            <div>
              <dt>Sun → Moon</dt>
              <dd id="sun-moon">{measures ? formatKm(measures.sunMoon) : "—"}</dd>
            </div>
          </dl>
          <h2>Moon’s heliocentric eccentricity</h2>
          <strong className="mono eccentricity" id="eccentricity">
            {measures ? measures.eccentricity.toFixed(4) : "—"}
          </strong>
          <p className="mission-caption">Instantaneous osculating value for the Moon relative to the Sun.</p>
        </aside>
      </div>
    </section>
  );
}
