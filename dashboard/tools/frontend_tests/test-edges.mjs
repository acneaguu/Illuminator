/* Failure paths, the pack switcher, mock mode, and the column-order defence. */
import { boot, tick } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const live = JSON.parse(readFileSync(join(process.env.TMPDIR || tmpdir(), 'live/session.json'), 'utf8'));
let passed = 0; const failures = [];
const check = (l, c, e = '') => { if (c) { passed++; console.log(`  PASS      ${l}${e ? '  ' + e : ''}`); }
  else { failures.push(l); console.log(`  **FAIL**  ${l}${e ? '  ' + e : ''}`); } };

async function selectBatteryCase(doc, loadModule) {
  await loadModule('app.js');
  await tick(60);
  [...doc.querySelectorAll('.tab')][2].click();
  await tick(40);
}

/* ---------------------------------------------------- 1. engine failure */
console.log('=== 1. simulation fails ===');
{
  const failure = { ...live.status_done, state: 'error', progress: 0.3, rows: 28,
    error: { type: 'KeyError',
             message: "Parameter 'nope' not found in model 'Wind1'. Available parameters: p_rated, ...",
             traceback: 'Traceback (most recent call last):\n  File "engine.py", line 724\nKeyError: ...' } };
  const { doc, loadModule, consoleMessages } = await boot({ routes: {
    'GET /api/packs': () => live.packs,
    'GET /api/packs/{p}/cases/{c}/baseline': () => live.baseline,
    'POST /api/runs': () => ({ ...live.created, state: 'queued' }),
    'GET /api/runs/{id}': () => failure,
    'GET /api/runs/{id}/results': () => ({ ...live.results_full, rows: [], total: 0, next: 0 }),
  }});
  await selectBatteryCase(doc, loadModule);
  // No topology route is stubbed here, so the diagram never mounts and the
  // settings panel has to keep every control rather than hand them to assets.
  check('without a diagram the panel keeps every setting',
    doc.querySelectorAll('#controls .control').length > 0,
    `${doc.querySelectorAll('#controls .control').length} rendered`);
  doc.getElementById('run-btn').click();
  await tick(500);

  const panel = doc.getElementById('error-panel');
  check('error panel shown', !panel.classList.contains('hidden'));
  check('engine message surfaced', panel.textContent.includes("Parameter 'nope' not found"));
  check('traceback shown in a pre', panel.querySelector('pre')?.textContent.includes('Traceback'));
  check('status pill reads Failed', doc.getElementById('status-pill').textContent === 'Failed');
  check('controls re-enabled after failure', !doc.querySelector('#controls input').disabled);
  check('Simulate available again', !doc.getElementById('run-btn').disabled);
  check('no uncaught page errors', consoleMessages.filter(([l]) => l === 'jsdomError').length === 0);
}

/* ------------------------------------------------------------ 2. cancel */
console.log('=== 2. stopping a run ===');
{
  let cancelled = false; let deletes = 0;
  const { doc, loadModule } = await boot({ routes: {
    'GET /api/packs': () => live.packs,
    'GET /api/packs/{p}/cases/{c}/baseline': () => live.baseline,
    'POST /api/runs': () => ({ ...live.created, state: 'queued' }),
    'GET /api/runs/{id}': () => (cancelled
      ? { ...live.status_done, state: 'cancelled', rows: 12, progress: 0.12 }
      : { ...live.status_done, state: 'running', rows: 12, progress: 0.12, error: null }),
    'GET /api/runs/{id}/results': () => ({ ...live.results_full,
      rows: live.results_full.rows.slice(0, 12), total: 12, next: 12 }),
    'DELETE /api/runs/{id}': () => { deletes++; cancelled = true;
      return { ...live.status_done, state: 'cancelled' }; },
  }});
  await selectBatteryCase(doc, loadModule);
  doc.getElementById('run-btn').click();
  await tick(500);
  check('Stop button visible while running', !doc.getElementById('cancel-btn').classList.contains('hidden'));
  doc.getElementById('cancel-btn').click();
  await tick(700);
  check('DELETE sent once', deletes === 1, `${deletes} calls`);
  check('status pill reads Stopped', doc.getElementById('status-pill').textContent === 'Stopped',
    doc.getElementById('status-pill').textContent);
  check('controls re-enabled after stopping', !doc.querySelector('#controls input').disabled);
}

