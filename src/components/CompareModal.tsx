import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import {
  HOUR,
  type LandingSite,
  type MissionStats,
  type SkySample,
  type TransitionEvent,
} from "../lib/astronomy";
import { ForecastChart } from "../lib/chart";
import { asClock, deg, formatHours, percent, signed } from "../lib/format";
import { TerrainScene, mountScene } from "../lib/scenes";

export interface SavedScenario {
  id: string;
  site: LandingSite;
  time: number;
  mast: number;
  endurance: number;
  ridge: number;
  relief: number;
  horizon: number[];
  stats: MissionStats;
  samples: SkySample[];
  eventList: { sun: TransitionEvent[]; earth: TransitionEvent[] };
  verdict: string;
}

interface CompareModalProps {
  scenarios: [SavedScenario, SavedScenario];
  onClose: () => void;
}

function summarizeWindows(events: TransitionEvent[], initiallyUp: boolean, baseTime: number): string {
  const intervals: string[] = [];
  let start = initiallyUp ? 0 : null;
  for (const ev of events) {
    if (ev.rises && start === null) {
      start = ev.hour;
    } else if (!ev.rises && start !== null) {
      intervals.push(`${asClock(baseTime + start * HOUR).slice(5, 16)} → ${asClock(baseTime + ev.hour * HOUR).slice(5, 16)}`);
      start = null;
    }
    if (intervals.length >= 2) break;
  }
  if (start !== null && intervals.length < 2) {
    intervals.push(`${asClock(baseTime + start * HOUR).slice(5, 16)} → +30d`);
  }
  return intervals.length ? intervals.join(" · ") : "None in 30d window";
}

function ScenarioPreviewColumn({
  scenario,
  index,
}: {
  scenario: SavedScenario;
  index: number;
}) {
  const terrainRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let scene: TerrainScene | null = null;
    let chart: ForecastChart | null = null;

    if (terrainRef.current) {
      scene = mountScene(TerrainScene, terrainRef.current);
      if (scene) {
        scene.setSurface(scenario.site.mesh, scenario.relief, scenario.horizon);
        scene.update(scenario.samples[0]);
      }
    }
    if (chartRef.current) {
      chart = new ForecastChart(chartRef.current, () => {});
      chart.update(scenario.samples);
      chart.seek(0);
    }

    return () => {
      scene?.dispose();
      chart?.dispose();
    };
  }, [scenario]);

  return (
    <div className="border border-[rgba(235,235,228,0.18)] bg-[#060606] p-3">
      <div className="flex items-start justify-between gap-2 border-b border-[rgba(235,235,228,0.12)] pb-2">
        <div>
          <div className="font-mono text-[10px] tracking-[0.12em] text-[#f4d21f] uppercase">
            Scenario 0{index + 1}
          </div>
          <h3 className="mt-0.5 text-base font-bold text-[#f4f5f5]">{scenario.site.name}</h3>
          <p className="font-mono text-[10px] text-[#a7a7a1]">
            {Math.abs(scenario.site.lat).toFixed(2)}° {scenario.site.lat < 0 ? "S" : "N"} ·{" "}
            {scenario.site.lon.toFixed(1)}° E · {asClock(scenario.time)}
          </p>
        </div>
        <span className="status-tag good">{scenario.verdict}</span>
      </div>

      <div className="mt-2.5">
        <div className="mb-1 font-mono text-[9px] tracking-[0.1em] text-[#8e908b] uppercase">
          Terrain &amp; Skyline Profile
        </div>
        <div
          ref={terrainRef}
          className="scene-host !h-[185px] border border-[rgba(235,235,228,0.14)]"
        />
      </div>

      <div className="mt-3">
        <div className="mb-1 font-mono text-[9px] tracking-[0.1em] text-[#8e908b] uppercase">
          30-Day Skyline Clearance (Sun / Earth)
        </div>
        <div className="h-[135px] border border-[rgba(235,235,228,0.14)] bg-[#040404] p-1">
          <canvas ref={chartRef} className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}

export function CompareModal({ scenarios, onClose }: CompareModalProps) {
  const [a, b] = scenarios;

  const rows: [string, string, string, string?][] = [
    ["Landing site", a.site.name, b.site.name],
    ["Landing time", asClock(a.time), asClock(b.time)],
    ["Mast height", `${a.mast} m`, `${b.mast} m`],
    [
      "Initial solar alt",
      deg(a.samples[0].sun.alt),
      deg(b.samples[0].sun.alt),
      `${signed(b.samples[0].sun.alt - a.samples[0].sun.alt, 1)}°`,
    ],
    [
      "14d Any sunlight",
      percent(a.stats.sun),
      percent(b.stats.sun),
      `${signed(b.stats.sun - a.stats.sun, 1)} pp`,
    ],
    [
      "14d Earth visibility",
      percent(a.stats.earth),
      percent(b.stats.earth),
      `${signed(b.stats.earth - a.stats.earth, 1)} pp`,
    ],
    [
      "Longest shadow",
      formatHours(a.stats.longest),
      formatHours(b.stats.longest),
      `${signed(b.stats.longest - a.stats.longest, 1)} h`,
    ],
    [
      "Sunlit windows",
      summarizeWindows(a.eventList.sun, a.samples[0].sun.clearance > 0, a.time),
      summarizeWindows(b.eventList.sun, b.samples[0].sun.clearance > 0, b.time),
    ],
    [
      "Earth-visible windows",
      summarizeWindows(a.eventList.earth, a.samples[0].earth.clearance > 0, a.time),
      summarizeWindows(b.eventList.earth, b.samples[0].earth.clearance > 0, b.time),
    ],
    ["Modeled window", a.verdict, b.verdict],
  ];

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compare-modal-title"
    >
      <div className="max-h-[92vh] w-full max-w-[1080px] overflow-y-auto border border-[rgba(235,235,228,0.28)] bg-[#080808] p-5">
        <div className="flex items-start justify-between gap-4 border-b border-[rgba(235,235,228,0.16)] pb-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.14em] text-[#f4d21f] uppercase">
              Side-by-Side Scenario Analysis
            </div>
            <h2 id="compare-modal-title" className="mt-1 text-xl font-bold text-[#f4f5f5]">
              {a.site.name} vs {b.site.name}
            </h2>
          </div>
          <button
            type="button"
            className="secondary flex h-9 w-9 items-center justify-center !p-0"
            aria-label="Close comparison"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <ScenarioPreviewColumn scenario={a} index={0} />
          <ScenarioPreviewColumn scenario={b} index={1} />
        </div>

        <div className="mt-4 border border-[rgba(235,235,228,0.18)]">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Parameter</th>
                  <th scope="col">Scenario 01</th>
                  <th scope="col">Scenario 02</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, valA, valB, delta]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td className="font-mono text-xs">{valA}</td>
                    <td className="font-mono text-xs">
                      {valB}
                      {delta && <span className="delta">{delta}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
