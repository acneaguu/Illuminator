/* Dashboard orchestration: case selection, settings, run lifecycle, results.
 *
 * The shape of the UI is driven entirely by the pack the backend serves, so
 * adding a tutorial is a pack file, not a code change. See ../API.md.
 */

import { api, ApiError, MOCK } from './api.js';
import { formatValue, renderControls, renderDayPicker, syncDayPicker } from './controls.js';
import { createChart, createStackChart, createStepTable, renderComparison } from './charts.js';
import { applyFormat, createTopology } from './topology.js';

/** How often to ask for status and new rows while a simulation is running. */
const POLL_MS = 400;

/** Debounce for dataset views, which refetch as a slider moves. */
const BASELINE_DEBOUNCE_MS = 220;

const el = {
  packTitle: document.getElementById('pack-title'),
  packSubtitle: document.getElementById('pack-subtitle'),
  statusPill: document.getElementById('status-pill'),
  mockBadge: document.getElementById('mock-badge'),
  tabs: document.getElementById('case-tabs'),
  description: document.getElementById('case-description'),
  daySection: document.getElementById('day-section'),
  dayPresets: document.getElementById('day-presets'),
  dayInput: document.getElementById('day-input'),
  controlsHeading: document.getElementById('controls-heading'),
  controls: document.getElementById('controls'),
  notes: document.getElementById('notes'),
  runBtn: document.getElementById('run-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  resetBtn: document.getElementById('reset-btn'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progress-bar'),
  progressLabel: document.getElementById('progress-label'),
  errorPanel: document.getElementById('error-panel'),
  placeholder: document.getElementById('placeholder'),
  topologySlot: document.getElementById('topology-slot'),
  pinbar: document.getElementById('pinbar'),
  charts: document.getElementById('charts'),
  comparison: document.getElementById('comparison'),
  summary: document.getElementById('summary'),
};

const state = {
  pack: null,
  caseDef: null,
  day: null,
  settings: {},
  states: {},
  controlsHandle: null,
  charts: [],
  stackChart: null,
  topo: null,           // topology view handle, simulation cases only
  topoToken: 0,         // guards a slow fetch against a case switch
  runId: null,
  runState: 'idle',
  results: null,       // accumulated { columns, rows }
  cursor: null,        // selected timestep, as a row index; null = the newest
  stepTable: null,     // per-step results table handle
  topoPayload: null,   // the topology as served, for node types
  lastRun: null,       // { id, day, settings, states } of the run on screen
  pinned: null,        // snapshot of an earlier run, drawn against this one
  pollTimer: null,
  baselineTimer: null,
  baselineToken: 0,
};

/* ---------------------------------------------------------------- status */

const PILL = {
  idle: ['Ready', 'pill-idle'],
  queued: ['Starting…', 'pill-running'],
  running: ['Simulating…', 'pill-running'],
  done: ['Complete', 'pill-done'],
  error: ['Failed', 'pill-error'],
  cancelled: ['Stopped', 'pill-cancel'],
  loading: ['Loading…', 'pill-running'],
};

function setStatus(kind) {
  const [text, className] = PILL[kind] || PILL.idle;
  el.statusPill.textContent = text;
  el.statusPill.className = `pill ${className}`;
}

function showNotes(notes) {
  el.notes.replaceChildren();
  for (const note of notes || []) {
    const div = document.createElement('div');
    div.className = 'note';
    div.textContent = note;
    el.notes.append(div);
  }
}

function showError(title, message, details) {
  el.errorPanel.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  el.errorPanel.append(heading, paragraph);
  if (details) {
    const pre = document.createElement('pre');
    pre.textContent = details;
    el.errorPanel.append(pre);
  }
  el.errorPanel.classList.remove('hidden');
}

function clearError() {
  el.errorPanel.classList.add('hidden');
  el.errorPanel.replaceChildren();
}

/* ----------------------------------------------------------------- setup */

