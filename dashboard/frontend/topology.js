/* The topology view: the energy system as a diagram, animated by the results.
 *
 * Everything drawn here comes from /api/.../topology -- nodes with positions
 * and icon categories, edges optionally bound to a result column -- so this
 * file knows about *kinds* of asset, never about a particular tutorial. Inline
 * SVG, no dependencies: it must work offline on a Raspberry Pi.
 *
 * Flows are normalised per column against the largest magnitude seen so far in
 * this run, so dash width and speed always use the run's own scale. The sign
 * convention matches API.md: a positive value (after the edge's `sign`) moves
 * from `from` to `to`; negative reverses the arrow and the dashes.
 *
 * The view owns the *selected timestep* for the whole results panel: the
 * scrubber under the diagram drives the charts and the table above it through
 * the `onCursor` callback.
 */

import { clockOf } from './charts.js';
import { buildCompactControl } from './controls.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Chip radius around each icon; edges stop at this circle. */
const NODE_RADIUS = 27;

/** Perpendicular bow for the second edge of an A->B / B->A pair. */
const CURVE_OFFSET = 30;

/** Default milliseconds per step when playing the day back -- manually or in
 *  the automatic replay once a run finishes. The Options popover (app.js)
 *  overrides this via `setSpeed`; this is only the value before anyone has. */
const DEFAULT_PLAY_STEP_MS = 300;

/** Below this share of the column's range a flow is treated as "off". */
const FLOW_FLOOR = 0.015;

/* Flow marks: near-zero dashes with a round cap render as dots, spaced by the
   gap. Dot size is the stroke width, so magnitude still reads as weight.

   The floor is deliberately well clear of a hairline: a small flow still has
   to be legible across a room, and the range above it carries the comparison.
   The gap leaves daylight between dots even at the widest. */
const DOT_PATTERN = '0.1 11';
const DOT_MIN_WIDTH = 3.4;
const DOT_MAX_WIDTH = 6.5;

/** Width of a node's charge bar, in SVG units. */
const BAR_WIDTH = 44;

const CATEGORY_COLOR = {
  pv: '#b06a00',
  wind: '#0f7c8c',
  load: '#0b6fb8',
  load_ev: '#6a3fb5',
  load_hp: '#a3357f',
  battery: '#1f7a4d',
  controller: '#55636f',
  grid: '#b3261e',
  data: '#8494a1',
  generic: '#8494a1',
};

/* Icon glyphs, drawn in a 24x24 box, stroked. `fill` entries are filled. */
const ICONS = {
  pv: [
    { d: 'M4 9 h16 v9 H4 z M9.3 9 v9 M14.6 9 v9 M4 13.5 h16' },
    { d: 'M12 3.2 m-1.7 0 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0', fill: true },
  ],
  wind: [
    { d: 'M12 21.5 V12 M12 12 V3.5 M12 12 L19.4 16.2 M12 12 L4.6 16.2' },
    { d: 'M12 12 m-1.5 0 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0', fill: true },
  ],
  load: [
    { d: 'M3.5 12 L12 4.5 L20.5 12 M6 10.5 V19.5 H18 V10.5 M10.7 19.5 V15 h2.6 v4.5' },
  ],
  load_ev: [
    // A charging plug: two prongs, the body, and a curl of cable.
    { d: 'M9 3 v3.5 M15 3 v3.5 M7.5 6.5 h9 v4 a4.5 4.5 0 0 1 -9 0 z M12 15 v3 a3 3 0 0 1 -3 3' },
  ],
  load_hp: [
    // A heat-pump unit: the box, the fan ring, and its hub.
    { d: 'M4.5 6 h15 v12 h-15 z M12 12 m-3.4 0 a3.4 3.4 0 1 0 6.8 0 a3.4 3.4 0 1 0 -6.8 0' },
    { d: 'M12 12 m-1.2 0 a1.2 1.2 0 1 0 2.4 0 a1.2 1.2 0 1 0 -2.4 0', fill: true },
  ],
  battery: [
    { d: 'M3.5 7.5 h15 v9 h-15 z M18.5 10.2 h2 v3.6 h-2 z' },
  ],
  controller: [
    { d: 'M4.5 4.5 h15 v15 h-15 z M8 9.5 h8 M8 14.5 h8' },
    { d: 'M14.3 9.5 m-1.7 0 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0', fill: true },
    { d: 'M9.7 14.5 m-1.7 0 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0', fill: true },
  ],
  grid: [
    { d: 'M8 21 L11 3 h2 L16 21 M9 16.5 h6 M10 10.5 h4 M9 16.5 L15 21 M15 16.5 L9 21' },
  ],
  data: [
    { d: 'M6.5 3 H14 l4 4 V21 H6.5 z M14 3 V7 h4 M9.5 12.5 h5 M9.5 16 h5' },
  ],
  generic: [
    { d: 'M12 12 m-7.5 0 a7.5 7.5 0 1 0 15 0 a7.5 7.5 0 1 0 -15 0' },
  ],
};

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function categoryColor(category) {
  return CATEGORY_COLOR[category] || CATEGORY_COLOR.generic;
}

