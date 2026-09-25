/* Runs the real dashboard frontend in jsdom.
 *
 * fetch() is served from a pluggable backend so the same harness can drive the
 * UI against captured fixtures (mock mode) or against live payloads exported
 * from the running Python backend.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// jsdom is optional dev tooling, installed wherever is convenient. ESM imports
// ignore NODE_PATH, so resolve it through require, which does honour it.
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

// .../dashboard/tools/frontend_tests/harness.mjs -> repository root
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FE = join(ROOT, 'dashboard/frontend');

export async function boot({ routes = {}, mock = false, quiet = true, query = '' } = {}) {
  const html = readFileSync(join(FE, 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  const consoleMessages = [];
  virtualConsole.on('jsdomError', (e) => consoleMessages.push(['jsdomError', e.message]));
  for (const level of ['error', 'warn', 'log']) {
    virtualConsole.on(level, (...args) => {
      consoleMessages.push([level, args.map(String).join(' ')]);
      if (!quiet) console.log(`  [page ${level}]`, ...args);
    });
  }

  const search = [mock ? 'mock=1' : '', query].filter(Boolean).join('&');
  const dom = new JSDOM(html, {
    url: `http://localhost:8000/${search ? `?${search}` : ''}`,
    runScripts: 'dangerously',
    resources: undefined,
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  // --- shims jsdom lacks -------------------------------------------------
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.structuredClone = window.structuredClone || ((v) => JSON.parse(JSON.stringify(v)));
  window.devicePixelRatio = 1;
  // uPlot tracks DPI changes through matchMedia, which jsdom does not implement.
  window.matchMedia = window.matchMedia || ((query) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));

  // uPlot builds strokes with Path2D, which jsdom does not implement.
  window.Path2D = class Path2D {
    constructor() { this.ops = []; }
    moveTo(...a) { this.ops.push(['moveTo', a]); }
    lineTo(...a) { this.ops.push(['lineTo', a]); }
    rect(...a) { this.ops.push(['rect', a]); }
    arc(...a) { this.ops.push(['arc', a]); }
    ellipse(...a) { this.ops.push(['ellipse', a]); }
    bezierCurveTo(...a) { this.ops.push(['bezierCurveTo', a]); }
    quadraticCurveTo(...a) { this.ops.push(['quadraticCurveTo', a]); }
    closePath() { this.ops.push(['closePath', []]); }
    addPath(other) { if (other && other.ops) this.ops.push(...other.ops); }
  };

  // uPlot draws to a canvas; jsdom has no 2d context, so record the calls
  // instead. Enough for uPlot to run, and it lets us assert it actually drew.
  const canvasCalls = [];
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    const handler = {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args) => { canvasCalls.push([prop, args]); };
      },
      set(target, prop, value) { target[prop] = value; return true; },
    };
    // Only methods with meaningful return values are defined; everything else
    // falls through to the proxy and is recorded, so the call count is real.
    return new Proxy({
      canvas: this,
      measureText: (t) => ({ width: String(t).length * 7 }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      createLinearGradient: () => ({ addColorStop() {} }),
    }, handler);
  };
  // Elements report zero size in jsdom; give the chart holder a real width.
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth',
    { configurable: true, get() { return 800; } });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight',
    { configurable: true, get() { return 300; } });

  // jsdom lays nothing out, so every bounding rect is zero and uPlot would map
  // any pointer to the left edge. Report the shimmed size instead, which makes
  // hover and click on a chart testable. The mapping is not pixel-exact (the
  // plot area is narrower than the element), so tests assert on what the page
  // reports for a position rather than on a computed index.
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const width = this.clientWidth;
    const height = this.clientHeight;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height,
             width, height, toJSON() { return this; } };
  };

  // --- fetch --------------------------------------------------------------
  // jsdom exposes no Response constructor, so hand back the minimal shape
  // api.js consumes: ok / status / text() / json().
  const makeResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
    async json() { return JSON.parse(body); },
  });

  const requests = [];
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost:8000');
    const key = `${(init.method || 'GET').toUpperCase()} ${url.pathname}`;
    requests.push({ key, search: url.search, body: init.body ? JSON.parse(init.body) : undefined });

    for (const [pattern, handler] of Object.entries(routes)) {
      const [method, path] = pattern.split(' ');
      const re = new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$');
      if ((init.method || 'GET').toUpperCase() === method && re.test(url.pathname)) {
        const result = await handler(url, init);
        const status = result && result.__status ? result.__status : 200;
        const payload = result && result.__status ? result.body : result;
        return makeResponse(status, JSON.stringify(payload));
      }
    }
    // Static files (fixtures, in mock mode) come off disk.
    const onDisk = join(ROOT, 'dashboard', url.pathname);
    if (existsSync(onDisk)) return makeResponse(200, readFileSync(onDisk, 'utf8'));
    return makeResponse(404, JSON.stringify({ detail: `no route for ${key}` }));
  };

  // --- load the modules the page declares --------------------------------
  // jsdom will not fetch them itself, so evaluate them in order by hand.
  window.eval(readFileSync(join(FE, 'vendor/uplot.iife.min.js'), 'utf8'));

  const modules = new Map();
  async function loadModule(name) {
    if (modules.has(name)) return modules.get(name);
    let source = readFileSync(join(FE, name), 'utf8');
    const imports = [...source.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/([^']+)';?/g)];
    for (const [full, names, dep] of imports) {
      const mod = await loadModule(dep);
      const binding = names.split(',').map((n) => n.trim()).map((n) => {
        const [orig, alias] = n.split(/\s+as\s+/);
        return `const ${alias || orig} = __mods[${JSON.stringify(dep)}].${orig};`;
      }).join('\n');
      source = source.replace(full, binding);
      modules.set(dep, mod);
    }
    const exported = [];
    source = source.replace(/export\s+(const|function|class)\s+([A-Za-z0-9_$]+)/g, (m, kind, id) => {
      exported.push(id); return `${kind} ${id}`;
    });
    const factory = window.eval(`(function(__mods){\n${source}\n; return {${exported.join(',')}};})`);
    const result = factory(Object.fromEntries(modules));
    modules.set(name, result);
    return result;
  }

  return { dom, window, doc: window.document, requests, canvasCalls, consoleMessages, loadModule };
}

export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
