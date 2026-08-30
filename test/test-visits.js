/* Four visits, Do Not Visit, and return visits that outlive a territory.
   Runs the real handlers against an in-memory store. */

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

process.env.AUTH_SECRET = 'local-visit-test-secret';
const { sign } = require(p('_auth.js'));
const SC = require(p('_scope.js'));
const territory = require(p('territory.js'));
const team = require(p('team.js'));

function call(handler, { method = 'POST', token = '', body = null, headers = {} } = {}) {
  return new Promise(resolve => {
    const req = { method, headers: Object.assign({}, headers, token ? { authorization: 'Bearer ' + token } : {}), body: body || undefined, on() {} };
    const res = { _status: 200, setHeader() {}, status(s) { this._status = s; return this; },
      json(o) { resolve({ status: this._status, body: o }); return this; },
      end() { resolve({ status: this._status, body: null }); return this; } };
    handler(req, res);
  });
}
const T = (tok, action, payload) => call(team, { body: Object.assign({ action }, payload || {}), token: tok });
const H = (tok, method, body, headers) => call(territory, { method, token: tok, body, headers });

let fails = 0, checks = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && extra !== '' ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};
const houseRow = id => DB.Houses.find(x => x.id === id);
const logOf = id => JSON.parse(houseRow(id).HouseVisitLog || '[]');
const rvOf = id => JSON.parse(houseRow(id).HouseReturnVisits || '[]');

const now = Date.now();
const tonight = (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); })();

DB.Users = [
  { id: 'admin1', name: 'Ada Admin', role: 'admin', active: '1', _key: 'u1' },
  { id: 'own1', name: 'Owen Owner', role: 'user', active: '1', _key: 'u2' },
  { id: 'hlp1', name: 'Hal Helper', role: 'user', active: '1', _key: 'u3' },
  { id: 'out1', name: 'Ozzy Outsider', role: 'user', active: '1', _key: 'u4' },
];
DB.Territories = [{ name: 'T-1', ownerId: 'own1', assigneeIds: '', working: '1', updatedAt: '', _key: 't1' }];
DB.Houses = [1, 2, 3, 4].map(i => ({
  id: 'h' + i, HouseAddress: i + ' Test St', HouseTerritoryNumber: 'T-1',
  HouseVisitLog: '', HouseReturnVisits: '', HouseUpdatedAt: '2026-01-01T00:00:00.000Z', _key: 'x' + i,
}));
DB.Assignments = [{ id: 'p1', territory: 'T-1', ownerId: 'own1', assigneeId: 'hlp1', guestName: '',
  guestCode: 'GST1', houseIds: 'h1,h2', createdAt: '', expiresAt: String(tonight), active: '1', _key: 'a1' }];

const tok = uid => sign({ uid, exp: now + 3600e3 });
const ADMIN = tok('admin1'), OWNER = tok('own1'), HELPER = tok('hlp1'), OUT = tok('out1');
const GUEST = sign({ g: 'p1', exp: now + 3600e3 });

const visit = (i, d, t, k) => ({ i: i, d: d, t: t, k: k });

