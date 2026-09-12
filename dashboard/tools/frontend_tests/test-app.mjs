/* End-to-end test of the dashboard frontend against real backend payloads. */
import { boot, tick } from './harness.mjs';
const clockOf = (stamp) => /(\d{2}:\d{2})/.exec(stamp)[1];
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const live = JSON.parse(readFileSync(join(process.env.TMPDIR || tmpdir(), 'live/session.json'), 'utf8'));
const results = live.results_full;

let passed = 0; const failures = [];
function check(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS      ${label}${extra ? '  ' + extra : ''}`); }
  else { failures.push(label); console.log(`  **FAIL**  ${label}${extra ? '  ' + extra : ''}`); }
}

// A scripted backend: the run reports growing row counts across polls, exactly
// as the real one does while the collector appends.
const SCHEDULE = [
  { state: 'running', rows: 18 },
  { state: 'running', rows: 55 },
  { state: 'running', rows: 88 },
  { state: 'done', rows: 95 },
];
let pollIndex = 0;
let served = 0;
let runIndex = -1;
const postBodies = [];

// The second run returns everything doubled, so a comparison has something to
// show. Scaling the real payloads keeps the shapes genuine.
const scale = (value, factor) => (typeof value === 'number' ? value * factor : value);
const resultsByRun = [
  results,
  { ...results, rows: results.rows.map((row) => row.map((v, i) => (i ? scale(v, 2) : v))) },
];
const forRun = (byRun) => byRun[Math.min(runIndex, byRun.length - 1)];

// Day totals are computed from the rows the page already holds, so these
// mirror the frontend's arithmetic rather than the /summary endpoint's.
const colOf = (key) => results.columns.indexOf(key) + 1;
const dayTotal = (rows, key) => rows.reduce((sum, row) => sum + row[colOf(key)], 0);
const dayMean = (rows, key) => dayTotal(rows, key) / rows.length;

const routes = {
  'GET /api/packs': () => live.packs,
  'GET /api/packs/{p}/cases/{c}/baseline': () => live.baseline,
  'GET /api/packs/{p}/cases/{c}/topology': () => live.topology,
  'POST /api/runs': (url, init) => {
    const body = JSON.parse(init.body);
    postBodies.push(body);
    pollIndex = 0; served = 0; runIndex++;
    // The real server echoes the settings it resolved, and gives every run its
    // own id; the frontend compares runs on both.
    return { ...live.created, id: `run-${runIndex}`, state: 'queued', rows: 0, progress: 0,
             day: body.day, settings: body.settings, state_values: body.states };
  },
  'GET /api/runs/{id}/results': (url) => {
    const since = Number(new URLSearchParams(url.search).get('since') || 0);
    const payload = forRun(resultsByRun);
    const rows = payload.rows.slice(since, served);
    return { ...payload, rows, since, next: served, total: served,
             state: pollIndex >= SCHEDULE.length ? 'done' : SCHEDULE[pollIndex - 1]?.state };
  },
  'GET /api/runs/{id}': () => {
    const step = SCHEDULE[Math.min(pollIndex, SCHEDULE.length - 1)];
    pollIndex++;
    served = step.rows;
    return { ...live.status_done, state: step.state, rows: step.rows,
             progress: step.rows / live.status_done.expected_steps,
             error: null };
  },
};

const { window, doc, requests, canvasCalls, consoleMessages, loadModule } =
  await boot({ routes });

console.log('=== 1. boot and pack load ===');
await loadModule('app.js');
await tick(60);

check('pack title rendered', doc.getElementById('pack-title').textContent ===
  live.packs.packs[0].title, doc.getElementById('pack-title').textContent);
const tabs = [...doc.querySelectorAll('.tab')].map((t) => t.textContent);
check('one tab per case', tabs.length === 3, JSON.stringify(tabs));
check('first case selected', doc.querySelector('.tab').getAttribute('aria-selected') === 'true');

console.log('=== 2. dataset case (task 1) ===');
check('dataset case hides Simulate', doc.getElementById('run-btn').classList.contains('hidden'));
check('baseline was requested', requests.some((r) => r.key.endsWith('/baseline')));
check('stacked chart drawn', doc.querySelectorAll('#charts .chart-card').length === 1);
const legendNames = [...doc.querySelectorAll('#charts .legend-item')].map((n) => n.textContent);
check('mix layers in legend', legendNames.length === 11, `${legendNames.length} entries`);

console.log('=== 3. switch to the battery case ===');
const batteryTab = [...doc.querySelectorAll('.tab')][2];
batteryTab.click();
await tick(40);
check('battery tab selected', batteryTab.getAttribute('aria-selected') === 'true');
check('Simulate shown for simulation case', !doc.getElementById('run-btn').classList.contains('hidden'));

const caseDef = live.packs.packs[0].cases[2];
const sliders = [...doc.querySelectorAll('#controls .control')];
check('control per schema entry', sliders.length === caseDef.controls.length + caseDef.states.length,
  `${sliders.length} rendered`);
const labels = [...doc.querySelectorAll('#controls .control-label')].map((l) => l.textContent);
check('labels come from the pack', labels.includes('Battery power limit') && labels.includes('Houses in the neighbourhood'));
const firstRange = doc.querySelector('#controls input[type=range]');
check('slider bounds from the pack', firstRange.min === String(caseDef.controls[0].min) &&
  firstRange.max === String(caseDef.controls[0].max), `min=${firstRange.min} max=${firstRange.max}`);
const socStart = doc.getElementById('control-soc_start');
check('state control rendered too', socStart !== null && socStart.value === '90', socStart && socStart.value);
check('day presets rendered', doc.querySelectorAll('#day-presets .preset').length === 2);
check('date input bounded by data range', doc.getElementById('day-input').min === '2012-01-01' &&
  doc.getElementById('day-input').max === '2012-12-30');

console.log('=== 3b. topology renders with the case, before any run ===');
const topoCard = doc.querySelector('#topology-slot .topo-card');
check('topology mounted for a simulation case', topoCard !== null);
check('one chip per visible model',
  topoCard.querySelectorAll('.topo-node').length === live.topology.nodes.length,
  `${topoCard.querySelectorAll('.topo-node').length} nodes`);
check('every scenario connection drawn',
  topoCard.querySelectorAll('.topo-edge-base').length === live.topology.edges.length,
  `${topoCard.querySelectorAll('.topo-edge-base').length} base edges`);
const boundEdges = live.topology.edges.filter((e) => e.column);
check('flow overlays only for column-bound edges',
  topoCard.querySelectorAll('.topo-edge-flow').length === boundEdges.length,
  `${topoCard.querySelectorAll('.topo-edge-flow').length} flows`);
check('the national grid is drawn, though no model produces it',
  topoCard.querySelector('[data-node="Grid"]') !== null,
  [...topoCard.querySelectorAll('.topo-node')].map((g) => g.dataset.node).join(','));
check('battery carries both a charge and a power badge',
  topoCard.querySelectorAll('[data-node="Battery1"] .topo-badge').length === 2);
check('badges idle before a run',
  [...topoCard.querySelectorAll('.topo-badge')].every((b) => b.textContent === '—'));
check('flows dark before a run',
  [...topoCard.querySelectorAll('.topo-edge-flow')].every((f) =>
    f.getAttribute('stroke-opacity') === '0'));
check('scrubber hidden before a run',
  topoCard.querySelector('.topo-scrub').classList.contains('hidden'));

console.log('=== 4. move a slider ===');
const powerSlider = doc.getElementById('control-battery_power');
powerSlider.value = '2.5';
powerSlider.dispatchEvent(new window.Event('input'));
const readout = powerSlider.closest('.control').querySelector('.control-value').textContent;
check('readout follows the slider', readout.startsWith('2.5'), readout);

console.log('=== 5. run the simulation ===');
doc.getElementById('run-btn').click();
await tick(80);
check('POST body carries pack/case/day', postBodies.length === 1 &&
  postBodies[0].pack === 'power_balance' && postBodies[0].case === 'res_battery' &&
  postBodies[0].day === '2012-06-01');
check('POST body carries the moved slider', postBodies[0].settings.battery_power === 2.5,
  `battery_power=${postBodies[0].settings.battery_power}`);
check('POST body carries the initial state', postBodies[0].states.soc_start === 90);
check('controls disabled while running', doc.querySelector('#controls input').disabled);
check('Stop button shown', !doc.getElementById('cancel-btn').classList.contains('hidden'));

const widths = [];
for (let i = 0; i < 8; i++) {
  await tick(POLL_WAIT());
  widths.push(doc.getElementById('progress-bar').style.width);
  if (doc.getElementById('status-pill').textContent === 'Complete') break;
}
function POLL_WAIT() { return 420; }

console.log('=== 6. completion ===');
check('status reached Complete', doc.getElementById('status-pill').textContent === 'Complete',
  doc.getElementById('status-pill').textContent);
check('progress bar advanced then filled', widths.some((w) => w && w !== '100%') && widths.at(-1) === '100%',
  JSON.stringify(widths.slice(0, 5)));
check('two charts rendered', doc.querySelectorAll('#charts .chart-card').length === 2,
  `${doc.querySelectorAll('#charts .chart-card').length} cards`);
check('uPlot mounted a canvas per chart', doc.querySelectorAll('#charts canvas').length >= 2,
  `${doc.querySelectorAll('#charts canvas').length} canvases`);
check('uPlot issued drawing calls', canvasCalls.length > 50, `${canvasCalls.length} canvas ops`);

// The legend prints the latest value of each series, so it is a direct readout
// of the column-by-name lookup and the per-series sign handling.
const lastRow = results.rows[results.rows.length - 1];
const colIndex = new Map(results.columns.map((c, i) => [c, i + 1]));
const chartSpec = caseDef.charts[0];
const expected = chartSpec.series.map((s) =>
  (lastRow[colIndex.get(s.col)] * (s.sign === undefined ? 1 : s.sign)).toFixed(2));
const shown = [...doc.querySelectorAll('#charts .chart-card')[0].querySelectorAll('.legend-value')]
  .map((n) => n.textContent);
check('legend values match the data, by column name', JSON.stringify(shown) === JSON.stringify(expected),
  `shown=${JSON.stringify(shown)} expected=${JSON.stringify(expected)}`);

const socShown = [...doc.querySelectorAll('#charts .chart-card')[1].querySelectorAll('.legend-value')]
  .map((n) => n.textContent);
check('battery chart reads Battery1.soc', socShown[0] === lastRow[colIndex.get('Battery1.soc')].toFixed(2),
  `shown=${socShown[0]}`);
check('controls re-enabled', !doc.querySelector('#controls input').disabled);
check('Stop hidden again', doc.getElementById('cancel-btn').classList.contains('hidden'));

const stepRows = doc.querySelectorAll('.step-table tbody tr');
check('a table row per simulation step', stepRows.length === results.rows.length,
  `${stepRows.length} rows`);
const headers = [...doc.querySelectorAll('.step-table thead th')].map((t) => t.textContent);
check('table headers from the pack', headers.includes('Battery SOC (%)') && headers[0] === 'Time',
  JSON.stringify(headers.slice(0, 3)));
const firstCells = [...stepRows[0].querySelectorAll('td')].map((td) => td.textContent);
check('first row is the first timestep, not an hourly digest', firstCells[0] === '00:00' &&
  firstCells[1] === results.rows[0][colOf('Load1.load_dem')].toFixed(2),
  JSON.stringify(firstCells.slice(0, 2)));
check('the newest step is highlighted',
  doc.querySelector('.step-table tbody tr.is-current') === stepRows[stepRows.length - 1]);
check('no aggregate summary was requested',
  !requests.some((r) => r.key.endsWith('/summary')),
  requests.filter((r) => r.key.endsWith('/summary')).length + ' calls');

console.log('=== 7. incremental accumulation ===');
const resultCalls = requests.filter((r) => r.key.endsWith('/results'));
const sinces = resultCalls.map((r) => Number(new URLSearchParams(r.search).get('since')));
check('polled results incrementally with rising since', sinces.length >= 3 &&
  sinces.every((v, i, a) => i === 0 || v >= a[i - 1]), JSON.stringify(sinces));
check('never refetched from zero after the first page',
  sinces.filter((s) => s === 0).length === 1, JSON.stringify(sinces));

console.log('=== 8. topology follows the finished run ===');
const topoBadgeOf = (node) =>
  topoCard.querySelector(`[data-node="${node}"] .topo-badge`).textContent;
check('scrubber shown once rows exist',
  !topoCard.querySelector('.topo-scrub').classList.contains('hidden'));
const topoSlider = topoCard.querySelector('.topo-slider');
check('slider spans the run', topoSlider.max === String(results.rows.length - 1) &&
  topoSlider.value === topoSlider.max, `max=${topoSlider.max} value=${topoSlider.value}`);
check('clock reads the newest row',
  topoCard.querySelector('.topo-clock').textContent === '23:30',
  topoCard.querySelector('.topo-clock').textContent);
check('load badge formats the latest value',
  topoBadgeOf('Load1') === `${lastRow[colIndex.get('Load1.load_dem')].toFixed(2)} kW`,
  topoBadgeOf('Load1'));
const topoBadgesOf = (node) =>
  [...topoCard.querySelectorAll(`[data-node="${node}"] .topo-badge`)].map((b) => b.textContent);
check('battery badge is its state of charge',
  topoBadgeOf('Battery1') === `${lastRow[colIndex.get('Battery1.soc')].toFixed(0)}%`,
  topoBadgeOf('Battery1'));
check('battery also reports the power it moved',
  topoBadgesOf('Battery1')[1] ===
    `${Math.abs(lastRow[colIndex.get('Battery1.p_out')]).toFixed(2)} kW`,
  topoBadgesOf('Battery1')[1]);
// The exchange is signed in the data; the arrow shows the direction, so the
// badge prints its size.
check('grid badge is the size of the exchange',
  topoBadgeOf('Grid') === `${Math.abs(lastRow[colIndex.get('Controller1.dump')]).toFixed(2)} kW`,
  topoBadgeOf('Grid'));
const chargeBar = topoCard.querySelector('.topo-charge-fill');
const socNow = lastRow[colIndex.get('Battery1.soc')];
check('charge bar filled to the state of charge',
  Math.abs(Number(chargeBar.getAttribute('width')) - 44 * socNow / 100) < 0.01,
  `width=${chargeBar.getAttribute('width')} soc=${socNow}`);
// Demand is positive on a Load -> Controller edge with sign -1, so its arrow
// points back at the homes: base angle 180 plus the 180 flip.
const arrows = [...topoCard.querySelectorAll('.topo-arrow')];
check('load arrow points at the homes',
  arrows[2].getAttribute('transform').includes('rotate(360)'),
  arrows[2].getAttribute('transform'));
const flows = [...topoCard.querySelectorAll('.topo-edge-flow')];
check('an active flow is visible and weighted', flows.some((f) =>
  f.getAttribute('stroke-opacity') === '0.9' && Number(f.getAttribute('stroke-width')) > 2));

console.log('=== 8b. scrub back to midnight ===');
topoSlider.value = '0';
topoSlider.dispatchEvent(new window.Event('input'));
check('clock follows the scrub', topoCard.querySelector('.topo-clock').textContent === '00:00',
  topoCard.querySelector('.topo-clock').textContent);
const firstRow = results.rows[0];
check('badges read the scrubbed instant',
  topoBadgeOf('Load1') === `${firstRow[colIndex.get('Load1.load_dem')].toFixed(2)} kW` &&
  topoBadgeOf('Battery1') === `${firstRow[colIndex.get('Battery1.soc')].toFixed(0)}%`,
  `${topoBadgeOf('Load1')} / ${topoBadgeOf('Battery1')}`);

console.log('=== 8b2. the charts follow the scrubbed timestep ===');
const balanceLegend = doc.querySelectorAll('#charts .chart-card')[0];
check('legend says which moment its numbers belong to',
  balanceLegend.querySelector('.legend-time').textContent === 'at 00:00',
  balanceLegend.querySelector('.legend-time').textContent);
const scrubbedValues = [...balanceLegend.querySelectorAll('.legend-value')].map((n) => n.textContent);
const expectedAtMidnight = chartSpec.series.map((s) =>
  (firstRow[colIndex.get(s.col)] * (s.sign === undefined ? 1 : s.sign)).toFixed(2));
check('legend values are the scrubbed step, not the last one',
  JSON.stringify(scrubbedValues) === JSON.stringify(expectedAtMidnight),
  `shown=${JSON.stringify(scrubbedValues.slice(0, 3))}`);
check('the table highlights the same step',
  doc.querySelector('.step-table tbody tr.is-current') ===
  doc.querySelectorAll('.step-table tbody tr')[0]);

console.log('=== 8b3. tap an asset for its settings ===');
topoCard.querySelector('[data-node="Battery1"]').dispatchEvent(
  new window.Event('click', { bubbles: true }));
const panel = topoCard.querySelector('.topo-detail');
check('panel opens for the tapped asset', !panel.classList.contains('hidden') &&
  panel.querySelector('.topo-detail-head strong').textContent === 'Battery1');
const panelTerms = [...panel.querySelectorAll('dt')].map((t) => t.textContent);
const panelValues = [...panel.querySelectorAll('dd')].map((t) => t.textContent);
check('settings that target this model are listed',
  panelTerms.includes('Battery capacity') && panelTerms.includes('Minimum state of charge'),
  JSON.stringify(panelTerms));
check('settings show the values the run used',
  panelValues[panelTerms.indexOf('Battery capacity')] === '0.8 kWh',
  panelValues[panelTerms.indexOf('Battery capacity')]);
check('readings are labelled the way the pack names them',
  panelTerms.includes('Battery SOC (%)') && panelTerms.includes('Battery power (kW)'),
  JSON.stringify(panelTerms));
check('readings are for the scrubbed step',
  panelValues[panelTerms.indexOf('Battery SOC (%)')] ===
    `${firstRow[colIndex.get('Battery1.soc')].toFixed(0)}%`,
  panelValues[panelTerms.indexOf('Battery SOC (%)')]);
check('panel heads its readings with the time',
  [...panel.querySelectorAll('h4')].some((h) => h.textContent === 'At 00:00'),
  [...panel.querySelectorAll('h4')].map((h) => h.textContent).join(' / '));

// The grid's exchange is reported on the controller's column, so the panel has
// to reach it through the badge rather than through Grid's own monitor items.
topoCard.querySelector('[data-node="Grid"]').dispatchEvent(
  new window.Event('click', { bubbles: true }));
check('the grid panel finds its column too',
  [...panel.querySelectorAll('dt')].some((t) => t.textContent === 'Power to grid (kW)'),
  [...panel.querySelectorAll('dt')].map((t) => t.textContent).join(', '));
topoCard.querySelector('[data-node="Grid"]').dispatchEvent(
  new window.Event('click', { bubbles: true }));
check('tapping the same asset again closes the panel', panel.classList.contains('hidden'));

console.log('=== 8b4. the table scrubs too ===');
doc.querySelectorAll('.step-table tbody tr')[10].dispatchEvent(
  new window.Event('click', { bubbles: true }));
check('clicking a row moves the diagram',
  topoCard.querySelector('.topo-clock').textContent === clockOf(results.rows[10][0]),
  topoCard.querySelector('.topo-clock').textContent);
check('and the charts with it',
  balanceLegend.querySelector('.legend-time').textContent ===
    `at ${clockOf(results.rows[10][0])}`);
topoSlider.value = String(results.rows.length - 1);
topoSlider.dispatchEvent(new window.Event('input'));

console.log('=== 8b5. hover and click a chart ===');
const over = balanceLegend.querySelector('.u-over');
check('the plot exposes a pointer surface', over !== null);

const hover = (x) => over.dispatchEvent(new window.MouseEvent('mousemove',
  { clientX: x, clientY: 120, bubbles: true }));
hover(220);
await tick(40);

const chartTip = balanceLegend.querySelector('.chart-tip');
check('hovering opens the readout', chartTip && !chartTip.classList.contains('hidden'));
const hoveredTime = chartTip.querySelector('.chart-tip-time').textContent;
check('readout names the moment under the pointer', /^\d{2}:\d{2}$/.test(hoveredTime),
  hoveredTime);

// Non-circular: find the row that time belongs to and check the numbers.
const hoveredRow = results.rows.find((row) => clockOf(row[0]) === hoveredTime);
const tipValues = [...chartTip.querySelectorAll('.chart-tip-row b')].map((b) => b.textContent);
const tipExpected = chartSpec.series.map((s) =>
  (hoveredRow[colIndex.get(s.col)] * (s.sign === undefined ? 1 : s.sign)).toFixed(2));
check('readout gives every series its value at that moment',
  JSON.stringify(tipValues) === JSON.stringify(tipExpected),
  `shown=${JSON.stringify(tipValues)} expected=${JSON.stringify(tipExpected)}`);
const tipLabels = [...chartTip.querySelectorAll('.chart-tip-row span:last-of-type')]
  .map((n) => n.textContent);
check('readout labels them from the pack',
  tipLabels.includes('Load demand') && tipLabels.includes('Solar generation'),
  JSON.stringify(tipLabels));

over.dispatchEvent(new window.MouseEvent('click', { clientX: 220, clientY: 120, bubbles: true }));
await tick(40);
check('clicking the chart moves the shared timestep',
  topoCard.querySelector('.topo-clock').textContent === hoveredTime,
  `diagram at ${topoCard.querySelector('.topo-clock').textContent}, chart at ${hoveredTime}`);
check('the chart legend follows its own click',
  balanceLegend.querySelector('.legend-time').textContent === `at ${hoveredTime}`,
  balanceLegend.querySelector('.legend-time').textContent);
check('the table follows it too',
  doc.querySelector('.step-table tbody tr.is-current td').textContent === hoveredTime,
  doc.querySelector('.step-table tbody tr.is-current td').textContent);
check('the battery chart marks the same moment',
  doc.querySelectorAll('#charts .chart-card')[1].querySelector('.legend-time').textContent
    === `at ${hoveredTime}`);

balanceLegend.querySelector('.chart-holder')
  .dispatchEvent(new window.MouseEvent('mouseleave', {}));
check('the readout closes when the pointer leaves', chartTip.classList.contains('hidden'));

topoSlider.value = String(results.rows.length - 1);
topoSlider.dispatchEvent(new window.Event('input'));

console.log('=== 8c. play the day ===');
const playBtn = topoCard.querySelector('.topo-play');
playBtn.click();
await tick(350);
const playedTo = Number(topoSlider.value);
check('playback advances through the rows', playedTo > 0 && playedTo < results.rows.length - 1,
  `at row ${playedTo}`);
playBtn.click();                 // pause
await tick(250);
check('pause holds the moment', Number(topoSlider.value) === playedTo,
  `still ${topoSlider.value}`);

console.log('=== 9. pin a run and compare the next one ===');
const pinbar = doc.getElementById('pinbar');
check('pin offered once a run has finished', !pinbar.classList.contains('hidden') &&
  pinbar.textContent.includes('Pin this run'));
check('nothing pinned yet, so no ghost',
  doc.querySelectorAll('#charts .legend-pinned').length === 0);

// Day totals stand on their own, before there is anything to compare with.
const soloHeaders = [...doc.querySelectorAll('#comparison thead th')].map((t) => t.textContent);
check('day totals shown for a single run', soloHeaders.length === 2 &&
  soloHeaders[1].startsWith('This run'), JSON.stringify(soloHeaders));

// Change a setting and run again. The finished run should be kept as the
// baseline without the user having to ask for it.
const energySlider = doc.getElementById('control-battery_energy');
energySlider.value = '4';
energySlider.dispatchEvent(new window.Event('input'));
doc.getElementById('run-btn').click();
await tick(80);

check('previous run kept automatically', pinbar.textContent.includes('Kept automatically'));
check('pin bar spells out what changed',
  pinbar.textContent.includes('Battery capacity 0.8 kWh → 4.0 kWh'),
  pinbar.textContent.replace(/\s+/g, ' ').slice(0, 160));

for (let i = 0; i < 8; i++) {
  await tick(420);
  if (doc.getElementById('status-pill').textContent === 'Complete') break;
}
check('second run completed', doc.getElementById('status-pill').textContent === 'Complete',
  doc.getElementById('status-pill').textContent);

const balanceCard = doc.querySelectorAll('#charts .chart-card')[0];
const ghostValues = [...balanceCard.querySelectorAll('.legend-pinned')].map((n) => n.textContent);
check('pinned run drawn alongside every series',
  ghostValues.length === chartSpec.series.length, `${ghostValues.length} ghost entries`);
check('ghost legend reads the pinned run',
  JSON.stringify(ghostValues) === JSON.stringify(expected.map((v) => `was ${v}`)),
  `shown=${JSON.stringify(ghostValues.slice(0, 2))}`);

const secondRow = resultsByRun[1].rows[resultsByRun[1].rows.length - 1];
const nowExpected = chartSpec.series.map((s) =>
  (secondRow[colIndex.get(s.col)] * (s.sign === undefined ? 1 : s.sign)).toFixed(2));
const nowShown = [...balanceCard.querySelectorAll('.legend-value')].map((n) => n.textContent);
check('current values are the new run, not the pinned one',
  JSON.stringify(nowShown) === JSON.stringify(nowExpected), `shown=${JSON.stringify(nowShown)}`);

const compare = doc.querySelector('#comparison .compare-table');
const compareHeaders = [...compare.querySelectorAll('thead th')].map((t) => t.textContent);
check('comparison has pinned / current / change columns', compareHeaders.length === 4 &&
  compareHeaders[1].startsWith('Pinned') && compareHeaders[3].startsWith('Change'),
  JSON.stringify(compareHeaders.map((h) => h.slice(0, 24))));
check('column headers name the setting that differs',
  compareHeaders[1].includes('Battery capacity 0.8 kWh') &&
  compareHeaders[2].includes('Battery capacity 4.0 kWh'),
  JSON.stringify(compareHeaders.slice(1, 3)));

const compareCells = [...compare.querySelectorAll('tbody tr')[0].querySelectorAll('td')]
  .map((td) => td.textContent);
const loadTotal = dayTotal(results.rows, 'Load1.load_dem');
check('day total sums every step of the run', compareCells[1] === loadTotal.toFixed(2),
  `${compareCells[1]} vs ${loadTotal.toFixed(2)}`);
check('current column doubled with the data', compareCells[2] === (loadTotal * 2).toFixed(2),
  compareCells[2]);
check('change column states the difference', compareCells[3].startsWith(`+${loadTotal.toFixed(2)}`),
  compareCells[3]);

// State of charge is a level: averaged over the day, never summed.
const summarySpec = caseDef.summary;
const socRow = Object.keys(summarySpec.sum_columns).length;
check('the pack lists battery SOC as a sampled column',
  Object.keys(summarySpec.sample_columns)[0] === 'Battery1.soc');
const socCells = [...compare.querySelectorAll('tbody tr')[socRow].querySelectorAll('td')]
  .map((td) => td.textContent);
const socMean = dayMean(results.rows, 'Battery1.soc');
check('sampled column is averaged, not totalled', socCells[1] === socMean.toFixed(2),
  `${socCells[1]} vs ${socMean.toFixed(2)}`);
check('averaged rows are labelled as such', socCells[0].endsWith('average'), socCells[0]);

console.log('=== 10. unpin ===');
[...pinbar.querySelectorAll('button')].find((b) => b.textContent === 'Unpin').click();
await tick(30);
check('unpin removes the ghost series',
  doc.querySelectorAll('#charts .legend-pinned').length === 0);
check('unpin drops the comparison columns',
  doc.querySelectorAll('#comparison thead th').length === 2);
check('unpin hides the pinned description', !pinbar.textContent.includes('Kept automatically'));

console.log('=== 11. page errors ===');
const bad = consoleMessages.filter(([lvl]) => lvl === 'error' || lvl === 'jsdomError');
check('no page errors', bad.length === 0, JSON.stringify(bad.slice(0, 2)));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILURES:', failures);
// The topology view keeps an animation frame pending; exit explicitly.
process.exit(failures.length ? 1 : 0);
