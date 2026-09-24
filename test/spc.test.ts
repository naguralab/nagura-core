import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSpcBytes, parseFiles, parseSpc, readSpc, signalToCsv } from '../src/index.js';
import type { Signal } from '../src/index.js';

/**
 * Galactic SPC is checked two independent ways:
 * - against spc-parser 2.1.1 (tools/make_spc_reference.mjs), and
 * - against what every file states about itself: subfile indexes, the
 *   header's first and last X, the byte offsets of the log block and the
 *   subfile directory, and the point counts and limits in the log text.
 * Set NAGURA_EXTRA_SPC_REFERENCE to a reference folder (with manifest.json)
 * to also check files that are not committed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = [resolve(here, '../fixtures/spc'), resolve(here, '../../../fixtures/spc')].find(existsSync)!;

interface Summary {
  points: number;
  first_x: number;
  last_x: number;
  sum_y: number;
  moment_y: number;
  samples: Record<string, [number, number]>;
}

function close(actual: number, expected: number, rel = 1e-9): boolean {
  return Math.abs(actual - expected) <= rel * Math.max(1, Math.abs(expected));
}

/** Values in the file are 32-bit, so allow for float rounding relative to the largest value. */
function expectMatches(signal: Signal, ref: Summary, what: string) {
  expect(signal.times.length, `${what} points`).toBe(ref.points);
  expect(close(signal.times[0]!, ref.first_x, 1e-7), `${what} first x ${signal.times[0]} vs ${ref.first_x}`).toBe(true);
  expect(close(signal.times[ref.points - 1]!, ref.last_x, 1e-7), `${what} last x`).toBe(true);
  const ys = Array.from(signal.data);
  const scale = Math.max(...ys.map(Math.abs), 1e-300);
  const sum = ys.reduce((a, b) => a + b, 0);
  const moment = ys.reduce((a, b, i) => a + b * (i + 1), 0);
  expect(Math.abs(sum - ref.sum_y) <= 1e-9 * scale * ys.length, `${what} sum ${sum} vs ${ref.sum_y}`).toBe(true);
  expect(Math.abs(moment - ref.moment_y) <= 1e-9 * scale * ys.length * ys.length, `${what} moment`).toBe(true);
  for (const [i, [x, y]] of Object.entries(ref.samples)) {
    expect(close(signal.times[Number(i)]!, x, 1e-7), `${what} x[${i}]`).toBe(true);
    expect(Math.abs(signal.data[Number(i)]! - y) <= 1e-9 * scale, `${what} y[${i}]: ${signal.data[Number(i)]} vs ${y}`).toBe(true);
  }
}

function referenceSets(): { root: string; base: string; entries: { data: string; reference: string }[] }[] {
  const sets = [{ root: join(here, 'reference-spc'), base: fixtures }];
  if (process.env.NAGURA_EXTRA_SPC_REFERENCE) sets.push({ root: resolve(process.env.NAGURA_EXTRA_SPC_REFERENCE), base: '' });
  return sets
    .filter((s) => existsSync(join(s.root, 'manifest.json')))
    .map((s) => ({ ...s, entries: JSON.parse(readFileSync(join(s.root, 'manifest.json'), 'utf8')) }));
}

describe('Galactic SPC against spc-parser', () => {
  for (const set of referenceSets()) {
    for (const entry of set.entries) {
      it(entry.data.split('/').pop()!, () => {
        const path = set.base ? join(set.base, entry.data) : entry.data;
        const run = parseSpc(path, readFileSync(path));
        const ref = JSON.parse(readFileSync(join(set.root, entry.reference), 'utf8')) as { spectra: Summary[] };
        expect(run.signals.length).toBe(ref.spectra.length);
        run.signals.forEach((s, i) => {
          // Chromatograms are stored in minutes; spc-parser keeps the file's unit.
          const ratio = !s.xAxis && readSpc(readFileSync(path)).header.xType === 4 ? 60 : 1;
          const scaled = ratio === 1 ? s : { ...s, times: s.times.map((t) => t * ratio) };
          expectMatches(scaled, ref.spectra[i]!, `${entry.data}[${i}]`);
        });
      });
    }
  }
});

/** Every committed fixture plus every file in an extra reference set. */
function allFiles(): string[] {
  const files = readdirSync(fixtures).filter((f) => /\.(spc|cgm)$/i.test(f)).map((f) => join(fixtures, f));
  for (const set of referenceSets()) if (!set.base) files.push(...set.entries.map((e) => e.data));
  const extra = process.env.NAGURA_EXTRA_SPC_DIR;
  if (extra) files.push(...readdirSync(extra).filter((f) => /\.(spc|cgm)$/i.test(f)).map((f) => join(extra, f)));
  return [...new Set(files)];
}