async function init() {
  el.mockBadge.classList.toggle('hidden', !MOCK);
  setStatus('loading');

  try {
    const payload = await api.packs();
    const pack = payload.packs[0];
    if (!pack) throw new Error('the backend returned no packs');
    state.pack = pack;

    el.packTitle.textContent = pack.title;
    el.packSubtitle.textContent = pack.subtitle || '';
    document.title = `${pack.title} — Illuminator`;

    buildTabs(pack);
    selectCase(pack.cases[0]);
    setStatus('idle');
  } catch (error) {
    setStatus('error');
    showError('Could not reach the dashboard backend', describe(error),
      MOCK ? null : 'Start it with:\n\n  uvicorn dashboard.backend.app:app --port 8000\n\n' +
             'run from the repository root, in the conda "illuminator" environment.');
  }

  el.runBtn.addEventListener('click', startRun);
  el.cancelBtn.addEventListener('click', cancelRun);
  el.resetBtn.addEventListener('click', resetToDefaults);
}

function describe(error) {
  if (error instanceof ApiError) return error.message;
  return error && error.message ? error.message : String(error);
}

function buildTabs(pack) {
  el.tabs.replaceChildren();
  for (const caseDef of pack.cases) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.textContent = caseDef.title;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.addEventListener('click', () => selectCase(caseDef));
    el.tabs.append(tab);
  }
}

function syncTabs() {
  [...el.tabs.children].forEach((tab, index) => {
    const selected = state.pack.cases[index].id === state.caseDef.id;
    tab.setAttribute('aria-selected', String(selected));
  });
}

/* ------------------------------------------------------------ case setup */

function selectCase(caseDef) {
  stopPolling();
  state.caseDef = caseDef;
  state.runId = null;
  state.runState = 'idle';
  state.results = null;
  state.cursor = null;
  state.lastRun = null;
  // A pin belongs to the case it was taken from: another case plots other
  // columns on other charts.
  state.pinned = null;
  state.day = caseDef.defaults.day;
  state.settings = { ...caseDef.defaults.settings };
  state.states = { ...caseDef.defaults.states };

  syncTabs();
  clearError();
  showNotes([]);
  destroyCharts();
  destroyTopology();
  destroyStepTable();
  if (caseDef.kind === 'simulation') loadTopology(caseDef);
  el.summary.replaceChildren();
  el.comparison.replaceChildren();
  el.pinbar.replaceChildren();
  el.pinbar.classList.add('hidden');
  el.progress.classList.add('hidden');

  el.description.textContent = caseDef.description || '';
  el.controlsHeading.textContent = caseDef.kind === 'dataset' ? 'Neighbourhood' : 'Settings';

  renderDayPicker(el.dayPresets, el.dayInput, caseDef.day, state.day, onDayChange);

  const allControls = [...caseDef.controls, ...caseDef.states];
  state.controlsHandle = renderControls(el.controls, allControls, { ...state.settings, ...state.states },
    onControlChange);

  const isDataset = caseDef.kind === 'dataset';
  el.runBtn.classList.toggle('hidden', isDataset);
  el.cancelBtn.classList.add('hidden');
  el.placeholder.classList.toggle('hidden', isDataset);
  el.placeholder.querySelector('p').innerHTML =
    'Choose your settings, then press <strong>Simulate</strong>.';

  setStatus('idle');

  if (isDataset) loadBaseline();
}

function onControlChange(id, value) {
  if (Object.prototype.hasOwnProperty.call(state.states, id)) state.states[id] = value;
  else state.settings[id] = value;

  if (state.caseDef.kind === 'dataset') scheduleBaseline();
}

function onDayChange(day) {
  state.day = day;
  syncDayPicker(el.dayPresets, el.dayInput, day);
  if (state.caseDef.kind === 'dataset') scheduleBaseline();
}

function resetToDefaults() {
  selectCase(state.caseDef);
}

/* ------------------------------------------------------------- topology */

function destroyTopology() {
  if (state.topo) state.topo.destroy();
  state.topo = null;
  state.topoPayload = null;
  el.topologySlot.replaceChildren();
}

function destroyStepTable() {
  if (state.stepTable) state.stepTable.destroy();
  state.stepTable = null;
  el.summary.replaceChildren();
}

/** A click on a chart or a table row: move everything to that timestep. */
function selectStep(index) {
  // Through the diagram when there is one, so it stays the single source of
  // truth for which moment is on show.
  if (state.topo) state.topo.setCursor(index);
  else applyCursor(index);
}

/** Show one timestep everywhere: the charts mark it, the table highlights it. */
function applyCursor(index) {
  state.cursor = index === null || index === undefined ? null : Number(index);
  for (const chart of state.charts) chart.setCursor(state.cursor);
  if (state.stepTable) state.stepTable.setCursor(state.cursor);
}

