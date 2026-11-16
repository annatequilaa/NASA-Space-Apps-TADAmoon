import { DAY } from "./astronomy";

export const asInput = (when: number) => new Date(when).toISOString().slice(0, 16);
export const asClock = (when: number) => `${asInput(when).replace("T", " ")} UTC`;
export const fromInputValue = (value: string) => Date.parse(`${value}Z`);
export const percent = (value: number) => `${value.toFixed(0)}%`;
export const dayLimits = (range: { min: number; max: number }) =>
  `${asInput(range.min).slice(0, 10)} to ${asInput(range.max).slice(0, 10)}`;
export const signed = (value: number, digits = 1) =>
  `${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(digits)}`;
export const deg = (value: number) => `${signed(value)}°`;
export const compact = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value === 0 ? 0 : value);

export function todayUtcMidnight() {
  return Math.floor(Date.now() / DAY) * DAY;
}

export function formatHours(hours: number) {
  const rounded = Math.round(hours * 60);
  const hoursTotal = Math.floor(rounded / 60);
  const days = Math.floor(hoursTotal / 24);
  if (days > 0) return `${days}d ${hoursTotal % 24}h`;
  if (hoursTotal > 0) return `${hoursTotal}h ${rounded % 60}m`;
  return `${rounded}m`;
}

export function statusGlyph(tone: "good" | "warn" | "bad" | "neutral") {
  if (tone === "good") return "●";
  if (tone === "warn") return "▲";
  if (tone === "bad") return "✖";
  return "○";
}
