/* The visibility rules, exercised locally against an in-memory store.

   Runs the real handlers — api/territory.js and api/team.js — with _store.js
   swapped for a fake, so every rule can be checked in a second without touching
   SharePoint or anybody's real territory. */

const path = require('path');
const API = path.resolve(__dirname, '../../../../../../I:/');   // replaced below

const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const p = f => path.join(ROOT, 'api', f);

/* ── an in-memory store, shaped exactly like _store.js ──────────────────── */
const DB = {};                                     // listName -> [row]
let seq = 1;
const clone = o => JSON.parse(JSON.stringify(o));

function fakeStore() {
  return {
    backend: 'memory',
    async read(spec) { return (DB[spec.name] || []).map(clone); },
    async readFresh(spec) { return (DB[spec.name] || []).map(clone); },
    async create(spec, obj) {
      DB[spec.name] = DB[spec.name] || [];
      const rec = clone(obj); rec._key = 'k' + (seq++);
      DB[spec.name].push(rec);
    },
    async createMany(spec, objs) { for (const o of objs) await this.create(spec, o); },
    async update(spec, key, obj) {
      const rows = DB[spec.name] || [];
      const i = rows.findIndex(r => r._key === key);
      if (i !== -1) { const rec = clone(obj); rec._key = key; rows[i] = rec; }
    },
    async updateMany(spec, entries) { for (const e of entries) await this.update(spec, e.key, e.obj); },
    async remove(spec, keys) {
      DB[spec.name] = (DB[spec.name] || []).filter(r => keys.indexOf(r._key) === -1);
    },
  };
}

// Swap the store before the handlers are loaded.
const storePath = require.resolve(p('_store.js'));
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true,
  exports: { makeStore: fakeStore, colLetter: () => 'A' },
};

process.env.AUTH_SECRET = 'local-rules-test-secret';
const { sign } = require(p('_auth.js'));
const territory = require(p('territory.js'));
const team = require(p('team.js'));

/* ── a minimal req/res pair ─────────────────────────────────────────────── */
function call(handler, { method = 'POST', token = '', body = null, headers = {} } = {}) {
  return new Promise(resolve => {
    const req = {
      method,
      headers: Object.assign({}, headers, token ? { authorization: 'Bearer ' + token } : {}),
      body: body || undefined,
      on() {},
    };
    const res = {
      _status: 200,
      setHeader() {},
      status(s) { this._status = s; return this; },
      json(o) { resolve({ status: this._status, body: o }); return this; },
      end() { resolve({ status: this._status, body: null }); return this; },
    };
    handler(req, res);
  });
}
const T = (token, action, payload) => call(team, { body: Object.assign({ action }, payload || {}), token });
const H = (token, method, body, headers) => call(territory, { method, token, body, headers });

let fails = 0, checks = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && extra !== '' ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

/* ── the world ──────────────────────────────────────────────────────────── */
const now = Date.now();
const tonight = (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); })();

DB.Users = [
  { id: 'admin1', name: 'Ada Admin', role: 'admin', active: '1', _key: 'u1' },
  { id: 'own1', name: 'Owen Owner', role: 'user', active: '1', _key: 'u2' },
  { id: 'shr1', name: 'Shari Shared', role: 'user', active: '1', _key: 'u3' },
  { id: 'hlp1', name: 'Hal Helper', role: 'user', active: '1', _key: 'u4' },
  { id: 'non1', name: 'Nora Nothing', role: 'user', active: '1', _key: 'u5' },
  { id: 'off1', name: 'Otto Off', role: ' USER ', active: '0', _key: 'u6' },
];
DB.Territories = [
  { name: 'T-1', ownerId: 'own1', assigneeIds: 'shr1,ghost-deleted-id', working: '1', updatedAt: '', _key: 't1' },
  { name: 'T-2', ownerId: 'admin1', assigneeIds: '', working: '1', updatedAt: '', _key: 't2' },
];
DB.Houses = [
  { id: 'h1', HouseAddress: '1 A St', HouseTerritoryNumber: 'T-1', HouseUpdatedAt: '2026-01-01T00:00:00.000Z', _key: 'x1' },
  { id: 'h2', HouseAddress: '2 A St', HouseTerritoryNumber: 't-1', HouseUpdatedAt: '2026-01-01T00:00:00.000Z', _key: 'x2' },
  { id: 'h3', HouseAddress: '3 A St', HouseTerritoryNumber: 'T-1', HouseUpdatedAt: '2026-01-01T00:00:00.000Z', _key: 'x3' },
  { id: 'h9', HouseAddress: '9 B St', HouseTerritoryNumber: 'T-2', HouseUpdatedAt: '2026-01-01T00:00:00.000Z', _key: 'x9' },
  { id: 'orph', HouseAddress: '0 Nowhere', HouseTerritoryNumber: '', HouseUpdatedAt: '2026-01-01T00:00:00.000Z', _key: 'x0' },
];
DB.Assignments = [
  { id: 'p1', territory: 'T-1', ownerId: 'own1', assigneeId: 'hlp1', guestName: '', guestCode: '',
    houseIds: 'h1,h2', createdAt: '', expiresAt: String(tonight), active: '1', _key: 'a1' },
  { id: 'p-dead', territory: 'T-1', ownerId: 'own1', assigneeId: 'hlp1', guestName: '', guestCode: '',
    houseIds: 'h3', createdAt: '', expiresAt: String(now - 3600e3), active: '1', _key: 'a2' },
  { id: 'p-guest', territory: 'T-1', ownerId: 'own1', assigneeId: '', guestName: 'Gus', guestCode: 'GUEST1',
    houseIds: 'h3', createdAt: '', expiresAt: String(tonight), active: '1', _key: 'a3' },
];

