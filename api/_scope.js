/* Who may see and touch which houses.

   Every request answers this question once, here, rather than leaving each
   branch to remember a check — the guest scope worked that way already and the
   DELETE branch shows what happens when a check is left out.

   The rules, in the owner's words: admins see every territory; everyone else
   sees the territories assigned to them, or just the numbers handed to them.

   Two answers that must never collapse into one another:
     read === null   -> everything, and only an admin ever gets it
     read.size === 0 -> nothing, and `reason` says why

   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

const AS = require('./_assign');

const HOUSES_TAB = {
  name: 'Houses',
  cols: [
    'id','HouseAddress','HouseCity','HouseState','HouseZIP',
    'HouseTerritoryNumber','HouseTerritoryAssingnedTo','HouseLanguage',
    'HouseLastVisitDate','HouseGPSCoordinates','HouseNotes','HousePersonalNotes',
    'HouseResutsOnVisit1','HouseResutsOnVisit2','HouseResutsOnVisit3',
    'HouseResutsOnVisit4','HouseResutsOnVisit5','HouseVerifiedOnMaps',
    'HouseReturnVisits','HouseUpdatedAt','HouseVisitLog','HouseDeleted',
  ],
};

const USERS_TAB = {
  name: 'Users',
  cols: ['id','name','phone','email','role','passHash','passSalt','setupCode',
         'mustSetup','active','createdAt','updatedAt'],
};

/* How long someone may still UPLOAD notes for houses they no longer hold.

   Numbers come back at midnight, but a phone in a driveway with no signal does
   not. Without this, the notes written at 23:50 are refused at 07:00 and the
   volunteer's morning is gone. Reading stops the moment the packet does; only
   adding to what they already wrote survives, and only additions — never an
   edit, never a deletion, never a scalar field. */
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/* Compared normalised everywhere an authority decision is made. A stray space
   in a role cell must not demote the admin, and a difference in case must not
   orphan a territory's worth of houses. */
const norm = v => String(v || '').trim().toLowerCase();

const splitIds = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* Everything except the house rows themselves, which the caller usually has
   already. Reads Users, and — for anyone who is not an admin — Territories and
   Assignments. */
async function resolveGrants(store, claims, now) {
  const grant = {
    kind: 'none', uid: '', role: '', name: '',
    territories: new Set(),   // owned ∪ assigned — governs creating and deleting
    owned: new Set(),         // owned only      — governs the kill switch
    packets: [], gracePackets: [],
    canCreate: false, canDelete: false, canHandOut: false,
    empty: true, reason: '',
    read: new Set(), write: new Set(), grace: new Set(),
  };

  /* A guest token carries a work packet rather than an account. */
  if (claims.g) {
    const [assigns, terrs] = await Promise.all([
      store.read(AS.ASSIGN_TAB), store.read(AS.TERR_TAB),
    ]);
    const a = assigns.find(x => x.id === claims.g);
    const t = a ? terrs.find(x => norm(x.name) === norm(a.territory)) : null;
    const state = AS.packetState(a, t, now);
    grant.kind = 'guest';
    grant.uid = 'g:' + claims.g;
    grant.name = (a && a.guestName) || 'Helper';
    if (a) {
      if (state.ok) grant.packets = [a];
      // Grace ignores `active` and `working` on purpose: revoked, stopped and
      // expired are all reasons to stop READING, none of them a reason to
      // throw away a note already written.
      if (now <= Number(a.expiresAt || 0) + GRACE_MS) grant.gracePackets = [a];
    }
    grant.reason = state.ok ? '' : state.reason;
    return grant;
  }

  const users = await store.read(USERS_TAB);
  /* An empty Users list is a storage fault, not an org with no people: a
     renamed or moved list makes _sp.js create a fresh empty one, and every
     account would silently resolve to no role and no territories. */
  if (!users.length) throw fail(503, 'Cannot read the account list right now');

  const me = users.find(u => u.id === claims.uid);
  // 403, never 401: the client signs out and clears its queue on a 401.
  if (!me) throw fail(403, 'This account no longer exists');
  if (me.active === '0') throw fail(403, 'This account has been turned off');

  grant.uid = me.id;
  grant.role = norm(me.role);
  grant.name = me.name || '';

  if (grant.role === 'admin') {
    // Short-circuited deliberately: an admin's own access must not depend on
    // the two lists most likely to be wrong.
    grant.kind = 'admin';
    grant.read = null; grant.write = null;
    grant.canCreate = true; grant.canDelete = true; grant.canHandOut = true;
    grant.empty = false;
    return grant;
  }

  const [terrs, assigns] = await Promise.all([
    store.read(AS.TERR_TAB), store.read(AS.ASSIGN_TAB),
  ]);
  if (!terrs.length && assigns.length) throw fail(503, 'Cannot read the territory list right now');

  terrs.forEach(t => {
    const name = norm(t.name);
    if (!name) return;
    if (t.ownerId && t.ownerId === me.id) { grant.owned.add(name); grant.territories.add(name); }
    // Ids are compared as opaque strings and never resolved through Users, so
    // an id left behind by a deleted account matches no session and grants
    // nothing rather than throwing.
    else if (splitIds(t.assigneeIds).indexOf(me.id) !== -1) grant.territories.add(name);
  });

  assigns.forEach(a => {
    if (a.assigneeId !== me.id) return;
    const t = terrs.find(x => norm(x.name) === norm(a.territory));
    if (AS.packetState(a, t, now).ok) grant.packets.push(a);
    if (now <= Number(a.expiresAt || 0) + GRACE_MS) grant.gracePackets.push(a);
  });

  grant.kind = grant.territories.size ? 'holder' : (grant.packets.length ? 'numbers' : 'none');
  grant.canCreate = grant.territories.size > 0;
  grant.canDelete = grant.territories.size > 0;
  grant.canHandOut = grant.territories.size > 0;
  grant.empty = !grant.territories.size && !grant.packets.length;
  if (grant.empty) {
    // Say which of the two silences this is. A packet that has ended reads
    // very differently from never having been given anything.
    const ended = assigns.filter(a => a.assigneeId === me.id).length;
    grant.reason = ended
      ? 'Those numbers have been returned.'
      : 'Nothing is assigned to you yet.';
  }
  return grant;
}

