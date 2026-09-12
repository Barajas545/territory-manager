/* Cambiarle el nombre a un territorio.

   El nombre no es una etiqueta: es la llave que une siete listas. Esta suite
   existe para una sola pregunta — despues de renombrar, ¿queda algo apuntando
   al nombre viejo? Si queda, el territorio se ve vacio o una entrega se rompe,
   y eso se descubre un domingo con el grupo parado en la banqueta.

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

process.env.AUTH_SECRET = 'local-rename-test-secret';
const { sign } = require(p('_auth.js'));
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
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const now = Date.now();
const VIEJO = 'Paso Robles 3';
const NUEVO = 'Paso Robles #P3';

function sembrar() {
  DB.Users = [
    { id: 'admin1', name: 'Ada', role: 'admin', active: '1', _key: 'u1' },
    { id: 'user1', name: 'Beto', role: 'user', active: '1', _key: 'u2' },
  ];
  DB.Territories = [
    { name: VIEJO, ownerId: 'user1', assigneeIds: '', working: '1', updatedAt: '', _key: 't1' },
    { name: 'Atascadero 3', ownerId: '', assigneeIds: '', working: '1', updatedAt: '', _key: 't2' },
  ];
  // Tres del territorio que se renombra y uno de otro, para ver que no se lo lleva.
  DB.Houses = [
    { id: 'h1', HouseAddress: '905 Stoney Creek Rd', HouseTerritoryNumber: VIEJO, HouseUpdatedAt: '', _key: 'x1' },
    { id: 'h2', HouseAddress: '1129 Stoney Creek Rd', HouseTerritoryNumber: VIEJO, HouseUpdatedAt: '', _key: 'x2' },
    { id: 'h3', HouseAddress: '2173 Bel Air Pl', HouseTerritoryNumber: VIEJO, HouseUpdatedAt: '', _key: 'x3' },
    { id: 'h9', HouseAddress: '6440 Ardilla Rd', HouseTerritoryNumber: 'Atascadero 3', HouseUpdatedAt: '', _key: 'x9' },
  ];
  DB.Assignments = [
    { id: 'p1', territory: VIEJO, ownerId: 'user1', assigneeId: '', guestName: 'Hno Lopez',
      guestCode: 'ABC123', houseIds: 'h1,h2', createdAt: '', expiresAt: String(now + 3600e3), active: '1', _key: 'a1' },
    { id: 'p2', territory: 'Atascadero 3', ownerId: 'user1', assigneeId: '', guestName: 'Otro',
      guestCode: 'ZZZ999', houseIds: 'h9', createdAt: '', expiresAt: String(now + 3600e3), active: '1', _key: 'a2' },
  ];
  DB.TerritoryLog = [
    { id: 'L1', territory: VIEJO, userId: 'user1', userName: 'Beto', assignedAt: '', assignedOn: '2026-01-05',
      assignedBy: 'admin1', returnedAt: '', returnedOn: '', returnedBy: '', note: '', _key: 'l1' },
    { id: 'L2', territory: VIEJO, userId: 'user1', userName: 'Beto', assignedAt: '', assignedOn: '2025-06-01',
      assignedBy: 'admin1', returnedAt: '', returnedOn: '2025-09-01', returnedBy: 'admin1', note: '', _key: 'l2' },
  ];
  DB.TerritoryBounds = [
    { id: 'B1', territory: VIEJO, points: '[[35.6,-120.7],[35.6,-120.6],[35.5,-120.6]]',
      updatedAt: '', updatedBy: 'admin1', _key: 'b1' },
  ];
  DB.Presence = [{ userId: 'user1', territory: VIEJO, lat: '35.6', lng: '-120.7', acc: '10', ts: String(now), _key: 'pr1' }];
  DB.Voice = [{ id: 'V1', territory: VIEJO, userId: 'user1', ts: String(now), dur: '3', audio: 'x', _key: 'v1' }];
}

const tok = uid => sign({ uid, exp: now + 3600e3 });
const ADMIN = tok('admin1'), USER = tok('user1');

// Cuenta cuanto sigue apuntando a un nombre.
const apuntanA = nombre => {
  let k = 0;
  (DB.Houses || []).forEach(h => { if (h.HouseTerritoryNumber === nombre) k++; });
  (DB.Territories || []).forEach(t => { if (t.name === nombre) k++; });
  ['Assignments', 'TerritoryLog', 'TerritoryBounds', 'Presence', 'Voice'].forEach(L => {
    (DB[L] || []).forEach(r => { if (r.territory === nombre) k++; });
  });
  return k;
};

(async () => {
  sembrar();
  const antes = apuntanA(VIEJO);
  check('el territorio empieza con 10 renglones apuntándole', antes === 10, antes);

  // ══ solo el administrador ══════════════════════════════════════════════
  let r = await T(USER, 'renameTerritory', { from: VIEJO, to: NUEVO });
  check('quien no es administrador no puede renombrar', r.status === 403, JSON.stringify(r.body));
  check('y no movió nada', apuntanA(VIEJO) === 10, apuntanA(VIEJO));

  // ══ la cascada completa ════════════════════════════════════════════════
  r = await T(ADMIN, 'renameTerritory', { from: VIEJO, to: NUEVO });
  check('el administrador sí', r.status === 200, JSON.stringify(r.body));
  check('NO queda NADA apuntando al nombre viejo', apuntanA(VIEJO) === 0, apuntanA(VIEJO));
  check('y todo apunta al nuevo', apuntanA(NUEVO) === 10, apuntanA(NUEVO));

  // Lista por lista, porque "nada quedó" podría esconder que algo se borró.
  check('los 3 domicilios se mudaron',
    DB.Houses.filter(h => h.HouseTerritoryNumber === NUEVO).length === 3);
  check('el domicilio de OTRO territorio no se tocó',
    DB.Houses.find(h => h.id === 'h9').HouseTerritoryNumber === 'Atascadero 3');
  check('la entrega de números sigue viva y con el nombre nuevo',
    DB.Assignments.find(a => a.id === 'p1').territory === NUEVO &&
    DB.Assignments.find(a => a.id === 'p1').guestCode === 'ABC123');
  check('la entrega del otro territorio no se tocó',
    DB.Assignments.find(a => a.id === 'p2').territory === 'Atascadero 3');
  check('las dos entradas del historial se mudaron',
    DB.TerritoryLog.filter(l => l.territory === NUEVO).length === 2);
  check('el historial conserva sus fechas',
    DB.TerritoryLog.find(l => l.id === 'L1').assignedOn === '2026-01-05' &&
    DB.TerritoryLog.find(l => l.id === 'L2').returnedOn === '2025-09-01');
  check('el contorno del mapa se mudó CON sus puntos',
    DB.TerritoryBounds[0].territory === NUEVO &&
    DB.TerritoryBounds[0].points.indexOf('35.6') !== -1,
    DB.TerritoryBounds[0].points);
  check('la ubicación compartida se mudó', DB.Presence[0].territory === NUEVO);
  check('el mensaje de voz se mudó', DB.Voice[0].territory === NUEVO);
  check('el territorio quedó con el nombre nuevo',
    DB.Territories.find(t => t._key === 't1').name === NUEVO);
  check('y conservó a su dueño',
    DB.Territories.find(t => t._key === 't1').ownerId === 'user1');
  check('sigue habiendo DOS territorios, no se juntaron', DB.Territories.length === 2);

  // ══ el nombre nuevo se ve donde se debe ════════════════════════════════
  r = await T(ADMIN, 'listTerritories', {});
  const nombres = (r.body.territories || []).map(t => t.name);
  check('listTerritories ya lo llama por el nombre nuevo',
    nombres.indexOf(NUEVO) !== -1 && nombres.indexOf(VIEJO) === -1, nombres.join(','));
  const conBordes = (r.body.territories || []).find(t => t.name === NUEVO);
  check('y su contorno sigue llegando con él', conBordes && conBordes.bounds.length === 3,
    conBordes && conBordes.bounds.length);

  // ══ lo que NO se debe poder hacer ══════════════════════════════════════
  r = await T(ADMIN, 'renameTerritory', { from: NUEVO, to: 'Atascadero 3' });
  check('no se puede usar el nombre de otro territorio', r.status === 400, JSON.stringify(r.body));
  check('y ese intento no movió nada', apuntanA(NUEVO) === 10, apuntanA(NUEVO));

  r = await T(ADMIN, 'renameTerritory', { from: 'No existe', to: 'Cualquiera' });
  check('no se puede renombrar uno que no existe', r.status === 404);

  r = await T(ADMIN, 'renameTerritory', { from: NUEVO, to: '   ' });
  check('no se puede dejar sin nombre', r.status === 400, JSON.stringify(r.body));

  // ══ repetirlo no hace daño ═════════════════════════════════════════════
  r = await T(ADMIN, 'renameTerritory', { from: NUEVO, to: NUEVO });
  check('renombrarlo a lo mismo es inofensivo', r.status === 200, JSON.stringify(r.body));
  check('y todo sigue en su sitio', apuntanA(NUEVO) === 10, apuntanA(NUEVO));

  // ══ terminar un cambio que se quedó a medias ═══════════════════════════
  /* Si se cayera la señal a media cascada, el renglon del territorio seria lo
     ultimo en moverse: quedaria con el nombre viejo y el resto con el nuevo.
     Volver a intentarlo tiene que terminar el trabajo, no romperlo mas. */
  sembrar();
  DB.Houses.forEach(h => { if (h.HouseTerritoryNumber === VIEJO) h.HouseTerritoryNumber = NUEVO; });
  DB.Assignments.find(a => a.id === 'p1').territory = NUEVO;
  r = await T(ADMIN, 'renameTerritory', { from: VIEJO, to: NUEVO });
  check('un cambio a medias se termina al reintentarlo', r.status === 200, JSON.stringify(r.body));
  check('y al final tampoco queda nada en el nombre viejo', apuntanA(VIEJO) === 0, apuntanA(VIEJO));
  check('con los 10 renglones completos en el nuevo', apuntanA(NUEVO) === 10, apuntanA(NUEVO));

  console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
