import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAgilentFile, parseAgilentRuns, parseDx, signalToCsv, overviewTrace, extractTrace, spectrumAt } from '../src/index.js';
import type { Signal } from '../src/index.js';

/**
 * Compares every fixture against the output of rainbow (tools/make_reference.py).
 * Set NAGURA_EXTRA_REFERENCE to another reference folder (with manifest.json)
 * to also check files too large to commit.
 */
const here = dirname(fileURLToPath(import.meta.url));
/** Public fixtures: at the repo root in nagura-core, three levels up in the monorepo. */
const fixtures = [resolve(here, '../fixtures/agilent'), resolve(here, '../../../fixtures/agilent')].find(existsSync)!;

interface Reference {
  detector: string | null;
  unit: string;
  shape: [number, number];
  ylabels: (number | null)[];
  times: (number | null)[];
  row_sums: (number | null)[];
  col_sums: (number | null)[];
  sample_rows: Record<string, (number | null)[]>;
  metadata: Record<string, string | number>;
}

function close(actual: number, expected: number | null, rel = 1e-9): boolean {
  if (expected === null) return !Number.isFinite(actual);
  const scale = Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) <= rel * scale;
}

function expectArrayClose(actual: ArrayLike<number>, expected: (number | null)[], what: string, rel = 1e-9) {
  expect(actual.length, `${what} length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (!close(actual[i]!, expected[i]!, rel)) {
      throw new Error(`${what}[${i}]: got ${actual[i]}, expected ${expected[i]}`);
    }
  }
}

function rowSums(s: Signal): number[] {
  const n = s.ylabels.length;
  return Array.from(s.times, (_, i) => s.data.subarray(i * n, (i + 1) * n).reduce((a, b) => a + b, 0));
}

function colSums(s: Signal): number[] {
  const n = s.ylabels.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < s.data.length; i++) out[i % n]! += s.data[i]!;
  return out;
}

function referenceSets(): { root: string; entries: { data: string; reference: string; member?: string }[] }[] {
  const roots = [join(here, 'reference')];
  if (process.env.NAGURA_EXTRA_REFERENCE) roots.push(resolve(process.env.NAGURA_EXTRA_REFERENCE));
  return roots
    .filter((root) => existsSync(join(root, 'manifest.json')))
    .map((root) => ({ root, entries: JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) }));
}

for (const { root, entries } of referenceSets()) {
  describe(`matches rainbow: ${root}`, () => {
    for (const entry of entries) {
      it(entry.reference.replace('__', '/').replace(/\.json$/, ''), () => {
        const ref: Reference = JSON.parse(readFileSync(join(root, entry.reference), 'utf8'));
        // Committed references point into the fixtures folder; extra sets use absolute paths.
        const dataPath = resolve(fixtures, entry.data);
        const bytes = new Uint8Array(readFileSync(dataPath));
        const signal = entry.member
          ? (parseDx(dataPath, bytes).signals.find((s) => s.name === entry.member) ?? null)
          : parseAgilentFile(dataPath, bytes);
        expect(signal).not.toBeNull();
        const s = signal!;

        expect(s.detector).toBe(ref.detector);
        // rainbow leaves MS unitless; Nagura Lab labels ion abundance as counts.
        expect(s.unit).toBe(ref.detector === 'MS' && !ref.unit ? 'counts' : ref.unit);
        expect([s.times.length, s.ylabels.length]).toEqual(ref.shape);
        expectArrayClose(s.ylabels, ref.ylabels, 'ylabels');
        if (ref.times.length === ref.shape[0]) {
          expectArrayClose(s.times, ref.times, 'times', 1e-6);
        } else {
          // rainbow builds one time point fewer than it decodes values for some
          // version 181 files. The values agree (GC2ASM too), so check that the
          // time axis spans the same run instead of matching it point by point.
          expect(Math.abs(s.times[0]! - ref.times[0]!)).toBeLessThan(1e-6);
          const step = (ref.times[ref.times.length - 1]! - ref.times[0]!) / (ref.times.length - 1);
          expect(Math.abs(s.times[s.times.length - 1]! - ref.times[ref.times.length - 1]!)).toBeLessThanOrEqual(step);
        }
        expectArrayClose(rowSums(s), ref.row_sums, 'row sums', 1e-7);
        expectArrayClose(colSums(s), ref.col_sums, 'column sums', 1e-7);
        const n = s.ylabels.length;
        for (const [row, values] of Object.entries(ref.sample_rows)) {
          const i = Number(row);
          expectArrayClose(s.data.subarray(i * n, (i + 1) * n), values, `row ${i}`);
        }
        for (const [key, value] of Object.entries(ref.metadata)) {
          expect(s.metadata[key], `metadata.${key}`).toEqual(value);
        }
      });
    }
  });
}

describe('runs and exports', () => {
  const load = (run: string, names: string[]) =>
    names.map((name) => ({
      path: `batch/${run}/${name}`,
      bytes: new Uint8Array(readFileSync(join(fixtures, run, name))),
    }));

  it('groups files by .D folder and reports undecodable files', () => {
    const files = [
      ...load('red.D', ['ADC1A.CH', 'DAD1B.ch', 'DAD1.UV']),
      ...load('yellow.D', ['FID1A.ch']),
      { path: 'batch/yellow.D/broken.ch', bytes: new Uint8Array([3, 0x31, 0x37, 0x39, 0, 0]) },
      { path: 'batch/yellow.D/ACQ.M/notes.ch', bytes: new Uint8Array([0]) },
    ];
    const runs = parseAgilentRuns(files);
    expect(runs.map((r) => r.name)).toEqual(['red.D', 'yellow.D']);
    expect(runs[0]!.signals.map((s) => s.name)).toEqual(['ADC1A.CH', 'DAD1.UV', 'DAD1B.ch']);
    expect(runs[1]!.signals.map((s) => s.name)).toEqual(['FID1A.ch']);
    expect(runs[1]!.skipped).toHaveLength(1);
    expect(runs[1]!.skipped[0]!.path).toBe('batch/yellow.D/broken.ch');
  });

  it('reads an OpenLab .dx as its own run, telemetry opt-in', () => {
    const dx = { path: 'batch/teal.dx', bytes: new Uint8Array(readFileSync(join(fixtures, 'teal.dx'))) };
    const runs = parseAgilentRuns([dx, ...load('red.D', ['DAD1B.ch'])]);
    expect(runs.map((r) => r.name)).toEqual(['red.D', 'teal.dx']);
    const run = runs[1]!;
    expect(run.signals.map((s) => s.name).sort()).toEqual(['DAD1A.CH', 'DAD1H.CH', 'DAD1I.UV']);
    expect(run.metadata.method).toBe('standbyflush.amx');
    expect(run.skipped).toEqual([]);
    const withTelemetry = parseDx(dx.path, dx.bytes, { telemetry: true });
    expect(withTelemetry.signals.length).toBeGreaterThan(3);
  });

  it('writes a signal matrix as CSV', () => {
    const [run] = parseAgilentRuns(load('red.D', ['DAD1B.ch']));
    const csv = signalToCsv(run!.signals[0]!);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('Time (min),280 (mAU)');
    expect(lines).toHaveLength(2101);
  });

  it('extracts traces and spectra', () => {
    const [red, yellow] = parseAgilentRuns([...load('red.D', ['DAD1.UV']), ...load('yellow.D', ['data.ms'])]);

    const ms = yellow!.signals[0]!;
    const tic = overviewTrace(ms);
    const xic = extractTrace(ms, ms.ylabels[10]!)!;
    expect(xic.values.length).toBe(tic.values.length);
    expect(xic.values.every((v, i) => v <= tic.values[i]!)).toBe(true);

    const uv = red!.signals[0]!;
    const at254 = extractTrace(uv, 254.4)!;
    expect(at254.label).toContain('254 nm');
    const spec = spectrumAt(uv, uv.times[100]!)!;
    expect(spec.y.length).toBe(uv.ylabels.length);
    expect(spec.y[uv.ylabels.indexOf(254)]).toBe(at254.values[100]);
  });
});
