# Test fixtures

`agilent/` holds small Agilent ChemStation runs copied from the test suite of
[rainbow](https://github.com/evanyeyeye/rainbow) (LGPL-3.0-or-later). They are
public example data, not data from any customer or employer.

Reference outputs in the core's `test/reference/` folder are generated from these
files with `npm run reference` (needs `pip install rainbow-api`).

Larger files (an OpenLab `OL` `.uv` and partial `.MS` files) are checked the
same way without being committed:

    git clone --depth 1 https://github.com/evanyeyeye/rainbow /tmp/rainbow
    python3 tools/make_reference.py /tmp/rainbow/tests/inputs /tmp/ref-extra
    NAGURA_EXTRA_REFERENCE=/tmp/ref-extra npm test

Agilent version 181 `.ch` files (not committed; license CeCILL-2.1) come from
[chromConverterExtraTests](https://github.com/ethanbass/chromConverterExtraTests)
(`inst/chemstation_181.D`, originally from IFPEN's
[GC2ASM](https://github.com/ifpen/GC2ASM)):

    git clone --depth 1 https://github.com/ethanbass/chromConverterExtraTests /tmp/cce
    mkdir -p /tmp/v181 && cp -r /tmp/cce/inst/chemstation_181.D /tmp/v181/
    python3 tools/make_reference.py /tmp/v181 /tmp/ref181
    NAGURA_EXTRA_REFERENCE=/tmp/ref181 npm test

For these files rainbow returns one time point fewer than values. The decoded
values match both rainbow and GC2ASM (5914 samples, first value 2.10104 pA);
Nagura Lab spreads the time axis over the header's start and end times.

## JCAMP-DX

`jcamp/` holds files from Robert J. Lancashire's JCAMP-DX test set (University
of the West Indies), as distributed with the
[jcamp](https://github.com/nzhagen/jcamp) Python package (MIT). Only files whose
every `##OWNER=` record says public domain are committed. Together they cover
AFFN, PAC, SQZ, DIF and DUP encodings and a peak table.

References in the core's `test/reference-jcamp/` come from jcampconverter
10.0.2, the last MIT-licensed release (later versions are non-commercial):

    npm install --no-save jcampconverter@10.0.2
    npm run reference:jcamp

The tests also check every file against its own declared values, so files
where jcampconverter is wrong (`dupinc2.jdx`, `jtpolys.jdx`) are still covered.

The full test set (NMR, the ISAS Dortmund official test files, compound files;
not committed because several are copyrighted) is checked the same way:

    git clone --depth 1 https://github.com/nzhagen/jcamp /tmp/jcamp
    mkdir -p /tmp/jall && find /tmp/jcamp/data -type f \( -iname '*.jdx' -o -iname '*.dx' -o -iname '*.jcm' \) -exec cp {} /tmp/jall/ \;
    node tools/make_jcamp_reference.mjs /tmp/jall /tmp/jref
    NAGURA_EXTRA_JCAMP_REFERENCE=/tmp/jref npm test

Expected result: all pass except five files. jcampconverter cannot read
`TEST32.DX`, `TESTSPEC.DX` (a space before every `##`), `toluene.jdx` (XYPOINTS)
and `example_compound_file.jdx`; these were checked against the files' own
values and the `jcamp` Python reader instead. `xyinc2.jdx` declares 298 points
but holds 350, and is refused on purpose.

## Galactic SPC

`spc/` holds synthetic files written by `tools/make_spc_fixtures.py` (made-up
bands, no third-party rights): one per storage form the decoder handles. IR
with evenly spaced X and a log block, Raman with an X array, UV-Vis kinetics
(12 subfiles, even Z), NIR with 16-bit values and a different exponent per
subfile, an HPLC chromatogram (`.cgm`, 32-bit values, minutes), GC-MS with an X
array per subfile, a directory and custom axis labels, and the old 0x4D format.

    python3 tools/make_spc_fixtures.py        # rewrites fixtures/spc
    npm install --no-save spc-parser@2.1.1
    npm run reference:spc

References in the core's `test/reference-spc/` come from spc-parser 2.1.1 (MIT).
The tests also check each file against its own structure (subfile indexes, first
and last X, log and directory offsets, the log text's point counts).

Real instrument files (Thermo's SPC sample files and others; not committed
because their license is unclear) come from the test sets of spc-parser (MIT)
and [spc](https://github.com/rohanisaac/spc) (GPL-3.0; its files only, no code):

    git clone --depth 1 https://github.com/cheminfo/spc-parser /tmp/spc-parser
    git clone --depth 1 https://github.com/rohanisaac/spc /tmp/spc
    mkdir -p /tmp/spcall && cp /tmp/spc/test_data/*.[sS][pP][cC] /tmp/spcall/
    cp /tmp/spc-parser/src/galactic/__tests__/data/*.[sS][pP][cC] /tmp/spcall/
    node tools/make_spc_reference.mjs /tmp/spcall /tmp/spcref
    NAGURA_EXTRA_SPC_REFERENCE=/tmp/spcref NAGURA_EXTRA_SPC_DIR=/tmp/spcall npm test

Expected result (24-09-2026): all 31 files pass. spc-parser cannot read
`test_input.spc` (its log block), so that file is covered by the structure
checks only. For `m_evenz.spc` spc-parser takes a subfile exponent of 0 to mean
"use the main exponent" and halves one subfile; SPC.H applies the main exponent
only to single-subfile files, and [spc-io](https://github.com/h2020charisma/spc-io)
0.2.1 (MIT) agrees with Nagura Lab. spc-io also matches every other new-format
file it can read except `NDR0002.SPC`, where it uses the subfile exponent of a
single-subfile file (4x too small by SPC.H; spc-parser and Nagura Lab agree).

## AIA / ANDI netCDF

`aia/` holds synthetic files written by `tools/make_aia_fixtures.py` (made-up
peaks, no third-party rights): an HPLC chromatogram (CDF-1, times from delay
and interval, peak table), a GC-FID run (64-bit offset, explicit uneven
retention times in minutes), GC-MS scans twice (plain, and with the pairs as
interleaved record variables) and an ELSD run in CDF-5.

    pip install scipy numpy netCDF4
    python3 tools/make_aia_fixtures.py        # rewrites fixtures/aia (byte-for-byte reproducible)
    npm run reference:aia

References in the core's `test/reference-aia/` come from Unidata's netCDF C
library through netCDF4-python (MIT), independent of both the writer (SciPy)
and the TypeScript reader. The tests also check each file's own values.

Real files (not committed: their licenses are unclear) from chromConverterExtraTests
and PyMassSpec's example data (their files only, no code):

    git clone --depth 1 https://github.com/ethanbass/chromConverterExtraTests /tmp/cce
    git clone --depth 1 https://github.com/PyMassSpec/PyMassSpec /tmp/pyms
    mkdir -p /tmp/aiaall && cp /tmp/cce/inst/*.CDF /tmp/pyms/pyms-data/*.cdf /tmp/aiaall/
    python3 tools/make_aia_reference.py /tmp/aiaall /tmp/aiaref
    NAGURA_EXTRA_AIA_REFERENCE=/tmp/aiaref npm test

Expected result (24-09-2026): all 10 files pass. `gc01_0812_066.cdf` states
m/z ranges its own scans exceed, so only its range check is skipped.
