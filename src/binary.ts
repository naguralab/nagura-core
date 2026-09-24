import { ParseError } from './types.js';

/**
 * Bounds-checked reads over a file's bytes. Vendor formats mix big- and
 * little-endian fields in one file, so every read names its byte order.
 */
export class BinaryReader {
  readonly view: DataView;
  readonly length: number;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
  }

  private check(offset: number, size: number): void {
    if (offset < 0 || offset + size > this.length) {
      throw new ParseError(
        `Read of ${size} bytes at 0x${offset.toString(16)} is past the end of the file (${this.length} bytes).`,
      );
    }
  }

  has(offset: number, size: number): boolean {
    return offset >= 0 && offset + size <= this.length;
  }

  u8(offset: number): number {
    this.check(offset, 1);
    return this.view.getUint8(offset);
  }

  i16be(offset: number): number {
    this.check(offset, 2);
    return this.view.getInt16(offset, false);
  }

  i16le(offset: number): number {
    this.check(offset, 2);
    return this.view.getInt16(offset, true);
  }

  u16be(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset, false);
  }

  u16le(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset, true);
  }

  i32be(offset: number): number {
    this.check(offset, 4);
    return this.view.getInt32(offset, false);
  }

  i32le(offset: number): number {
    this.check(offset, 4);
    return this.view.getInt32(offset, true);
  }

  u32be(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset, false);
  }

  u32le(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset, true);
  }

  f32be(offset: number): number {
    this.check(offset, 4);
    return this.view.getFloat32(offset, false);
  }

  f32le(offset: number): number {
    this.check(offset, 4);
    return this.view.getFloat32(offset, true);
  }

  f64be(offset: number): number {
    this.check(offset, 8);
    return this.view.getFloat64(offset, false);
  }

  f64le(offset: number): number {
    this.check(offset, 8);
    return this.view.getFloat64(offset, true);
  }

  /**
   * A length-prefixed string: one byte holding the character count, then the
   * characters `gap` bytes apart. A gap of two is UTF-16LE; a gap of one is
   * single-byte text. Returns an empty string for an unreadable slot, since
   * header strings are informational and never worth failing a file over.
   */
  pstring(offset: number, gap: 1 | 2): string {
    if (!this.has(offset, 1)) return '';
    const size = this.view.getUint8(offset) * gap;
    if (!this.has(offset + 1, size)) return '';
    const raw = this.bytes.subarray(offset + 1, offset + 1 + size);
    try {
      const label = gap === 2 ? 'utf-16le' : 'utf-8';
      return new TextDecoder(label, { fatal: true }).decode(raw).trim();
    } catch {
      return new TextDecoder('latin1').decode(raw.filter((_, i) => i % gap === 0)).trim();
    }
  }
}
