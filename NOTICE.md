# Notice

`@naguralab/core` is licensed under the GNU Lesser General Public License,
version 3 or later (see `COPYING` and `COPYING.LESSER`).

The Agilent ChemStation and OpenLab CDS decoders in `src/agilent/` are a TypeScript port of
the format knowledge in [rainbow](https://github.com/evanyeyeye/rainbow)
(Copyright the rainbow authors, LGPL-3.0-or-later).

The test fixtures in `/fixtures/agilent` are taken from rainbow's test suite.

Zip archives (`.dx`) are read with [fflate](https://github.com/101arrowz/fflate) (MIT).

The JCAMP-DX decoder in `src/jcamp/` is written from the published JCAMP-DX
specifications (IUPAC). Its tests compare against
[jcampconverter](https://github.com/cheminfo/jcampconverter) 10.0.2 (MIT), which
is used only to generate reference files and is not part of this package.

The test fixtures in `/fixtures/jcamp` come from Robert J. Lancashire's JCAMP-DX
test set (University of the West Indies), as distributed with the
[jcamp](https://github.com/nzhagen/jcamp) Python package (MIT). Each is marked
`##OWNER= public domain`.

The Galactic SPC decoder in `src/galactic/` is written from Galactic Industries'
published "Universal Data Format Specification" (SPC.H). Its tests compare
against [spc-parser](https://github.com/cheminfo/spc-parser) 2.1.1 (MIT), which is
used only to generate reference files and is not part of this package. The test
fixtures in `/fixtures/spc` are synthetic, written by `tools/make_spc_fixtures.py`
for this project.

The AIA/ANDI and netCDF readers in `src/aia/` and `src/netcdf/` are written from
Unidata's published netCDF classic format specification and the public ANDI
variable names. Their tests compare against the Unidata netCDF library through
[netCDF4-python](https://github.com/Unidata/netcdf4-python) (MIT), used only to
generate reference files. The fixtures in `/fixtures/aia` are synthetic, written
by `tools/make_aia_fixtures.py` with [SciPy](https://scipy.org) (BSD) for this
project.
