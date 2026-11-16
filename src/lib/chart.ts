import { clamp, FORECAST_HOURS, type SkySample } from "./astronomy";

const COLORS = { sun: "#f4d21f", earth: "#93e5e1", baseline: "#c4a1f9" };
const MONO = '10px "IBM Plex Mono", monospace';

export class ForecastChart {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  hour = 0;
  samples: SkySample[] | undefined;
  baseline: SkySample[] | undefined;
  plot: { left: number; width: number } | undefined;
  resizeObserver: ResizeObserver;
  clickHandler: (event: MouseEvent) => void;

  constructor(canvas: HTMLCanvasElement, onSeek: (hour: number) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(canvas);
    this.clickHandler = (event: MouseEvent) => {
      if (!this.plot || !this.samples) return;
      const { left, width } = this.plot;
      const x = event.clientX - canvas.getBoundingClientRect().left;
      onSeek(clamp((x - left) / width, 0, 1) * FORECAST_HOURS);
    };
    canvas.addEventListener("click", this.clickHandler);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("click", this.clickHandler);
  }

  update(samples: SkySample[], baseline?: SkySample[]) {
    this.samples = samples;
    this.baseline = baseline;
    this.render();
  }

  seek(hour: number) {
    this.hour = hour;
    this.render();
  }

  render() {
    const { canvas, ctx } = this;
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h || !this.samples) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const left = 43;
    const right = w - 10;
    const top = 10;
    const bottom = h - 28;
    const width = right - left;
    this.plot = { left, width };

    const lines = [
      { values: this.samples.map((item) => item.sun.clearance), color: COLORS.sun, dash: [] as number[] },
      { values: this.samples.map((item) => item.earth.clearance), color: COLORS.earth, dash: [] as number[] },
    ];
    if (this.baseline) {
      lines.push({
        values: this.baseline.map((item) => item.sun.clearance),
        color: COLORS.baseline,
        dash: [5, 5],
      });
    }
    const all = lines.flatMap((line) => line.values);
    const low = Math.min(-1, ...all);
    const high = Math.max(1, ...all);
    const desired = (high - low) / 5;
    const increment = [0.5, 1, 2, 5, 10, 20, 30, 45, 90].find((step) => step >= desired) ?? 90;
    const min = Math.floor(low / increment) * increment;
    const max = Math.ceil(high / increment) * increment;
    const x = (hour: number) => left + (width * hour) / FORECAST_HOURS;
    const y = (angle: number) => bottom - ((bottom - top) * (angle - min)) / (max - min);

    ctx.fillStyle = "rgba(244, 210, 31, 0.06)";
    ctx.fillRect(left, top, x(14 * 24) - left, bottom - top);
    ctx.font = MONO;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (let angle = min; angle <= max + 1e-9; angle += increment) {
      const row = y(angle);
      ctx.strokeStyle = Math.abs(angle) < 1e-6 ? "rgba(235, 235, 228, 0.45)" : "rgba(235, 235, 228, 0.12)";
      ctx.setLineDash(Math.abs(angle) < 1e-6 ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(left, row);
      ctx.lineTo(right, row);
      ctx.stroke();
      ctx.fillStyle = "#a7a7a1";
      ctx.fillText(`${Number(angle.toFixed(1))}°`, left - 6, row);
    }
    ctx.setLineDash([]);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const gap = w < 480 ? 10 : 5;
    for (let days = 0; days <= 30; days += gap) {
      const column = x(days * 24);
      ctx.strokeStyle = "rgba(235, 235, 228, 0.1)";
      ctx.beginPath();
      ctx.moveTo(column, top);
      ctx.lineTo(column, bottom);
      ctx.stroke();
      ctx.fillStyle = "#a7a7a1";
      ctx.textAlign = days === 30 ? "right" : days === 0 ? "left" : "center";
      ctx.fillText(`${days}d`, column, bottom + 6);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width + 1, bottom - top + 1);
    ctx.clip();
    for (const { values, color, dash } of lines) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(left, y(values[0]));
      for (let hour = 1; hour < values.length; hour++) ctx.lineTo(x(hour), y(values[hour]));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = "#f4d21f";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x(this.hour), top);
    ctx.lineTo(x(this.hour), bottom);
    ctx.stroke();
    ctx.restore();
  }
}
