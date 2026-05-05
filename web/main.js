// Watchfire — isometric "city" view of Claude Code & Codex sessions,
// grouped by cwd into 3x3 districts. All graphics drawn procedurally via
// Phaser.Graphics — no sprite sheets.

import { connectWS } from "./ws.js";
import { Layout } from "./layout.js";
import { enable as enableAudio, bell, chime } from "./audio.js";

// --- Iso math --------------------------------------------------------------
const TILE_W = 96;
const TILE_H = 48;
const GROUND_RADIUS = 7;   // ground tiles span [-R..R] in both axes

/** Grid (col, row) -> screen (x, y) for diamond/iso projection. */
export function gridToScreen(col, row) {
  return { x: (col - row) * (TILE_W / 2), y: (col + row) * (TILE_H / 2) };
}

// --- Status visuals --------------------------------------------------------
// What the lit window inside the house shows. Replaces the old flag — at any
// zoom, a glowing window reads as "this house is doing something" while a
// dark window reads as "empty/idle".
const WINDOW_GLOW = {
  working:       0xffe066,   // warm yellow — someone's home, working
  waiting_input: 0xef476f,   // urgent red, also pulses
  done:          0x06d6a0,   // calm green
  idle:          0x2a2230,   // dark — unlit
};

// Roof color per agent — terra cotta for Claude, teal for Codex
const AGENT_ROOF = {
  claude: 0xa64633,
  codex:  0x3a7a8a,
};

// --- Geometry helpers (used by drawBuilding) -------------------------------
function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

function scaleColor(hex, f) {
  const r = Math.max(0, Math.min(255, Math.floor(((hex >> 16) & 0xff) * f)));
  const g = Math.max(0, Math.min(255, Math.floor(((hex >>  8) & 0xff) * f)));
  const b = Math.max(0, Math.min(255, Math.floor(( hex        & 0xff) * f)));
  return (r << 16) | (g << 8) | b;
}

function fillQuad(g, a, b, c, d, fill, line) {
  g.fillStyle(fill, 1);
  g.beginPath();
  g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y); g.lineTo(d.x, d.y);
  g.closePath();
  g.fillPath();
  if (line != null) { g.lineStyle(1, line, 1); g.strokePath(); }
}

function fillTri(g, a, b, c, fill, line) {
  g.fillStyle(fill, 1);
  g.beginPath();
  g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y);
  g.closePath();
  g.fillPath();
  if (line != null) { g.lineStyle(1, line, 1); g.strokePath(); }
}

// Draw one triangular roof slope as overlapping rows of shingles.
// `eave1`/`eave2` are the two corners along the bottom (eave) edge; `peak`
// is the apex. Rows are bands parallel to the eave, narrowing toward the
// peak. Vertical seams are offset like brickwork between adjacent rows.
function drawTiledSlope(g, eave1, eave2, peak, baseColor) {
  const ROWS = 12;           // very dense shingle pattern
  const dark = scaleColor(baseColor, 0.55);
  const med  = scaleColor(baseColor, 0.88);

  // Base fill so any anti-aliasing seams show the right colour.
  fillTri(g, eave1, eave2, peak, baseColor, null);

  for (let i = 0; i < ROWS; i++) {
    const t0 = i       / ROWS;
    const t1 = (i + 1) / ROWS;
    const a0 = lerp(eave1, peak, t0);
    const b0 = lerp(eave2, peak, t0);
    const a1 = lerp(eave1, peak, t1);
    const b1 = lerp(eave2, peak, t1);

    // Alternating row tint — every other row a touch darker for a
    // shadow-under-the-overhanging-shingle effect.
    const rowColor = (i % 2 === 0) ? baseColor : med;
    fillQuad(g, a0, b0, b1, a1, rowColor, null);

    // Vertical seams — fewer toward the peak (rows narrow). Offset by
    // half a tile every other row for the brick pattern.
    const tilesInRow = Math.max(3, 12 - i);
    const offset = (i % 2 === 1) ? (0.5 / tilesInRow) : 0;
    g.lineStyle(1, dark, 0.55);
    for (let j = 1; j < tilesInRow; j++) {
      const f = j / tilesInRow + offset;
      if (f <= 0 || f >= 1) continue;
      const p = lerp(a0, b0, f);
      const q = lerp(a1, b1, f);
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.strokePath();
    }
    // Horizontal seam between rows — emphasizes the shingle ledge.
    if (i > 0) {
      g.lineStyle(1, dark, 0.7);
      g.beginPath(); g.moveTo(a0.x, a0.y); g.lineTo(b0.x, b0.y); g.strokePath();
    }
  }

  // Outline of the slope (over the bands).
  g.lineStyle(1, 0x1a1410, 1);
  g.beginPath();
  g.moveTo(eave1.x, eave1.y); g.lineTo(eave2.x, eave2.y); g.lineTo(peak.x, peak.y);
  g.closePath();
  g.strokePath();
}