/** Fetch and mount the system diagram for a simulation case.

    The diagram appears before any run: seeing the system helps make sense of
    the settings. Results flow in through `state.topo.update` as polling runs.
    Failure is not worth blocking the case over -- the charts stand alone. */
async function loadTopology(caseDef) {
  const token = ++state.topoToken;
  try {
    const topo = await api.topology(state.pack.id, caseDef.id);
    if (token !== state.topoToken || state.caseDef.id !== caseDef.id) return;
    if (!topo.nodes || !topo.nodes.length) return;
    state.topoPayload = topo;
    state.topo = createTopology(el.topologySlot, topo, {
      onCursor: applyCursor,
      detailsFor,
    });
    if (state.results) state.topo.update(state.results);
  } catch (error) {
    console.warn('topology unavailable:', describe(error));
  }
}

/* --------------------------------------------------------- asset details */

/** A control's value as the panel should print it, unit included. */
function displayValue(control, value) {
  return `${formatValue(control, value)}${control.unit ? ` ${control.unit}` : ''}`;
}

/** Result column -> a label the pack already uses for it somewhere. */
function columnLabels() {
  const labels = new Map();
  const summary = state.caseDef.summary || {};
  for (const section of ['sum_columns', 'sample_columns']) {
    for (const [key, label] of Object.entries(summary[section] || {})) labels.set(key, label);
  }
  for (const chart of state.caseDef.charts || []) {
    for (const series of chart.series || []) {
      // Skip a series that negates its column: its label describes the flipped
      // value ("Power from grid" for -dump), not the number in the results.
      const flipped = series.sign !== undefined && Number(series.sign) !== 1;
      if (series.col && !flipped && !labels.has(series.col)) {
        labels.set(series.col, series.label || series.col);
      }
    }
  }
  return labels;
}

/** Print a reading the way the diagram would, but signed: the panel has room. */
function formatReading(column, value) {
  const badges = (state.topoPayload && state.topoPayload.badges) || [];
  const badge = badges.find((entry) => entry.col === column);
  return badge ? applyFormat(badge.fmt, value) : Number(value).toFixed(2);
}

/** The settings behind what is on screen -- the run's, not the sliders'. */
function shownSettings() {
  if (state.results && state.lastRun) return state.lastRun;
  return { settings: state.settings, states: state.states };
}

/**
 * What the diagram should show when an asset is tapped: the settings that
 * apply to it and its readings at the selected timestep.
 *
 * Derived from the pack -- a control belongs to an asset when one of its
 * targets writes that model -- so a new tutorial gets this for free.
 */
function detailsFor(nodeId, row) {
  const caseDef = state.caseDef;
  const source = shownSettings();

  const settings = [];
  for (const control of caseDef.controls || []) {
    if (!(control.targets || []).some((target) => target.model === nodeId)) continue;
    const value = source.settings ? source.settings[control.id] : undefined;
    if (value !== undefined) settings.push({ label: control.label, value: displayValue(control, value) });
  }
  for (const control of caseDef.states || []) {
    if (control.model !== nodeId) continue;
    const value = source.states ? source.states[control.id] : undefined;
    if (value !== undefined) settings.push({ label: control.label, value: displayValue(control, value) });
  }

  // Columns worth showing for this asset: the ones the diagram already binds to
  // it (a badge, or an edge it sits on), then anything else monitored on it.
  // The grid node is why the badges and edges come first -- its exchange is
  // reported on the controller's column, not on one of its own.
  const topo = state.topoPayload || {};
  const wanted = [];
  const seen = new Set();
  const want = (column) => {
    if (column && !seen.has(column)) { seen.add(column); wanted.push(column); }
  };
  for (const badge of topo.badges || []) if (badge.node === nodeId) want(badge.col);
  for (const edge of topo.edges || []) {
    if (edge.from === nodeId || edge.to === nodeId) want(edge.column);
  }
  for (const item of caseDef.monitor_items || []) {
    if (item.split('.')[0] === nodeId) want(item);
  }

  const labels = columnLabels();
  const index = state.results
    ? new Map(state.results.columns.map((name, i) => [name, i + 1]))
    : new Map();
  const readings = wanted.map((column) => {
    const at = index.get(column);
    const value = row && at !== undefined ? row[at] : null;
    return {
      label: labels.get(column) || column,
      value: typeof value === 'number' ? formatReading(column, value) : '—',
    };
  });

  const node = (topo.nodes || []).find((entry) => entry.id === nodeId);
  return {
    title: node ? node.label : nodeId,
    subtitle: node ? node.type : '',
    settings,
    readings,
  };
}