(async () => {
  // ══ four visits, not five ═══════════════════════════════════════════════
  let log = [];
  for (let i = 1; i <= 5; i++) {
    log.push(visit('v' + i, '2026-08-0' + i, 'Visit ' + i, 'NH'));
    await H(OWNER, 'PATCH', { id: 'h1', HouseVisitLog: JSON.stringify(log) });
  }
  let row = houseRow('h1');
  check('the row projects the LAST four visits',
    [1, 2, 3, 4].map(n => row['HouseResutsOnVisit' + n]).join('|') === 'Visit 2|Visit 3|Visit 4|Visit 5',
    [1, 2, 3, 4].map(n => row['HouseResutsOnVisit' + n]).join('|'));
  check('the fifth column is cleared, not left stale', row.HouseResutsOnVisit5 === '',
    JSON.stringify(row.HouseResutsOnVisit5));
  check('but the record still holds all five', logOf('h1').filter(e => !e.x).length === 5,
    logOf('h1').length);
  check('the schema still has 22 columns',
    require(p('territory.js')) && SC.HOUSES_TAB.cols.length === 22, SC.HOUSES_TAB.cols.length);

  // ══ an entry is written once ════════════════════════════════════════════
  await H(OWNER, 'PATCH', { id: 'h1', HouseVisitLog: JSON.stringify([visit('v1', '2026-08-01', 'REWRITTEN', 'W')]) });
  check('a stale phone cannot rewrite an entry it still remembers',
    logOf('h1').find(e => e.i === 'v1').t === 'Visit 1',
    logOf('h1').find(e => e.i === 'v1').t);
  await H(OWNER, 'PATCH', { id: 'h1', HouseVisitLog: JSON.stringify([{ i: 'v1', d: '2026-08-01', t: 'Visit 1', k: 'NH', x: 1 }]) });
  check('but a correction can tombstone it', logOf('h1').find(e => e.i === 'v1').x === 1);
  await H(OWNER, 'PATCH', { id: 'h1', HouseVisitLog: JSON.stringify([visit('v1', '2026-08-01', 'Visit 1', 'NH')]) });
  check('and a stale replay cannot bring it back', logOf('h1').find(e => e.i === 'v1').x === 1);

  // ══ authorship ══════════════════════════════════════════════════════════
  await H(HELPER, 'PATCH', { id: 'h2', HouseVisitLog: JSON.stringify([visit('a1', '2026-08-23', 'Not home', 'NH')]) });
  check('an entry is stamped with whoever recorded it',
    logOf('h2').find(e => e.i === 'a1').u === 'hlp1', logOf('h2').find(e => e.i === 'a1').u);
  await H(HELPER, 'PATCH', { id: 'h2', HouseVisitLog: JSON.stringify(logOf('h2').concat([
    { i: 'forge', d: '2026-08-23', t: 'x', k: 'NH', u: 'nobody-at-all' }])) });
  check('an invented author is replaced with the real one',
    logOf('h2').find(e => e.i === 'forge').u === 'hlp1', logOf('h2').find(e => e.i === 'forge').u);
  await H(HELPER, 'PATCH', { id: 'h2', HouseVisitLog: JSON.stringify(logOf('h2').concat([
    { i: 'queued', d: '2026-08-23', t: 'written before signing out', k: 'NH', u: 'own1' }])) });
  check('a note queued under another live account keeps its author',
    logOf('h2').find(e => e.i === 'queued').u === 'own1');
  await H(GUEST, 'PATCH', { id: 'h1', HouseVisitLog: JSON.stringify(logOf('h1').concat([
    { i: 'g1', d: '2026-08-23', t: 'guest visit', k: 'NH', u: 'own1' }])) });
  check('a guest mints no authorship at all',
    logOf('h1').find(e => e.i === 'g1') && !logOf('h1').find(e => e.i === 'g1').u);

  // ══ return visits are the access ════════════════════════════════════════
  let r = await H(OUT, 'GET');
  check('an outsider sees nothing to begin with', r.body.length === 0, r.body.length);
  DB.Houses.find(x => x.id === 'h3').HouseReturnVisits =
    JSON.stringify([{ i: 'rv1', d: '2026-08-20', n: 'Studies on Tuesdays', u: 'out1' }]);
  r = await H(OUT, 'GET');
  check('a return visit keeps that ONE house visible to its author',
    r.body.length === 1 && r.body[0].id === 'h3', r.body.map(x => x.id).join(','));
  check('...and it is marked as held that way', r.body[0].HouseAccess === 'rv', r.body[0].HouseAccess);
  check('...without leaking the rest of the territory',
    !r.body.some(x => x.id === 'h1' || x.id === 'h4'));

  r = await H(OUT, 'PUT', { updates: [{ id: 'h3', HouseAddress: 'HACKED', HouseNotes: 'mine now' }] }, { 'x-tm-client': '3' });
  check('but it is not a licence to edit the house',
    houseRow('h3').HouseAddress === '3 Test St', houseRow('h3').HouseAddress);
  check('...and the refusal is named', (r.body.rejected || []).some(x => x.code === 'rv_field'),
    JSON.stringify(r.body.rejected));

  r = await H(OUT, 'PUT', { updates: [{ id: 'h3', HouseReturnVisits: JSON.stringify(rvOf('h3').concat([
    { i: 'rv2', d: '2026-08-23', n: 'Brought the magazine' }])) }] }, { 'x-tm-client': '3' });
  check('they can still add to their own return visit',
    rvOf('h3').some(e => e.i === 'rv2'), JSON.stringify(rvOf('h3').map(e => e.i)));

  r = await H(OUT, 'PUT', { updates: [{ id: 'h3', HouseReturnVisits: JSON.stringify(
    rvOf('h3').map(e => (e.i === 'rv1' ? Object.assign({}, e, { x: 1 }) : e))
      .map(e => (e.i === 'rv2' ? Object.assign({}, e, { x: 1 }) : e)) ) }] }, { 'x-tm-client': '3' });
  r = await H(OUT, 'GET');
  check('withdrawing their own notes hands the key back', r.body.length === 0, r.body.map(x => x.id).join(','));

  // ══ Do Not Visit ════════════════════════════════════════════════════════
  const dnv = (i, d, reason) => ({ i: i, d: d, t: 'Do not visit', k: 'DNV', r: reason });
  r = await H(GUEST, 'PATCH', { id: 'h1', HouseVisitLog: JSON.stringify(logOf('h1').concat([dnv('d1', '2026-08-23', 'asked us not to call')])) });
  check('a guest cannot retire an address', r.status === 403, r.status);
  r = await H(OWNER, 'PATCH', { id: 'h4', HouseVisitLog: JSON.stringify([dnv('d1', '2026-08-23', 'asked us not to call again')]) });
  check('somebody working the territory can', r.status === 200, r.status);
  check('...and it does not read as a visit today',
    !houseRow('h4').HouseLastVisitDate, JSON.stringify(houseRow('h4').HouseLastVisitDate));
  check('...nor take a visit box', houseRow('h4').HouseResutsOnVisit1 === '',
    houseRow('h4').HouseResutsOnVisit1);
  const st = SC.dnvState(houseRow('h4'));
  check('the state derives from the entry', st.on && st.reason === 'asked us not to call again' && st.by === 'own1',
    JSON.stringify(st));

  r = await H(OWNER, 'PATCH', { id: 'h4', HouseNotes: 'anything at all' });
  check('a marked address is closed for changes', r.status === 403, r.status);
  r = await H(OWNER, 'PATCH', { id: 'h4', HouseVisitLog: JSON.stringify(logOf('h4').concat([
    visit('late', '2026-08-22', 'Called on Tuesday, before it was marked', 'NH')])) });
  check('...but a note from before it was marked still lands', r.status === 200, r.status);
  r = await H(OWNER, 'PATCH', { id: 'h4', HouseReturnVisits: JSON.stringify([{ i: 'nope', d: '2026-08-23', n: 'start a study' }]) });
  check('a new return visit cannot be started there', r.status === 403, r.status);
  r = await H(OWNER, 'DELETE', { id: 'h4' });
  check('and the record cannot be deleted out from under it', r.status === 403, r.status);

  r = await H(OWNER, 'PATCH', { id: 'h4', HouseVisitLog: JSON.stringify(logOf('h4').concat([
    { i: 'x1', d: '2026-08-24', t: 'cleared', k: 'DNVX' }])) });
  check('only an admin can lift it', r.status === 403, r.status);
  r = await H(OWNER, 'PATCH', { id: 'h4', HouseVisitLog: JSON.stringify(
    logOf('h4').map(e => (e.k === 'DNV' ? Object.assign({}, e, { x: 1 }) : e))) });
  check('and it cannot be deleted instead of cleared', r.status === 403, r.status);
  check('...the decision is still there', SC.dnvState(houseRow('h4')).on);

  r = await H(ADMIN, 'PATCH', { id: 'h4', HouseVisitLog: JSON.stringify(logOf('h4').concat([
    { i: 'x1', d: '2026-08-24', t: 'Spoke to the new owner', k: 'DNVX' }])) });
  check('an admin clears it by appending, not erasing', r.status === 200 && !SC.dnvState(houseRow('h4')).on,
    r.status + ' on=' + SC.dnvState(houseRow('h4')).on);
  check('...and the original decision survives in the history',
    logOf('h4').some(e => e.k === 'DNV' && !e.x && e.r === 'asked us not to call again'));
  r = await H(OWNER, 'PATCH', { id: 'h4', HouseNotes: 'now editable again' });
  check('once cleared the address is workable again', r.status === 200, r.status);

  // ══ packets never contain a retired address ═════════════════════════════
  await H(OWNER, 'PATCH', { id: 'h4', HouseVisitLog: JSON.stringify(logOf('h4').concat([dnv('d2', '2026-08-25', 'again')])) });
  r = await T(OWNER, 'createAssignment', { territory: 'T-1', houseIds: ['h3', 'h4'], guestName: 'zz' });
  check('a marked address cannot be handed out', r.status === 400, JSON.stringify(r.body).slice(0, 90));

  console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
