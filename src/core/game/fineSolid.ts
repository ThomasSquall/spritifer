/**
 * Fine collision of a scene: a bitmap of small solid cells (4 or 8 px), for maps whose obstacles are painted rather than
 * built from tiles (a picture's walls, posts and tree trunks). Same meaning as a solid tile, only finer: everything that
 * asks "is this solid?" asks it too. Stored as run lengths, alternating free and solid, starting with free.
 */

export interface FineSolidData {
  /** Side of a cell in pixels. */
  cell: number;
  cols: number;
  rows: number;
  /** Run lengths in base 36, comma separated: free, solid, free, solid... over the cells row by row. */
  rle: string;
}

export interface FineSolid {
  cell: number;
  cols: number;
  rows: number;
  bits: Uint8Array;
}

/** Decodes the stored bitmap; null with a reason when it doesn't fit the scene. */
export function decodeFineSolid(d: FineSolidData, widthPx: number, heightPx: number): { fine: FineSolid | null; error?: string } {
  const cell = Math.round(d.cell);
  if (!(cell >= 1 && cell <= 64)) return { fine: null, error: `collisionFine: cell ${d.cell} is not between 1 and 64 px` };
  if (d.cols !== Math.ceil(widthPx / cell) || d.rows !== Math.ceil(heightPx / cell)) {
    return { fine: null, error: `collisionFine: ${d.cols}x${d.rows} cells of ${cell} px do not cover the scene (${widthPx}x${heightPx} px)` };
  }
  const bits = new Uint8Array(d.cols * d.rows);
  let k = 0;
  let solid = false;
  const toks = d.rle.split(',');
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t]!;
    // runs are plain base-36 digits, never empty (a bitmap that starts solid begins with "0")
    if (!/^[0-9a-z]+$/.test(tok)) return { fine: null, error: `collisionFine: "${tok.slice(0, 12)}" is not a run length` };
    const n = parseInt(tok, 36);
    if (k + n > bits.length) return { fine: null, error: 'collisionFine: the run lengths do not match the size' };
    if (solid) bits.fill(1, k, k + n);
    k += n;
    solid = !solid;
  }
  if (k !== bits.length) return { fine: null, error: 'collisionFine: the run lengths do not match the size' };
  return { fine: { cell, cols: d.cols, rows: d.rows, bits } };
}

/** Encodes a bitmap (1 = solid) as stored in a scene. */
export function encodeFineSolid(bits: ArrayLike<number>, cols: number, rows: number, cell: number): FineSolidData {
  const runs: string[] = [];
  let cur = 0;
  let n = 0;
  for (let i = 0; i < cols * rows; i++) {
    const v = bits[i] ? 1 : 0;
    if (v === cur) n++;
    else {
      runs.push(n.toString(36));
      cur = v;
      n = 1;
    }
  }
  runs.push(n.toString(36));
  return { cell, cols, rows, rle: runs.join(',') };
}

export function fineSolidAt(f: FineSolid, x: number, y: number): boolean {
  const cx = Math.floor(x / f.cell);
  const cy = Math.floor(y / f.cell);
  return cx >= 0 && cy >= 0 && cx < f.cols && cy < f.rows && f.bits[cy * f.cols + cx] === 1;
}

/** Solid cells overlapping a box, merged into horizontal runs. */
export function fineSolidRects(f: FineSolid, box: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const c = f.cell;
  const x0 = Math.max(0, Math.floor(box.x / c));
  const x1 = Math.min(f.cols - 1, Math.floor((box.x + box.w - 1e-6) / c));
  const y0 = Math.max(0, Math.floor(box.y / c));
  const y1 = Math.min(f.rows - 1, Math.floor((box.y + box.h - 1e-6) / c));
  for (let cy = y0; cy <= y1; cy++) {
    let start = -1;
    for (let cx = x0; cx <= x1 + 1; cx++) {
      const on = cx <= x1 && f.bits[cy * f.cols + cx] === 1;
      if (on && start < 0) start = cx;
      if (!on && start >= 0) {
        out.push({ x: start * c, y: cy * c, w: (cx - start) * c, h: c });
        start = -1;
      }
    }
  }
  return out;
}

/** How much of each map tile the fine cells cover, 0..1: a tile more than half covered counts as solid for tile-level work (paths, maps). */
export function fineTileCover(f: FineSolid, tileSize: number, cols: number, rows: number): Float32Array {
  const out = new Float32Array(cols * rows);
  const area = tileSize * tileSize;
  for (let cy = 0; cy < f.rows; cy++) {
    for (let cx = 0; cx < f.cols; cx++) {
      if (!f.bits[cy * f.cols + cx]) continue;
      // the cell's square in pixels, spread over every tile it overlaps (a cell can be bigger than a tile)
      const x0 = cx * f.cell, y0 = cy * f.cell, x1 = x0 + f.cell, y1 = y0 + f.cell;
      for (let ty = Math.floor(y0 / tileSize); ty < Math.min(rows, Math.ceil(y1 / tileSize)); ty++) {
        for (let tx = Math.floor(x0 / tileSize); tx < Math.min(cols, Math.ceil(x1 / tileSize)); tx++) {
          const w = Math.min(x1, (tx + 1) * tileSize) - Math.max(x0, tx * tileSize);
          const h = Math.min(y1, (ty + 1) * tileSize) - Math.max(y0, ty * tileSize);
          if (w > 0 && h > 0) out[ty * cols + tx]! += (w * h) / area;
        }
      }
    }
  }
  return out;
}

/** Tiles of a scene that its fine collision blocks (more than half covered), for tile-level tools; null when it has none. */
export function fineBlockedTiles(scene: { collisionFine?: FineSolidData; cols: number; rows: number; tileSize: number }): Uint8Array | null {
  if (!scene.collisionFine) return null;
  const { fine } = decodeFineSolid(scene.collisionFine, scene.cols * scene.tileSize, scene.rows * scene.tileSize);
  if (!fine) return null;
  const cover = fineTileCover(fine, scene.tileSize, scene.cols, scene.rows);
  return Uint8Array.from(cover, (c) => (c > 0.5 ? 1 : 0));
}
