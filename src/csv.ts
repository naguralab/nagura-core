import type { Signal } from './types.js';
import { axisOf, axisTitle, type Trace } from './ops.js';

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function num(x: number): string {
  return Number.isFinite(x) ? String(x) : '';
}

/**
 * A signal's full matrix as CSV: one row per retention time (or spectral
 * point), one column per wavelength or m/z (a single column for a
 * one-channel file or a spectrum).
 */
export function signalToCsv(signal: Signal): string {
  const n = signal.ylabels.length;
  const unit = signal.unit ? ` (${signal.unit})` : '';
  const header = [axisTitle(axisOf(signal))];
  signal.ylabels.forEach((y) => header.push(Number.isNaN(y) ? `${signal.name}${unit}` : `${num(y)}${unit}`));
  const lines = [header.map(cell).join(',')];
  for (let i = 0; i < signal.times.length; i++) {
    const row = [num(signal.times[i]!)];
    for (let j = 0; j < n; j++) row.push(num(signal.data[i * n + j]!));
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Several traces side by side. Traces sampled on the same times share one
 * time column; otherwise each trace gets its own time and value columns.
 */
export function tracesToCsv(traces: Trace[]): string {
  if (traces.length === 0) return '';
  const first = traces[0]!.times;
  const shared = traces.every(
    (t) => t.times.length === first.length && t.times.every((x, i) => x === first[i]),
  );
  const label = (t: Trace) => (t.unit ? `${t.label} (${t.unit})` : t.label);
  const x = axisOf(traces[0]!);

  const lines: string[] = [];
  if (shared) {
    lines.push([axisTitle(x), ...traces.map(label)].map(cell).join(','));
    for (let i = 0; i < first.length; i++) {
      lines.push([num(first[i]!), ...traces.map((t) => num(t.values[i]!))].join(','));
    }
  } else {
    const xName = (t: Trace) => {
      const a = axisOf(t);
      return `${t.label} ${a.label.toLowerCase()}${a.unit ? ` (${a.unit})` : ''}`;
    };
    lines.push(traces.flatMap((t) => [xName(t), label(t)]).map(cell).join(','));
    const rows = Math.max(...traces.map((t) => t.times.length));
    for (let i = 0; i < rows; i++) {
      lines.push(
        traces
          .flatMap((t) => (i < t.times.length ? [num(t.times[i]!), num(t.values[i]!)] : ['', '']))
          .join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}