// A tiny three-blade grass tuft, used to texture the ground.
function drawGrassTuft(g, cx, cy, color) {
  g.lineStyle(1, color, 0.75);
  g.beginPath();
  g.moveTo(cx - 2, cy + 1); g.lineTo(cx - 2, cy - 2);
  g.moveTo(cx,     cy + 1); g.lineTo(cx,     cy - 3);
  g.moveTo(cx + 2, cy + 1); g.lineTo(cx + 2, cy - 2);
  g.strokePath();
}

// Fixed tuft layouts per ground-tile variant — keeps placement stable
// across reloads (no RNG) while still looking scattered. ~4-5 tufts per
// tile gives a dense, "every patch has grass" texture.
const TUFT_PATTERNS = [
  [[ -8,  4], [ 12, -2], [  2,  8], [-16, -5]],
  [[-15, -3], [ 10,  4], [ -2, -7], [ 14, -8], [ -4, 10]],
  [[ -6,  6], [ 12, -4], [-13, -8], [  0,  4], [ 8, 10]],
  [[  0, -5], [-14,  4], [ 14,  2], [  6,  9], [ -8, -8]],
  [[-10,  0], [  8, -6], [ 13,  5], [ -4,  8], [  4, -9]],
  [[ -4, -8], [ 11,  6], [ 14, -6], [-14,  4], [  2, 10]],
  [[  2,  4], [-15,  2], [ 10, -8], [  8,  8], [ -2,-10]],
  [[-12, -3], [ 12,  3], [  0,  8], [ -6, -8], [  6, -4]],
];

// Tiny five-petal flower for occasional ground accents (pink/yellow).
function drawFlower(g, cx, cy, color) {
  g.fillStyle(color, 0.8);
  g.fillCircle(cx,     cy,     1.2);
  g.fillCircle(cx - 2, cy,     1.0);
  g.fillCircle(cx + 2, cy,     1.0);
  g.fillCircle(cx,     cy - 2, 1.0);
  g.fillCircle(cx,     cy + 2, 1.0);
  g.fillStyle(0xfff3b0, 1);
  g.fillCircle(cx, cy, 0.6);
}

// Tiny pebble — two-tone gray dot, scattered between grass tufts.
function drawPebble(g, cx, cy) {
  g.fillStyle(0x6a6056, 1);
  g.fillCircle(cx, cy, 1.2);
  g.fillStyle(0x9a8e80, 1);
  g.fillCircle(cx - 0.4, cy - 0.4, 0.6);
}

// Faint vertical plank seams — implies wood siding without pulling focus.
function drawWallPlanks(g, base1, base2, top1, top2, color, count) {
  g.lineStyle(1, color, 0.38);
  for (let i = 1; i < count; i++) {
    const t = i / count;
    const a = lerp(base1, base2, t);
    const b = lerp(top1, top2, t);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokePath();
  }
}

// Stone foundation strip at the bottom `fraction` of a wall surface.
// Drawn over the wall fill, so plank seams above remain visible.
function drawFoundation(g, base1, base2, top1, top2, color, fraction) {
  const f1 = lerp(base1, top1, fraction);
  const f2 = lerp(base2, top2, fraction);
  fillQuad(g, base1, base2, f2, f1, color, null);
  // Top edge of foundation — emphasizes the ledge.
  g.lineStyle(1, scaleColor(color, 0.5), 0.7);
  g.beginPath(); g.moveTo(f1.x, f1.y); g.lineTo(f2.x, f2.y); g.strokePath();
  // 2 vertical seams to suggest stones.
  g.lineStyle(1, scaleColor(color, 0.55), 0.55);
  for (const f of [0.33, 0.66]) {
    const p = lerp(base1, base2, f), q = lerp(f1, f2, f);
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.strokePath();
  }
}

// Stone-coursed wall: solid fill + horizontal courses + brick-offset
// vertical seams. Used for the tower; reads as masonry rather than wood.
function drawStoneWall(g, base1, base2, top1, top2, fillColor, outline) {
  fillQuad(g, base1, base2, top2, top1, fillColor, outline);
  const seam = scaleColor(fillColor, 0.5);
  const COURSES = 12;         // very dense stone-block courses
  for (let i = 1; i < COURSES; i++) {
    const t = i / COURSES;
    const a = lerp(base1, top1, t);
    const b = lerp(base2, top2, t);
    g.lineStyle(1, seam, 0.55);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokePath();
  }
  const STONES = 3;
  for (let i = 0; i < COURSES; i++) {
    const t0 = i / COURSES, t1 = (i + 1) / COURSES;
    const a0 = lerp(base1, top1, t0), b0 = lerp(base2, top2, t0);
    const a1 = lerp(base1, top1, t1), b1 = lerp(base2, top2, t1);
    const off = (i % 2) ? (0.5 / STONES) : 0;
    g.lineStyle(1, seam, 0.45);
    for (let j = 1; j < STONES; j++) {
      const f = j / STONES + off;
      if (f <= 0 || f >= 1) continue;
      const p = lerp(a0, b0, f), q = lerp(a1, b1, f);
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.strokePath();
    }
  }
}

