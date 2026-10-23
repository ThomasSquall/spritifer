import { PNG } from 'pngjs';
import type { Bitmap } from '../core/sprite.js';

export function encodePng(b: Bitmap): Buffer {
  const png = new PNG({ width: b.width, height: b.height });
  png.data = Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength);
  return PNG.sync.write(png);
}

export function decodePng(buf: Buffer): Bitmap {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}