/* ---------------------------------------------------------- 3. conflict */
console.log('=== 3. another run holds the slot (409) ===');
{
  let blocked = true; let cancels = 0; let creates = 0;
  const { doc, loadModule } = await boot({ routes: {
    'GET /api/packs': () => live.packs,
    'GET /api/packs/{p}/cases/{c}/baseline': () => live.baseline,
    'POST /api/runs': () => {
      if (blocked) return { __status: 409, body: { detail: 'a simulation is already running (run-abc); cancel it or wait' } };
      creates++; return { ...live.created, state: 'queued' };
    },
    'GET /api/runs': () => ({ runs: [{ id: 'run-abc', state: 'running' }] }),
    'DELETE /api/runs/{id}': () => { cancels++; blocked = false; return { state: 'cancelled' }; },
    'GET /api/runs/{id}': () => live.status_done,
    'GET /api/runs/{id}/results': () => live.results_full,
    'GET /api/runs/{id}/summary': () => live.summary,
  }});
  await selectBatteryCase(doc, loadModule);
  doc.getElementById('run-btn').click();
  await tick(300);

  const panel = doc.getElementById('error-panel');
  check('conflict explained, not raw', panel.textContent.includes('Another simulation is running'));
  const takeover = panel.querySelector('button');
  check('offers to stop the other run', takeover !== null && /Stop it/.test(takeover.textContent));
  takeover.click();
  await tick(600);
  check('cancelled the blocking run', cancels === 1, `${cancels} cancels`);
  check('then started ours', creates === 1, `${creates} creates`);
  check('error panel cleared', panel.classList.contains('hidden'));
}

/* ------------------------------------------------- 4. column-order defence */
console.log('=== 4. results arrive in a different column order ===');
{
  // Same data, columns permuted -- exactly what the collector does between runs.
  const original = live.results_full;
  const order = [...original.columns].reverse();
  const from = new Map(original.columns.map((c, i) => [c, i + 1]));
  const shuffled = { ...original, columns: order,
    rows: original.rows.map((row) => [row[0], ...order.map((c) => row[from.get(c)])]) };

  const { doc, loadModule } = await boot({ routes: {
    'GET /api/packs': () => live.packs,
    'GET /api/packs/{p}/cases/{c}/baseline': () => live.baseline,
    'POST /api/runs': () => ({ ...live.created, state: 'queued' }),
    'GET /api/runs/{id}': () => live.status_done,
    'GET /api/runs/{id}/results': () => shuffled,
    'GET /api/runs/{id}/summary': () => live.summary,
  }});
  await selectBatteryCase(doc, loadModule);
  doc.getElementById('run-btn').click();
  await tick(700);

  const caseDef = live.packs.packs[0].cases[2];
  const lastRow = original.rows[original.rows.length - 1];
  const expected = caseDef.charts[0].series.map((s) =>
    (lastRow[from.get(s.col)] * (s.sign === undefined ? 1 : s.sign)).toFixed(2));
  const shown = [...doc.querySelectorAll('#charts .chart-card')[0].querySelectorAll('.legend-value')]
    .map((n) => n.textContent);
  check('plots the right series despite reordering', JSON.stringify(shown) === JSON.stringify(expected),
    `shown=${JSON.stringify(shown)}`);
}