// A small stone watchtower with a slate spire and red pennant. Drawn at
// (x, y) — the screen center of the bottom-left tile of each district.
function drawTower(g, x, y) {
  const tfw = 14;             // narrower footprint than houses
  const tfh = 7;
  const PLINTH_H = 4;         // wider stone foot
  const TWH = 40;             // wall height (above plinth)
  const RIM_H = 4;            // parapet rim between wall top & spire
  const TRH = 14;             // pyramid spire rise

  // Plinth (wider than walls, sticks out at the base).
  const pfw = tfw + 3, pfh = tfh + 1.5;
  const PE = { x: x + pfw, y },
        PS = { x,         y: y + pfh },
        PW = { x: x - pfw, y };
  // Plinth top (where walls actually start, narrower again).
  const pTopY = y - PLINTH_H;
  const PEt = { x: x + tfw, y: pTopY + 0    },
        PSt = { x,           y: pTopY + tfh },
        PWt = { x: x - tfw, y: pTopY + 0    };

  // Walls go from plinth top to wall top.
  const E  = PEt, S = PSt, W = PWt;
  const Ep = { x: E.x, y: E.y - TWH },
        Sp = { x: S.x, y: S.y - TWH },
        Wp = { x: W.x, y: W.y - TWH };

  // Parapet rim above the walls (slightly darker stone).
  const Er = { x: Ep.x, y: Ep.y - RIM_H },
        Sr = { x: Sp.x, y: Sp.y - RIM_H },
        Wr = { x: Wp.x, y: Wp.y - RIM_H };

  // Spire peak.
  const P  = { x, y: Sr.y - TRH };

  const stoneLit   = 0x9aa3ad;
  const stoneShade = 0x6c7480;
  const slateLit   = 0x5e5670;
  const slateShade = 0x3f3850;
  const outline    = 0x1a1410;

  // Plinth — lighter stone, two visible faces, wider than walls.
  fillQuad(g, PE, PS, PSt, PEt, scaleColor(stoneLit, 1.05), outline);
  fillQuad(g, PS, PW, PWt, PSt, scaleColor(stoneShade, 1.05), outline);

  // Walls — stone-coursed.
  drawStoneWall(g, E, S, Ep, Sp, stoneLit,   outline);
  drawStoneWall(g, S, W, Sp, Wp, stoneShade, outline);

  // Two arrow slits, one high on each visible wall.
  const slitLitB = lerp(S, E, 0.5), slitLitT = lerp(Sp, Ep, 0.5);
  const slitLitC = lerp(slitLitB, slitLitT, 0.72);
  const slitDarkB = lerp(W, S, 0.5), slitDarkT = lerp(Wp, Sp, 0.5);
  const slitDarkC = lerp(slitDarkB, slitDarkT, 0.4);
  g.fillStyle(0x0a0808, 1);
  g.lineStyle(1, outline, 1);
  for (const c of [slitLitC, slitDarkC]) {
    g.fillRect(c.x - 1, c.y - 3, 2, 6);
    g.strokeRect(c.x - 1, c.y - 3, 2, 6);
  }

  // Parapet rim (battlement band) — slightly darker stone band on top of walls.
  fillQuad(g, Ep, Sp, Sr, Er, scaleColor(stoneLit, 0.78),   outline);
  fillQuad(g, Sp, Wp, Wr, Sr, scaleColor(stoneShade, 0.78), outline);

  // Pyramid spire — two visible faces, rises from the rim.
  fillTri(g, Sr, Er, P, slateLit,   outline);
  fillTri(g, Wr, Sr, P, slateShade, outline);

  // Pennant flag on top — pole + forked-tail flag.
  g.lineStyle(1, outline, 1);
  g.beginPath();
  g.moveTo(P.x, P.y); g.lineTo(P.x, P.y - 11);
  g.strokePath();
  g.fillStyle(0xa64633, 1);
  g.beginPath();
  g.moveTo(P.x, P.y - 11);
  g.lineTo(P.x + 7, P.y - 9);
  g.lineTo(P.x + 4, P.y - 7);
  g.lineTo(P.x + 7, P.y - 5);
  g.lineTo(P.x,     P.y - 7);
  g.closePath();
  g.fillPath(); g.strokePath();
}

// --- Phaser scene ----------------------------------------------------------

class CityScene extends Phaser.Scene {
  constructor() { super("City"); }

  create() {
    // World container we can pan/zoom by moving camera
    this.world = this.add.container(0, 0);

    // Tooltip element (DOM)
    this.tooltipEl = document.getElementById("tooltip");

    // Layout manager: assigns each cwd a 3x3 origin on the grid
    this.layout = new Layout();

    // Map session_id -> { gfx, label, session }
    this.buildings = new Map();
    // Map cwd -> { signGfx, signLabel, archiveGfx }
    this.districts = new Map();
    // Have we received the initial snapshot yet? Used to suppress sounds for
    // already-existing waiting/done states on first load.
    this.bootstrapped = false;

    // Ground tiles: centered around origin so spiral-placed districts (which
    // extend into negative coords) land on visible ground.
    this.drawGround(GROUND_RADIUS);

    // Camera pan with right-mouse drag, zoom with wheel
    this.installCameraControls();

    // Connect to server
    connectWS({
      onSnapshot: (sessions) => this.applySnapshot(sessions),
      onUpsert:   (s) => this.upsertSession(s),
      onRemove:   (id) => this.removeSession(id),
    });

    // Unlock Web Audio on first user gesture (browser autoplay policy)
    const unlock = () => { enableAudio(); window.removeEventListener("pointerdown", unlock); };
    window.addEventListener("pointerdown", unlock);
  }

