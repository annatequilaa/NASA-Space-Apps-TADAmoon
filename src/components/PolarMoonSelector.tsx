import type { FormEvent } from "react";
import { RAD, clamp, type LandingSite, type LoadedDatabase } from "../lib/astronomy";
import { asInput } from "../lib/format";

interface PolarMoonSelectorProps {
  database: LoadedDatabase | null;
  selectedSite: LandingSite | null;
  siteId: string;
  dateInput: string;
  mastInput: string;
  busy: boolean;
  onSelectSiteId: (id: string) => void;
  onDateInputChange: (val: string) => void;
  onMastInputChange: (val: string) => void;
  onApplyScenario: (e: FormEvent) => void;
  onFindBestDate: () => void;
}

function polarPosition(lat: number, lon: number, index: number): { left: string; top: string; isRight: boolean } {
  // Stereographic south-pole projection centered at 90°S (50%, 50%)
  const colat = Math.max(0.2, 90 + lat);
  // Ensure inner Shackleton sites stay distinctly clickable without overlapping
  const rPct = clamp((colat / 6.2) * 38, index === 0 ? 11 : 7, 39);
  const angle = lon * RAD;
  const x = 50 + rPct * Math.sin(angle);
  const y = 50 - rPct * Math.cos(angle);
  return {
    left: `${x.toFixed(2)}%`,
    top: `${y.toFixed(2)}%`,
    isRight: x > 54,
  };
}

export function PolarMoonSelector({
  database,
  selectedSite,
  siteId,
  dateInput,
  mastInput,
  busy,
  onSelectSiteId,
  onDateInputChange,
  onMastInputChange,
  onApplyScenario,
  onFindBestDate,
}: PolarMoonSelectorProps) {
  const skyMin = database ? asInput(database.ephemeris.sky.min) : undefined;
  const skyMax = database ? asInput(database.ephemeris.sky.max) : undefined;
  const profileSites = database?.sites ?? [];
  const ready = !!database;

  return (
    <section className="card map-hud-panel flex flex-col justify-between overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-[rgba(235,235,228,0.14)] px-4 py-3.5">
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] text-[#a7a7a1] uppercase">
            <span className="text-[#f4d21f]">01</span> · Lunar South Pole
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[#f2f2f0]">Landing Sites</h1>
          <p className="mt-0.5 font-mono text-[10px] tracking-[0.1em] text-[#8e908b] uppercase">
            Click a polar candidate node or choose a site below
          </p>
        </div>
        <div className="text-right font-mono text-[10px] tracking-[0.1em] uppercase">
          <div className="text-[#777771]">Target Pole</div>
          <div className="mt-0.5 text-[#f4d21f]">90° 00&apos; S</div>
        </div>
      </div>

      {/* Interactive Polar Moon Disc */}
      <div className="relative flex flex-1 items-center justify-center px-4 py-5">
        <div className="polar-disc-frame relative aspect-square w-full max-w-[380px]">
          <div className="polar-disc-surface" aria-hidden="true" />
          <div className="polar-grid-ring ring-outer" aria-hidden="true" />
          <div className="polar-grid-ring ring-mid" aria-hidden="true" />
          <div className="polar-grid-ring ring-inner" aria-hidden="true" />
          <div className="polar-axis axis-h" aria-hidden="true" />
          <div className="polar-axis axis-v" aria-hidden="true" />

          <span className="polar-tick tick-n">0° E</span>
          <span className="polar-tick tick-s">180° E</span>
          <span className="polar-tick tick-e">90° E</span>
          <span className="polar-tick tick-w">270° E</span>

          <div className="polar-center-mark" aria-hidden="true">
            <span className="text-[11px] text-[#f4d21f]">+</span>
            <span className="font-mono text-[9px] tracking-[0.12em] text-[#c7c9c7]">SOUTH POLE</span>
          </div>

          {profileSites.map((site, idx) => {
            const pos = polarPosition(site.lat, site.lon, idx);
            const active = selectedSite?.id === site.id;
            return (
              <button
                key={site.id}
                type="button"
                className={`polar-node ${active ? "is-selected" : ""} ${pos.isRight ? "is-right" : ""}`}
                style={{ left: pos.left, top: pos.top }}
                aria-label={`Select ${site.name}`}
                aria-pressed={active}
                disabled={busy}
                onClick={() => onSelectSiteId(site.id)}
              >
                <span className="polar-node-ring" aria-hidden="true" />
                <span className="polar-node-core" aria-hidden="true" />
                <span className="polar-node-tooltip">
                  <span className="flex items-center justify-between gap-2 font-mono text-[9px] tracking-[0.1em] text-[#9b9fa0] uppercase">
                    <span className="text-[#f4d21f]">0{idx + 1} CANDIDATE</span>
                    <span>{site.elevation !== null ? `${Math.round(site.elevation)} m` : "—"}</span>
                  </span>
                  <strong className="mt-0.5 block text-[13px] font-bold tracking-tight text-[#f4f5f5]">
                    {site.name}
                  </strong>
                  <span className="mt-1 block border-t border-[rgba(255,255,255,0.1)] pt-1 font-mono text-[9px] text-[#a7a7a1]">
                    {Math.abs(site.lat).toFixed(2)}° S · {site.lon.toFixed(1)}° E
                  </span>
                </span>
              </button>
            );
          })}

          <div className="polar-scale" aria-hidden="true">
            <span className="polar-scale-bar" />
            <span>0–100 KM</span>
          </div>
        </div>
      </div>

      {/* Mission Window & All Sites Dropdown Controls */}
      <div className="border-t border-[rgba(235,235,228,0.16)] bg-[#070707]/95 px-4 py-3">
        <div className="mb-2.5">
          <label className="field-label">
            All Sites
            <select
              id="site-select"
              disabled={!ready || busy}
              value={siteId}
              onChange={(e) => onSelectSiteId(e.target.value)}
            >
              {!database ? (
                <option value="">Loading sites…</option>
              ) : (
                <>
                  <optgroup label="Terrain profiles">
                    {database.sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Reference sites · flat skyline">
                    {database.reference.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </optgroup>
                </>
              )}
            </select>
          </label>
        </div>

        <form onSubmit={onApplyScenario} className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1.2fr_0.9fr_auto]">
          <label className="field-label">
            Landing Date <span className="unit">UTC</span>
            <input
              type="datetime-local"
              id="landing-date"
              min={skyMin}
              max={skyMax}
              required
              disabled={!ready || busy}
              value={dateInput}
              onChange={(e) => onDateInputChange(e.target.value)}
            />
          </label>
          <label className="field-label">
            Mast Height
            <select
              id="mast"
              disabled={!ready || busy}
              value={mastInput}
              onChange={(e) => onMastInputChange(e.target.value)}
            >
              <option value="2">2 m · Rover</option>
              <option value="6">6 m · Lander</option>
              <option value="15">15 m · Solar</option>
              <option value="35">35 m · Tower</option>
            </select>
          </label>
          <div className="flex items-end gap-1.5">
            <button type="submit" className="primary" id="apply-landing" disabled={!ready || busy}>
              Apply
            </button>
            <button
              type="button"
              className="secondary"
              id="find-date"
              disabled={!selectedSite || busy}
              onClick={onFindBestDate}
              title="Search forward 30 days for highest sunlit + Earth window"
            >
              Best Date
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
