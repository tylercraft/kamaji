import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compareShots, widen, type Box } from './compare.js';

/** A white page, width × height, with grey blocks where asked. */
function page(width: number, height: number, blocks: (Box & { grey?: number })[] = []): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (const b of blocks)
    for (let y = b.y; y < b.y + b.height; y += 1)
      for (let x = b.x; x < b.x + b.width; x += 1) {
        const i = (y * width + x) * 4;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = b.grey ?? 60;
      }
  return PNG.sync.write(png);
}
const shot = (png: Buffer, masks: Box[] = []) => ({ png, masks });

describe('comparing a page before and after', () => {
  it('finds nothing in the same page twice', () => {
    const p = page(100, 200, [{ x: 10, y: 10, width: 30, height: 30 }]);
    expect(compareShots(shot(p), shot(p), { screenHeight: 50 })).toMatchObject({
      compared: 'page',
      changedPct: 0,
      maskedPct: 0,
    });
  });

  it('says how much moved: a block 20 px lower changes its old place and its new one', () => {
    const before = page(100, 200, [{ x: 0, y: 0, width: 100, height: 20 }]);
    const after = page(100, 200, [{ x: 0, y: 20, width: 100, height: 20 }]);
    const r = compareShots(shot(before), shot(after), { screenHeight: 50 });
    // 40 rows of 200 changed.
    expect(r.changedPct).toBe(20);
    expect(PNG.sync.read(r.diff)).toMatchObject({ width: 100, height: 200 });
  });

  it('leaves out the boxes the shot measured, from either side, and says how much is masked', () => {
    const before = page(100, 100, [{ x: 0, y: 0, width: 50, height: 10, grey: 10 }]);
    const after = page(100, 100, [{ x: 0, y: 0, width: 50, height: 10, grey: 200 }]);
    const r = compareShots(shot(before, [{ x: 0, y: 0, width: 50, height: 10 }]), shot(after), {
      screenHeight: 50,
    });
    expect(r).toMatchObject({ changedPct: 0, maskedPct: 5 });
  });

  it('masks what differed between the two “before” rounds (a carousel), widened by 10 px', () => {
    const slide = (grey: number) => [{ x: 40, y: 40, width: 20, height: 20, grey }];
    const before = page(100, 100, slide(30));
    const again = page(100, 100, slide(150));
    const after = page(100, 100, slide(220));
    const without = compareShots(shot(before), shot(after), { screenHeight: 50 });
    expect(without.changedPct).toBe(4);
    const masked = compareShots(shot(before), shot(after), {
      screenHeight: 50,
      beforeAgain: shot(again),
    });
    // The 20 × 20 slide and 10 px around it: 40 × 40 of 100 × 100.
    expect(masked).toMatchObject({ changedPct: 0, maskedPct: 16 });
  });

  it('still catches a real change beside a masked carousel', () => {
    const slide = (grey: number) => ({ x: 40, y: 40, width: 20, height: 20, grey });
    const header = { x: 0, y: 0, width: 100, height: 10 };
    const r = compareShots(
      shot(page(100, 100, [slide(30)])),
      shot(page(100, 100, [slide(220), header])),
      { screenHeight: 50, beforeAgain: shot(page(100, 100, [slide(150)])) },
    );
    // The header's 1,000 pixels of the 8,400 left open.
    expect(r.changedPct).toBeCloseTo(11.9, 1);
  });

  it('compares only the first screen when the page got taller', () => {
    const before = page(100, 200, [{ x: 0, y: 150, width: 100, height: 10 }]);
    const after = page(100, 400, [{ x: 0, y: 350, width: 100, height: 10 }]);
    const r = compareShots(shot(before), shot(after), { screenHeight: 80 });
    expect(r).toMatchObject({ compared: 'first screen', changedPct: 0 });
    expect(PNG.sync.read(r.diff)).toMatchObject({ height: 80 });
  });

  it('counts heights within 2 px as the same page', () => {
    const r = compareShots(shot(page(100, 200)), shot(page(100, 202)), { screenHeight: 80 });
    expect(r.compared).toBe('page');
  });
});

describe('widening a mask', () => {
  it('reaches r pixels each way, and no further', () => {
    const mask = new Uint8Array(11 * 11);
    mask[5 * 11 + 5] = 1;
    const out = widen(mask, 11, 11, 2);
    const set = [...out].reduce((n, v) => n + v, 0);
    expect(set).toBe(25);
    expect(out[3 * 11 + 3]).toBe(1);
    expect(out[2 * 11 + 5]).toBe(0);
  });
});