/** Apply a Python-style badge format ("{:.2f} kW", "{:.0f}%") to a value. */
export function applyFormat(fmt, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const match = /^(.*)\{:\.?(\d*)f\}(.*)$/.exec(fmt || '{:.2f}');
  if (!match) return String(value);
  const places = match[2] === '' ? 6 : Number(match[2]);
  return `${match[1]}${Number(value).toFixed(places)}${match[3]}`;
}

/* -------------------------------------------------------------- geometry */

/* jsdom (which the frontend tests run in) implements none of SVG's geometry
 * API, so path lengths, midpoints and tangents are computed here from the
 * shapes we generate -- straight lines and single quadratic beziers. */

function edgeGeometry(from, to, curved) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const span = Math.hypot(dx, dy) || 1;
  const ux = dx / span;
  const uy = dy / span;

  const a = { x: from.x + ux * NODE_RADIUS, y: from.y + uy * NODE_RADIUS };
  const b = { x: to.x - ux * NODE_RADIUS, y: to.y - uy * NODE_RADIUS };

  if (!curved) {
    return {
      d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      angle: (Math.atan2(uy, ux) * 180) / Math.PI,
    };
  }

  // Bowed to the side so a facing pair of edges reads as two distinct links.
  const control = {
    x: (a.x + b.x) / 2 - uy * CURVE_OFFSET,
    y: (a.y + b.y) / 2 + ux * CURVE_OFFSET,
  };
  return {
    d: `M ${a.x} ${a.y} Q ${control.x} ${control.y} ${b.x} ${b.y}`,
    // Midpoint of a quadratic at t=0.5; its tangent there parallels a->b.
    mid: {
      x: 0.25 * a.x + 0.5 * control.x + 0.25 * b.x,
      y: 0.25 * a.y + 0.5 * control.y + 0.25 * b.y,
    },
    angle: (Math.atan2(uy, ux) * 180) / Math.PI,
  };
}

/* ------------------------------------------------------------------ view */

/**
 * Mount the topology view.
 *
 * @param {HTMLElement} parent
 * @param {Object} topo  payload of /api/packs/{pack}/cases/{case}/topology
 * @param {Object} [opts]
 *   onCursor(index|null)  -- the selected timestep changed
 *   detailsFor(nodeId, row) -> { title, subtitle, settings, readings } | null
 *     what to show when an asset is tapped; the caller owns pack knowledge
 *   playSpeedMs -- initial milliseconds per step for playback (see setSpeed)
 * @returns {{update: Function, destroy: Function, el: HTMLElement}}
 */
