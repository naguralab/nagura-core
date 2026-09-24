import { ParseError } from '../types.js';

/**
 * A reader for netCDF classic files (CDF-1, 64-bit offset CDF-2 and CDF-5),
 * written from Unidata's published "NetCDF Classic Format Specification".
 * netCDF-4 files (HDF5 inside) are not read. All values are big-endian.
 */

export type NcValue = string | Float64Array;

export interface NcVariable {
  name: string;
  dimensions: string[];
  shape: number[];
  attributes: Map<string, NcValue>;
  type: number;
  /** True when the first dimension is the unlimited (record) dimension. */
  record: boolean;
  begin: number;
  vsize: number;
}

export interface NcFile {
  version: number;
  records: number;
  dimensions: { name: string; size: number; unlimited: boolean }[];
  attributes: Map<string, NcValue>;
  variables: Map<string, NcVariable>;
  /** Reads a variable's values (numbers; characters as a string). */
  read(name: string): Float64Array | string;
}

const NC_DIMENSION = 0x0a;
const NC_VARIABLE = 0x0b;
const NC_ATTRIBUTE = 0x0c;

// nc_type -> element size in bytes.
const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 8 };

/** True for the first bytes of a netCDF classic file: "CDF" and a version byte. */
export function isNetcdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 32 && bytes[0] === 0x43 && bytes[1] === 0x44 && bytes[2] === 0x46 && [1, 2, 5].includes(bytes[3]!);
}

/** True for netCDF-4 (HDF5) bytes, which this reader does not read. */
export function isHdf5Bytes(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x48 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

export function readNetcdf(bytes: Uint8Array): NcFile {
  if (isHdf5Bytes(bytes)) throw new ParseError('This is a netCDF-4 (HDF5) file; only netCDF classic files are supported.');
  if (!isNetcdfBytes(bytes)) throw new ParseError('Not a netCDF file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[3]!;
  let at = 4;

  const need = (n: number) => {
    if (at + n > bytes.length) throw new ParseError(`The netCDF header runs past the end of the file (byte ${at}).`);
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(at, false);
    at += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = Number(view.getBigUint64(at, false));
    at += 8;
    return v;
  };
  // Counts and sizes are 64-bit only in CDF-5.
  const count = () => (version === 5 ? u64() : u32());
  const pad = (n: number) => (n + 3) & ~3;
  const name = () => {
    const n = count();
    need(n);
    const s = new TextDecoder('utf-8').decode(bytes.subarray(at, at + n));
    at += pad(n);
    return s;
  };
  const values = (type: number, n: number, offset: number, out?: Float64Array, at0 = 0): Float64Array | string => {
    const size = SIZES[type];
    if (!size) throw new ParseError(`Unknown netCDF type ${type}.`);
    if (offset + size * n > bytes.length) throw new ParseError(`netCDF data runs past the end of the file (byte ${offset}).`);
    if (type === 2) {
      const raw = bytes.subarray(offset, offset + n);
      const end = raw.indexOf(0);
      return new TextDecoder('latin1').decode(end < 0 ? raw : raw.subarray(0, end));
    }
    const dest = out ?? new Float64Array(n);
    for (let i = 0; i < n; i++) dest[at0 + i] = element(view, type, offset + i * size);
    return dest;
  };
  const attributes = () => {
    const map = new Map<string, NcValue>();
    const tag = u32();
    const n = count();
    if (tag === 0 && n === 0) return map;
    if (tag !== NC_ATTRIBUTE) throw new ParseError('Malformed netCDF attribute list.');
    for (let i = 0; i < n; i++) {
      const key = name();
      const type = u32();
      const len = count();
      map.set(key, values(type, len, at));
      at += pad(len * (SIZES[type] ?? 1));
    }
    return map;
  };

  const records = count();
  const dimensions: NcFile['dimensions'] = [];
  {
    const tag = u32();
    const n = count();
    if (!(tag === 0 && n === 0)) {
      if (tag !== NC_DIMENSION) throw new ParseError('Malformed netCDF dimension list.');
      for (let i = 0; i < n; i++) {
        const dim = name();
        const size = count();
        dimensions.push({ name: dim, size, unlimited: size === 0 });
      }
    }
  }
  const global = attributes();
  const variables = new Map<string, NcVariable>();
  {
    const tag = u32();
    const n = count();
    if (!(tag === 0 && n === 0)) {
      if (tag !== NC_VARIABLE) throw new ParseError('Malformed netCDF variable list.');
      for (let i = 0; i < n; i++) {
        const key = name();
        const rank = count();
        const ids: number[] = [];
        for (let k = 0; k < rank; k++) ids.push(count());
        const attrs = attributes();
        const type = u32();
        const vsize = count();
        const begin = version === 1 ? u32() : u64();
        const dims = ids.map((id) => {
          const d = dimensions[id];
          if (!d) throw new ParseError(`Variable ${key} refers to a missing dimension.`);
          return d;
        });
        variables.set(key, {
          name: key,
          dimensions: dims.map((d) => d.name),
          shape: dims.map((d) => (d.unlimited ? records : d.size)),
          attributes: attrs,
          type,
          record: dims[0]?.unlimited ?? false,
          begin,
          vsize,
        });
      }
    }
  }

  // Record variables are interleaved: one slab of each per record.
  const recordVars = [...variables.values()].filter((v) => v.record);
  // With a single record variable its slab is not padded (spec: "record size").
  const recsize =
    recordVars.length === 1
      ? recordVars[0]!.shape.slice(1).reduce((a, b) => a * b, 1) * SIZES[recordVars[0]!.type]!
      : recordVars.reduce((a, v) => a + v.vsize, 0);

  return {
    version,
    records,
    dimensions,
    attributes: global,
    variables,
    read(key: string) {
      const v = variables.get(key);
      if (!v) throw new ParseError(`The file has no variable ${key}.`);
      if (!v.record) return values(v.type, v.shape.reduce((a, b) => a * b, 1), v.begin);
      const per = v.shape.slice(1).reduce((a, b) => a * b, 1);
      if (v.type === 2) {
        let s = '';
        for (let r = 0; r < records; r++) s += values(2, per, v.begin + r * recsize) as string;
        return s;
      }
      const out = new Float64Array(records * per);
      for (let r = 0; r < records; r++) values(v.type, per, v.begin + r * recsize, out, r * per);
      return out;
    },
  };
}

function element(view: DataView, type: number, offset: number): number {
  switch (type) {
    case 1:
      return view.getInt8(offset);
    case 3:
      return view.getInt16(offset, false);
    case 4:
      return view.getInt32(offset, false);
    case 5:
      return view.getFloat32(offset, false);
    case 6:
      return view.getFloat64(offset, false);
    case 7:
      return view.getUint8(offset);
    case 8:
      return view.getUint16(offset, false);
    case 9:
      return view.getUint32(offset, false);
    case 10:
      return Number(view.getBigInt64(offset, false));
    case 11:
      return Number(view.getBigUint64(offset, false));
    default:
      throw new ParseError(`Unknown netCDF type ${type}.`);
  }
}

/** A numeric variable as numbers, or undefined when absent. */
export function numbers(nc: NcFile, key: string): Float64Array | undefined {
  if (!nc.variables.has(key)) return undefined;
  const v = nc.read(key);
  return typeof v === 'string' ? undefined : v;
}

/** A text attribute (global or of a variable), trimmed; '' when absent. */
export function text(attrs: Map<string, NcValue>, key: string): string {
  const v = attrs.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
