/* Charts and the hourly summary table.
 *
 * Chart definitions come from the pack (`charts:` on each case), so this file
 * knows about *kinds* of chart, never about particular quantities.
 *
 * One rule matters more than any other here: **result columns are looked up by
 * name, every time.** The Illuminator's collector builds each CSV row from a
 * Mosaik dict, so the column order varies between runs of the same scenario --
 * two captures of one case produced identical numbers in a different order.
 * Indexing positionally would silently plot the wrong series.
 */

const PALETTE = ['#0b6fb8', '#b3261e', '#1f7a4d', '#b06a00', '#6a3fb5', '#0f7c8c', '#a3357f'];

/** Parse "YYYY-MM-DD HH:MM:SS" as local time, which is how the data is stamped. */
function toEpochSeconds(timestamp) {
  return new Date(timestamp.replace(' ', 'T')).getTime() / 1000;
}

/** "2012-06-01 14:30:00" -> "14:30". */
export function clockOf(timestamp) {
  const match = /(\d{2}:\d{2})/.exec(timestamp || '');
  return match ? match[1] : '—';
}

/** The same, for an x value off the chart's own axis. */
function clockAt(epochSeconds) {
  const when = new Date(epochSeconds * 1000);
  return `${String(when.getHours()).padStart(2, '0')}:` +
         `${String(when.getMinutes()).padStart(2, '0')}`;
}

function colourFor(series, index) {
  return series.color || PALETTE[index % PALETTE.length];
}

/* ------------------------------------------------------------ formatting */

function formatNumber(value, places = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(places);
}

/** A change, with its sign spelled out: "+1.20", "-0.35". */
function formatSigned(value, places = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const text = Math.abs(value).toFixed(places);
  return `${value < 0 ? '-' : '+'}${text}`;
}

/* ------------------------------------------------------- aligning runs */

/* Comparing two runs means drawing them on one x axis, and the key to align
 * them on is *elapsed time*, not the wall clock: it lines up two runs of the
 * same day exactly, and still overlays a summer day on a winter one hour for
 * hour. Samples that only one run has become null in the other, so uPlot leaves
 * a gap rather than inventing a value.
 */

/** Rows -> per-series values plus an elapsed-seconds index. */
function readSeries(results, seriesSpecs) {
  if (!results || !results.rows || !results.rows.length) return null;

  // Column name -> row index. Recomputed per update: the order is not stable.
  const index = new Map(results.columns.map((name, i) => [name, i + 1]));

  const times = results.rows.map((row) => toEpochSeconds(row[0]));
  const elapsed = times.map((t) => t - times[0]);
  const at = new Map(elapsed.map((seconds, i) => [seconds, i]));

  const columns = seriesSpecs.map((series) => {
    const column = index.get(series.col);
    const sign = series.sign === undefined ? 1 : Number(series.sign);
    return column === undefined
      ? elapsed.map(() => null)
      : results.rows.map((row) => (typeof row[column] === 'number' ? row[column] * sign : null));
  });

  return { t0: times[0], elapsed, at, columns, stamps: results.rows.map((row) => row[0]) };
}

/** The union of both runs' sample times, ascending. */
function mergeElapsed(...runs) {
  const all = new Set();
  for (const run of runs) {
    if (run) for (const seconds of run.elapsed) all.add(seconds);
  }
  return [...all].sort((a, b) => a - b);
}

/** One series placed on the shared grid; times the run does not have are null. */
function project(run, columnIndex, grid) {
  if (!run) return grid.map(() => null);
  const values = run.columns[columnIndex];
  return grid.map((seconds) => {
    const i = run.at.get(seconds);
    return i === undefined ? null : values[i];
  });
}

function valueAt(run, columnIndex, seconds) {
  if (!run) return null;
  const i = run.at.get(seconds);
  return i === undefined ? null : run.columns[columnIndex][i];
}

/* ---------------------------------------------------------------- charts */

/**
 * Create a chart from a pack chart spec.
 *
 * @param {HTMLElement} parent
 * @param {Object} spec   chart definition from the pack
 * @param {Object} [opts] { limits, bands, pinned, onSelect } -- `pinned` is a
 *                        snapshot of an earlier run, drawn underneath as a
 *                        dashed ghost; `onSelect(rowIndex)` fires on a click
 * @returns {{update: Function, setPinned: Function, destroy: Function, el: HTMLElement}}
 */
