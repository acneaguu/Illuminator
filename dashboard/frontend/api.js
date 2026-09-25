/* Talking to the dashboard backend.
 *
 * Every network call goes through here, which gives mock mode a single seam:
 * with `?mock=1` the same functions answer from the captured fixtures in
 * `dashboard/fixtures/`, so the UI can be developed and demonstrated without a
 * running engine. See ../API.md for the contract these mirror.
 */

const params = new URLSearchParams(location.search);

/** Serve from captured fixtures instead of the live API (`?mock=1`). */
export const MOCK = params.get('mock') === '1';

/** How long a mocked run pretends to take, in milliseconds. */
const MOCK_RUN_MS = 4000;

export class ApiError extends Error {
  constructor(status, detail, payload) {
    super(typeof detail === 'string' ? detail : `request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.payload = payload;
  }
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }

  if (!response.ok) {
    // Every error carries `detail`, but 422 (request validation) makes it a
    // list of per-field objects rather than a string -- see ../API.md.
    const detail = payload && payload.detail !== undefined ? payload.detail : payload;
    throw new ApiError(response.status, normaliseDetail(detail), payload);
  }
  return payload;
}

function normaliseDetail(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        const where = Array.isArray(item.loc) ? item.loc.filter((p) => p !== 'body').join('.') : '';
        return where ? `${where}: ${item.msg}` : item.msg;
      })
      .join('; ');
  }
  return detail ? String(detail) : 'request failed';
}

/* ------------------------------------------------------------------ mock */

const fixtureCache = new Map();

async function fixture(name) {
  if (!fixtureCache.has(name)) {
    const response = await fetch(`/fixtures/${name}.json`);
    if (!response.ok) {
      throw new ApiError(response.status, `fixture '${name}' not found — mock mode needs ` +
        `dashboard/fixtures/ to be served at /fixtures (the backend does this automatically)`);
    }
    fixtureCache.set(name, await response.json());
  }
  // Cloned: callers may mutate what they get back.
  return structuredClone(fixtureCache.get(name));
}

/** State of the single fake run mock mode keeps, so progress can advance. */
let mockRun = null;

function mockProgressRows(total) {
  if (!mockRun) return 0;
  const fraction = Math.min(1, (Date.now() - mockRun.startedAt) / MOCK_RUN_MS);
  return Math.floor(fraction * total);
}

/* ------------------------------------------------------------------- api */

export const api = {
  mock: MOCK,

  async health() {
    return MOCK ? fixture('health') : request('GET', '/api/health');
  },

  async packs() {
    return MOCK ? fixture('packs') : request('GET', '/api/packs');
  },

  async topology(pack, caseId) {
    if (MOCK) return fixture(`topology_${caseId}`);
    return request('GET', `/api/packs/${enc(pack)}/cases/${enc(caseId)}/topology`);
  },

  async baseline(pack, caseId, { day, settings } = {}) {
    if (MOCK) return fixture('baseline_base');
    const query = new URLSearchParams();
    if (day) query.set('day', day);
    // Control values keyed by control id, exactly as POST /api/runs takes
    // them; the server ignores unknown ids and clamps out-of-range values.
    for (const [id, value] of Object.entries(settings || {})) {
      if (value !== undefined && value !== null) query.set(id, String(value));
    }
    const suffix = query.toString() ? `?${query}` : '';
    return request('GET', `/api/packs/${enc(pack)}/cases/${enc(caseId)}/baseline${suffix}`);
  },

  async createRun(body) {
    if (MOCK) {
      const created = await fixture('run_created');
      mockRun = { id: created.id, startedAt: Date.now() };
      return { ...created, state: 'queued', rows: 0, progress: 0 };
    }
    return request('POST', '/api/runs', body);
  },

  async runs() {
    return MOCK ? { runs: [] } : request('GET', '/api/runs');
  },

  async runStatus(id) {
    if (MOCK) {
      const done = await fixture('run_done');
      if (mockRun && mockRun.cancelled) return { ...done, state: 'cancelled', progress: 0 };
      const rows = mockProgressRows(done.expected_steps);
      if (rows >= done.expected_steps) return done;
      return { ...done, state: 'running', rows, finished_at: null,
               progress: rows / done.expected_steps };
    }
    return request('GET', `/api/runs/${enc(id)}`);
  },

  async runResults(id, since = 0) {
    if (MOCK) {
      const full = await fixture('results_full');
      const status = await this.runStatus(id);
      const available = status.state === 'running' ? status.rows : full.total;
      const start = Math.min(since, available);
      return { ...full, rows: full.rows.slice(start, available), since: start,
               next: available, total: available,
               state: status.state, complete: status.state !== 'running' };
    }
    return request('GET', `/api/runs/${enc(id)}/results?since=${encodeURIComponent(since)}`);
  },

  async runSummary(id) {
    return MOCK ? fixture('summary') : request('GET', `/api/runs/${enc(id)}/summary`);
  },

  async runRanges(id) {
    return MOCK ? fixture('ranges') : request('GET', `/api/runs/${enc(id)}/ranges`);
  },

  async runLog(id, tail = 60) {
    if (MOCK) return { id, log: '(no log in mock mode)' };
    return request('GET', `/api/runs/${enc(id)}/log?tail=${tail}`);
  },

  async cancelRun(id) {
    if (MOCK) {
      if (mockRun) mockRun.cancelled = true;
      const done = await fixture('run_done');
      return { ...done, state: 'cancelled' };
    }
    return request('DELETE', `/api/runs/${enc(id)}`);
  },
};

function enc(value) {
  return encodeURIComponent(value);
}
