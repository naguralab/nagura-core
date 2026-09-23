import type { Run } from './types.js';

/** A retention-time window, in minutes. */
export interface TimeWindow {
  label: string;
  start: number;
  end: number;
}

export interface WindowResult {
  label: string;
  start: number;
  end: number;
  /** Data points inside the window. */
  points: number;
  /** Highest value in the window, and its retention time (min). */
  max: number | null;
  rtAtMax: number | null;
  /** Trapezoidal area of the signal in the window, in signal unit × seconds. */
  area: number | null;
  /**
   * Area above a straight baseline drawn between the first and last point of
   * the window (a drop-line baseline), in signal unit × seconds.
   */
  areaAboveBaseline: number | null;
}

/**
 * Plain arithmetic over the points inside a user-chosen window: no peak
 * detection, no judgment calls, so every number can be checked by hand.
 * Times are ascending, in minutes; areas use seconds, as chromatography data
 * systems report them.
 */
export function windowStats(times: ArrayLike<number>, values: ArrayLike<number>, w: TimeWindow): WindowResult {
  const lo = Math.min(w.start, w.end);
  const hi = Math.max(w.start, w.end);
  const t: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const ti = times[i]!;
    const vi = values[i]!;
    if (ti >= lo && ti <= hi && Number.isFinite(vi)) {
      t.push(ti);
      v.push(vi);
    }
  }
  const result: WindowResult = { label: w.label, start: lo, end: hi, points: t.length, max: null, rtAtMax: null, area: null, areaAboveBaseline: null };
  if (t.length === 0) return result;

  let k = 0;
  for (let i = 1; i < v.length; i++) if (v[i]! > v[k]!) k = i;
  result.max = v[k]!;
  result.rtAtMax = t[k]!;
  if (t.length < 2) return result;

  const t0 = t[0]!;
  const t1 = t[t.length - 1]!;
  const v0 = v[0]!;
  const v1 = v[v.length - 1]!;
  const baseline = (x: number) => (t1 === t0 ? v0 : v0 + ((v1 - v0) * (x - t0)) / (t1 - t0));
  let area = 0;
  let above = 0;
  for (let i = 1; i < t.length; i++) {
    const dt = (t[i]! - t[i - 1]!) * 60;
    area += ((v[i]! + v[i - 1]!) / 2) * dt;
    above += ((v[i]! - baseline(t[i]!) + (v[i - 1]! - baseline(t[i - 1]!))) / 2) * dt;
  }
  result.area = area;
  result.areaAboveBaseline = above;
  return result;
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per run: name, sample, date, method, vial, operator and its signals. */
export function runsToCsv(runs: Run[]): string {
  const lines = [['Run', 'Sample', 'Date', 'Method', 'Vial', 'Operator', 'Signals'].join(',')];
  for (const r of runs) {
    const m = r.metadata;
    lines.push(
      [r.name, m.sample, m.date, m.method, m.vialpos, m.operator, r.signals.map((s) => s.name).join('; ')]
        .map((x) => cell(x as string | number | undefined))
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export interface WindowRow {
  run: string;
  sample: string;
  trace: string;
  unit: string;
  result: WindowResult;
}

/** The window table as CSV: one row per run and window. */
export function windowRowsToCsv(rows: WindowRow[]): string {
  const header = ['Run', 'Sample', 'Trace', 'Window', 'Start (min)', 'End (min)', 'Points', 'RT at max (min)', 'Max', 'Area (unit·s)', 'Area above baseline (unit·s)', 'Unit'];
  const lines = [header.map(cell).join(',')];
  for (const r of rows) {
    const x = r.result;
    lines.push(
      [r.run, r.sample, r.trace, x.label, x.start, x.end, x.points, x.rtAtMax, x.max, x.area, x.areaAboveBaseline, r.unit].map(cell).join(','),
    );
  }
  return lines.join('\n') + '\n';
}
