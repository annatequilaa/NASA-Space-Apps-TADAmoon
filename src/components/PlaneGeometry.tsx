import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { triangleGeometry } from "../lib/astronomy";
import { compact } from "../lib/format";
import { GeometryScene, mountScene } from "../lib/scenes";

interface PlaneGeometryProps {
  active: boolean;
}

const DEFAULT_COORDS = {
  ax: "0",
  ay: "0",
  az: "0",
  bx: "6",
  by: "0",
  bz: "0",
  cx: "1",
  cy: "2",
  cz: "4",
};

type CoordKey = keyof typeof DEFAULT_COORDS;

export function PlaneGeometry({ active }: PlaneGeometryProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<GeometryScene | null>(null);

  const [coords, setCoords] = useState(DEFAULT_COORDS);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    area: string;
    incenter: string;
    normal: string;
  }>({ area: "—", incenter: "—", normal: "—" });

  const evaluate = useCallback((values: typeof DEFAULT_COORDS) => {
    const points = (["a", "b", "c"] as const).map((pt) =>
      (["x", "y", "z"] as const).map((axis) => {
        const raw = values[`${pt}${axis}` as CoordKey];
        return raw === "" ? NaN : Number(raw);
      }),
    );
    const valid = points.flat().every((v) => Number.isFinite(v) && Math.abs(v) <= 1e12);
    const computed = valid ? triangleGeometry(points) : null;
    if (!computed) {
      setError(
        valid
          ? "The points are collinear or repeated. Enter three non-collinear points."
          : "Enter finite coordinates between −1 trillion and +1 trillion.",
      );
      setResult({ area: "—", incenter: "—", normal: "—" });
    } else {
      const fmt = (arr: number[]) => `(${arr.map(compact).join(", ")})`;
      setError(null);
      setResult({
        area: compact(computed.area),
        incenter: fmt(computed.incenter),
        normal: fmt(computed.normal),
      });
    }
    sceneRef.current?.update(points, computed);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (hostRef.current && !sceneRef.current) {
      sceneRef.current = mountScene(GeometryScene, hostRef.current);
    }
    evaluate(coords);
  }, [active, coords, evaluate]);

  useEffect(() => {
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    evaluate(coords);
  };

  const handleReset = () => {
    setCoords(DEFAULT_COORDS);
    evaluate(DEFAULT_COORDS);
  };

  const setField = (key: CoordKey, value: string) => {
    setCoords((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <section id="geometry" role="tabpanel" aria-labelledby="tab-geometry" hidden={!active}>
      <div className="intro">
        <div>
          <h1>Three-point plane</h1>
          <p>Enter three points to see the triangle, its incenter and its unit normal.</p>
        </div>
      </div>

      <div className="split geometry-layout">
        <section className="card geom-controls">
          <h2>Triangle coordinates</h2>
          <form id="triangle-form" onSubmit={handleSubmit}>
            <div className="coordinates-grid">
              <span />
              <span>X</span>
              <span>Y</span>
              <span>Z</span>
              {(["a", "b", "c"] as const).map((pt) => (
                <div key={pt} className="contents">
                  <span>{pt.toUpperCase()}</span>
                  {(["x", "y", "z"] as const).map((axis) => {
                    const key = `${pt}${axis}` as CoordKey;
                    return (
                      <input
                        key={key}
                        aria-label={`${pt.toUpperCase()} ${axis}`}
                        name={key}
                        type="number"
                        step="any"
                        required
                        value={coords[key]}
                        onChange={(e) => setField(key, e.target.value)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="control-group">
              <button type="submit" className="primary">
                Draw plane
              </button>
              <button type="button" className="secondary" id="reset-triangle" onClick={handleReset}>
                Reset example
              </button>
            </div>
          </form>

          {error && (
            <p id="geometry-status" className="notice" role="status" data-tone="error">
              {error}
            </p>
          )}

          <dl className="geometry-results">
            <div>
              <dt>Area</dt>
              <dd id="triangle-area">{result.area}</dd>
            </div>
            <div>
              <dt>Incenter</dt>
              <dd id="triangle-center">{result.incenter}</dd>
            </div>
            <div>
              <dt>Unit normal (+Y)</dt>
              <dd id="triangle-normal">{result.normal}</dd>
            </div>
          </dl>
        </section>

        <section className="card viewer">
          <header className="view-head">
            <h2>Triangle preview</h2>
            <button
              id="geometry-camera"
              type="button"
              className="secondary"
              onClick={() => sceneRef.current?.reset()}
            >
              Reset view
            </button>
          </header>
          <div
            ref={hostRef}
            id="geometry-view"
            className="scene-host geometry-host"
            tabIndex={0}
            role="group"
            aria-label="3D triangle with its incenter and normal, use arrow keys to rotate and plus or minus to zoom"
          />
          <div className="viewer-footer legend">
            <span>
              <i className="earth" />
              Triangle
            </span>
            <span>
              <i className="sun" />
              Incenter and normal
            </span>
          </div>
        </section>
      </div>
    </section>
  );
}
