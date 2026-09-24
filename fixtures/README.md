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
