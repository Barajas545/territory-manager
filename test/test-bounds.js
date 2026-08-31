/* Los limites de cada territorio: quien puede moverlos, que forma se acepta,
   y la garantia de que esto no pidio una columna nueva en Territories.

   Corre los manejadores de verdad contra un almacen en memoria. */

const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const p = f => path.join(ROOT, 'api', f);

const DB = {};
let seq = 1;
const clone = o => JSON.parse(JSON.stringify(o));

function fakeStore() {
  return {
    backend: 'memory',
    async read(spec) { return (DB[spec.name] || []).map(clone); },
    async readFresh(spec) { return (DB[spec.name] || []).map(clone); },
    async create(spec, obj) {
      DB[spec.name] = DB[spec.name] || [];
      const rec = clone(obj); rec._key = 'k' + (seq++); DB[spec.name].push(rec);
    },
    async createMany(spec, objs) { for (const o of objs) await this.create(spec, o); },
    async update(spec, key, obj) {
      const rows = DB[spec.name] || [];
      const i = rows.findIndex(r => r._key === key);
      if (i !== -1) { const rec = clone(obj); rec._key = key; rows[i] = rec; }
    },
    async updateMany(spec, entries) { for (const e of entries) await this.update(spec, e.key, e.obj); },
    async remove(spec, keys) { DB[spec.name] = (DB[spec.name] || []).filter(r => keys.indexOf(r._key) === -1); },
  };
}
const storePath = require.resolve(p('_store.js'));
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true,
  exports: { makeStore: fakeStore, colLetter: () => 'A' } };

process.env.AUTH_SECRET = 'local-bounds-test-secret';
const { sign } = require(p('_auth.js'));
const AS = require(p('_assign.js'));
const BD = require(p('_bounds.js'));
const team = require(p('team.js'));

function call(handler, { method = 'POST', token = '', body = null } = {}) {
  return new Promise(resolve => {
    const req = { method, headers: token ? { authorization: 'Bearer ' + token } : {}, body: body || undefined, on() {} };
    const res = { _status: 200, setHeader() {}, status(s) { this._status = s; return this; },
      json(o) { resolve({ status: this._status, body: o }); return this; },
      end() { resolve({ status: this._status, body: null }); return this; } };
    handler(req, res);
  });
}
const T = (tok, action, payload) => call(team, { body: Object.assign({ action }, payload || {}), token: tok });

let fails = 0, checks = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && extra !== '' ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const now = Date.now();
DB.Users = [
  { id: 'admin1', name: 'Ada Admin', role: 'admin', active: '1', _key: 'u1' },
  { id: 'own1', name: 'Owen Owner', role: 'user', active: '1', _key: 'u2' },
];
DB.Territories = [
  { name: 'T-1', ownerId: 'own1', assigneeIds: '', working: '1', updatedAt: '', _key: 't1' },
  { name: 'T-2', ownerId: 'own1', assigneeIds: '', working: '1', updatedAt: '', _key: 't2' },
];
DB.Houses = [];
DB.Assignments = [];

const tok = uid => sign({ uid, exp: now + 3600e3 });
const ADMIN = tok('admin1'), OWNER = tok('own1');

// Una manzana cuadrada de Atascadero, con la casa 'dentro' en el centro.
const SQUARE = [[35.490, -120.672], [35.490, -120.668], [35.486, -120.668], [35.486, -120.672]];
const boundRows = () => DB.TerritoryBounds || [];

