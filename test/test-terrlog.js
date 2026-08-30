/* The territory record card: who has what, and who has had it. */

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
    async updateMany(spec, e) { for (const x of e) await this.update(spec, x.key, x.obj); },
    async remove(spec, keys) { DB[spec.name] = (DB[spec.name] || []).filter(r => keys.indexOf(r._key) === -1); },
  };
}
const storePath = require.resolve(p('_store.js'));
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true,
  exports: { makeStore: fakeStore, colLetter: () => 'A' } };

process.env.AUTH_SECRET = 'local-terrlog-secret';
const { sign } = require(p('_auth.js'));
const team = require(p('team.js'));

function call(handler, { token = '', body = null } = {}) {
  return new Promise(resolve => {
    const req = { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: body || undefined, on() {} };
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
const log = () => DB.TerritoryLog || [];
const openRows = () => log().filter(r => !r.returnedAt);

const now = Date.now();
DB.Users = [
  { id: 'admin1', name: 'Ada Admin', role: 'admin', active: '1', _key: 'u1' },
  { id: 'ann', name: 'Ann Reyes', role: 'user', active: '1', _key: 'u2' },
  { id: 'bob', name: 'Bob Silva', role: 'user', active: '1', _key: 'u3' },
  { id: 'cid', name: 'Cid Nunez', role: 'user', active: '1', _key: 'u4' },
];
DB.Territories = [
  { name: 'T-1', ownerId: '', assigneeIds: '', working: '0', updatedAt: '', _key: 't1' },
  { name: 'T-2', ownerId: '', assigneeIds: '', working: '0', updatedAt: '', _key: 't2' },
];
const ADMIN = sign({ uid: 'admin1', exp: now + 3600e3 });
const ANN = sign({ uid: 'ann', exp: now + 3600e3 });

(async () => {
  // ══ checking one out ════════════════════════════════════════════════════
  let r = await T(ADMIN, 'assignTerritory', { territory: 'T-1', ownerId: 'ann' });
  check('assigning a territory opens a record', r.body.recorded === true && log().length === 1, log().length);
  check('...with the date and who did it',
    !!log()[0].assignedAt && log()[0].userId === 'ann' && log()[0].assignedBy === 'admin1',
    JSON.stringify({ at: log()[0].assignedAt, by: log()[0].assignedBy }));
  check('...and no return date yet', !log()[0].returnedAt);
  check('...and the name is written down beside the id',
    log()[0].userName === 'Ann Reyes', log()[0].userName);

  // Saving the same sheet again must not fill the history with nothing.
  r = await T(ADMIN, 'assignTerritory', { territory: 'T-1', ownerId: 'ann', assigneeIds: ['bob'] });
  check('re-saving with the same holder records nothing new',
    log().length === 1 && r.body.recorded === false, log().length);

  // ══ handing it straight to somebody else ════════════════════════════════
  r = await T(ADMIN, 'assignTerritory', { territory: 'T-1', ownerId: 'bob' });
  check('handing it on closes the old record and opens a new one',
    log().length === 2 && openRows().length === 1, log().length + ' rows, ' + openRows().length + ' open');
  const annRow = log().find(x => x.userId === 'ann');
  check('...Ann\'s record now has a return date', !!annRow.returnedAt, annRow.returnedAt);
  check('...and Bob is the one holding it', openRows()[0].userId === 'bob');

  // ══ giving it back ══════════════════════════════════════════════════════
  r = await T(ADMIN, 'returnTerritory', { territory: 'T-1', note: 'finished the street' });
  check('returning it closes the record', r.status === 200 && openRows().length === 0, openRows().length);
  check('...and the territory has nobody holding it',
    DB.Territories.find(t => t.name === 'T-1').ownerId === '',
    DB.Territories.find(t => t.name === 'T-1').ownerId);
  check('...and stops being worked',
    DB.Territories.find(t => t.name === 'T-1').working === '0');
  check('...keeping the note', log().find(x => x.userId === 'bob').note === 'finished the street');

  // ══ the history reads back ══════════════════════════════════════════════
  await T(ADMIN, 'assignTerritory', { territory: 'T-2', ownerId: 'cid' });
  r = await T(ADMIN, 'territoryHistory', {});
  check('the history lists every check-out', r.body.records.length === 3, r.body.records.length);
  check('...newest first', r.body.records[0].territory === 'T-2', r.body.records[0].territory);
  check('...naming the person, not their id',
    r.body.records.every(x => /Ann|Bob|Cid/.test(x.who)), JSON.stringify(r.body.records.map(x => x.who)));
  check('every territory is listed, held or not', r.body.territories.length === 2);
  const t1 = r.body.territories.find(x => x.name === 'T-1');
  const t2 = r.body.territories.find(x => x.name === 'T-2');
  check('an unheld territory shows as unheld', !t1.ownerId && !t1.assignedOn, JSON.stringify(t1));
  check('a held one shows who and since when',
    t2.ownerId === 'cid' && !!t2.assignedOn, JSON.stringify(t2));

  r = await T(ADMIN, 'territoryHistory', { territory: 'T-1' });
  check('it can be asked about one territory', r.body.records.length === 2, r.body.records.length);

  // ══ who may see it ══════════════════════════════════════════════════════
  r = await T(ANN, 'territoryHistory', {});
  check('the record card is the admin\'s', r.status === 403, r.status);
  r = await T(ANN, 'returnTerritory', { territory: 'T-2' });
  check('and so is handing one back', r.status === 403, r.status);
  r = await T(ADMIN, 'returnTerritory', { territory: 'nope' });
  check('returning something that does not exist is a 404', r.status === 404, r.status);

  // ══ the current holder rides along with the ordinary list ═══════════════
  r = await T(ADMIN, 'listTerritories');
  const lt2 = r.body.territories.find(x => x.name === 'T-2');
  check('the territory list carries the date it was handed over',
    !!lt2.assignedOn, lt2.assignedOn);

  // ══ a territory held since before the card existed ═════════════════════
  DB.Territories.push({ name: 'T-9', ownerId: 'ann', assigneeIds: '', working: '1', updatedAt: '', _key: 't9' });
  r = await T(ADMIN, 'territoryHistory', {});
  let t9 = r.body.territories.find(x => x.name === 'T-9');
  check('an already-held territory shows no invented start date',
    t9.ownerId === 'ann' && t9.assignedOn === '' && t9.hasRecord === false, JSON.stringify(t9));

  r = await T(ADMIN, 'setTerritoryStart', { territory: 'T-9', assignedOn: '2026-03-12' });
  check('the admin can write down the date they remember', r.status === 200, JSON.stringify(r.body));
  r = await T(ADMIN, 'territoryHistory', {});
  t9 = r.body.territories.find(x => x.name === 'T-9');
  check('...and it sticks', t9.assignedOn === '2026-03-12', t9.assignedOn);
  r = await T(ADMIN, 'setTerritoryStart', { territory: 'T-9', assignedOn: '2026-01-01' });
  check('...but it cannot overwrite a date already recorded', r.status === 400, r.status);
  r = await T(ADMIN, 'setTerritoryStart', { territory: 'T-9', assignedOn: '2099-01-01' });
  check('...nor be in the future', r.status === 400, r.status);

  // Handing on a territory that predates the card must not erase the holder.
  DB.Territories.push({ name: 'T-8', ownerId: 'bob', assigneeIds: '', working: '1', updatedAt: '', _key: 't8' });
  r = await T(ADMIN, 'assignTerritory', { territory: 'T-8', ownerId: 'ann' });
  const t8rows = log().filter(x => x.territory === 'T-8');
  check('handing on an unlogged territory records the person who had it',
    t8rows.length === 2 && t8rows.some(x => x.userId === 'bob' && x.returnedAt),
    JSON.stringify(t8rows.map(x => x.userId + (x.returnedAt ? ':closed' : ':open'))));
  check('...with the start date honestly blank',
    (t8rows.find(x => x.userId === 'bob') || {}).assignedOn === '');

  // Returning one that predates the card leaves a trace rather than nothing.
  DB.Territories.push({ name: 'T-7', ownerId: 'cid', assigneeIds: '', working: '1', updatedAt: '', _key: 't7' });
  r = await T(ADMIN, 'returnTerritory', { territory: 'T-7' });
  const t7 = log().filter(x => x.territory === 'T-7');
  check('returning an unlogged territory still records who had it',
    t7.length === 1 && t7[0].userId === 'cid' && !!t7[0].returnedOn,
    JSON.stringify(t7.map(x => x.userId + '→' + x.returnedOn)));

  // ══ dates are calendar days, not the server's UTC instant ═══════════════
  const anyRec = log().find(x => x.assignedOn);
  check('a recorded date is a plain day', /^\d{4}-\d{2}-\d{2}$/.test(anyRec.assignedOn), anyRec.assignedOn);

  // ══ taking on an unclaimed territory by handing numbers out ═════════════
  DB.Territories.push({ name: 'T-6', ownerId: '', assigneeIds: '', working: '0', updatedAt: '', _key: 't6' });
  DB.Houses = [{ id: 'hx', HouseAddress: '1 X St', HouseTerritoryNumber: 'T-6', HouseVisitLog: '', _key: 'hx' }];
  r = await T(ANN, 'createAssignment', { territory: 'T-6', houseIds: ['hx'], guestName: 'zz' });
  check('a stranger cannot claim an unheld territory by handing its numbers out',
    r.status === 403, r.status);
  r = await T(ADMIN, 'createAssignment', { territory: 'T-6', houseIds: ['hx'], guestName: 'zz' });
  const t6 = log().filter(x => x.territory === 'T-6');
  check('but when an admin does, it goes on the card',
    r.status === 200 && t6.length === 1 && t6[0].userId === 'admin1',
    r.status + ' ' + JSON.stringify(t6.map(x => x.userId)));

  // ══ a deleted account does not erase the history ════════════════════════
  await T(ADMIN, 'deleteUser', { id: 'cid' });
  r = await T(ADMIN, 'territoryHistory', {});
  const cidRow = r.body.records.find(x => x.userId === 'cid');
  check('a deleted person still reads by name in the history',
    cidRow && cidRow.who === 'Cid Nunez', cidRow && cidRow.who);

  console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
