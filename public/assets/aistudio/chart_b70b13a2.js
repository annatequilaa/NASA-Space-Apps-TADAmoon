import { clamp, FORECAST_HOURS } from "./astronomy.js";

const COLORS = { sun: "#ffc675", earth: "#71cefb", baseline: "#c4a1f9" };
const MONO = '10px "IBM Plex Mono", monospace';

export class ForecastChart {
  constructor(canvas, onSeek) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.hour = 0;
    new ResizeObserver(() => this.render()).observe(canvas);
    canvas.addEventListener("click", (event) => {
      if (!this.plot || !this.samples) return;
      const { left, width } = this.plot;
      const x = event.clientX - canvas.getBoundingClientRect().left;
      onSeek(clamp((x - left) / width, 0, 1) * FORECAST_HOURS);
    });
  }

  update(samples, baseline) {
    this.samples = samples;
    this.baseline = baseline;
    this.render();
  }

  seek(hour) {
    this.hour = hour;
    this.render();
  }

  render() {
    const { canvas, ctx } = this;
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h || !this.samples) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const left = 43, right = w - 10, top = 10, bottom = h - 28, width = right - left;
    this.plot = { left, width };
    const lines = [
      { values: this.samples.map((item) => item.sun.clearance), color: COLORS.sun, dash: [] },
      { values: this.samples.map((item) => item.earth.clearance), color: COLORS.earth, dash: [] },
    ];
    if (this.baseline) {
      lines.push({ values: this.baseline.map((item) => item.sun.clearance), color: COLORS.baseline, dash: [5, 5] });
    }
    const all = lines.flatMap((line) => line.values);
    const low = Math.min(-1, ...all), high = Math.max(1, ...all);
    const desired = (high - low) / 5;
    const increment = [0.5, 1, 2, 5, 10, 20, 30, 45, 90].find((step) => step >= desired) ?? 90;
    const min = Math.floor(low / increment) * increment, max = Math.ceil(high / increment) * increment;
    const x = (hour) => left + width * hour / FORECAST_HOURS;
    const y = (angle) => bottom - (bottom - top) * (angle - min) / (max - min);

    ctx.fillStyle = "#1c2a2c55";
    ctx.fillRect(left, top, x(14 * 24) - left, bottom - top);
    ctx.font = MONO;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (let angle = min; angle <= max; angle += increment) {
      const row = y(angle);
      ctx.strokeStyle = angle === 0 ? "#9cacbd" : "#2b3441";
      ctx.setLineDash(angle === 0 ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(left, row);
      ctx.lineTo(right, row);
      ctx.stroke();
      ctx.fillStyle = "#a4b0bf";
      ctx.fillText(`${angle}°`, left - 6, row);
    }
    ctx.setLineDash([]);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const gap = w < 480 ? 10 : 5;
    for (let days = 0; days <= 30; days += gap) {
      const column = x(days * 24);
      ctx.strokeStyle = "#2b3441";
      ctx.beginPath();
      ctx.moveTo(column, top);
      ctx.lineTo(column, bottom);
      ctx.stroke();
      ctx.fillStyle = "#a4b0bf";
      ctx.textAlign = days === 30 ? "right" : days === 0 ? "left" : "center";
      ctx.fillText(`${days}d`, column, bottom + 6);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width + 1, bottom - top + 1);
    ctx.clip();
    for (const { values, color, dash } of lines) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.45;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(left, y(values[0]));
      for (let hour = 1; hour < values.length; hour++) ctx.lineTo(x(hour), y(values[hour]));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = "#c4edab";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x(this.hour), top);
    ctx.lineTo(x(this.hour), bottom);
    ctx.stroke();
    ctx.restore();
  }
}
