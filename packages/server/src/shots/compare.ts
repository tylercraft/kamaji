// Comparing a page before and after (ops/screenshots-plan.md, "Masks"): pixelmatch over the two
// PNGs, with what's masked left out. The masks: the boxes the shot script measured (configured
// selectors, video, frames from other hosts) and, for a run, whatever differed between its two
// "before" rounds, widened by 10 px. When the heights differ, everything below the change moves,
// so only the first screen is compared and the height change is its own signal.
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Shot {
  png: Buffer;
  /** The boxes the shot script measured, in page pixels. */
  masks: Box[];
}

export interface Compared {
  compared: 'page' | 'first screen';
  changedPct: number;
  maskedPct: number;
  /** Changes in red over a faded copy, masked areas in blue. */
  diff: Buffer;
}

/** Heights within this many pixels count as the same. */
const SAME_HEIGHT = 2;
/** How far the automatic mask reaches past what differed between the two "before" rounds. */
const WIDEN = 10;
/** pixelmatch's per-pixel threshold: how different a pixel's colour must be to count. */
const THRESHOLD = 0.1;

/** A copy of the top-left width × height of a PNG, padded with white where it's smaller. */
function region(png: PNG, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4, 255);
  const w = Math.min(width, png.width);
  for (let y = 0; y < Math.min(height, png.height); y += 1)
    png.data.copy(out, y * width * 4, y * png.width * 4, (y * png.width + w) * 4);
  return out;
}

/** Marks every pixel inside the boxes. */
function paintBoxes(mask: Uint8Array, width: number, height: number, boxes: Box[]): void {
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(width, Math.ceil(b.x + b.width));
    const y1 = Math.min(height, Math.ceil(b.y + b.height));
    for (let y = y0; y < y1; y += 1) mask.fill(1, y * width + x0, y * width + x1);
  }
}

/** Widens a mask by r pixels each way: a sliding window across, then down. */
export function widen(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const across = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    const row = y * width;
    for (let x = 0; x < Math.min(r, width); x += 1) count += mask[row + x]!;
    for (let x = 0; x < width; x += 1) {
      if (x + r < width) count += mask[row + x + r]!;
      if (x - r - 1 >= 0) count -= mask[row + x - r - 1]!;
      across[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y < Math.min(r, height); y += 1) count += across[y * width + x]!;
    for (let y = 0; y < height; y += 1) {
      if (y + r < height) count += across[(y + r) * width + x]!;
      if (y - r - 1 >= 0) count -= across[(y - r - 1) * width + x]!;
      out[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/** The pixels that differ between two images of the same size, as a mask. */
function differing(a: Buffer, b: Buffer, width: number, height: number): Uint8Array {
  const out = Buffer.alloc(width * height * 4);
  pixelmatch(a, b, out, width, height, {
    threshold: THRESHOLD,
    diffMask: true,
    diffColor: [255, 0, 0],
    aaColor: [0, 0, 255],
  });
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1)
    if (out[i * 4 + 3]! > 0 && out[i * 4] === 255 && out[i * 4 + 2] === 0) mask[i] = 1;
  return mask;
}

export function compareShots(
  before: Shot,
  after: Shot,
  options: {
    /** The first screen's height at this size, compared when the page heights differ. */
    screenHeight: number;
    /** The run's second "before" round, for the automatic mask. */
    beforeAgain?: Shot | null;
  },
): Compared {
  const a = PNG.sync.read(before.png);
  const b = PNG.sync.read(after.png);
  const width = Math.max(a.width, b.width);
  const samePage = Math.abs(a.height - b.height) <= SAME_HEIGHT;
  const height = samePage
    ? Math.min(a.height, b.height)
    : Math.min(options.screenHeight, a.height, b.height);
  const one = region(a, width, height);
  const two = region(b, width, height);

  const mask = new Uint8Array(width * height);
  paintBoxes(mask, width, height, [...before.masks, ...after.masks]);
  if (options.beforeAgain) {
    const again = PNG.sync.read(options.beforeAgain.png);
    const moving = widen(
      differing(one, region(again, width, height), width, height),
      width,
      height,
      WIDEN,
    );
    for (let i = 0; i < mask.length; i += 1) if (moving[i]) mask[i] = 1;
  }
  let masked = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    masked += 1;
    // The same colour in both, so pixelmatch never counts it.
    one.writeUInt32BE(0xff00ffff, i * 4);
    two.writeUInt32BE(0xff00ffff, i * 4);
  }

  const out = new PNG({ width, height });
  const changed = pixelmatch(one, two, out.data, width, height, {
    threshold: THRESHOLD,
    alpha: 0.15,
  });
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) out.data.writeUInt32BE(0xc8dcffff, i * 4);
  const open = width * height - masked;
  return {
    compared: samePage ? 'page' : 'first screen',
    changedPct: open === 0 ? 0 : round((100 * changed) / open),
    maskedPct: round((100 * masked) / (width * height)),
    diff: PNG.sync.write(out),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
