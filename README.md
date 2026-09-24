# nagura-core

Parsers for analytical instrument data files, in TypeScript, for the browser and Node. This is the decoding core of [Nagura Lab](https://naguralab.com), which opens lab instrument data in the browser without the vendor software.

## Supported files

| Vendor | File | Contents | Versions |
|---|---|---|---|
| Agilent ChemStation | `.ch` | One detector channel: UV at one wavelength, FID, CAD, ELSD | 30, 130, 179, 181 |
| Agilent ChemStation | `.uv` | Diode-array spectra over time | 31, 131 (LC and OL), partial files |
| Agilent ChemStation | `.ms` | Single-quadrupole MS, scan and SIM | GC and LC, partial files |
| Agilent OpenLab CDS 2 | `.dx` | Result archive (zip) with UV spectra and signals | CDS 2.x |
| JCAMP-DX (IUPAC, any vendor) | `.jdx`, `.dx`, `.jcm` | IR, Raman, UV-Vis, NMR and mass spectra, peak tables, compound files | 4.24, 5.x; AFFN, PAC, SQZ, DIF, DUP. Not yet: NTUPLES |

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

`parseFiles(files)` recognizes each file by its contents (`.dx` is both an OpenLab archive and a JCAMP-DX text file) and groups them into runs: one per `.D` folder, `.dx` archive or JCAMP-DX file. Every signal is a matrix of rows × ylabels (wavelength in nm, m/z, or a single channel), with the unit and header metadata. Rows are retention times in minutes for chromatograms; spectra carry an `xAxis` (for example wavenumber in cm⁻¹, marked `reversed` for IR) and rows in ascending order.

## How it is verified

Every Agilent decoder is compared value by value with [rainbow](https://github.com/evanyeyeye/rainbow), the open-source Python parser whose format work this package ports: shape, axes, every row and column sum, sampled spectra and header metadata, on public test files (`fixtures/`). Version 181 `.ch` files were also checked against [GC2ASM](https://github.com/ifpen/GC2ASM).

JCAMP-DX is checked two independent ways: against [jcampconverter](https://github.com/cheminfo/jcampconverter) 10.0.2, and against what each file states about itself (the declared point count, the first value, and the X value that starts every data line). Where jcampconverter is wrong (a DUP right after a check value, a factor followed by a comment, `E+03` exponents), the tests rely on the file's own checks and say why.

Where the references disagree, the tests say so and why.

```sh
npm install
npm test                               # against the committed references
pip install rainbow-api && npm run reference   # regenerate Agilent references
npm install --no-save jcampconverter@10.0.2 && npm run reference:jcamp   # JCAMP-DX references
```

See `fixtures/README.md` for the extended test set.

## How it was made

Designed and checked by an analytical chemist, written with the help of an AI assistant (Claude). The correctness claims above rest on the tests, not on trust: run them.

## License

LGPL-3.0-or-later. See `COPYING`, `COPYING.LESSER` and `NOTICE.md` (credits to rainbow, fflate and the JCAMP-DX test data). The license lets closed-source software use this package, as long as changes to the package itself are shared.