const tok = uid => sign({ uid, exp: now + 3600e3 });
const gtok = g => sign({ g, exp: now + 3600e3 });
const ADMIN = tok('admin1'), OWNER = tok('own1'), SHARED = tok('shr1'),
  HELPER = tok('hlp1'), NOBODY = tok('non1'), OFF = tok('off1'), GHOST = tok('deleted-user');
const GUEST = gtok('p-guest');

(async () => {
  // ══ who sees what ═══════════════════════════════════════════════════════
  let r = await H(ADMIN, 'GET');
  check('admin sees every house, orphan included', r.body.length === 5, r.body.length);

  r = await H(OWNER, 'GET');
  check('owner sees their territory', r.body.map(x => x.id).sort().join(',') === 'h1,h2,h3', r.body.map(x => x.id).join(','));
  check('...case difference in the territory name does not orphan a house',
    r.body.some(x => x.id === 'h2'));

  r = await H(SHARED, 'GET');
  check('someone the territory is shared with sees all of it', r.body.length === 3, r.body.length);

  r = await H(HELPER, 'GET');
  check('a helper sees only the numbers handed to them', r.body.map(x => x.id).sort().join(',') === 'h1,h2',
    r.body.map(x => x.id).join(','));
  check('...and not the ones on an expired packet', !r.body.some(x => x.id === 'h3'));

  r = await H(NOBODY, 'GET');
  check('someone with nothing sees nothing, with a 200', r.status === 200 && r.body.length === 0, r.status);

  r = await H(GUEST, 'GET');
  check('a guest still sees exactly their packet', r.body.length === 1 && r.body[0].id === 'h3',
    r.body.map(x => x.id).join(','));

  r = await H(OFF, 'GET');
  check('a deactivated account is refused', r.status === 403, r.status);
  r = await H(GHOST, 'GET');
  check('a token naming a deleted account is 403, not 401', r.status === 403, r.status);

  // ══ writes ══════════════════════════════════════════════════════════════
  r = await H(HELPER, 'PATCH', { id: 'h9', HouseNotes: 'nope' });
  check('helper cannot touch another territory', r.status === 403, r.status);

  r = await H(HELPER, 'PATCH', { id: 'h1', HouseNotes: 'perro en el patio' });
  check('helper can write on their own number', r.status === 200, r.status);

  r = await H(HELPER, 'PATCH', { id: 'h1', HouseTerritoryNumber: 'T-2' });
  check('helper cannot move a house out of the territory',
    DB.Houses.find(x => x.id === 'h1').HouseTerritoryNumber === 'T-1',
    DB.Houses.find(x => x.id === 'h1').HouseTerritoryNumber);

  r = await H(HELPER, 'PATCH', { id: 'h1', HouseDeleted: '1' });
  check('helper cannot delete by writing the flag',
    DB.Houses.find(x => x.id === 'h1').HouseDeleted !== '1');

  r = await H(HELPER, 'DELETE', { id: 'h1' });
  check('helper cannot delete a house they hold', r.status === 403, r.status);
  r = await H(OWNER, 'DELETE', { id: 'h9' });
  check('owner cannot delete another territory\'s house', r.status === 403, r.status);
  r = await H(OWNER, 'DELETE', { id: 'h3' });
  check('owner can delete their own', r.status === 200, r.status);
  DB.Houses.find(x => x.id === 'h3').HouseDeleted = '';   // put it back for later checks

  r = await H(HELPER, 'POST', { id: 'new1', HouseAddress: 'x', HouseTerritoryNumber: 'T-1' });
  check('a numbers-only user cannot add a house', r.status === 403, r.status);
  r = await H(OWNER, 'POST', { id: 'new2', HouseAddress: 'x', HouseTerritoryNumber: 'T-2' });
  check('an owner cannot add into another territory', r.status === 403, r.status);
  r = await H(OWNER, 'POST', { id: 'new3', HouseAddress: 'x', HouseTerritoryNumber: 'T-1' });
  check('an owner can add into their own', r.status === 200, r.status);
  r = await H(OWNER, 'POST', { id: 'h1', HouseAddress: 'dup', HouseTerritoryNumber: 'T-1' });
  check('a duplicate id is refused', r.status === 409, r.status);
  r = await H(ADMIN, 'POST', { id: 'new4', HouseAddress: 'x', HouseTerritoryNumber: '' });
  check('even an admin must say which territory', r.status === 400, r.status);

  // ══ bulk sync ═══════════════════════════════════════════════════════════
  r = await H(HELPER, 'PUT', {
    updates: [{ id: 'h1', HouseNotes: 'mine' }, { id: 'h9', HouseNotes: 'not mine' }],
    creates: [{ id: 'sneak', HouseAddress: 'x', HouseTerritoryNumber: 'T-1' }],
    deletes: ['h2'],
  }, { 'x-tm-client': '3' });
  check('bulk applies what is theirs', (r.body.applied.updated || []).indexOf('h1') !== -1);
  check('bulk names the out-of-scope update', r.body.rejected.some(x => x.id === 'h9' && x.code === 'out_of_scope'));
  check('bulk refuses the create', r.body.rejected.some(x => x.code === 'no_create'));
  check('bulk refuses the delete', r.body.rejected.some(x => x.code === 'no_delete'));
  check('nothing out of scope was written', !DB.Houses.some(x => x.id === 'sneak') &&
    DB.Houses.find(x => x.id === 'h9').HouseNotes !== 'not mine');
  check('a rejected id is not reported as missing', (r.body.applied.missing || []).indexOf('h9') === -1);
  check('the read-back is still scoped', r.body.records.length === 2, r.body.records.length);

  r = await H(HELPER, 'PUT', { updates: [{ id: 'h9', HouseNotes: 'x' }] });   // no client header
  check('a phone that predates this is refused whole', r.status === 409, r.status);

  r = await H(OWNER, 'PUT', {
    creates: [{ id: 'bulknew', HouseAddress: 'y', HouseTerritoryNumber: 'T-1' }],
  }, { 'x-tm-client': '3' });
  check('a house created in bulk comes back in the same answer',
    r.body.records.some(x => x.id === 'bulknew'));

  // ══ the grace window ════════════════════════════════════════════════════
  // h3's packet expired an hour ago; the helper should still be able to add a
  // note they wrote before it did.
  r = await H(HELPER, 'PATCH', {
    id: 'h3', HouseVisitLog: JSON.stringify([{ i: 'g1', d: '2026-08-23', t: 'Wrote this at 23:50' }]),
  });
  check('a note written before the numbers came back still uploads', r.status === 200, r.status);
  check('...and is actually stored',
    /Wrote this at 23:50/.test(DB.Houses.find(x => x.id === 'h3').HouseVisitLog || ''));

  r = await H(HELPER, 'PATCH', { id: 'h3', HouseNotes: 'not allowed now' });
  check('but nothing else may be changed after they came back', r.status === 403, r.status);

  // Your own note is yours to withdraw — that is also how somebody hands back
  // the return-visit claim that keeps a house visible to them.
  r = await H(HELPER, 'PATCH', {
    id: 'h3', HouseVisitLog: JSON.stringify([{ i: 'g1', d: '2026-08-23', t: 'Wrote this at 23:50', x: 1 }]),
  });
  check('your own note can be withdrawn in the grace window', r.status === 200, r.status);
  check('...and it really is tombstoned',
    JSON.parse(DB.Houses.find(x => x.id === 'h3').HouseVisitLog || '[]')
      .some(e => e.i === 'g1' && e.x === 1));

  // Somebody else's is not.
  DB.Houses.find(x => x.id === 'h3').HouseVisitLog = JSON.stringify([
    { i: 'other1', d: '2026-08-23', t: 'Recorded by the owner', u: 'own1' }]);
  r = await H(HELPER, 'PATCH', {
    id: 'h3', HouseVisitLog: JSON.stringify([{ i: 'other1', d: '2026-08-23', t: 'Recorded by the owner', u: 'own1', x: 1 }]),
  });
  check("somebody else's note cannot be erased", r.status === 403, r.status);
  check('...it is untouched',
    !JSON.parse(DB.Houses.find(x => x.id === 'h3').HouseVisitLog || '[]').some(e => e.x));

  r = await H(HELPER, 'GET');
  check('grace does not restore READ access', !r.body.some(x => x.id === 'h3'),
    r.body.map(x => x.id).join(','));

  // ══ team.js ═════════════════════════════════════════════════════════════
  r = await T(HELPER, 'assignTerritory', { territory: 'T-3', ownerId: 'hlp1' });
  check('nobody grants themselves a territory', r.status === 403, r.status);
  check('...and no territory was created', !DB.Territories.some(t => t.name === 'T-3'));

  r = await T(HELPER, 'setTerritoryWorking', { territory: 'T-9', working: true });
  check('an invented territory cannot be started', r.status === 404, r.status);

  r = await T(SHARED, 'setTerritoryWorking', { territory: 'T-1', working: false });
  check('the kill switch belongs to the owner alone', r.status === 403, r.status);

  r = await T(SHARED, 'createAssignment', { territory: 'T-1', houseIds: ['h1'], guestName: 'zz' });
  check('someone the territory is shared with may hand numbers on', r.status === 200, r.status);

  r = await T(HELPER, 'createAssignment', { territory: 'T-1', houseIds: ['h1'], guestName: 'zz' });
  check('a numbers-only user may not re-lend them', r.status === 403, r.status);

  r = await T(OWNER, 'createAssignment', { territory: 'T-1', houseIds: ['h9'], guestName: 'zz' });
  check('a packet cannot hold another territory\'s numbers', r.status === 400, r.status);

  const before = DB.Territories.find(t => t.name === 'T-1').working;
  r = await T(ADMIN, 'assignTerritory', { territory: 'T-1', ownerId: 'own1', assigneeIds: ['shr1'] });
  check('sharing a territory no longer stops everyone working it',
    DB.Territories.find(t => t.name === 'T-1').working === before,
    'working=' + DB.Territories.find(t => t.name === 'T-1').working);

  r = await T(HELPER, 'listTerritories');
  check('a helper is shown only territories they are in',
    r.body.territories.length === 1 && r.body.territories[0].name === 'T-1',
    r.body.territories.map(t => t.name).join(','));
  check('the scope envelope describes them',
    r.body.scope.kind === 'numbers' && !r.body.scope.canCreate && !r.body.scope.canHandOut,
    JSON.stringify(r.body.scope));
  r = await T(ADMIN, 'listTerritories');
  check('an admin still sees every territory', r.body.territories.length >= 2, r.body.territories.length);
  check('...and is told so', r.body.scope.kind === 'admin' && r.body.scope.canCreate);

  r = await T(NOBODY, 'listTerritories');
  check('someone with nothing is told why', r.body.scope.empty && /assigned to you/i.test(r.body.scope.reason),
    r.body.scope.reason);

  r = await T(HELPER, 'postPresence', { territory: 'T-2', lat: 1, lng: 2 });
  check('you cannot appear on another group\'s map', r.status === 403, r.status);
  r = await T(HELPER, 'getVoice', { territory: 'T-2', since: 0 });
  check('you cannot listen to another group', r.status === 403, r.status);
  r = await T(HELPER, 'getPresence', { territory: 'T-1' });
  check('you can see your own group', r.status === 200, r.status);

  r = await T(HELPER, 'listAssignments', { territory: 'T-2' });
  check('the working flag is not an oracle about other territories',
    r.body.working === false, JSON.stringify(r.body).slice(0, 60));

  r = await T(HELPER, 'myAssignments');
  check('a helper can finally see what they hold', (r.body.assignments || []).length >= 1,
    (r.body.assignments || []).length);
  check('...including one that has ended, with the reason',
    (r.body.assignments || []).some(a => !a.usable && a.reason),
    JSON.stringify((r.body.assignments || []).map(a => a.reason)));

  // ══ the policy ══════════════════════════════════════════════════════════
  r = await T(HELPER, 'setReturnPolicy', { nights: 6 });
  check('only an admin sets the return policy', r.status === 403, r.status);
  r = await T(ADMIN, 'setReturnPolicy', { nights: 99 });
  check('an unlisted policy value is refused', r.status === 400, r.status);
  r = await T(ADMIN, 'setReturnPolicy', { nights: 2 });
  check('an admin can lengthen it', r.status === 200, JSON.stringify(r.body));

  r = await T(OWNER, 'createAssignment', { territory: 'T-1', houseIds: ['h1'], guestName: 'zz policy' });
  const later = Number(r.body.expiresAt);
  check('the new policy governs the next hand-out',
    later > tonight + 24 * 3600e3 && later < tonight + 3 * 24 * 3600e3,
    new Date(later).toISOString());
  check('packets already out keep the expiry they were given',
    DB.Assignments.find(a => a.id === 'p1').expiresAt === String(tonight));

  await T(ADMIN, 'setReturnPolicy', { nights: 0 });
  r = await T(OWNER, 'createAssignment', { territory: 'T-1', houseIds: ['h1'], guestName: 'zz back' });
  check('back to midnight tonight', Math.abs(Number(r.body.expiresAt) - tonight) < 90 * 60e3,
    new Date(Number(r.body.expiresAt)).toString());

  console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
