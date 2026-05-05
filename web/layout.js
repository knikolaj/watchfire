// Project placement on the iso grid.
//
// Each cwd gets a 3x3 area. Layout is persisted on the server (POST /layout)
// so positions stay stable across reloads.
//
// Phase 3a: in-memory only with a deterministic spiral. Persistence comes
// in phase 4 along with drag-to-rearrange. The shape of `assign(cwd) -> {col,row}`
// stays the same; only its backing storage changes.

const DISTRICT = 3;     // 3x3 tiles
const PADDING  = 1;     // 1-tile gutter between districts
const STRIDE   = DISTRICT + PADDING;

export class Layout {
  constructor() {
    this.byKey = new Map();   // cwd -> { col, row }
    this.taken = new Set();   // "col,row" of district origins
  }

  assign(cwd) {
    if (this.byKey.has(cwd)) return this.byKey.get(cwd);
    const origin = this.nextSpiralSlot();
    this.byKey.set(cwd, origin);
    this.taken.add(`${origin.col},${origin.row}`);
    return origin;
  }

  /** Outward square spiral starting near (0,0), in district-stride steps. */
  nextSpiralSlot() {
    // Directions: right, down, left, up
    const dirs = [[1,0],[0,1],[-1,0],[0,-1]];
    let col = 0, row = 0, steps = 1, di = 0;
    if (!this.taken.has(`${col},${row}`)) return { col, row };
    while (true) {
      for (let twice = 0; twice < 2; twice++) {
        const [dc, dr] = dirs[di];
        for (let s = 0; s < steps; s++) {
          col += dc * STRIDE;
          row += dr * STRIDE;
          if (!this.taken.has(`${col},${row}`)) return { col, row };
        }
        di = (di + 1) % 4;
      }
      steps++;
      if (steps > 200) throw new Error("layout spiral exhausted");
    }
  }
}