/* -------------------------------------------------------- dataset views */

function scheduleBaseline() {
  clearTimeout(state.baselineTimer);
  state.baselineTimer = setTimeout(loadBaseline, BASELINE_DEBOUNCE_MS);
}

async function loadBaseline() {
  const caseDef = state.caseDef;
  const token = ++state.baselineToken;
  setStatus('loading');
  try {
    const profile = await api.baseline(state.pack.id, caseDef.id, {
      day: state.day,
      houses: state.settings.houses,
    });
    // A slower earlier request must not overwrite a newer one.
    if (token !== state.baselineToken || state.caseDef.id !== caseDef.id) return;

    clearError();
    showNotes(profile.notes);
    el.placeholder.classList.add('hidden');

    if (!state.stackChart) {
      destroyCharts();
      state.stackChart = createStackChart(el.charts, { title: 'Demand over the day' });
    }
    state.stackChart.update(profile);
    setStatus('idle');
  } catch (error) {
    if (token !== state.baselineToken) return;
    setStatus('error');
    showError('Could not load the profile', describe(error));
  }
}

/* ------------------------------------------------------------------ runs */

function destroyCharts() {
  for (const chart of state.charts) chart.destroy();
  state.charts = [];
  if (state.stackChart) { state.stackChart.destroy(); state.stackChart = null; }
  el.charts.replaceChildren();
}

/** Resolve a chart's `limits_from` against the current control values. */
function limitsFor(chartSpec) {
  if (!chartSpec.limits_from) return null;
  const limits = {};
  for (const [key, controlId] of Object.entries(chartSpec.limits_from)) {
    const value = state.settings[controlId] ?? state.states[controlId];
    if (value !== undefined) limits[key] = Number(value);
  }
  return limits;
}

/** Resolve a chart's `bands_from` (grid capacity thresholds) the same way. */
function bandsFor(chartSpec) {
  if (!chartSpec.bands_from) return null;
  const bands = {};
  for (const [key, controlId] of Object.entries(chartSpec.bands_from)) {
    const value = state.settings[controlId] ?? state.states[controlId];
    if (value !== undefined) bands[key] = Number(value);
  }
  return Number.isFinite(bands.cap) ? bands : null;
}

/** The quantities the pack wants tabulated, in the order it lists them. */
function summaryColumns() {
  const summary = state.caseDef.summary || {};
  const columns = [];
  for (const [key, label] of Object.entries(summary.sum_columns || {})) {
    columns.push({ key, label, agg: 'sum' });
  }
  for (const [key, label] of Object.entries(summary.sample_columns || {})) {
    columns.push({ key, label, agg: 'sample' });
  }
  return columns;
}

/** Build the per-step table, once the run has produced something to put in it. */
function buildStepTable() {
  destroyStepTable();
  const columns = summaryColumns();
  if (!columns.length) return;
  state.stepTable = createStepTable(el.summary, columns, selectStep);
}

function buildCharts() {
  destroyCharts();
  state.charts = (state.caseDef.charts || []).map((spec) =>
    createChart(el.charts, spec, {
      limits: limitsFor(spec), bands: bandsFor(spec), pinned: state.pinned,
      onSelect: selectStep,
    }));
  // Draw the pinned run straight away, so the new one grows over a complete
  // reference curve instead of starting from an empty chart.
  for (const chart of state.charts) chart.update(state.results);
}

/* ------------------------------------------------------------------ pins */

/** Every control that carries a value: settings and initial states alike. */
function allControls() {
  return [...(state.caseDef.controls || []), ...(state.caseDef.states || [])];
}

function valueIn(run, id) {
  if (!run) return undefined;
  const setting = run.settings ? run.settings[id] : undefined;
  return setting === undefined ? (run.states ? run.states[id] : undefined) : setting;
}