  // -- Ground -------------------------------------------------------------

  drawGround(radius) {
    const g = this.add.graphics();
    // Grass palette — 8 deterministic variants so the field reads as a
    // patchy meadow rather than a uniform board. Borders are kept very
    // faint (drawn separately at low alpha) so the iso grid is implied
    // but doesn't dominate.
    const variants = [
      0x3a6b3a, 0x447a44, 0x4f8050, 0x3a6b3a,
      0x457644, 0x3f713e, 0x4a7d4a, 0x416f3e,
    ];
    const tuftColor = 0x6da053;
    const flowerColors = [0xe07a8a, 0xe5b54a, 0xb8a9d9];
    for (let r = -radius; r <= radius; r++) {
      for (let c = -radius; c <= radius; c++) {
        const h = ((c * 73856093) ^ (r * 19349663)) & 7;
        this.drawDiamond(g, c, r, variants[h], 0x2a4a2a);
        // Scatter a small grass tuft cluster on each tile.
        const { x, y } = gridToScreen(c, r);
        for (const [ox, oy] of TUFT_PATTERNS[h]) {
          drawGrassTuft(g, x + ox, y + oy, tuftColor);
        }
        // Occasional flower (~1 in 5 tiles), deterministic by tile coords.
        const f = ((c * 31337) ^ (r * 0x7fffffff)) & 0x1f;
        if (f < 6) {
          const fx = x + ((f * 7) % 24) - 12;
          const fy = y + ((f * 11) % 12) - 6;
          drawFlower(g, fx, fy, flowerColors[f % flowerColors.length]);
        }
        // 1–3 small pebbles per tile — adds micro-detail to the meadow.
        const pHash = ((c * 0xabcdef) ^ (r * 0x123456)) & 0xfff;
        const pebbleCount = 1 + (pHash & 0x3);  // 1..4
        for (let k = 0; k < pebbleCount; k++) {
          const px = x + (((pHash >> (k * 3)) * 11) % 30) - 15;
          const py = y + (((pHash >> (k * 3 + 1)) * 7) % 14) - 7;
          drawPebble(g, px, py);
        }
      }
    }
    this.world.add(g);
  }

  drawDiamond(g, col, row, fillColor, lineColor) {
    const { x, y } = gridToScreen(col, row);
    const hw = TILE_W / 2, hh = TILE_H / 2;
    g.fillStyle(fillColor, 1);
    // Faint borders — grid stays implied, terrain stays the dominant signal.
    g.lineStyle(1, lineColor, 0.3);
    g.beginPath();
    g.moveTo(x,       y - hh);
    g.lineTo(x + hw,  y);
    g.lineTo(x,       y + hh);
    g.lineTo(x - hw,  y);
    g.closePath();
    g.fillPath();
    g.strokePath();
  }

  // -- District (3x3 area for one cwd) -----------------------------------

  ensureDistrict(cwd) {
    if (this.districts.has(cwd)) return this.districts.get(cwd);
    const origin = this.layout.assign(cwd);

    // Stone fence around the 3x3 perimeter — drawn first so buildings overlay it
    const fenceGfx = this.drawFence(origin);
    this.world.add(fenceGfx);

    // Watchtower on the bottom-left tile of the 3x3.
    const towerSlot = { col: origin.col, row: origin.row + 2 };
    const tp = gridToScreen(towerSlot.col, towerSlot.row);
    const towerGfx = this.add.graphics();
    drawTower(towerGfx, tp.x, tp.y);
    this.world.add(towerGfx);

    // Hovering the tower shows the full session list for this district.
    // Hit area covers the visible tower (walls + spire + pennant).
    towerGfx.setInteractive(
      new Phaser.Geom.Rectangle(tp.x - 18, tp.y - 70, 36, 80),
      Phaser.Geom.Rectangle.Contains,
    );
    towerGfx.on("pointerover", () => this.showDistrictTip(cwd));
    towerGfx.on("pointermove", (p) => this.moveTooltipPx(p.event.clientX, p.event.clientY));
    towerGfx.on("pointerout", () => { this.tooltipEl.style.display = "none"; });

    // Folder name printed below the southern (front) corner of the village.
    // setResolution(2) renders the text texture at 2× pixel density —
    // canonical Phaser fix for blurry small text.
    const south = gridToScreen(origin.col + 2, origin.row + 2);
    const nameLabel = this.add.text(south.x, south.y + TILE_H / 2 + 8, this.shortLabel(cwd), {
      fontFamily: "ui-monospace, monospace",
      fontSize: "12px",
      color: "#cfd8dc",
      backgroundColor: "rgba(0,0,0,0.55)",
      padding: { left: 6, right: 6, top: 2, bottom: 2 },
      resolution: 2,
    }).setOrigin(0.5, 0);
    this.world.add(nameLabel);

    const district = { origin, fenceGfx, nameLabel, towerGfx };
    this.districts.set(cwd, district);
    return district;
  }

