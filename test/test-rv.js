/* El territorio personal: los cuatro campos de una revisita, el historial de
   regresos, y la garantia de que nada de esto pidio una columna nueva.

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

process.env.AUTH_SECRET = 'local-rv-test-secret';
const { sign } = require(p('_auth.js'));
const SC = require(p('_scope.js'));
const territory = require(p('territory.js'));

function call(handler, { method = 'POST', token = '', body = null, headers = {} } = {}) {
  return new Promise(resolve => {
    const req = { method, headers: Object.assign({}, headers, token ? { authorization: 'Bearer ' + token } : {}), body: body || undefined, on() {} };
    const res = { _status: 200, setHeader() {}, status(s) { this._status = s; return this; },
      json(o) { resolve({ status: this._status, body: o }); return this; },
      end() { resolve({ status: this._status, body: null }); return this; } };
    handler(req, res);
  });
}
const H = (tok, method, body, headers) => call(territory, { method, token: tok, body, headers });

let fails = 0, checks = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && extra !== '' ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};
const houseRow = id => DB.Houses.find(x => x.id === id);
const rvOf = id => JSON.parse(houseRow(id).HouseReturnVisits || '[]');
const byId = (id, eid) => rvOf(id).find(e => e.i === eid);

const now = Date.now();
const tonight = (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); })();

DB.Users = [
  { id: 'admin1', name: 'Ada Admin', role: 'admin', active: '1', _key: 'u1' },
  { id: 'own1', name: 'Owen Owner', role: 'user', active: '1', _key: 'u2' },
  { id: 'hlp1', name: 'Hal Helper', role: 'user', active: '1', _key: 'u3' },
];
DB.Territories = [{ name: 'T-1', ownerId: 'own1', assigneeIds: 'hlp1', working: '1', updatedAt: '', _key: 't1' }];
DB.Houses = [1, 2, 3].map(i => ({
  id: 'h' + i, HouseAddress: i + ' Test St', HouseTerritoryNumber: 'T-1',
  HouseVisitLog: '', HouseReturnVisits: '', HouseUpdatedAt: '2026-01-01T00:00:00.000Z', _key: 'x' + i,
}));
DB.Assignments = [];

const tok = uid => sign({ uid, exp: now + 3600e3 });
const OWNER = tok('own1'), HELPER = tok('hlp1');

// Una revisita con todo lo que ahora se pregunta en la puerta.
const full = {
  i: 'r1', d: '2026-08-30',
  s: 'Hablamos de por qué Dios permite el sufrimiento',
  rd: '2026-09-06', rt: '18:30',
  p: 'Llevarle el folleto y leer Apocalipsis 21:4',
  n: 'Tiene dos niños; mejor después de las 6',
};

(async () => {
  // ══ los cuatro campos llegan enteros ═══════════════════════════════════
  await H(OWNER, 'PATCH', { id: 'h1', HouseReturnVisits: JSON.stringify([full]) });
  const got = byId('h1', 'r1');
  check('de qué hablaron se guarda', got && got.s === full.s, got && got.s);
  check('la fecha de regreso se guarda', got && got.rd === '2026-09-06', got && got.rd);
  check('la hora de regreso se guarda', got && got.rt === '18:30', got && got.rt);
  check('el plan para la próxima se guarda', got && got.p === full.p, got && got.p);
  check('las notas adicionales se guardan', got && got.n === full.n, got && got.n);
  check('y queda firmada por quien la levantó', got && got.u === 'own1', got && got.u);

  // ══ acentos, comillas y saltos de línea ════════════════════════════════
  const messy = { i: 'r2', d: '2026-08-30', s: 'Dijo "vuelva el jueves"\nse llama Ángel — 3ro',
    p: 'Ñoño & <b>negritas</b>' };
  await H(OWNER, 'PATCH', { id: 'h1', HouseReturnVisits: JSON.stringify(rvOf('h1').concat([messy])) });
  check('comillas, acentos y saltos de línea sobreviven el viaje',
    byId('h1', 'r2').s === messy.s, JSON.stringify(byId('h1', 'r2').s));
  check('y los signos que romperían el HTML también',
    byId('h1', 'r2').p === messy.p, byId('h1', 'r2').p);

  // ══ una entrada se escribe una sola vez ════════════════════════════════
  await H(OWNER, 'PATCH', { id: 'h1', HouseReturnVisits: JSON.stringify([
    { i: 'r1', d: '2026-08-30', s: 'REESCRITO', rd: '2030-01-01', p: 'REESCRITO' }]) });
  check('un teléfono atrasado no puede reescribir la revisita',
    byId('h1', 'r1').s === full.s, byId('h1', 'r1').s);
  check('ni moverle la cita', byId('h1', 'r1').rd === '2026-09-06', byId('h1', 'r1').rd);

  // ══ volver a la puerta agrega, no reemplaza ════════════════════════════
  const back = { i: 'r3', d: '2026-09-06', s: 'Leímos Apocalipsis 21:4, le gustó',
    rd: '2026-09-13', rt: '10:00', p: 'Empezar el curso bíblico' };
  await H(OWNER, 'PATCH', { id: 'h1', HouseReturnVisits: JSON.stringify(rvOf('h1').concat([back])) });
  check('la visita siguiente entra como registro nuevo', !!byId('h1', 'r3'));
  check('y la primera sigue completa', byId('h1', 'r1').s === full.s);
  check('el historial guarda las dos citas',
    rvOf('h1').filter(e => e.rd).map(e => e.rd).sort().join(',') === '2026-09-06,2026-09-13',
    rvOf('h1').filter(e => e.rd).map(e => e.rd).sort().join(','));

  // ══ una revisita de otra persona no es mía ═════════════════════════════
  await H(HELPER, 'PATCH', { id: 'h2', HouseReturnVisits: JSON.stringify([
    { i: 's1', d: '2026-08-30', s: 'Del ayudante', rd: '2026-09-09' }]) });
  check('cada quien firma la suya', byId('h2', 's1').u === 'hlp1', byId('h2', 's1').u);
  await H(HELPER, 'PATCH', { id: 'h2', HouseReturnVisits: JSON.stringify(rvOf('h2').concat([
    { i: 's2', d: '2026-08-30', s: 'Firmada con un nombre inventado', u: 'no-existe' }])) });
  check('un autor inventado se reemplaza por el de verdad',
    byId('h2', 's2').u === 'hlp1', byId('h2', 's2').u);
  /* Un id de usuario REAL sí se respeta, a proposito: es como un telefono
     alcanza a subir lo que otro anoto sin señal, sin robarle la autoria. */
  await H(HELPER, 'PATCH', { id: 'h2', HouseReturnVisits: JSON.stringify(rvOf('h2').concat([
    { i: 's3', d: '2026-08-30', s: 'Anotada por Owen, subida por Hal', u: 'own1' }])) });
  check('pero una firma de alguien real se respeta, para poder relevar',
    byId('h2', 's3').u === 'own1', byId('h2', 's3').u);

  /* Con acceso SOLO por autoría, la casa se ve pero las revisitas ajenas no:
     el territorio personal es de quien lo levantó. */
  DB.Territories[0].assigneeIds = '';
  DB.Houses.find(x => x.id === 'h3').HouseReturnVisits = JSON.stringify([
    { i: 'm1', d: '2026-08-20', s: 'La mía', rd: '2026-09-20', u: 'hlp1' },
    { i: 'o1', d: '2026-08-21', s: 'La de otro', rd: '2026-09-21', u: 'own1' },
  ]);
  const seen = await H(HELPER, 'GET');
  const h3 = (seen.body || []).find(x => x.id === 'h3');
  check('la casa sigue visible por haber levantado la revisita', !!h3,
    (seen.body || []).map(x => x.id).join(','));
  const mine = h3 ? JSON.parse(h3.HouseReturnVisits || '[]') : [];
  check('pero solo se ve la revisita propia',
    mine.length === 1 && mine[0].i === 'm1', mine.map(e => e.i).join(','));

  // ══ borrar deja lápida, no hueco ═══════════════════════════════════════
  await H(OWNER, 'PATCH', { id: 'h1', HouseReturnVisits: JSON.stringify(
    rvOf('h1').map(e => e.i === 'r2' ? Object.assign({}, e, { x: 1 }) : e)) });
  check('una revisita borrada queda marcada', byId('h1', 'r2').x === 1);
  await H(OWNER, 'PATCH', { id: 'h1', HouseReturnVisits: JSON.stringify([
    { i: 'r2', d: '2026-08-30', s: messy.s }]) });
  check('y un teléfono atrasado no la revive', byId('h1', 'r2').x === 1);

  // ══ la garantía que sostiene todo lo demás ═════════════════════════════
  check('NO se agregó ninguna columna: la lista sigue con 22',
    SC.HOUSES_TAB.cols.length === 22, SC.HOUSES_TAB.cols.length);
  check('todo cabe dentro de HouseReturnVisits',
    SC.HOUSES_TAB.cols.indexOf('HouseReturnVisits') !== -1);

  console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