/* Turn the grants into id sets. Pure — the caller passes the house rows it has
   already read, so this costs nothing. */
function attachHouses(grant, houseRows) {
  if (grant.read === null) return grant;      // admin: everything, no work to do

  const read = new Set();
  const byTerritory = new Map();
  houseRows.forEach(r => {
    if (!r || !r.id) return;
    const t = norm(r.HouseTerritoryNumber);
    if (!byTerritory.has(t)) byTerritory.set(t, []);
    byTerritory.get(t).push(r.id);
  });

  grant.territories.forEach(t => {
    (byTerritory.get(t) || []).forEach(id => read.add(id));
  });
  // An explicit id outranks the absence of a territory grant: a house with a
  // blank or unknown territory is still visible to somebody handed it by name.
  grant.packets.forEach(a => AS.houseIdList(a).forEach(id => read.add(id)));

  const write = new Set(read);
  const grace = new Set();
  grant.gracePackets.forEach(a => AS.houseIdList(a).forEach(id => {
    if (read.has(id)) return;
    grace.add(id); write.add(id);
  }));

  grant.read = read; grant.write = write; grant.grace = grace;
  if (read.size) grant.empty = false;
  return grant;
}

/* What a graced writer may add: entries, to the two append-only logs, and
   nothing else. No tombstones, no rewrites of an existing entry, no scalar
   fields — so somebody whose numbers came back can finish uploading their own
   notes without being able to touch anything else. */
const GRACE_FIELDS = ['HouseVisitLog', 'HouseReturnVisits'];

function graceFilter(update, existing, parseArr, entryKey, seedLog) {
  const fields = {};
  const refusedFields = [];
  Object.keys(update || {}).forEach(k => {
    if (k === 'id' || k === '_base') return;
    if (GRACE_FIELDS.indexOf(k) === -1) { refusedFields.push(k); return; }
    const base = k === 'HouseVisitLog' ? seedLog(existing) : existing[k];
    const have = new Set(parseArr(base).map(entryKey));
    const add = parseArr(update[k]).filter(e => e && !e.x && !have.has(entryKey(e)));
    if (!add.length) { refusedFields.push(k); return; }
    fields[k] = JSON.stringify(parseArr(base).concat(add));
  });
  return { fields: fields, refusedFields: refusedFields };
}

module.exports = {
  HOUSES_TAB, USERS_TAB, GRACE_MS, GRACE_FIELDS,
  norm, splitIds, resolveGrants, attachHouses, graceFilter,
};