  // Tooltip that lists every chat that has ever lived in this directory —
  // both active (currently in a terminal, with live status) and archived
  // (transcript on disk only). Active state comes from `this.buildings`;
  // archived list comes from the server scanning ~/.claude/projects/<dir>.
  showDistrictTip(cwd) {
    // Render whatever we have synchronously (active sessions + cached list)
    // so the tooltip doesn't blink empty while we fetch.
    this.renderDistrictTip(cwd);
    // Then refresh from disk in the background.
    this.refreshChatsCache(cwd).then(() => this.renderDistrictTip(cwd));
  }

  async refreshChatsCache(cwd) {
    if (!this.chatsCache) this.chatsCache = new Map();
    try {
      const r = await fetch(`/chats?cwd=${encodeURIComponent(cwd)}`);
      if (r.ok) this.chatsCache.set(cwd, await r.json());
    } catch { /* ignore — tooltip falls back to active-only list */ }
  }

  renderDistrictTip(cwd) {
    if (!this.chatsCache) this.chatsCache = new Map();
    const palette = {
      working: "#ffd166", waiting_input: "#ef476f",
      done: "#06d6a0", idle: "#6c7a89",
    };

    // Active sessions for this cwd, keyed by session_id.
    const active = new Map();
    for (const e of this.buildings.values()) {
      if ((e.session.cwd || "(unknown)") === cwd) {
        active.set(e.session.session_id, e.session);
      }
    }
    // Archived chats (transcripts on disk) — anything not in `active`.
    const archived = (this.chatsCache.get(cwd) || [])
      .filter(c => !active.has(c.session_id));

    const head = `<b>${this.escape(this.shortLabel(cwd))}</b>`;
    const sub  = `<div class="cwd">${this.escape(cwd)}</div>`;

    let body = "";
    if (active.size === 0 && archived.length === 0) {
      body = `<div class="msg">No chats yet.</div>`;
    } else {
      // Active first, sorted by recency.
      const activeRows = [...active.values()]
        .sort((a, b) => (b.last_event_at || 0) - (a.last_event_at || 0))
        .map(s => {
          const status = s.status || "idle";
          const dot = palette[status] || palette.idle;
          const name = this.escape(s.name || (s.session_id || "").slice(0, 8));
          return `<div style="display:flex;gap:6px;align-items:center;margin:3px 0;">
            <span style="width:7px;height:7px;border-radius:50%;background:${dot};display:inline-block;flex-shrink:0;"></span>
            <span style="flex:1;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
            <span style="color:#7a8a9a;font-size:10px;">${status}</span>
          </div>`;
        }).join("");
      // Then archived, by mtime desc (server already sorts).
      const archivedRows = archived.map(c => {
        const name = this.escape(c.name || c.first_prompt || (c.session_id || "").slice(0, 8));
        return `<div style="display:flex;gap:6px;align-items:center;margin:3px 0;opacity:0.6;">
          <span style="width:7px;height:7px;border-radius:50%;background:#3a4250;display:inline-block;flex-shrink:0;"></span>
          <span style="flex:1;color:#9aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
          <span style="color:#667;font-size:10px;">archived</span>
        </div>`;
      }).join("");
      body = activeRows + archivedRows;
    }
    this.tooltipEl.innerHTML = head + sub + body;
    this.tooltipEl.style.display = "block";
  }

  moveTooltipPx(clientX, clientY) {
    this.tooltipEl.style.left = (clientX + 14) + "px";
    this.tooltipEl.style.top  = (clientY + 14) + "px";
  }

  /**
   * Draws a low stone fence around the 3x3 district.
   * The 4 outer corners of the diamond perimeter are the outer edges of the
   * corner tiles: top-of(col,row), right-of(col+2,row), bottom-of(col+2,row+2),
   * left-of(col,row+2).
   */
  drawFence(origin) {
    const g = this.add.graphics();
    const hw = TILE_W / 2, hh = TILE_H / 2;

    const tl = gridToScreen(origin.col,     origin.row);
    const tr = gridToScreen(origin.col + 2, origin.row);
    const br = gridToScreen(origin.col + 2, origin.row + 2);
    const bl = gridToScreen(origin.col,     origin.row + 2);

    const N = { x: tl.x,       y: tl.y - hh };
    const E = { x: tr.x + hw,  y: tr.y      };
    const S = { x: br.x,       y: br.y + hh };
    const W = { x: bl.x - hw,  y: bl.y      };

    // Shadow/base (slightly offset down for a 3D feel)
    g.lineStyle(4, 0x0d1620, 0.7);
    g.beginPath();
    g.moveTo(N.x, N.y + 2);
    g.lineTo(E.x, E.y + 2);
    g.lineTo(S.x, S.y + 2);
    g.lineTo(W.x, W.y + 2);
    g.closePath();
    g.strokePath();

    // Stone wall
    g.lineStyle(3, 0x6b6555, 1);
    g.beginPath();
    g.moveTo(N.x, N.y);
    g.lineTo(E.x, E.y);
    g.lineTo(S.x, S.y);
    g.lineTo(W.x, W.y);
    g.closePath();
    g.strokePath();

    // Corner posts (taller little blocks)
    const post = (p) => {
      g.fillStyle(0x8a8275, 1);
      g.lineStyle(1, 0x2a2620, 1);
      g.fillRect(p.x - 3, p.y - 8, 6, 8);
      g.strokeRect(p.x - 3, p.y - 8, 6, 8);
    };
    post(N); post(E); post(S); post(W);

    return g;
  }