describe("Galactic SPC against each file's own checks", () => {
  for (const path of allFiles()) {
    it(path.split('/').pop()!, () => {
      const bytes = readFileSync(path);
      expect(isSpcBytes(bytes)).toBe(true);
      const spc = readSpc(bytes);
      const h = spc.header;

      // Subfile indexes run 0, 1, 2, ... (SPC.H: "subindx must be correct for all subfiles").
      spc.subfiles.forEach((s, i) => expect(s.index, `subindx of subfile ${i}`).toBe(i));

      // The data ends where the log block begins; the directory, if any, sits between them.
      if (spc.directory.length) {
        expect(spc.dataEnd, 'end of data').toBeLessThanOrEqual(h.points);
        expect(h.points + 12 * spc.directory.length, 'end of directory').toBe(h.logOffset || bytes.length);
      } else if (h.logOffset) {
        expect(spc.dataEnd, 'end of data').toBe(h.logOffset);
      } else {
        // Without a log block some writers pad the file; the data must still fit.
        expect(spc.dataEnd, 'end of data').toBeLessThanOrEqual(bytes.length);
      }
      // Each directory entry points at the subfile's record, or at an identical copy
      // (GRAMS may move a changed subfile to the end of the file).
      spc.directory.forEach((d, i) => {
        const s = spc.subfiles[i]!;
        const record = (at: number) => Buffer.from(bytes.subarray(at, at + s.size)).toString('hex');
        expect(record(d.offset), `directory entry ${i}`).toBe(record(s.offset));
        expect(d.size, `directory size ${i}`).toBeGreaterThanOrEqual(s.size);
      });

      // A stored X array starts and ends at the header's FFIRST and FLAST.
      const xyxy = (h.flags & 0x40) !== 0;
      if (!xyxy) {
        const x = spc.subfiles[0]!.x;
        expect(close(x[0]!, h.first, 1e-6), `first x ${x[0]} vs ${h.first}`).toBe(true);
        expect(close(x[x.length - 1]!, h.last, 1e-6), `last x ${x[x.length - 1]} vs ${h.last}`).toBe(true);
      }

      // Log text repeats header values; where it does, they agree.
      const log = (key: string) => (spc.log.has(key) ? Number.parseFloat(spc.log.get(key)!) : undefined);
      const npts = log('NPTS');
      if (npts) expect(spc.subfiles[0]!.x.length, 'log NPTS').toBe(npts);
      const nsubs = log('NSUBS');
      if (nsubs) expect(spc.subfiles.length, 'log NSUBS').toBe(nsubs);
      const begx = log('BEGX');
      const endx = log('ENDX');
      if (!xyxy && begx !== undefined && endx !== undefined) {
        const step = Math.abs(h.last - h.first) / Math.max(1, spc.subfiles[0]!.x.length - 1);
        expect(Math.abs(begx - h.first) <= step, `log BEGX ${begx} vs ${h.first}`).toBe(true);
        expect(Math.abs(endx - h.last) <= step, `log ENDX ${endx} vs ${h.last}`).toBe(true);
      }
    });
  }
});

const fixture = (name: string) => readFileSync(join(fixtures, name));

