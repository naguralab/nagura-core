/**
 * Builds reference outputs for the Galactic SPC tests from spc-parser 2.1.1
 * (MIT, cheminfo).
 *
 *   npm install --no-save spc-parser@2.1.1
 *   node tools/make_spc_reference.mjs                  # committed fixtures
 *   node tools/make_spc_reference.mjs IN_DIR OUT_DIR   # any other folder
 *
 * Each subfile gets a summary (point count, first and last x, sums, evenly
 * spaced samples), ordered by ascending x. The tests decode the same file and
 * compare. Files where spc-parser is known to be wrong are listed in
 * KNOWN_WRONG and checked by the file's own values instead (see the test).
 */
import { parse } from 'spc-parser';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const core = existsSync(join(root, 'packages', 'core')) ? join(root, 'packages', 'core') : root;
const inDir = resolve(process.argv[2] ?? join(root, 'fixtures', 'spc'));
const outDir = resolve(process.argv[3] ?? join(core, 'test', 'reference-spc'));
/** Committed fixtures are listed relative to their folder; any other set by absolute path. */
const committed = inDir === resolve(root, 'fixtures', 'spc');

/**
 * m_evenz.spc: a subfile exponent of 0 is taken to mean "use the main
 * header's exponent", so that subfile comes out at half its value. SPC.H only
 * does that for single-subfile files; spc-io agrees with the decoder here.
 */
const KNOWN_WRONG = new Set(['m_evenz.spc']);

function summary(x, y) {
  const order = Array.from(x.keys()).sort((a, b) => x[a] - x[b]);
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
  if (!/\.(spc|cgm)$/i.test(name) || KNOWN_WRONG.has(name)) continue;
  const path = join(inDir, name);
  let spectra;
  try {
    spectra = parse(readFileSync(path)).spectra.map((s) => summary(s.variables.x.data, s.variables.y.data));
  } catch (err) {
    console.log(`${name}: spc-parser cannot read it (${err.message}); not in the reference set`);
    continue;
  }
  const reference = `${name}.json`;
  writeFileSync(join(outDir, reference), JSON.stringify({ spectra }) + '\n');
  manifest.push({ data: committed ? relative(inDir, path) : path, reference });
  console.log(`${name}: ${spectra.length} subfile(s), ${spectra[0]?.points} points`);
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