/** What differs between two runs, as printable "label: before -> after" parts. */
function diffRuns(before, after) {
  const changes = [];
  if (!before || !after) return changes;
  if (before.day !== after.day) changes.push({ label: 'Day', from: before.day, to: after.day });

  for (const control of allControls()) {
    const from = valueIn(before, control.id);
    const to = valueIn(after, control.id);
    if (from === undefined || to === undefined) continue;
    // Compare as displayed: values that print the same are the same setting.
    const fromText = displayValue(control, from);
    const toText = displayValue(control, to);
    if (fromText !== toText) changes.push({ label: control.label, from: fromText, to: toText });
  }
  return changes;
}

/** One side of a diff, short enough for a column header. */
function sideLabel(changes, side) {
  if (!changes.length) return 'same settings';
  const shown = changes.slice(0, 2).map((change) => `${change.label} ${change[side]}`);
  return shown.join(', ') + (changes.length > 2 ? ', …' : '');
}

/**
 * Keep the finished run on screen as the baseline for the next one.
 *
 * The results object is safe to hold by reference: nothing mutates it once the
 * run ends, because `startRun` builds a fresh one for the next run.
 */
function pinCurrent(auto) {
  if (!state.results || !state.lastRun) return;
  state.pinned = {
    auto,
    runId: state.lastRun.id,
    day: state.lastRun.day,
    settings: { ...state.lastRun.settings },
    states: { ...state.lastRun.states },
    results: state.results,
  };
  applyPin();
}

function unpin() {
  state.pinned = null;
  applyPin();
}

function applyPin() {
  for (const chart of state.charts) chart.setPinned(state.pinned);
  renderPinBar();
  updateComparison();
}

function pinNote(text) {
  const note = document.createElement('div');
  note.className = 'pin-note';
  note.textContent = text;
  return note;
}

function pinButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-ghost';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function renderPinBar() {
  const pinned = state.pinned;
  const canPin = Boolean(state.results && state.runState === 'done');

  el.pinbar.replaceChildren();
  el.pinbar.classList.toggle('hidden', !pinned && !canPin);
  if (!pinned && !canPin) return;

  const info = document.createElement('div');
  info.className = 'pin-info';
  const text = document.createElement('div');

  if (pinned) {
    const ghost = document.createElement('span');
    ghost.className = 'pin-ghost';
    info.append(ghost);

    const changes = diffRuns(pinned, state.lastRun);
    const title = document.createElement('strong');
    title.textContent = 'Pinned run';
    const description = document.createElement('span');
    description.className = 'pin-desc';
    description.textContent = changes.length
      ? `${pinned.day} · ${sideLabel(changes, 'from')}`
      : pinned.day;
    text.append(title, description, pinNote('The dashed curves show it.'));

    if (pinned.auto) text.append(pinNote('Kept automatically when you pressed Simulate.'));
    if (changes.length) {
      const spelled = changes.map((change) => `${change.label} ${change.from} → ${change.to}`);
      text.append(pinNote(`Changed since: ${spelled.join(', ')}`));
    }
  } else {
    const title = document.createElement('strong');
    title.textContent = 'Compare runs';
    text.append(title, pinNote('Pin this run to draw the next one against it.'));
  }
  info.append(text);

  const actions = document.createElement('div');
  actions.className = 'pin-actions';
  if (canPin) {
    actions.append(pinButton(pinned ? 'Pin this one instead' : 'Pin this run',
      () => pinCurrent(false)));
  }
  if (pinned) actions.append(pinButton('Unpin', unpin));

  el.pinbar.append(info, actions);
}

/** Day totals for the finished run, against the pinned one if they differ. */
function updateComparison() {
  const pinned = state.pinned;
  const comparing = Boolean(pinned && state.lastRun && pinned.runId !== state.lastRun.id);
  const changes = comparing ? diffRuns(pinned, state.lastRun) : [];
  renderComparison(el.comparison, {
    columns: summaryColumns(),
    current: state.results,
    pinned: comparing ? pinned.results : null,
    pinnedLabel: sideLabel(changes, 'from'),
    currentLabel: sideLabel(changes, 'to'),
  });
}