describe('Galactic SPC layouts and axes', () => {
  it('reads an IR spectrum: axis reversed, header text and log', () => {
    const run = parseSpc('drop/ir-absorbance.spc', fixture('ir-absorbance.spc'));
    expect(run.vendor).toBe('Galactic SPC');
    expect(run.metadata).toEqual({ sample: 'Synthetic IR spectrum (Nagura Lab test data)', date: '2026-09-24 10:30' });
    const s = run.signals[0]!;
    expect(s.name).toBe('ir-absorbance.spc');
    expect(s.technique).toBe('IR spectrum');
    expect(s.xAxis).toEqual({ label: 'Wavenumber', unit: 'cm⁻¹', reversed: true });
    expect(s.unit).toBe('Absorbance');
    expect([s.times[0], s.times[s.times.length - 1]]).toEqual([400, 4000]);
    expect(s.metadata.resolution).toBe('4 cm-1');
    expect(s.metadata['log MODEL']).toBe('NaguraLabSynthetic');
    expect(signalToCsv(s).split('\n')[0]).toBe('Wavenumber (cm⁻¹),ir-absorbance.spc (Absorbance)');
  });

  it('reads a chromatogram as retention time in minutes', () => {
    const s = parseSpc('hplc-int32.cgm', fixture('hplc-int32.cgm')).signals[0]!;
    expect(s.xAxis).toBeUndefined();
    expect(s.technique).toBeUndefined();
    expect(s.unit).toBe('mV');
    expect(s.times[s.times.length - 1]).toBeCloseTo(15, 12);
    // The largest band (300 mV at 11.4 min, on a 0.5 + 0.02 t baseline), to 32-bit fixed-point precision.
    const top = s.data.indexOf(Math.max(...s.data));
    expect(s.times[top]).toBeCloseTo(11.4, 6);
    expect(s.data[top]).toBeCloseTo(300 + 0.5 + 0.02 * 11.4, 4);
  });

  it('names subfiles by their Z value, evenly spaced from fzinc', () => {
    const run = parseSpc('uvvis-kinetics.spc', fixture('uvvis-kinetics.spc'));
    expect(run.signals.map((s) => s.name).slice(0, 3)).toEqual(['#1 · Time 0 s', '#2 · Time 30 s', '#3 · Time 60 s']);
    expect(run.signals[0]!.technique).toBe('UV-Vis spectrum');
    expect(run.signals[0]!.xAxis).toEqual({ label: 'Wavelength', unit: 'nm' });
  });

  it('applies each subfile its own exponent in 16-bit files', () => {
    const spc = readSpc(fixture('nir-int16.spc'));
    expect(spc.subfiles.map((s) => s.z)).toEqual([0.5, 1, 2.5, 5, 10]);
    // The same band shape at 0.3, 0.6, 1.1, 2.2 and 4.5 times: the ratio survives the per-subfile exponents.
    const peak = (i: number) => Math.max(...spc.subfiles[i]!.y);
    expect(peak(4) / peak(0)).toBeCloseTo(15, 3);
  });

  it('reads MS spectra with their own X arrays as sticks, with custom axis labels', () => {
    const run = parseSpc('ms-xyxy.spc', fixture('ms-xyxy.spc'));
    expect(run.signals.map((s) => s.times.length)).toEqual([5, 3, 7]);
    const s = run.signals[1]!;
    expect(s.sticks).toBe(true);
    expect(s.technique).toBe('Mass spectrum');
    expect(s.xAxis).toEqual({ label: 'm/z', unit: '' });
    expect(s.unit).toBe('Abundance');
    expect(s.name).toBe('#2 · Retention time 2.75');
    expect(Array.from(s.times)).toEqual([27, 43, 58]);
    expect(Array.from(s.data).map((v) => Math.round(v))).toEqual([30, 100, 25]);
  });

  it('reads the old Lab Calc format with word-swapped 32-bit values', () => {
    const run = parseSpc('raman-old-format.spc', fixture('raman-old-format.spc'));
    const s = run.signals[0]!;
    expect(run.metadata.date).toBe('1994-03-14 15:09');
    expect(s.technique).toBe('Raman spectrum');
    expect(s.xAxis).toEqual({ label: 'Raman shift', unit: 'cm⁻¹' });
    // The 1085 cm⁻¹ band (1500 on a baseline of 50) falls between points 2 cm⁻¹ apart.
    const top = s.data.indexOf(Math.max(...s.data));
    expect(s.times[top]).toBe(1084);
    expect(s.data[top]).toBeCloseTo(50 + 1500 * Math.exp(-0.5 / 36), 3);
  });

  it('reads one subfile from an old-format file that is not a multifile, whatever follows', () => {
    const bytes = new Uint8Array([...fixture('raman-old-format.spc'), ...new Uint8Array(4000)]);
    expect(readSpc(bytes).subfiles).toHaveLength(1);
  });

  it('uses a subfile exponent of 0 as is in a multifile', () => {
    // One subfile, TMULTI, fexp 5, subexp 0: 0x40000000 is 0.25 * 2^0.
    const bytes = new Uint8Array(512 + 32 + 4);
    const v = new DataView(bytes.buffer);
    bytes.set([0x04, 0x4b, 0, 5]);
    v.setUint32(4, 1, true);
    v.setUint32(24, 1, true);
    v.setInt32(544, 0x40000000, true);
    expect(readSpc(bytes).subfiles[0]!.y[0]).toBe(0.25);
    // Without TMULTI the main header's exponent applies: 0.25 * 2^5.
    bytes[0] = 0;
    expect(readSpc(bytes).subfiles[0]!.y[0]).toBe(8);
  });

  it('refuses a truncated file with a clear reason', () => {
    const bytes = fixture('uvvis-kinetics.spc').subarray(0, 20000);
    expect(() => readSpc(bytes)).toThrow(/past the end|missing/);
  });
});

describe('recognizing SPC files by content', () => {
  it('reads an .spc among other dropped files', () => {
    const runs = parseFiles([
      { path: 'drop/ir-absorbance.spc', bytes: fixture('ir-absorbance.spc') },
      { path: 'drop/old.SPC', bytes: fixture('raman-old-format.spc') },
    ]);
    expect(runs.map((r) => [r.name, r.vendor, r.signals.length])).toEqual([
      ['ir-absorbance.spc', 'Galactic SPC', 1],
      ['old.SPC', 'Galactic SPC', 1],
    ]);
  });

  it('explains a Shimadzu UVProbe .spc instead of misreading it', () => {
    const ole = new Uint8Array(1024);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(isSpcBytes(ole)).toBe(false);
    const [run] = parseFiles([{ path: 'scan.spc', bytes: ole }]);
    expect(run!.signals).toEqual([]);
    expect(run!.skipped[0]!.reason).toMatch(/UVProbe/);
  });
});