/* ------------------------------------------------------ 5. several packs */
console.log('=== 5. a second pack brings up the tutorial switcher ===');
{
  const second = { ...live.packs.packs[0], id: 'power_reserve', title: 'Power Reserve' };
  const routes = {
    'GET /api/packs': () => ({ packs: [live.packs.packs[0], second] }),
    'GET /api/packs/{p}/cases/{c}/baseline': () => live.baseline,
    'GET /api/packs/{p}/cases/{c}/topology': () => live.topology,
  };

  const { doc, window, loadModule } = await boot({ routes });
  await loadModule('app.js');
  await tick(60);

  const switcher = doc.getElementById('pack-switch');
  check('switcher shown with two packs', !switcher.classList.contains('hidden'));
  const buttons = [...switcher.querySelectorAll('.pack-btn')];
  check('one button per pack', buttons.length === 2,
    JSON.stringify(buttons.map((b) => b.textContent)));
  check('the first pack starts selected', buttons[0].getAttribute('aria-pressed') === 'true' &&
    doc.getElementById('pack-title').textContent === live.packs.packs[0].title);

  buttons[1].click();
  await tick(60);
  check('switching packs renames the page',
    doc.getElementById('pack-title').textContent === 'Power Reserve',
    doc.getElementById('pack-title').textContent);
  check('the switcher follows the selection',
    buttons[1].getAttribute('aria-pressed') === 'true' &&
    buttons[0].getAttribute('aria-pressed') === 'false');
  check('the cases are the new pack\'s tabs',
    doc.querySelectorAll('.tab').length === second.cases.length &&
    doc.querySelector('.tab').getAttribute('aria-selected') === 'true');
  check('the URL remembers the tutorial', window.location.search.includes('pack=power_reserve'),
    window.location.search);

  // A shared link (or a reload) lands on the same tutorial.
  const deep = await boot({ routes, query: 'pack=power_reserve' });
  await deep.loadModule('app.js');
  await tick(60);
  check('?pack= deep-links straight to it',
    deep.doc.getElementById('pack-title').textContent === 'Power Reserve',
    deep.doc.getElementById('pack-title').textContent);
}

/* ------------------------------------------------ 6. leaving a case mid-run */
console.log('=== 6. switching case while a run is in flight ===');
{
  const { doc, loadModule } = await boot({ routes: {
    'GET /api/packs': () => live.packs,
    'GET /api/packs/{p}/cases/{c}/baseline': () => live.baseline,
    'GET /api/packs/{p}/cases/{c}/topology': () => live.topology,
    'POST /api/runs': () => ({ ...live.created, state: 'queued' }),
    // Never finishes, so the page is still in its running state when we leave.
    'GET /api/runs/{id}': () => ({ ...live.status_done, state: 'running',
                                   rows: 12, progress: 0.12, error: null }),
    'GET /api/runs/{id}/results': () => ({ ...live.results_full,
      rows: live.results_full.rows.slice(0, 12), total: 12, next: 12 }),
  }});
  await selectBatteryCase(doc, loadModule);
  doc.getElementById('run-btn').click();
  await tick(500);
  check('Simulate is disabled while the run is in flight',
    doc.getElementById('run-btn').disabled);

  // Leave the case. The run carries on server-side, but this view of it ends.
  [...doc.querySelectorAll('.tab')][1].click();
  await tick(60);
  check('Simulate is usable again after leaving', !doc.getElementById('run-btn').disabled);
  check('and reads Simulate, not Simulating…',
    doc.getElementById('run-btn').textContent === 'Simulate',
    doc.getElementById('run-btn').textContent);
  check('the progress bar is put away', doc.getElementById('progress').classList.contains('hidden'));
  check('Stop is put away too', doc.getElementById('cancel-btn').classList.contains('hidden'));
  check('the day picker is editable again', !doc.getElementById('day-input').disabled);
}

/* --------------------------------------------------------- 7. mock mode */
console.log('=== 7. mock mode (?mock=1, fixtures off disk) ===');
{
  const { doc, requests, loadModule, consoleMessages } = await boot({ routes: {}, mock: true });
  await loadModule('app.js');
  await tick(80);
  check('mock badge shown', !doc.getElementById('mock-badge').classList.contains('hidden'));
  check('served from /fixtures, no /api calls',
    requests.every((r) => !r.key.includes('/api/')) && requests.some((r) => r.key.includes('/fixtures/')),
    JSON.stringify(requests.map((r) => r.key).slice(0, 3)));
  check('pack title from fixtures', doc.getElementById('pack-title').textContent.length > 5,
    doc.getElementById('pack-title').textContent);

  [...doc.querySelectorAll('.tab')][2].click();
  await tick(40);
  doc.getElementById('run-btn').click();
  await tick(600);
  check('mock run reports progress', /steps/.test(doc.getElementById('progress-label').textContent),
    doc.getElementById('progress-label').textContent);
  check('no page errors in mock mode',
    consoleMessages.filter(([l]) => l === 'jsdomError').length === 0);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILURES:', failures);
// The topology view keeps an animation frame pending; exit explicitly.
process.exit(failures.length ? 1 : 0);