  shortLabel(cwd) {
    if (!cwd) return "(unknown)";
    const parts = cwd.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || cwd;
  }

  // -- Building (one session) -------------------------------------------

  buildingSlots(origin) {
    // 7 perimeter tiles of the 3x3 (excluding center=sign and bottom-left=archive)
    // Order chosen so first-added agents appear top, then sides, then bottom-right.
    return [
      { col: origin.col + 1, row: origin.row     }, // top
      { col: origin.col,     row: origin.row     }, // top-left
      { col: origin.col + 2, row: origin.row     }, // top-right
      { col: origin.col,     row: origin.row + 1 }, // left
      { col: origin.col + 2, row: origin.row + 1 }, // right
      { col: origin.col + 1, row: origin.row + 2 }, // bottom
      { col: origin.col + 2, row: origin.row + 2 }, // bottom-right
    ];
  }

  pickSlotFor(cwd, sessionId) {
    const district = this.districts.get(cwd);
    const slots = this.buildingSlots(district.origin);
    // Stable hash on session_id so the same session always lands in same slot
    let h = 0;
    for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
    const used = new Set(
      [...this.buildings.values()]
        .filter(b => b.session.cwd === cwd && b.session.session_id !== sessionId)
        .map(b => `${b.slot.col},${b.slot.row}`)
    );
    for (let k = 0; k < slots.length; k++) {
      const s = slots[(Math.abs(h) + k) % slots.length];
      if (!used.has(`${s.col},${s.row}`)) return s;
    }
    return slots[0];
  }

