import { TIME_AXIS, type Axis, type Signal } from './types.js';

/** A one-dimensional series over a signal's rows (retention times, or a spectral axis). */
export interface Trace {
  label: string;
  times: Float64Array;
  values: Float64Array;
  unit: string;
  /** Absent for chromatograms (retention time in minutes). */
  xAxis?: Axis;
  sticks?: boolean;
}

/** The row axis of a signal or trace. */
export function axisOf(x: { xAxis?: Axis }): Axis {
  return x.xAxis ?? TIME_AXIS;
}

/** An axis as a column or axis title, e.g. `Wavenumber (cm⁻¹)`. */
export function axisTitle(axis: Axis): string {
  return axis.unit ? `${axis.label} (${axis.unit})` : axis.label;
}

/** Axis identity, for deciding whether traces can share one plot. */
export function axisKey(axis: Axis): string {
  return `${axis.label}|${axis.unit}`;
}

export function columns(signal: Signal): number {
  return signal.ylabels.length;
}

/** Index of the column nearest `ylabel`, or -1 if the signal has no numeric labels. */
export function nearestColumn(signal: Signal, ylabel: number): number {
  let best = -1;
  let bestDist = Infinity;
  signal.ylabels.forEach((y, j) => {
    const d = Math.abs(y - ylabel);
    if (d < bestDist) [best, bestDist] = [j, d];
  });
  return best;
}

/** Index of the row nearest `time` (minutes). Times are ascending. */
export function nearestRow(signal: Signal, time: number): number {
  const t = signal.times;
  if (t.length === 0) return -1;
  let lo = 0;
  let hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! < time) lo = mid;
    else hi = mid;
  }
  return Math.abs(t[lo]! - time) <= Math.abs(t[hi]! - time) ? lo : hi;
}

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, '');
}

function sumColumns(signal: Signal, from: number, to: number): Float64Array {
  const n = columns(signal);
  const out = new Float64Array(signal.times.length);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = from; j <= to; j++) s += signal.data[i * n + j]!;
    out[i] = s;
  }
  return out;
}

/**
 * The signal's natural chromatogram: the channel itself for a single-column
 * file, the total ion chromatogram for MS, and the summed absorbance
 * (a "max plot"-like overview) for a diode-array file.
 */
export function overviewTrace(signal: Signal): Trace {
  const n = columns(signal);
  if (n === 1) {
    const wl = signal.ylabels[0]!;
    const label = Number.isNaN(wl) ? signal.name : `${signal.name} ${fmt(wl)} nm`;
    return { label, times: signal.times, values: sumColumns(signal, 0, 0), unit: signal.unit, xAxis: signal.xAxis, sticks: signal.sticks };
  }
  if (signal.detector === 'MS') {
    return { label: `${signal.name} TIC`, times: signal.times, values: sumColumns(signal, 0, n - 1), unit: signal.unit };
  }
  const values = sumColumns(signal, 0, n - 1);
  for (let i = 0; i < values.length; i++) values[i]! /= n;
  return { label: `${signal.name} mean ${fmt(signal.ylabels[0]!)}-${fmt(signal.ylabels[n - 1]!)} nm`, times: signal.times, values, unit: signal.unit };
}

/**
 * The chromatogram at one ylabel: a wavelength for UV (nearest recorded
 * wavelength), or an extracted ion chromatogram for MS summing every bin
 * within `window` of the target m/z.
 */
export function extractTrace(signal: Signal, ylabel: number, window = 0): Trace | null {
  const n = columns(signal);
  if (signal.detector === 'MS') {
    let from = -1;
    let to = -1;
    signal.ylabels.forEach((y, j) => {
      if (Math.abs(y - ylabel) <= window + 1e-9) {
        if (from < 0) from = j;
        to = j;
      }
    });
    if (from < 0) return null;
    return { label: `${signal.name} XIC m/z ${fmt(ylabel)}`, times: signal.times, values: sumColumns(signal, from, to), unit: signal.unit };
  }
  const j = nearestColumn(signal, ylabel);
  if (j < 0 || n === 0) return null;
  return { label: `${signal.name} ${fmt(signal.ylabels[j]!)} nm`, times: signal.times, values: sumColumns(signal, j, j), unit: signal.unit };
}

/** The spectrum (one row) at the retention time nearest `time`. */
export function spectrumAt(signal: Signal, time: number): { time: number; x: Float64Array; y: Float64Array } | null {
  const i = nearestRow(signal, time);
  if (i < 0) return null;
  const n = columns(signal);
  return { time: signal.times[i]!, x: signal.ylabels, y: signal.data.slice(i * n, (i + 1) * n) };
}

/** Minimum and maximum of the whole data matrix, ignoring non-finite values. */
export function dataRange(signal: Signal): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of signal.data) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}