(async () => {
  // ══ solo el administrador mueve la linea ═══════════════════════════════
  let r = await T(OWNER, 'setTerritoryBounds', { territory: 'T-1', points: SQUARE });
  check('el dueño del territorio NO puede mover su propio límite', r.status === 403,
    JSON.stringify(r.body));
  check('y no se guardó nada', boundRows().length === 0, boundRows().length);

  r = await T(ADMIN, 'setTerritoryBounds', { territory: 'T-1', points: SQUARE });
  check('el administrador sí puede', r.status === 200, JSON.stringify(r.body).slice(0, 60));
  check('devuelve los cuatro puntos', (r.body.bounds || []).length === 4,
    (r.body.bounds || []).length);

  // ══ el contorno viaja con el territorio ════════════════════════════════
  r = await T(ADMIN, 'listTerritories', {});
  const t1 = (r.body.territories || []).find(t => t.name === 'T-1');
  check('listTerritories trae el límite pegado', !!t1 && t1.bounds.length === 4,
    t1 && JSON.stringify(t1.bounds[0]));
  check('con los números tal cual, no como texto',
    !!t1 && typeof t1.bounds[0][0] === 'number', typeof (t1 && t1.bounds[0][0]));
  const t2 = (r.body.territories || []).find(t => t.name === 'T-2');
  check('un territorio sin límite trae una lista vacía, no falta el campo',
    !!t2 && Array.isArray(t2.bounds) && t2.bounds.length === 0);

  // ══ se reemplaza, no se acumula ════════════════════════════════════════
  const five = SQUARE.concat([[35.488, -120.670]]);
  await T(ADMIN, 'setTerritoryBounds', { territory: 'T-1', points: five });
  check('volver a guardar deja UN renglón, no dos', boundRows().length === 1, boundRows().length);
  check('y el dibujo es el nuevo', BD.parsePoints(boundRows()[0].points).length === 5,
    BD.parsePoints(boundRows()[0].points).length);

  // ══ formas que no son una figura ═══════════════════════════════════════
  r = await T(ADMIN, 'setTerritoryBounds', { territory: 'T-1', points: [[35.49, -120.67], [35.48, -120.66]] });
  check('dos puntos no cierran una figura', r.status === 400, JSON.stringify(r.body));
  check('y el límite anterior queda intacto',
    BD.parsePoints(boundRows()[0].points).length === 5,
    BD.parsePoints(boundRows()[0].points).length);

  r = await T(ADMIN, 'setTerritoryBounds', { territory: 'T-9', points: SQUARE });
  check('no se puede marcar un territorio que no existe', r.status === 404, JSON.stringify(r.body));

  // ══ basura adentro ═════════════════════════════════════════════════════
  const messy = [[35.490, -120.672], ['x', 'y'], [999, -120.67], [35.486, -120.668],
    null, [35.486, -120.672], [35.4885, -120.6701234567]];
  r = await T(ADMIN, 'setTerritoryBounds', { territory: 'T-2', points: messy });
  const kept = r.body.bounds || [];
  check('los puntos que no son puntos se descartan', kept.length === 4, kept.length);
  check('una latitud imposible también', !kept.some(pt => Math.abs(pt[0]) > 90));
  check('y se redondea a 6 decimales', kept[3][1] === -120.670123, kept[3][1]);

  // ══ borrar ═════════════════════════════════════════════════════════════
  r = await T(ADMIN, 'setTerritoryBounds', { territory: 'T-2', points: [] });
  check('guardar cero puntos borra el contorno', r.status === 200 && r.body.bounds.length === 0,
    JSON.stringify(r.body.bounds));
  check('pero deja el renglón, no lo elimina', boundRows().length === 2, boundRows().length);
  r = await T(ADMIN, 'listTerritories', {});
  const t2b = (r.body.territories || []).find(t => t.name === 'T-2');
  check('y el mapa ya no lo recibe', t2b.bounds.length === 0, t2b.bounds.length);

  // ══ el tope ════════════════════════════════════════════════════════════
  const many = [];
  for (let i = 0; i < 400; i++) many.push([35.48 + i * 0.0001, -120.67]);
  r = await T(ADMIN, 'setTerritoryBounds', { territory: 'T-1', points: many });
  check('un dibujo enorme se recorta al tope', r.body.bounds.length === BD.MAX_POINTS,
    r.body.bounds.length);

  // ══ la garantía que sostiene todo lo demás ═════════════════════════════
  check('NO se agregó ninguna columna a Territories: siguen 5',
    AS.TERR_TAB.cols.length === 5, AS.TERR_TAB.cols.join(','));
  check('los límites viven en su propia lista',
    BD.BOUNDS_TAB.name === 'TerritoryBounds', BD.BOUNDS_TAB.name);

  console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