async function startRun() {
  if (state.runState === 'running' || state.runState === 'queued') return;

  // Re-running used to throw the previous result away. Keep it as the baseline
  // instead -- unless the user pinned one deliberately, which outranks this.
  if (state.runState === 'done' && state.results && (!state.pinned || state.pinned.auto)) {
    pinCurrent(true);
  }

  clearError();
  showNotes([]);
  destroyStepTable();
  el.comparison.replaceChildren();
  el.placeholder.classList.add('hidden');
  state.results = null;
  state.cursor = null;
  buildCharts();
  renderPinBar();
  if (state.topo) state.topo.update(null);

  setRunning(true);
  setStatus('queued');
  setProgress(0, 0, null);

  try {
    const run = await api.createRun({
      pack: state.pack.id,
      case: state.caseDef.id,
      day: state.day,
      settings: state.settings,
      states: state.states,
    });
    state.runId = run.id;
    state.runState = run.state;
    // The server's own values, so a clamped setting is compared as it ran.
    state.lastRun = {
      id: run.id,
      day: run.day || state.day,
      settings: { ...(run.settings || state.settings) },
      states: { ...(run.state_values || state.states) },
    };
    showNotes(run.notes);
    renderPinBar();
    poll();
  } catch (error) {
    setRunning(false);
    setStatus('error');
    if (error instanceof ApiError && error.status === 409) {
      offerToStopActiveRun(error.message);
    } else {
      showError('Could not start the simulation', describe(error));
    }
  }
}

/** A 409 means another run holds the single slot; offer to stop it. */
function offerToStopActiveRun(message) {
  el.errorPanel.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = 'Another simulation is running';
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-danger';
  button.textContent = 'Stop it and run mine';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const runs = await api.runs();
      const active = (runs.runs || []).find((r) => r.state === 'running' || r.state === 'queued');
      if (active) await api.cancelRun(active.id);
      clearError();
      startRun();
    } catch (error) {
      showError('Could not stop the running simulation', describe(error));
    }
  });
  el.errorPanel.append(heading, paragraph, button);
  el.errorPanel.classList.remove('hidden');
}

async function cancelRun() {
  if (!state.runId) return;
  el.cancelBtn.disabled = true;
  try {
    await api.cancelRun(state.runId);
  } catch (error) {
    showError('Could not stop the simulation', describe(error));
  } finally {
    el.cancelBtn.disabled = false;
  }
}

function setRunning(running) {
  el.runBtn.disabled = running;
  el.runBtn.textContent = running ? 'Simulating…' : 'Simulate';
  el.cancelBtn.classList.toggle('hidden', !running);
  el.resetBtn.disabled = running;
  el.progress.classList.toggle('hidden', !running);
  if (state.controlsHandle) state.controlsHandle.setDisabled(running);
  for (const input of [el.dayInput, ...el.dayPresets.querySelectorAll('button')]) {
    input.disabled = running;
  }
}

function setProgress(fraction, rows, expected) {
  el.progressBar.style.width = `${Math.round(fraction * 100)}%`;
  el.progressLabel.textContent = expected
    ? `${rows} of ${expected} steps`
    : `${rows} steps`;
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function poll() {
  if (!state.runId) return;
  const runId = state.runId;

  try {
    const status = await api.runStatus(runId);
    if (state.runId !== runId) return;      // the user moved on

    state.runState = status.state;
    setStatus(status.state);
    setProgress(status.progress || 0, status.rows || 0, status.expected_steps);

    const since = state.results ? state.results.rows.length : 0;
    const page = await api.runResults(runId, since);
    if (state.runId !== runId) return;

    if (page.rows.length) {
      if (!state.results) state.results = { columns: page.columns, rows: [] };
      // Column order can differ between runs, never within one.
      state.results.columns = page.columns;
      state.results.rows.push(...page.rows);
      for (const chart of state.charts) chart.update(state.results);
      if (!state.stepTable) buildStepTable();
      if (state.stepTable) state.stepTable.update(state.results);
      // Last, so the cursor it publishes reaches charts and table alike.
      if (state.topo) state.topo.update(state.results);
    }

    if (status.state === 'running' || status.state === 'queued') {
      state.pollTimer = setTimeout(poll, POLL_MS);
      return;
    }

    // Terminal.
    setRunning(false);
    renderPinBar();
    if (status.state === 'done') {
      updateComparison();
    } else if (status.state === 'error') {
      const error = status.error || {};
      showError('The simulation failed',
        error.message || 'The engine stopped without a message.',
        error.traceback);
    } else if (status.state === 'cancelled') {
      showError('Simulation stopped', 'The run was stopped before it finished.');
    }
  } catch (error) {
    setRunning(false);
    setStatus('error');
    showError('Lost contact with the simulation', describe(error));
  }
}

init();
