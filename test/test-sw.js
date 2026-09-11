/* El service worker de verdad, corriendo en Node con almacenes falsos.

   Lo que se prueba es el orden en que busca un pedazo de mapa: primero el
   descargado a proposito, luego lo que se fue guardando de andar mirando, y
   solo entonces la red. Ese orden es todo el asunto — al reves, el recorte del
   segundo almacen podria tirar lo que alguien bajo anoche para hoy.

   Se prueba aqui porque el panel del navegador no deja registrar un service
   worker; asi al menos la decision no queda sin verificar. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = process.argv[2] || path.resolve(__dirname, '..');

let fails = 0, checks = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

// ── almacenes falsos, del tamaño justo para esta decision ────────────────
function makeCaches() {
  const stores = new Map();
  const api = {
    _stores: stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async match(req) { return m.get(String(req.url || req)) || undefined; },
        async put(req, res) { m.set(String(req.url || req), res); },
        async keys() { return [...m.keys()].map(u => ({ url: u })); },
        async delete(k) { return m.delete(String(k.url || k)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(n) { return stores.delete(n); },
    async match() { return undefined; },
  };
  return api;
}

function loadSW(caches, fetchImpl) {
  const listeners = {};
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: {},
  };
  const sandbox = {
    self, caches, fetch: fetchImpl, URL, Response: class { constructor(b, o) { Object.assign(this, o || {}); this.body = b; } },
    console, setTimeout, Promise,
  };
  sandbox.self.location = { href: 'https://x/territory-manager/sw.js' };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), sandbox);
  return { listeners, sandbox };
}

// Un evento de fetch falso que guarda lo que el service worker contesta.
function fireFetch(listeners, url) {
  let answered = null;
  const ev = {
    request: { method: 'GET', url },
    respondWith(p) { answered = p; },
  };
  listeners.fetch(ev);
  return answered;
}

const TILE = 'https://tile.openstreetmap.org/17/21601/51699.png';

(async () => {
  // ══ el mapa descargado gana ════════════════════════════════════════════
  {
    let fueALaRed = false;
    const caches = makeCaches();
    const { listeners } = loadSW(caches, async () => { fueALaRed = true; return { ok: true, type: 'basic', clone: () => ({}) }; });
    const guardado = await caches.open('tm-map-saved');
    await guardado.put(TILE, { marca: 'DESCARGADO' });
    const navegado = await caches.open('tm-tiles-v1');
    await navegado.put(TILE, { marca: 'de andar mirando' });

    const r = await fireFetch(listeners, TILE);
    check('un pedazo descargado se sirve del mapa guardado',
      r && r.marca === 'DESCARGADO', r && r.marca);
    check('y no se toca la red', fueALaRed === false);
  }

  // ══ lo que no se descargo, del otro almacen ════════════════════════════
  {
    let fueALaRed = false;
    const caches = makeCaches();
    const { listeners } = loadSW(caches, async () => { fueALaRed = true; return { ok: true, type: 'basic', clone: () => ({}) }; });
    const navegado = await caches.open('tm-tiles-v1');
    await navegado.put(TILE, { marca: 'de andar mirando' });

    const r = await fireFetch(listeners, TILE);
    check('sin mapa descargado, sirve lo que ya se habia mirado',
      r && r.marca === 'de andar mirando', r && r.marca);
    check('tampoco toca la red', fueALaRed === false);
  }

  // ══ y si no hay nada, la red ═══════════════════════════════════════════
  {
    let pedidas = 0;
    const caches = makeCaches();
    const { listeners } = loadSW(caches, async () => {
      pedidas++;
      return { ok: true, type: 'basic', marca: 'de la red', clone: () => ({ marca: 'copia' }) };
    });
    const r = await fireFetch(listeners, TILE);
    check('sin nada guardado, va a la red', r && r.marca === 'de la red', r && r.marca);
    check('una sola vez', pedidas === 1, pedidas);
    const navegado = await caches.open('tm-tiles-v1');
    check('y lo guarda para la proxima', !!(await navegado.match(TILE)));
  }

  // ══ sin señal y sin mapa: no revienta ══════════════════════════════════
  {
    const caches = makeCaches();
    const { listeners } = loadSW(caches, async () => { throw new TypeError('Failed to fetch'); });
    const r = await fireFetch(listeners, TILE);
    check('sin señal contesta 504 en vez de reventar', r && r.status === 504, r && r.status);
  }

  // ══ sin señal PERO con mapa descargado: se ve ══════════════════════════
  {
    const caches = makeCaches();
    const { listeners } = loadSW(caches, async () => { throw new TypeError('Failed to fetch'); });
    const guardado = await caches.open('tm-map-saved');
    await guardado.put(TILE, { marca: 'DESCARGADO' });
    const r = await fireFetch(listeners, TILE);
    check('SIN SEÑAL, el mapa descargado se sigue viendo',
      r && r.marca === 'DESCARGADO', r && r.marca);
  }

  // ══ la limpieza de versiones no se lo lleva ════════════════════════════
  {
    const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    check('el mapa guardado sobrevive a una versión nueva',
      /keep = new Set\(\[[^\]]*SAVED_TILES/.test(src));
    check('y el recorte de 800 no lo toca',
      /async function trimTiles[\s\S]{0,300}TILE_CACHE/.test(src) &&
      !/trimTiles[\s\S]{0,300}SAVED_TILES/.test(src));
  }

  console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