export function createTopology(parent, topo, opts = {}) {
  const card = document.createElement('div');
  card.className = 'topo-card';

  const heading = document.createElement('h3');
  heading.textContent = 'The energy system';
  card.append(heading);

  const nodes = topo.nodes || [];
  const edges = topo.edges || [];
  const badgeSpecs = topo.badges || [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  // --- static SVG scaffold ------------------------------------------------
  const xs = nodes.map((n) => n.position[0]);
  const ys = nodes.map((n) => n.position[1]);
  const pad = { left: 70, right: 70, top: 55, bottom: 95 };
  const minX = Math.min(...xs) - pad.left;
  const minY = Math.min(...ys) - pad.top;
  const width = Math.max(...xs) - Math.min(...xs) + pad.left + pad.right;
  const height = Math.max(...ys) - Math.min(...ys) + pad.top + pad.bottom;

  const svg = el('svg', {
    class: 'topo-svg',
    viewBox: `${minX} ${minY} ${width} ${height}`,
    role: 'img',
    'aria-label': 'Diagram of the energy system',
  });
  card.append(svg);

  const edgeLayer = el('g');
  const nodeLayer = el('g');
  svg.append(edgeLayer, nodeLayer);

  // Edges: a quiet base line always, plus a dashed flow overlay and an arrow
  // for edges bound to a result column.
  const pairs = new Set(edges.map((edge) => `${edge.from}->${edge.to}`));
  const flowViews = [];
  for (const edge of edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    const curved = pairs.has(`${edge.to}->${edge.from}`);
    const geo = edgeGeometry(
      { x: from.position[0], y: from.position[1] },
      { x: to.position[0], y: to.position[1] }, curved,
    );

    edgeLayer.append(el('path', { class: 'topo-edge-base', d: geo.d }));
    if (!edge.column) continue;

    const model = edge.column.split('.')[0];
    const color = categoryColor((nodeById.get(model) || {}).category);
    const flow = el('path', {
      class: 'topo-edge-flow', d: geo.d, stroke: color, 'stroke-dasharray': DOT_PATTERN,
    });
    const arrow = el('path', {
      class: 'topo-arrow', d: 'M -7 -5 L 7 0 L -7 5 z', fill: color,
    });
    edgeLayer.append(flow, arrow);
    flowViews.push({
      spec: edge, geo, flow, arrow,
      offset: 0,       // running dash offset, advanced by the animation loop
      value: 0,        // current signed value
      norm: 0,         // |value| / largest |value| of this column so far
    });
  }

  // Nodes: chip, icon, name, any number of value badges, optional charge bar.
  const badgeViews = [];
  const barViews = [];
  const chipByNode = new Map();
  for (const node of nodes) {
    const [x, y] = node.position;
    const color = categoryColor(node.category);
    const mine = badgeSpecs.filter((badge) => badge.node === node.id);
    const barSpec = mine.find((badge) => badge.bar);

    const group = el('g', {
      class: 'topo-node', 'data-node': node.id,
      tabindex: '0', role: 'button',
      'aria-label': `${node.label}, show settings and readings`,
    });

    const chip = el('circle', { class: 'topo-chip', cx: x, cy: y, r: NODE_RADIUS, stroke: color });
    group.append(chip);
    chipByNode.set(node.id, chip);

    const icon = el('g', {
      class: 'topo-icon',
      transform: `translate(${x - 18}, ${y - 18}) scale(1.5)`,
      stroke: color, fill: 'none',
    });
    for (const part of ICONS[node.category] || ICONS.generic) {
      icon.append(el('path', part.fill
        ? { d: part.d, fill: color, stroke: 'none' }
        : { d: part.d }));
    }
    group.append(icon);

    // A badge marked `bar` is also drawn as a 0-100 fill under the chip.
    if (barSpec) {
      const barX = x - BAR_WIDTH / 2;
      const barY = y + NODE_RADIUS + 7;
      group.append(el('rect', {
        class: 'topo-charge-track', x: barX, y: barY, width: BAR_WIDTH, height: 7, rx: 3.5,
      }));
      const fill = el('rect', {
        class: 'topo-charge-fill', x: barX, y: barY, width: 0, height: 7, rx: 3.5, fill: color,
      });
      group.append(fill);
      barViews.push({ spec: barSpec, fill });
    }

    const labelY = y + NODE_RADIUS + (barSpec ? 30 : 22);
    const label = el('text', { class: 'topo-label', x, y: labelY });
    label.textContent = node.label;
    group.append(label);

    mine.forEach((spec, row) => {
      const text = el('text', { class: 'topo-badge', x, y: labelY + 17 + row * 16, fill: color });
      text.textContent = '—';
      group.append(text);
      badgeViews.push({ spec, text });
    });

    group.addEventListener('click', () => select(node.id));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select(node.id);
      }
    });
    nodeLayer.append(group);
  }

  // --- the scrubber -------------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'topo-scrub hidden';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'topo-play';
  playBtn.setAttribute('aria-label', 'Play the day');
  playBtn.textContent = '▶';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'topo-slider';
  slider.min = '0';
  slider.max = '0';
  slider.value = '0';
  slider.step = '1';
  slider.setAttribute('aria-label', 'Moment of the day');

  const clock = document.createElement('span');
  clock.className = 'topo-clock';
  clock.textContent = '—';

  bar.append(playBtn, slider, clock);
  card.append(bar);

  // --- the asset popover --------------------------------------------------
  // Anchored beside the asset it describes rather than stacked underneath: as
  // a network grows, a panel below the diagram drifts ever further from
  // whatever was tapped. Plain HTML over the SVG, so its text keeps one size
  // however the diagram is scaled.
  const pop = document.createElement('div');
  pop.className = 'topo-pop hidden';
  pop.setAttribute('role', 'dialog');

  const popArrow = document.createElement('span');
  popArrow.className = 'topo-pop-arrow';
  const popBody = document.createElement('div');
  popBody.className = 'topo-pop-body';
  pop.append(popArrow, popBody);
  card.append(pop);

  const hint = document.createElement('p');
  hint.className = 'topo-hint';
  hint.textContent =
    'Arrows and dots follow each power flow — thicker and faster is more. ' +
    'Drag the slider to any moment of the day, or tap an asset to read and ' +
    'change its settings.';
  card.append(hint);

  parent.append(card);

  // --- state and rendering ------------------------------------------------
  let results = null;      // accumulated { columns, rows } for the shown run
  let colIndex = new Map();
  let maxAbs = new Map();  // column -> largest |value| seen, for normalising
  let index = 0;           // row on display
  let live = true;         // follow the newest row as the run appends
  let selected = null;     // node id whose popover is open
  let popParts = null;     // live handles into the open popover, for refreshes
  let inputsDisabled = false;
  let playTimer = null;
  let announced;           // last index handed to onCursor
  // The automatic replay after a run finishes animates the diagram alone: it
  // must not drag the charts and table away from whatever moment they were
  // showing (the finished run's last step, or wherever the user had scrubbed
  // to) just because nobody has touched the page yet.
  let silent = false;
  // Milliseconds per step, for both manual play and the automatic replay --
  // adjustable live from the Options popover via `setSpeed`.
  let playStepMs = Number(opts.playSpeedMs) || DEFAULT_PLAY_STEP_MS;

  const reducedMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function rowCount() {
    return results ? results.rows.length : 0;
  }

  function currentRow() {
    return rowCount() ? results.rows[index] : null;
  }

  function valueOf(column, row) {
    const at = colIndex.get(column);
    const value = at === undefined || !row ? undefined : row[at];
    return typeof value === 'number' ? value : null;
  }

  function badgeText(spec, row) {
    const value = valueOf(spec.col, row);
    return applyFormat(spec.fmt, value === null || !spec.abs ? value : Math.abs(value));
  }

  /** Open, switch or close the asset popover. */
  function select(nodeId) {
    selected = selected === nodeId ? null : nodeId;
    for (const [id, chip] of chipByNode) chip.classList.toggle('is-selected', id === selected);
    if (selected) buildPop(selected);
    else closePop();
  }

  function closePop() {
    pop.classList.add('hidden');
    popParts = null;
  }

  /* SVG user units -> pixels inside the card, honouring the letterboxing that
   * preserveAspectRatio="xMidYMid meet" applies once max-height clamps the
   * diagram. Returns null when nothing has been laid out yet (jsdom, or a card
   * that is still hidden), which callers treat as "park it in the corner". */
  function svgToCard(x, y) {
    if (typeof svg.getBoundingClientRect !== 'function') return null;
    const sr = svg.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    if (!sr.width || !sr.height) return null;
    const scale = Math.min(sr.width / width, sr.height / height);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    return {
      x: sr.left + (sr.width - width * scale) / 2 + (x - minX) * scale - cr.left,
      y: sr.top + (sr.height - height * scale) / 2 + (y - minY) * scale - cr.top,
      scale,
    };
  }

  /** Place the popover beside its node, flipped to whichever side has room. */
  function positionPop(nodeId) {
    const node = nodeById.get(nodeId);
    if (!node) return;
    const anchor = svgToCard(node.position[0], node.position[1]);
    const cw = card.clientWidth;
    const ch = card.clientHeight;
    const pw = pop.offsetWidth || 260;
    const ph = pop.offsetHeight || 200;

    if (!anchor || !cw || !ch) {
      pop.style.left = '12px';
      pop.style.top = '12px';
      pop.dataset.side = 'none';
      popArrow.style.top = '';
      popArrow.style.left = '';
      return;
    }

    const clear = NODE_RADIUS * anchor.scale + 14;
    let side = 'right';
    let left = anchor.x + clear;
    if (left + pw > cw - 8) { side = 'left'; left = anchor.x - clear - pw; }
    if (left < 8) {
      side = 'below';
      left = Math.min(Math.max(8, anchor.x - pw / 2), Math.max(8, cw - pw - 8));
    }
    let top = side === 'below' ? anchor.y + clear : anchor.y - ph / 2;
    top = Math.max(8, Math.min(top, Math.max(8, ch - ph - 8)));

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.dataset.side = side;
    // Keep the little pointer aimed at the chip even after clamping.
    if (side === 'below') {
      popArrow.style.left = `${Math.round(Math.max(14, Math.min(anchor.x - left, pw - 14)))}px`;
      popArrow.style.top = '';
    } else {
      popArrow.style.top = `${Math.round(Math.max(14, Math.min(anchor.y - top, ph - 14)))}px`;
      popArrow.style.left = '';
    }
  }

  /** Build the popover for one node. Rebuilt only on selection, never per
   *  frame -- a rebuild mid-drag would drop the slider the user is holding. */
  function buildPop(nodeId) {
    const info = opts.detailsFor ? opts.detailsFor(nodeId, currentRow()) : null;
    if (!info) {
      selected = null;
      for (const chip of chipByNode.values()) chip.classList.remove('is-selected');
      closePop();
      return;
    }

    popBody.replaceChildren();
    const parts = { nodeId, readings: [], editors: new Map(), heading: null, note: null };

    const head = document.createElement('div');
    head.className = 'topo-pop-head';
    const title = document.createElement('strong');
    title.textContent = info.title;
    head.append(title);
    if (info.subtitle) {
      const type = document.createElement('span');
      type.className = 'topo-pop-type';
      type.textContent = info.subtitle;
      head.append(type);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'topo-pop-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => select(nodeId));
    head.append(close);
    popBody.append(head);
    pop.setAttribute('aria-label', `${info.title}: settings and readings`);

    // Settings: editable here, which is the only place they can be changed.
    const settingsBlock = document.createElement('div');
    settingsBlock.className = 'topo-pop-block';
    const settingsLabel = document.createElement('h4');
    settingsLabel.textContent = 'Settings';
    settingsBlock.append(settingsLabel);

    const editable = info.controls || [];
    if (!editable.length) {
      const none = document.createElement('p');
      none.className = 'topo-pop-empty';
      none.textContent = 'No settings of its own.';
      settingsBlock.append(none);
    } else {
      for (const entry of editable) {
        const editor = buildCompactControl(entry.control, entry.value,
          (id, value) => {
            if (opts.onEdit) opts.onEdit(id, value);
          });
        editor.setDisabled(inputsDisabled);
        parts.editors.set(entry.control.id, editor);
        settingsBlock.append(editor.el);
      }
    }

    const note = document.createElement('p');
    note.className = 'topo-pop-note';
    note.textContent = info.note || '';
    note.classList.toggle('hidden', !info.note);
    settingsBlock.append(note);
    parts.note = note;
    popBody.append(settingsBlock);

    // Readings at the selected timestep.
    const readBlock = document.createElement('div');
    readBlock.className = 'topo-pop-block';
    const readLabel = document.createElement('h4');
    const row = currentRow();
    readLabel.textContent = row ? `At ${clockOf(row[0])}` : 'Readings';
    parts.heading = readLabel;
    readBlock.append(readLabel);

    const readings = info.readings || [];
    if (!readings.length) {
      const none = document.createElement('p');
      none.className = 'topo-pop-empty';
      none.textContent = 'Run the simulation to see values.';
      readBlock.append(none);
    } else {
      const list = document.createElement('dl');
      for (const entry of readings) {
        const term = document.createElement('dt');
        term.textContent = entry.label;
        const value = document.createElement('dd');
        value.textContent = entry.value;
        list.append(term, value);
        parts.readings.push(value);
      }
      readBlock.append(list);
    }
    popBody.append(readBlock);

    popParts = parts;
    pop.classList.remove('hidden');
    positionPop(nodeId);
  }

  /** Refresh the numbers in an open popover, leaving its inputs untouched. */
  function refreshPop() {
    if (!popParts || !selected) return;
    const info = opts.detailsFor ? opts.detailsFor(selected, currentRow()) : null;
    if (!info) { closePop(); return; }

    const readings = info.readings || [];
    if (readings.length !== popParts.readings.length) { buildPop(selected); return; }
    readings.forEach((entry, i) => { popParts.readings[i].textContent = entry.value; });

    const row = currentRow();
    if (popParts.heading) popParts.heading.textContent = row ? `At ${clockOf(row[0])}` : 'Readings';
    if (popParts.note) {
      popParts.note.textContent = info.note || '';
      popParts.note.classList.toggle('hidden', !info.note);
    }
  }

  /** Redraw badges, flows and the scrubber for the current row. */
  function renderFrame() {
    const rows = rowCount();
    bar.classList.toggle('hidden', rows === 0);
    if (rows === 0) {
      for (const { text } of badgeViews) text.textContent = '—';
      for (const view of flowViews) {
        view.norm = 0;
        view.flow.setAttribute('stroke-opacity', '0');
        view.arrow.setAttribute('fill-opacity', '0');
      }
      for (const { fill } of barViews) fill.setAttribute('width', '0');
      clock.textContent = '—';
      refreshPop();
      if (announced !== null && opts.onCursor) opts.onCursor(null);
      announced = null;
      return;
    }

    index = Math.max(0, Math.min(index, rows - 1));
    const row = results.rows[index];

    slider.max = String(rows - 1);
    slider.value = String(index);
    clock.textContent = clockOf(row[0]);

    for (const { spec, text } of badgeViews) text.textContent = badgeText(spec, row);

    for (const { spec, fill } of barViews) {
      const value = valueOf(spec.col, row);
      const fraction = value === null ? 0 : Math.max(0, Math.min(1, value / 100));
      fill.setAttribute('width', String(BAR_WIDTH * fraction));
    }

    for (const view of flowViews) {
      const raw = valueOf(view.spec.column, row);
      const value = raw === null ? 0 : raw * (view.spec.sign || 1);
      const scale = maxAbs.get(view.spec.column) || 0;
      view.value = value;
      view.norm = scale > 0 ? Math.abs(value) / scale : 0;

      const on = view.norm >= FLOW_FLOOR;
      view.flow.setAttribute('stroke-opacity', on ? '0.9' : '0');
      view.flow.setAttribute('stroke-width',
        String(DOT_MIN_WIDTH + (DOT_MAX_WIDTH - DOT_MIN_WIDTH) * view.norm));
      view.arrow.setAttribute('fill-opacity', on ? '0.95' : '0');
      const flip = value < 0 ? 180 : 0;
      view.arrow.setAttribute('transform',
        `translate(${view.geo.mid.x}, ${view.geo.mid.y}) rotate(${view.geo.angle + flip})`);
    }

    refreshPop();
    if (!silent) {
      if (announced !== index && opts.onCursor) opts.onCursor(index);
      announced = index;
    }
  }

  // --- dash animation ------------------------------------------------------
  // One requestAnimationFrame loop advances every active flow's dash offset;
  // speed scales with the flow. Skipped entirely under prefers-reduced-motion
  // (width and the arrow still show magnitude and direction) and idle while no
  // flow is active, which keeps a Raspberry Pi comfortable.
  let rafId = null;
  let lastTick = 0;

  function animate(now) {
    rafId = null;
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    let any = false;
    for (const view of flowViews) {
      if (view.norm < FLOW_FLOOR) continue;
      any = true;
      const speed = 8 + 34 * view.norm;                   // svg units per second
      view.offset -= Math.sign(view.value) * speed * dt;
      view.flow.setAttribute('stroke-dashoffset', String(view.offset));
    }
    if (any) rafId = requestAnimationFrame(animate);
  }

  function ensureAnimating() {
    if (reducedMotion || rafId !== null) return;
    if (flowViews.some((view) => view.norm >= FLOW_FLOOR)) {
      lastTick = performance.now();
      rafId = requestAnimationFrame(animate);
    }
  }

  // --- playback ------------------------------------------------------------
  function stopPlaying() {
    clearInterval(playTimer);
    playTimer = null;
    silent = false;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play the day');
  }

  function advanceFrame() {
    index = index + 1 >= rowCount() ? 0 : index + 1;
    renderFrame();
    ensureAnimating();
  }

  /** Play from the current position, wrapping back to the start at the end
   *  instead of stopping -- so a run can be left to replay unattended.
   *  `quiet` is set only for the automatic post-run replay: it animates the
   *  diagram without moving the shared cursor the charts and table follow. */
  function startPlaying(quiet = false) {
    if (rowCount() === 0) return;
    if (index >= rowCount() - 1) index = 0;   // replay from the start
    live = false;
    silent = quiet;
    playBtn.textContent = '⏸';
    playBtn.setAttribute('aria-label', 'Pause');
    clearInterval(playTimer);
    playTimer = setInterval(advanceFrame, playStepMs);
  }

  playBtn.addEventListener('click', () => (playTimer ? stopPlaying() : startPlaying()));

  slider.addEventListener('input', () => {
    stopPlaying();
    index = Number(slider.value);
    // Dragged to the newest row: follow the run again as it appends.
    live = index >= rowCount() - 1;
    renderFrame();
    ensureAnimating();
  });

  // A tap anywhere that is not the popover or another asset closes it.
  function onDocPointer(event) {
    if (!selected || pop.contains(event.target)) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('.topo-node')) return;
    select(selected);
  }
  document.addEventListener('pointerdown', onDocPointer);

  function onViewportChange() {
    if (selected) positionPop(selected);
  }
  window.addEventListener('resize', onViewportChange);

  renderFrame();   // start idle: flows off, badges dashed, scrubber hidden

  return {
    el: card,

    /**
     * Feed the accumulated results ({ columns, rows }, or null to reset).
     * Call it on every poll; in live mode the view follows the newest row.
     */
    update(nextResults) {
      results = nextResults || null;
      stopPlaying();
      if (!results) {
        colIndex = new Map();
        maxAbs = new Map();
        index = 0;
        live = true;
        renderFrame();
        return;
      }
      // Names, never positions: the collector's column order is not stable.
      colIndex = new Map(results.columns.map((name, i) => [name, i + 1]));
      maxAbs = new Map();
      for (const view of flowViews) {
        const at = colIndex.get(view.spec.column);
        if (at === undefined) continue;
        let peak = 0;
        for (const row of results.rows) {
          const value = row[at];
          if (typeof value === 'number') peak = Math.max(peak, Math.abs(value));
        }
        maxAbs.set(view.spec.column, peak);
      }
      if (live) index = results.rows.length - 1;
      renderFrame();
      ensureAnimating();
    },

    /** Grey out the popover's inputs while a run is in flight. */
    setDisabled(disabled) {
      inputsDisabled = Boolean(disabled);
      if (!popParts) return;
      for (const editor of popParts.editors.values()) editor.setDisabled(inputsDisabled);
    },

    /** Push changed settings back into an open popover (after a reset). */
    syncControls(values) {
      if (!popParts) return;
      for (const [id, editor] of popParts.editors) {
        if (values && Object.prototype.hasOwnProperty.call(values, id)) editor.sync(values[id]);
      }
    },

    /** Re-read the details for the open asset without rebuilding its inputs. */
    refreshDetails() {
      refreshPop();
    },

    /** Move the selected timestep from outside (the results table). */
    setCursor(next) {
      if (rowCount() === 0) return;
      stopPlaying();
      index = Math.max(0, Math.min(Number(next), rowCount() - 1));
      live = index >= rowCount() - 1;
      renderFrame();
      ensureAnimating();
    },

    /** A run just finished: rewind to the start of the day and replay it on
     *  a loop, at the configured speed, rather than leaving the diagram
     *  parked on the last moment simulated. Quiet, so the charts and table
     *  are undisturbed -- any manual scrub or play/pause click takes the
     *  shared cursor over from there as usual. */
    finish() {
      if (rowCount() === 0) return;
      index = 0;
      live = false;
      silent = true;
      renderFrame();
      startPlaying(true);
    },

    /** Change how fast playback runs, in milliseconds per step -- from the
     *  Options popover. Takes effect immediately, including mid-replay,
     *  without losing the current position or pausing. */
    setSpeed(ms) {
      const next = Number(ms);
      if (!Number.isFinite(next) || next <= 0) return;
      playStepMs = next;
      if (playTimer) {
        clearInterval(playTimer);
        playTimer = setInterval(advanceFrame, playStepMs);
      }
    },

    destroy() {
      stopPlaying();
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      document.removeEventListener('pointerdown', onDocPointer);
      window.removeEventListener('resize', onViewportChange);
      card.remove();
    },
  };
}