  drawBuilding(session, slot) {
    const { x, y } = gridToScreen(slot.col, slot.row);
    const status = session.status || "idle";
    const roofColor = AGENT_ROOF[session.agent] ?? AGENT_ROOF.claude;

    // Iso-house geometry. Footprint is a smaller diamond inside the tile so
    // neighbours don't visually touch. Walls go straight up in screen-space
    // (classic iso); the roof is a 4-sided hip whose two front slopes are
    // visible from the camera angle (back slopes are hidden by the peak).
    const fw = TILE_W * 0.32;   // footprint half-width  ≈ 31 (smaller than tile)
    const fh = TILE_H * 0.32;   // footprint half-height ≈ 15
    const WH = 22;              // wall height
    const RH = 16;              // roof rise above wall top

    // Footprint diamond (base)
    const N = { x,         y: y - fh },
          E = { x: x + fw, y },
          S = { x,         y: y + fh },
          W = { x: x - fw, y };
    // Wall-top diamond (one floor up)
    const Np = { x: N.x, y: N.y - WH }, Ep = { x: E.x, y: E.y - WH },
          Sp = { x: S.x, y: S.y - WH }, Wp = { x: W.x, y: W.y - WH };
    // Roof peak (centered above the building)
    const P  = { x, y: y - WH - RH };

    const wallLit   = 0xe2cf9d;   // sunlit (front-right) wall
    const wallShade = 0xb59e6c;   // shaded (front-left) wall
    const outline   = 0x1a1410;
    const roofShade = scaleColor(roofColor, 0.72);

    const container = this.add.container(0, 0);
    const gfx = this.add.graphics();
    container.add(gfx);

    // Walls. Front-right (E-S face) is lit; front-left (S-W face) is shaded.
    fillQuad(gfx, E, S, Sp, Ep, wallLit, outline);
    fillQuad(gfx, S, W, Wp, Sp, wallShade, outline);

    // Vertical plank seams — gives the wall siding texture.
    drawWallPlanks(gfx, E, S, Ep, Sp, scaleColor(wallLit, 0.55), 10);
    drawWallPlanks(gfx, S, W, Sp, Wp, scaleColor(wallShade, 0.55), 10);

    // Stone foundation strip at the base of each wall.
    drawFoundation(gfx, E, S, Ep, Sp, 0x6e645a,                       0.18);
    drawFoundation(gfx, S, W, Sp, Wp, scaleColor(0x6e645a, 0.85),     0.18);

    // Door on the lit wall, near the front (S) corner.
    const dB1 = lerp(S, E, 0.30);
    const dB2 = lerp(S, E, 0.55);
    const dT1 = { x: dB1.x, y: dB1.y - WH * 0.62 };
    const dT2 = { x: dB2.x, y: dB2.y - WH * 0.62 };
    fillQuad(gfx, dB1, dB2, dT2, dT1, 0x3a2818, outline);
    // Lintel — small dark trim above the door.
    const lintelH = 1.8;
    const lT1 = { x: dT1.x, y: dT1.y - lintelH };
    const lT2 = { x: dT2.x, y: dT2.y - lintelH };
    fillQuad(gfx, dT1, dT2, lT2, lT1, 0x231410, outline);
    // Vertical plank seams within the door.
    gfx.lineStyle(1, scaleColor(0x3a2818, 0.55), 0.7);
    for (const t of [0.34, 0.66]) {
      const a = lerp(dB1, dB2, t), b = lerp(dT1, dT2, t);
      gfx.beginPath(); gfx.moveTo(a.x, a.y); gfx.lineTo(b.x, b.y); gfx.strokePath();
    }
    // Door knob.
    gfx.fillStyle(0xd4a55a, 1);
    gfx.fillCircle(dB2.x - 2, dB1.y - WH * 0.32, 1.1);

    // Window on the shaded wall — its glow encodes the session status.
    const winGlow = WINDOW_GLOW[status] ?? WINDOW_GLOW.idle;
    const wB1 = lerp(W, S, 0.32);
    const wB2 = lerp(W, S, 0.62);
    const winBL = { x: wB1.x, y: wB1.y - WH * 0.30 };
    const winBR = { x: wB2.x, y: wB2.y - WH * 0.30 };
    const winTL = { x: wB1.x, y: wB1.y - WH * 0.68 };
    const winTR = { x: wB2.x, y: wB2.y - WH * 0.68 };
    // Frame (slightly inflated, dark wood) behind the pane.
    const fp = 1.4;
    fillQuad(gfx,
      { x: winBL.x - fp, y: winBL.y + fp },
      { x: winBR.x + fp, y: winBR.y + fp },
      { x: winTR.x + fp, y: winTR.y - fp },
      { x: winTL.x - fp, y: winTL.y - fp },
      0x1f1610, outline);
    fillQuad(gfx, winBL, winBR, winTR, winTL, winGlow, null);
    // Cross-frame mullions — vertical + horizontal divider for paned glass.
    gfx.lineStyle(1, 0x1f1610, 0.85);
    const mvB = lerp(winBL, winBR, 0.5), mvT = lerp(winTL, winTR, 0.5);
    gfx.beginPath(); gfx.moveTo(mvB.x, mvB.y); gfx.lineTo(mvT.x, mvT.y); gfx.strokePath();
    const mhL = lerp(winBL, winTL, 0.5), mhR = lerp(winBR, winTR, 0.5);
    gfx.beginPath(); gfx.moveTo(mhL.x, mhL.y); gfx.lineTo(mhR.x, mhR.y); gfx.strokePath();
    // Sill — small dark ledge sticking out below the window.
    const sillH = 1.6, sillX = 1.2;
    fillQuad(gfx,
      { x: winBL.x - sillX, y: winBL.y + sillH },
      { x: winBR.x + sillX, y: winBR.y + sillH },
      winBR, winBL,
      0x3a2a1c, outline);

    // Roof — tiled (shingled) slopes meeting at the peak. Right slope is
    // the lit one, left is the shaded one (passed a darker base color).
    drawTiledSlope(gfx, Sp, Ep, P, roofColor);
    drawTiledSlope(gfx, Wp, Sp, P, roofShade);
    // Ridge cap — small dark dot at the peak suggests a metal/clay capstone.
    gfx.fillStyle(scaleColor(roofColor, 0.35), 1);
    gfx.fillCircle(P.x, P.y, 1.6);

    // Chimney on the shaded slope, between Wp and the peak.
    const chBase = lerp(Wp, P, 0.55);
    const cw = 3, ch = 7;
    gfx.fillStyle(0x6a4a3a, 1);
    gfx.lineStyle(1, outline, 1);
    gfx.fillRect(chBase.x - cw, chBase.y - ch, cw * 2, ch);
    gfx.strokeRect(chBase.x - cw, chBase.y - ch, cw * 2, ch);
    // Brick courses on the chimney.
    gfx.lineStyle(1, scaleColor(0x6a4a3a, 0.55), 0.7);
    for (const cy of [chBase.y - ch * 0.66, chBase.y - ch * 0.33]) {
      gfx.beginPath();
      gfx.moveTo(chBase.x - cw, cy); gfx.lineTo(chBase.x + cw, cy);
      gfx.strokePath();
    }

    // Smoke puffs while the agent is working — three rising fading circles.
    if (status === "working") {
      gfx.fillStyle(0xc8c8d4, 0.55);
      gfx.fillCircle(chBase.x - 1, chBase.y - ch -  4, 2.5);
      gfx.fillStyle(0xc8c8d4, 0.40);
      gfx.fillCircle(chBase.x + 2, chBase.y - ch -  9, 3);
      gfx.fillStyle(0xc8c8d4, 0.25);
      gfx.fillCircle(chBase.x - 1, chBase.y - ch - 14, 3.5);
    }

    // Pulse the window for waiting_input — render the glow on its own gfx so
    // tweening alpha doesn't force redraws of the whole house.
    let pulseTween = null;
    if (status === "waiting_input") {
      const pulseGfx = this.add.graphics();
      fillQuad(pulseGfx, winBL, winBR, winTR, winTL, winGlow, null);
      container.add(pulseGfx);
      pulseTween = this.tweens.add({
        targets: pulseGfx, alpha: 0.25, duration: 700,
        yoyo: true, repeat: -1, ease: "Sine.easeInOut",
      });
    }

    // Hit area covers the visible building (walls + roof + a little slack).
    gfx.setInteractive(
      new Phaser.Geom.Rectangle(W.x - 2, P.y - 4, fw * 2 + 4, (S.y - P.y) + 6),
      Phaser.Geom.Rectangle.Contains,
    );

    // Name label below the footprint.
    const labelText = session.name || (session.session_id || "").slice(0, 6);
    const label = this.add.text(x, y + fh + 4, labelText, {
      fontFamily: "ui-monospace, monospace",
      fontSize: "10px",
      color: "#cfd8dc",
      backgroundColor: "rgba(0,0,0,0.45)",
      padding: { left: 3, right: 3, top: 1, bottom: 1 },
      resolution: 2,
    }).setOrigin(0.5, 0);
    container.add(label);

    // Stash the tween so upsert/remove can stop it before destroy.
    container.pulseTween = pulseTween;
    return container;
  }

