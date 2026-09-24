/**
 * Builds reference outputs for the JCAMP-DX tests from jcampconverter 10.0.2
 * (MIT; later versions are licensed for non-commercial use only).
 *
 *   npm install --no-save jcampconverter@10.0.2
 *   node tools/make_jcamp_reference.mjs                  # committed fixtures
 *   node tools/make_jcamp_reference.mjs IN_DIR OUT_DIR   # any other folder
 *
 * Each spectrum gets a summary (point count, first and last x, sums, evenly
 * spaced samples), ordered by ascending x. The tests decode the same file and
 * compare. Files where jcampconverter is known to be wrong are listed in
 * KNOWN_WRONG and checked by the file's own values instead (see the test).
 */
import { convert } from 'jcampconverter';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const core = existsSync(join(root, 'packages', 'core')) ? join(root, 'packages', 'core') : root;
const inDir = resolve(process.argv[2] ?? join(root, 'fixtures', 'jcamp'));
const outDir = resolve(process.argv[3] ?? join(core, 'test', 'reference-jcamp'));
/** Committed fixtures are listed relative to their folder; any other set by absolute path. */
const committed = inDir === resolve(root, 'fixtures', 'jcamp');

/**
 * dupinc2: a DUP right after a line's check value is applied to the wrong
 * point (every later line then fails its X check). jtpolys: YFACTOR is
 * ignored when its line carries a $$ comment. scientific_notation: E+03
 * exponents are read as SQZ digits.
 */
const KNOWN_WRONG = new Set(['dupinc2.jdx', 'jtpolys.jdx', 'scientific_notation_example.jdx']);

function summary(x, y) {
  const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const xs = order.map((i) => x[i]);
  const ys = order.map((i) => y[i]);
  const n = xs.length;
  const samples = {};
  for (let k = 0; k <= 20; k++) {
    const i = Math.round((k * (n - 1)) / 20);
    samples[i] = [xs[i], ys[i]];
  }
  return {
    points: n,
    first_x: xs[0],
    last_x: xs[n - 1],
    sum_y: ys.reduce((a, b) => a + b, 0),
    // Weighted by position, so a shifted point changes it.
    moment_y: ys.reduce((a, b, i) => a + b * (i + 1), 0),
    samples,
  };
}

mkdirSync(outDir, { recursive: true });
const manifest = [];
for (const name of readdirSync(inDir).sort()) {
  if (!/\.(jdx|dx|jcm)$/i.test(name) || KNOWN_WRONG.has(name)) continue;
  const path = join(inDir, name);
  const entries = convert(readFileSync(path)).flatten.filter(
    (e) => e.spectra?.[0]?.data?.x?.length && !/ASSIGNMENT/i.test(e.dataType ?? '') && !e.ntuples?.length,
  );
  const spectra = entries.map((e) => summary(e.spectra[0].data.x, e.spectra[0].data.y));
  const reference = `${name}.json`;
  writeFileSync(join(outDir, reference), JSON.stringify({ spectra }) + '\n');
  manifest.push({ data: committed ? relative(inDir, path) : path, reference });
  console.log(`${name}: ${spectra.map((s) => s.points).join(', ')} points`);
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
