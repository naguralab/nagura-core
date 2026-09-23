# nagura-core

Parsers for proprietary analytical instrument data files, in TypeScript, for the browser and Node. This is the decoding core of [Nagura Lab](https://naguralab.com), which opens Agilent chromatography data in the browser without the vendor software.

## Supported files

| Vendor | File | Contents | Versions |
|---|---|---|---|
| Agilent ChemStation | `.ch` | One detector channel: UV at one wavelength, FID, CAD, ELSD | 30, 130, 179, 181 |
| Agilent ChemStation | `.uv` | Diode-array spectra over time | 31, 131 (LC and OL), partial files |
| Agilent ChemStation | `.ms` | Single-quadrupole MS, scan and SIM | GC and LC, partial files |
| Agilent OpenLab CDS 2 | `.dx` | Result archive (zip) with UV spectra and signals | CDS 2.x |

## Use

```ts
import { readFileSync } from 'node:fs';
import { parseAgilentFile, parseDx, overviewTrace, signalToCsv } from '@naguralab/core';

const signal = parseAgilentFile('DAD1A.ch', new Uint8Array(readFileSync('sample.D/DAD1A.ch')));
console.log(signal?.detector, signal?.times.length);       // 'UV', 2100
console.log(signalToCsv(signal!));                          // time and value columns

const run = parseDx('injection.dx', new Uint8Array(readFileSync('injection.dx')));
for (const s of run.signals) console.log(s.name, overviewTrace(s).values.length);
```

`parseAgilentRuns(files)` groups a dropped set of files into runs (one per `.D` folder or `.dx` file). Every signal is a matrix of retention times (minutes) × ylabels (wavelength in nm, m/z, or a single channel), with the unit and header metadata.

## How it is verified

Every decoder is compared value by value with [rainbow](https://github.com/evanyeyeye/rainbow), the open-source Python parser whose format work this package ports: shape, axes, every row and column sum, sampled spectra and header metadata, on public test files (`fixtures/`). Version 181 `.ch` files were also checked against [GC2ASM](https://github.com/ifpen/GC2ASM). Where the references disagree, the tests say so and why.

```sh
npm install
npm test                               # against the committed references
pip install rainbow-api && npm run reference   # regenerate references
```

See `fixtures/README.md` for the extended test set.

## How it was made

Designed and checked by an analytical chemist, written with the help of an AI assistant (Claude). The correctness claims above rest on the tests, not on trust: run them.

## License

LGPL-3.0-or-later. See `COPYING`, `COPYING.LESSER` and `NOTICE.md` (credits to rainbow and fflate). The license lets closed-source software use this package, as long as changes to the package itself are shared.