  upsertSession(session) {
    if (!session.session_id) return;
    this.ensureDistrict(session.cwd || "(unknown)");

    let entry = this.buildings.get(session.session_id);
    const prevStatus = entry?.session?.status;

    if (entry) {
      // Status / name changed — redraw in place
      if (entry.container.pulseTween) entry.container.pulseTween.stop();
      entry.container.destroy();
      const container = this.drawBuilding(session, entry.slot);
      this.world.add(container);
      this.attachInteractive(container.list[0], session);
      entry.container = container;
      entry.session = session;
    } else {
      const slot = this.pickSlotFor(session.cwd || "(unknown)", session.session_id);
      const container = this.drawBuilding(session, slot);
      this.world.add(container);
      this.attachInteractive(container.list[0], session);
      this.buildings.set(session.session_id, { container, slot, session });
    }

    // Sound on meaningful transitions, but not on initial snapshot
    if (this.bootstrapped && prevStatus !== session.status) {
      if (session.status === "waiting_input") bell();
      else if (session.status === "done" && prevStatus === "working") chime();
    }
  }

  attachInteractive(gfx, session) {
    gfx.on("pointerdown", (p) => {
      if (p.leftButtonDown()) this.focusSession(session);
    });
    gfx.on("pointerover", (p) => {
      // Refresh from latest known state
      const latest = this.buildings.get(session.session_id)?.session ?? session;
      const agent = latest.agent ? ` [${latest.agent}]` : "";
      const head = latest.name
        ? `<b>${this.escape(latest.name)}</b>${agent} · ${latest.status || "?"}`
        : `<b>${latest.status || "?"}</b>${agent} — ${(latest.session_id || "").slice(0, 8)}`;
      this.tooltipEl.innerHTML =
        head +
        `<div class="cwd">${latest.cwd || ""}</div>` +
        (latest.last_message ? `<div class="msg">${this.escape(latest.last_message)}</div>` : "") +
        (latest.last_prompt  ? `<div class="msg">${this.escape(latest.last_prompt).slice(0, 200)}</div>` : "");
      this.tooltipEl.style.display = "block";
    });
    gfx.on("pointermove", (p) => {
      this.tooltipEl.style.left = (p.event.clientX + 14) + "px";
      this.tooltipEl.style.top  = (p.event.clientY + 14) + "px";
    });
    gfx.on("pointerout", () => { this.tooltipEl.style.display = "none"; });
  }

  focusSession(session) {
    fetch("/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.session_id,
        cwd: session.cwd,
        name: session.name,
      }),
    }).catch(() => {});
  }

  escape(s) {
    return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  removeSession(id) {
    const entry = this.buildings.get(id);
    if (entry) {
      if (entry.container.pulseTween) entry.container.pulseTween.stop();
      entry.container.destroy();
      this.buildings.delete(id);
    }
  }

  applySnapshot(sessions) {
    // Reset
    for (const e of this.buildings.values()) {
      if (e.container.pulseTween) e.container.pulseTween.stop();
      e.container.destroy();
    }
    this.buildings.clear();
    this.bootstrapped = false;
    for (const s of sessions) this.upsertSession(s);
    this.bootstrapped = true;
  }

  // -- Camera pan & zoom -------------------------------------------------

  installCameraControls() {
    const cam = this.cameras.main;
    cam.centerOn(0, 0);

    let dragging = false;
    let last = null;
    this.input.on("pointerdown", (p) => {
      if (p.rightButtonDown() || p.middleButtonDown()) {
        dragging = true; last = { x: p.x, y: p.y };
      }
    });
    this.input.on("pointermove", (p) => {
      if (dragging) {
        cam.scrollX -= (p.x - last.x) / cam.zoom;
        cam.scrollY -= (p.y - last.y) / cam.zoom;
        last = { x: p.x, y: p.y };
      }
    });
    this.input.on("pointerup",   () => { dragging = false; });
    this.input.on("pointerupoutside", () => { dragging = false; });

    this.input.on("wheel", (_p, _objs, _dx, dy) => {
      const next = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.4, 2.5);
      cam.setZoom(next);
    });

    // Disable browser context menu so right-drag works
    this.game.canvas.addEventListener("contextmenu", e => e.preventDefault());
  }
}

// --- Boot ------------------------------------------------------------------

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#1a2332",
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  scene: CityScene,
});