export function createChart(parent, spec, opts = {}) {
  const card = document.createElement('div');
  card.className = 'chart-card';

  if (spec.title) {
    const heading = document.createElement('h3');
    heading.textContent = spec.title;
    card.append(heading);
  }

  const holder = document.createElement('div');
  holder.className = 'chart-holder';
  card.append(holder);

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  card.append(legend);

  // Hover readout. It lives inside uPlot's overlay element, so its coordinates
  // are the cursor's own; makePlot re-parents it whenever the plot is rebuilt.
  const tip = document.createElement('div');
  tip.className = 'chart-tip hidden';

  parent.append(card);

  let plot = null;
  let limits = opts.limits || null;
  let bands = opts.bands || spec.bands || null;
  let pinned = opts.pinned || null;
  let lastResults = null;
  // The timestep the whole results panel is showing, as an index into the
  // current run's rows; null means "the newest one".
  let cursorIndex = null;
  let cursorX = null;      // its x value, for the marker line
  let cursorSlot = null;   // its position in the merged data grid
  // Kept from the last redraw so pointer positions can be turned back into
  // rows of the current run: the plotted grid may also hold pinned-only times.
  let lastGrid = [];
  let lastCurrent = null;
  // uPlot fixes its series list at construction, so adding or removing the
  // ghost means building a new plot rather than setting new data.
  let plotHasPinned = false;
  const seriesSpecs = spec.series || [];

  function buildLegend(latestValues, pinnedValues, timeLabel) {
    legend.replaceChildren();
    if (timeLabel) {
      const when = document.createElement('span');
      when.className = 'legend-time';
      when.textContent = `at ${timeLabel}`;
      legend.append(when);
    }
    seriesSpecs.forEach((series, index) => {
      const item = document.createElement('span');
      item.className = 'legend-item';

      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = colourFor(series, index);

      const label = document.createElement('span');
      label.textContent = series.label || series.col;

      item.append(swatch, label);

      if (latestValues && latestValues[index] !== undefined) {
        const value = document.createElement('span');
        value.className = 'legend-value';
        value.textContent = formatNumber(latestValues[index]);
        item.append(value);
      }
      if (pinnedValues) {
        const was = document.createElement('span');
        was.className = 'legend-pinned';
        was.textContent = `was ${formatNumber(pinnedValues[index])}`;
        item.append(was);
      }
      legend.append(item);
    });
  }

  /** Horizontal dashed limit lines (e.g. the battery's min/max state of charge). */
  function drawLimits(u) {
    if (!limits) return;
    const { ctx } = u;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = '#8494a1';
    ctx.lineWidth = 1;
    for (const value of Object.values(limits)) {
      if (value === null || value === undefined) continue;
      const y = u.valToPos(value, 'y', true);
      if (!Number.isFinite(y)) continue;
      ctx.beginPath();
      ctx.moveTo(u.bbox.left, y);
      ctx.lineTo(u.bbox.left + u.bbox.width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Green / amber / red capacity bands, used by the grid-congestion charts. */
  function drawBands(u) {
    if (!bands || !Number.isFinite(bands.cap)) return;
    const { ctx } = u;
    const { cap, tol = 0.67, crit = 0.9 } = bands;
    const regions = [
      [-cap * tol, cap * tol, 'rgba(218, 242, 208, 0.85)'],
      [cap * tol, cap * crit, 'rgba(255, 232, 162, 0.8)'],
      [-cap * crit, -cap * tol, 'rgba(255, 232, 162, 0.8)'],
      [cap * crit, cap, 'rgba(240, 46, 49, 0.35)'],
      [-cap, -cap * crit, 'rgba(240, 46, 49, 0.35)'],
    ];
    ctx.save();
    ctx.beginPath();
    ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    ctx.clip();
    for (const [lo, hi, fill] of regions) {
      const yHi = u.valToPos(hi, 'y', true);
      const yLo = u.valToPos(lo, 'y', true);
      if (!Number.isFinite(yHi) || !Number.isFinite(yLo)) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(u.bbox.left, yHi, u.bbox.width, yLo - yHi);
    }
    ctx.restore();
  }

  /** Which row of the current run a point on the plotted grid belongs to. */
  function rowAtGrid(gridIndex) {
    if (!lastCurrent || gridIndex === null || gridIndex === undefined) return null;
    const seconds = lastGrid[gridIndex];
    if (seconds === undefined) return null;
    const row = lastCurrent.at.get(seconds);
    return row === undefined ? null : row;
  }

  /** Fill and place the hover readout for the point under the pointer. */
  function showTip(u) {
    const at = u.cursor.idx;
    if (at === null || at === undefined || !u.data[0] || u.data[0][at] === undefined) {
      tip.classList.add('hidden');
      return;
    }

    tip.replaceChildren();
    const when = document.createElement('div');
    when.className = 'chart-tip-time';
    when.textContent = clockAt(u.data[0][at]);
    tip.append(when);

    // Ghost series come first in the data; read the live run, then its ghost.
    const first = 1 + (plotHasPinned ? seriesSpecs.length : 0);
    seriesSpecs.forEach((series, i) => {
      const row = document.createElement('div');
      row.className = 'chart-tip-row';

      const swatch = document.createElement('span');
      swatch.className = 'chart-tip-swatch';
      swatch.style.background = colourFor(series, i);

      const label = document.createElement('span');
      label.textContent = series.label || series.col;

      const value = document.createElement('b');
      const values = u.data[first + i];
      value.textContent = formatNumber(values ? values[at] : null);

      row.append(swatch, label, value);

      if (plotHasPinned) {
        const ghost = u.data[1 + i];
        const was = document.createElement('span');
        was.className = 'chart-tip-was';
        was.textContent = `was ${formatNumber(ghost ? ghost[at] : null)}`;
        row.append(was);
      }
      tip.append(row);
    });

    // Flip to the other side of the pointer near the right-hand edge.
    const width = u.over.clientWidth || 1;
    const flip = u.cursor.left > width * 0.6;
    tip.style.left = `${u.cursor.left}px`;
    tip.style.top = `${u.cursor.top}px`;
    tip.style.transform = `translate(${flip ? 'calc(-100% - 16px)' : '16px'}, -50%)`;
    tip.classList.remove('hidden');
  }

  /** The selected timestep: a dashed rule, and a dot on each live series. */
  function drawCursor(u) {
    if (cursorX === null || cursorSlot === null) return;
    const { ctx } = u;
    const x = u.valToPos(cursorX, 'x', true);
    if (!Number.isFinite(x)) return;

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#55636f';
    ctx.lineWidth = 1.5;
    ctx.moveTo(x, u.bbox.top);
    ctx.lineTo(x, u.bbox.top + u.bbox.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ghost series come first in the data, so skip them to mark the live run.
    const first = 1 + (plotHasPinned ? seriesSpecs.length : 0);
    seriesSpecs.forEach((series, i) => {
      const values = u.data[first + i];
      const value = values ? values[cursorSlot] : null;
      if (value === null || value === undefined) return;
      const y = u.valToPos(value, 'y', true);
      if (!Number.isFinite(y)) return;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = colourFor(series, i);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    });
    ctx.restore();
  }

  function makePlot(data) {
    const series = [{}];
    // Ghosts first, so the current run draws on top of them.
    if (pinned) {
      seriesSpecs.forEach((item, index) => {
        series.push({
          label: `${item.label || item.col} (pinned)`,
          stroke: colourFor(item, index),
          width: 1.5,
          dash: [5, 4],
          alpha: 0.5,
          points: { show: false },
        });
      });
    }
    seriesSpecs.forEach((item, index) => {
      series.push({
        label: item.label || item.col,
        stroke: colourFor(item, index),
        width: 2,
        points: { show: false },
      });
    });

    const scaleY = {};
    if (spec.y_min !== undefined && spec.y_max !== undefined) {
      scaleY.range = () => [spec.y_min, spec.y_max];
    } else if (bands && Number.isFinite(bands.cap)) {
      scaleY.range = () => [-bands.cap, bands.cap];
    }

    const options = {
      width: holder.clientWidth || 640,
      height: spec.height || 260,
      legend: { show: false },          // we render our own, touch-friendly
      cursor: { drag: { x: false, y: false } },
      scales: { x: { time: true }, y: scaleY },
      axes: [
        { grid: { stroke: '#eef2f5' }, ticks: { stroke: '#dbe2e8' } },
        {
          label: spec.y_label,
          labelSize: spec.y_label ? 28 : 0,
          grid: { stroke: '#eef2f5' },
          ticks: { stroke: '#dbe2e8' },
          size: 56,
        },
      ],
      series,
      hooks: {
        drawClear: [drawBands],
        draw: [drawLimits, drawCursor],
        setCursor: [showTip],
      },
    };
    plot = new uPlot(options, data, holder);
    if (plot.over) plot.over.append(tip);
  }

  /* Clicking a chart selects that timestep everywhere, exactly as the scrubber
   * and the results table do.
   *
   * Bound on the holder in the *capture* phase, one level above uPlot's own
   * wrapper: uPlot's default `cursor.drag.click` calls stopImmediatePropagation
   * from a capture listener of its own, so a listener on the plot area itself
   * would never run. Capturing at the ancestor gets there first.
   */
  holder.addEventListener('click', () => {
    if (!opts.onSelect || !plot) return;
    const at = Number.isInteger(plot.cursor.idx)
      ? plot.cursor.idx
      : (plot.cursor.left >= 0 ? plot.posToIdx(plot.cursor.left) : null);
    const row = rowAtGrid(at);
    if (row !== null) opts.onSelect(row);
  }, true);

  // mouseleave does not bubble, but it fires on the holder in its own right,
  // and the holder outlives any one plot.
  holder.addEventListener('mouseleave', () => tip.classList.add('hidden'));

  const resize = new ResizeObserver(() => {
    if (plot && holder.clientWidth) {
      plot.setSize({ width: holder.clientWidth, height: spec.height || 260 });
    }
  });
  resize.observe(holder);

  function redraw() {
    const current = readSeries(lastResults, seriesSpecs);
    const ghost = pinned ? readSeries(pinned.results, seriesSpecs) : null;
    if (!current && !ghost) return;

    const grid = mergeElapsed(ghost, current);
    const origin = (current || ghost).t0;
    lastGrid = grid;
    lastCurrent = current;
    const data = [grid.map((seconds) => origin + seconds)];
    if (pinned) seriesSpecs.forEach((_, i) => data.push(project(ghost, i, grid)));
    seriesSpecs.forEach((_, i) => data.push(project(current, i, grid)));

    if (plot && plotHasPinned !== Boolean(pinned)) {
      plot.destroy();
      plot = null;
    }
    if (!plot) {
      plotHasPinned = Boolean(pinned);
      makePlot(data);
    } else {
      plot.setData(data);
    }

    // Every number on the card belongs to one instant: the selected timestep,
    // or the newest sample while a run is streaming in. Both runs are read at
    // that same instant, so a comparison stays like for like.
    const run = current || ghost;
    const at = current && cursorIndex !== null
      ? Math.max(0, Math.min(cursorIndex, current.elapsed.length - 1))
      : run.elapsed.length - 1;
    const now = run.elapsed[at];

    cursorX = current && cursorIndex !== null ? origin + now : null;
    cursorSlot = cursorX === null ? null : grid.indexOf(now);

    buildLegend(
      seriesSpecs.map((_, i) => valueAt(current, i, now)),
      pinned ? seriesSpecs.map((_, i) => valueAt(ghost, i, now)) : null,
      clockOf(run.stamps[at]),
    );
  }

  return {
    el: card,

    /**
     * @param {Object} results  { columns, rows } from /api/runs/{id}/results,
     *                          or null to draw the pinned run on its own
     * @param {Object} [extra]  { limits, bands } to refresh the guide lines
     */
    update(results, extra = {}) {
      if (extra.limits) limits = extra.limits;
      if (extra.bands) bands = extra.bands;
      lastResults = results || null;
      redraw();
    },

    /** Show (or clear, with null) an earlier run as a dashed reference. */
    setPinned(snapshot) {
      pinned = snapshot || null;
      redraw();
    },

    /** Mark one timestep (a row index of the current run), or null for latest. */
    setCursor(next) {
      cursorIndex = next === null || next === undefined ? null : Number(next);
      redraw();
    },

    destroy() {
      resize.disconnect();
      if (plot) plot.destroy();
      card.remove();
    },
  };
}

/**
 * Stacked-area chart for the dataset views: the demand curve with the
 * generation mix that meets it layered underneath.
 */
export function createStackChart(parent, spec = {}) {
  const card = document.createElement('div');
  card.className = 'chart-card';

  const heading = document.createElement('h3');
  heading.textContent = spec.title || 'Demand';
  card.append(heading);

  const holder = document.createElement('div');
  holder.className = 'chart-holder';
  card.append(holder);

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  card.append(legend);

  parent.append(card);
  let plot = null;

  const resize = new ResizeObserver(() => {
    if (plot && holder.clientWidth) plot.setSize({ width: holder.clientWidth, height: 300 });
  });
  resize.observe(holder);

  return {
    el: card,

    update(profile) {
      const xs = profile.timestamps.map(toEpochSeconds);
      const layers = profile.layers || [];

      // Cumulative sums, drawn largest first so each layer's fill sits on top
      // of the one below it -- the usual way to fake a stackplot with lines.
      const cumulative = [];
      let running = new Array(xs.length).fill(0);
      for (const layer of layers) {
        running = running.map((value, i) => value + (layer.values[i] || 0));
        cumulative.push({ name: layer.name, color: layer.color, values: running.slice() });
      }

      const series = [{}];
      const data = [xs];

      for (let i = cumulative.length - 1; i >= 0; i -= 1) {
        const layer = cumulative[i];
        series.push({
          label: layer.name,
          stroke: layer.color || PALETTE[i % PALETTE.length],
          fill: layer.color || PALETTE[i % PALETTE.length],
          width: 0.5,
          points: { show: false },
        });
        data.push(layer.values);
      }

      series.push({
        label: profile.label || 'Total',
        stroke: '#16202a',
        width: 2.5,
        points: { show: false },
      });
      data.push(profile.total);

      if (plot) plot.destroy();
      plot = new uPlot({
        width: holder.clientWidth || 640,
        height: 300,
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: true } },
        axes: [
          { grid: { stroke: '#eef2f5' }, ticks: { stroke: '#dbe2e8' } },
          { label: `${profile.label || 'Load'} (${profile.unit || 'kW'})`, labelSize: 28,
            grid: { stroke: '#eef2f5' }, ticks: { stroke: '#dbe2e8' }, size: 56 },
        ],
        series,
      }, data, holder);

      legend.replaceChildren();
      const entries = [...layers.map((l) => ({ name: l.name, color: l.color })),
                       { name: profile.label || 'Total', color: '#16202a' }];
      for (const entry of entries) {
        const item = document.createElement('span');
        item.className = 'legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'legend-swatch';
        swatch.style.background = entry.color;
        const label = document.createElement('span');
        label.textContent = entry.name;
        item.append(swatch, label);
        legend.append(item);
      }
    },

    destroy() {
      resize.disconnect();
      if (plot) plot.destroy();
      card.remove();
    },
  };
}

/* ----------------------------------------------------------------- tables */

/** Column index of a result column, by name. Never by position. */
function columnAt(results, key) {
  const at = results.columns.indexOf(key);
  return at === -1 ? null : at + 1;
}

/**
 * Reduce one column of a run to a single number for the whole day.
 *
 * Flows are totalled; a column the pack lists under `sample_columns` is a level
 * (a state of charge, say) and is averaged instead -- adding up 96 readings of
 * a level would mean nothing.
 */
function aggregate(results, key, agg) {
  if (!results || !results.rows.length) return null;
  const at = columnAt(results, key);
  if (at === null) return null;
  let total = 0;
  let count = 0;
  for (const row of results.rows) {
    const value = row[at];
    if (typeof value === 'number' && !Number.isNaN(value)) { total += value; count += 1; }
  }
  if (!count) return null;
  return agg === 'sample' ? total / count : total;
}

/** Values this close are the same number once rounded to 2 places. */
const DELTA_EPSILON = 0.005;

function headerCell(title, subtitle) {
  const th = document.createElement('th');
  th.append(document.createTextNode(title));
  if (subtitle) {
    const small = document.createElement('span');
    small.className = 'col-note';
    small.textContent = subtitle;
    th.append(small);
  }
  return th;
}

/**
 * Day totals for this run, beside the pinned one if there is one.
 *
 * Two curves are hard to compare by eye; one number each is not. This is the
 * table that answers "so what did the bigger battery actually do?".
 *
 * @param {HTMLElement} container
 * @param {Object} opts { columns, current, pinned, currentLabel, pinnedLabel }
 *        where `columns` is [{key, label, agg}] from the pack's summary block
 *        and `current`/`pinned` are raw { columns, rows } result sets.
 */
export function renderComparison(container, opts = {}) {
  const { columns, current, pinned, currentLabel, pinnedLabel } = opts;
  container.replaceChildren();
  if (!columns || !columns.length || !current || !current.rows.length) return;

  const comparing = Boolean(pinned && pinned.rows && pinned.rows.length);

  const heading = document.createElement('h3');
  heading.textContent = comparing ? 'Day totals, compared' : 'Day totals';

  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  const table = document.createElement('table');
  table.className = 'compare-table';

  const headRow = document.createElement('tr');
  headRow.append(headerCell('Quantity', ''));
  if (comparing) headRow.append(headerCell('Pinned', pinnedLabel));
  headRow.append(headerCell('This run', comparing ? currentLabel : ''));
  if (comparing) headRow.append(headerCell('Change', ''));

  const thead = document.createElement('thead');
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const column of columns) {
    const agg = column.agg || 'sum';
    const value = aggregate(current, column.key, agg);

    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.append(document.createTextNode(column.label));
    const tag = document.createElement('span');
    tag.className = 'agg-tag';
    tag.textContent = agg === 'sample' ? 'average' : 'total';
    name.append(tag);
    tr.append(name);

    let before = null;
    if (comparing) {
      before = aggregate(pinned, column.key, agg);
      const cell = document.createElement('td');
      cell.textContent = formatNumber(before);
      tr.append(cell);
    }

    const now = document.createElement('td');
    now.textContent = formatNumber(value);
    tr.append(now);

    if (comparing) {
      const cell = document.createElement('td');
      cell.className = 'delta';
      if (before === null || value === null) {
        cell.textContent = '—';
      } else if (Math.abs(value - before) < DELTA_EPSILON) {
        cell.textContent = 'no change';
        cell.classList.add('delta-none');
      } else {
        cell.textContent = formatSigned(value - before);
        if (Math.abs(before) >= DELTA_EPSILON) {
          const percent = document.createElement('span');
          percent.className = 'delta-pct';
          percent.textContent = `${formatSigned((value - before) / Math.abs(before) * 100, 1)}%`;
          cell.append(percent);
        }
      }
      tr.append(cell);
    }

    tbody.append(tr);
  }

  table.append(thead, tbody);
  scroll.append(table);
  container.append(heading, scroll);
}

/**
 * The results table: one row per simulation step, not an hourly digest.
 *
 * Rows are appended as the run produces them rather than rebuilt, so the table
 * fills in live and the reader's scroll position survives. The selected
 * timestep is highlighted and scrolled to, and clicking a row selects it --
 * the table and the diagram drive each other.
 *
 * @param {HTMLElement} container
 * @param {Array} columns  [{key, label}] from the pack's summary block
 * @param {Function} [onSelect]  called with a row index when a row is clicked
 * @returns {{update: Function, setCursor: Function, destroy: Function}}
 */
export function createStepTable(container, columns, onSelect) {
  container.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = 'Every timestep';

  const scroll = document.createElement('div');
  scroll.className = 'table-scroll step-scroll';

  const table = document.createElement('table');
  table.className = 'step-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const timeHeader = document.createElement('th');
  timeHeader.textContent = 'Time';
  headRow.append(timeHeader);
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column.label;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  scroll.append(table);
  container.append(heading, scroll);

  let rendered = 0;        // rows already in the DOM
  let current = null;      // the highlighted <tr>

  function addRow(row, index, results) {
    const tr = document.createElement('tr');
    tr.dataset.index = String(index);
    const time = document.createElement('td');
    time.textContent = clockOf(row[0]);
    tr.append(time);
    for (const column of columns) {
      const at = columnAt(results, column.key);
      const value = at === null ? null : row[at];
      const cell = document.createElement('td');
      cell.textContent = typeof value === 'number' ? formatNumber(value) : '—';
      tr.append(cell);
    }
    if (onSelect) tr.addEventListener('click', () => onSelect(index));
    tbody.append(tr);
  }

  return {
    /** Append whatever rows are new; pass null to empty the table. */
    update(results) {
      if (!results || !results.rows.length) {
        tbody.replaceChildren();
        rendered = 0;
        current = null;
        return;
      }
      // A shorter run than last time is a new run: start the table again.
      if (results.rows.length < rendered) {
        tbody.replaceChildren();
        rendered = 0;
        current = null;
      }
      for (let i = rendered; i < results.rows.length; i += 1) {
        addRow(results.rows[i], i, results);
      }
      rendered = results.rows.length;
    },

    setCursor(index) {
      if (current) current.classList.remove('is-current');
      current = null;
      if (index === null || index === undefined) return;
      const row = tbody.children[Number(index)];
      if (!row) return;
      row.classList.add('is-current');
      current = row;
      // Keep it in view without scrolling the page: this container only.
      const top = row.offsetTop - (scroll.clientHeight - row.offsetHeight) / 2;
      if (Number.isFinite(top)) scroll.scrollTop = Math.max(0, top);
    },

    destroy() {
      container.replaceChildren();
    },
  };
}
