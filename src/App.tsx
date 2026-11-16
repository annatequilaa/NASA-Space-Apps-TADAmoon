import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { loadData, type LoadedDatabase } from "./lib/astronomy";
import { LandingPlanner } from "./components/LandingPlanner";
import { OrbitSimulator } from "./components/OrbitSimulator";

type TabName = "landing" | "orbit";
const TAB_ORDER: TabName[] = ["landing", "orbit"];

function initialTab(): TabName {
  const hash = window.location.hash.slice(1) as TabName;
  return TAB_ORDER.includes(hash) ? hash : "landing";
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabName>(initialTab);
  const [database, setDatabase] = useState<LoadedDatabase | null>(null);
  const [appNotice, setAppNotice] = useState<{ message: string; isError: boolean } | null>({
    message: "Loading the lunar ephemeris…",
    isError: false,
  });
  const [landingPlayheadTime, setLandingPlayheadTime] = useState<number | null>(null);

  const methodDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const methodSummaryRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Record<TabName, HTMLButtonElement | null>>({
    landing: null,
    orbit: null,
  });

  useEffect(() => {
    let cancelled = false;
    loadData()
      .then((loaded) => {
        if (cancelled) return;
        setDatabase(loaded);
        setAppNotice(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setAppNotice({
          message: error instanceof Error ? error.message : "Could not load lunar terrain data.",
          isError: true,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.slice(1) as TabName;
      if (TAB_ORDER.includes(hash)) setActiveTab(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const activateTab = useCallback((name: TabName, focus = false, updateLocation = true) => {
    setActiveTab(name);
    if (updateLocation) {
      window.history.replaceState(null, "", `#${name}`);
    }
    if (focus) {
      tabRefs.current[name]?.focus();
    }
  }, []);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const idx = TAB_ORDER.indexOf(activeTab);
    let nextIdx: number | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") nextIdx = (idx + 1) % 2;
    else if (event.key === "Home") nextIdx = 0;
    else if (event.key === "End") nextIdx = 1;
    if (nextIdx === undefined) return;
    event.preventDefault();
    activateTab(TAB_ORDER[nextIdx], true);
  };

  const handleBrandClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    activateTab("landing");
    window.scrollTo(0, 0);
  };

  const handleMethodClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (methodDetailsRef.current) {
      methodDetailsRef.current.open = true;
      methodDetailsRef.current.scrollIntoView();
      methodSummaryRef.current?.focus({ preventScroll: true });
    }
  };

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="topbar">
        <div className="shell topbar-inner">
          <a
            className="brand"
            href="#landing"
            aria-label="Lunar Navigator home"
            onClick={handleBrandClick}
          >
            <span className="brand-moon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
              </svg>
            </span>
            <span>TADAmoon</span>
          </a>

          <nav className="tabs" role="tablist" aria-label="Project views">
            {(
              [
                ["landing", "Landing planner"],
                ["orbit", "Orbit simulator"],
              ] as const
            ).map(([key, label]) => {
              const selected = activeTab === key;
              return (
                <button
                  key={key}
                  ref={(el) => {
                    tabRefs.current[key] = el;
                  }}
                  id={`tab-${key}`}
                  type="button"
                  role="tab"
                  aria-controls={key}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => activateTab(key)}
                  onKeyDown={handleTabKeyDown}
                >
                  {label}
                </button>
              );
            })}
          </nav>

          <a className="method-link" href="#method" onClick={handleMethodClick}>
            Data &amp; method
          </a>
        </div>
      </header>

      <main className="shell" id="main">
        {appNotice && (
          <p id="app-status" className="notice" role="status" data-tone={appNotice.isError ? "error" : undefined}>
            {appNotice.message}
          </p>
        )}

        <LandingPlanner
          database={database}
          active={activeTab === "landing"}
          onPlayheadChange={setLandingPlayheadTime}
        />

        <OrbitSimulator
          database={database}
          active={activeTab === "orbit"}
          landingPlayheadTime={landingPlayheadTime}
        />

        <footer>
          <details id="method" ref={methodDetailsRef}>
            <summary ref={methodSummaryRef}>Data &amp; method</summary>
            <div className="method-body">
              <p>
                The landing planner computes Moon-centered apparent Sun and Earth vectors in the Mean Earth /
                Polar Axis (MOON_ME) frame using astronomical ephemerides with Cassini and physical libration
                rotations. The orbit simulator tracks Sun–Earth–Moon ICRF vectors and instantaneous osculating
                heliocentric eccentricity.
              </p>
              <p>
                The terrain view uses the supplied 40 × 40 elevation grids and 360-point skyline profiles. Display
                relief and marker size are illustrative. Reference coordinates use a flat skyline. Nearby custom
                points can borrow a profile within 10 km.
              </p>
              <p>
                Clearance compares the Sun’s upper limb or Earth’s center with the local skyline. The planner
                uses hourly forecast samples, a modeled mast-height correction and an adjustable battery
                assumption. A −2° floor in the supplied profiles can make a visibility estimate uncertain.
              </p>
              <p>
                <a href="https://ssd.jpl.nasa.gov/planets/eph_export.html" target="_blank" rel="noreferrer">
                  NASA JPL ephemerides
                </a>{" "}
                ·{" "}
                <a href="https://naif.jpl.nasa.gov/pub/naif/generic_kernels/" target="_blank" rel="noreferrer">
                  NAIF lunar kernels
                </a>{" "}
                ·{" "}
                <a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">
                  NASA SVS Moon texture
                </a>{" "}
                ·{" "}
                <a
                  href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/"
                  target="_blank"
                  rel="noreferrer"
                >
                  NASA Blue Marble Earth texture
                </a>
              </p>
            </div>
          </details>
        </footer>
      </main>
    </>
  );
}
