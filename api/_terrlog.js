/* The territory record card: who has each territory now, and who has had it.

   One row per check-out. It opens when a territory is assigned to somebody and
   closes when they give it back — so the history is a list of periods, not a
   field that gets overwritten the next time it changes hands. An overwritten
   field cannot answer "who had this in March", which is the whole question.

   Its own list rather than columns on Territories: _sp.js provisions a list
   only when the entire list is absent, so a new column on a live list would
   never be created and the first write would take every territory write down
   with it. A brand-new list is created correctly on first read.

   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

const crypto = require('crypto');

/* assignedOn / returnedOn are plain calendar days in the group's own time
   zone — what a record card actually says. The …At instants are kept beside
   them for ordering, because two handovers on one day still have an order. */
const TERRLOG_TAB = {
  name: 'TerritoryLog',
  cols: ['id', 'territory', 'userId', 'userName',
         'assignedAt', 'assignedOn', 'assignedBy',
         'returnedAt', 'returnedOn', 'returnedBy', 'note'],
};

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

const norm = v => String(v || '').trim().toLowerCase();
const isOpen = r => !!r && !String(r.returnedAt || '').trim();

/* Newest first, by when it was handed over. Open records sort above closed
   ones from the same day, because that is the one somebody is holding. */
function byNewest(a, b) {
  const d = String(b.assignedAt || '').localeCompare(String(a.assignedAt || ''));
  if (d !== 0) return d;
  return (isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0);
}

async function readLog(store) {
  try { return await store.read(TERRLOG_TAB); }
  catch (e) { return []; }
}

const openFor = (rows, territory) =>
  rows.filter(r => norm(r.territory) === norm(territory) && isOpen(r)).sort(byNewest)[0] || null;

/* Give it back. Closing is idempotent — a territory handed straight from one
   person to another closes the old record and opens a new one in one step, and
   closing something already closed is not an error worth stopping for. */
async function closeOpen(store, territory, whoId, nowIso, today, note) {
  const rows = await readLog(store);
  const open = rows.filter(r => norm(r.territory) === norm(territory) && isOpen(r));
  for (const r of open) {
    const rec = Object.assign({}, r, {
      returnedAt: nowIso,
      returnedOn: today || '',
      returnedBy: whoId || '',
      note: note !== undefined && note !== '' ? String(note) : (r.note || ''),
    });
    delete rec._key;
    await store.update(TERRLOG_TAB, r._key, rec);
  }
  return open.length;
}

async function openNew(store, territory, userId, userName, byId, nowIso, today, note) {
  const rec = {
    id: newId(), territory: territory, userId: userId || '', userName: userName || '',
    assignedAt: nowIso, assignedOn: today || '', assignedBy: byId || '',
    returnedAt: '', returnedOn: '', returnedBy: '',
    note: note ? String(note) : '',
  };
  await store.create(TERRLOG_TAB, rec);
  return rec;
}

/* A territory that was already in somebody's hands before any of this existed
   has no record. Opening one with a blank date says exactly that — somebody
   has it, and when they got it was never written down — rather than inventing
   a date or, worse, letting the only trace be deleted when it comes back. */
async function ensureOpen(store, territory, userId, userName, byId, nowIso, today) {
  const rows = await readLog(store);
  if (openFor(rows, territory)) return null;
  if (!userId) return null;
  const rec = {
    id: newId(), territory: territory, userId: userId, userName: userName || '',
    assignedAt: '', assignedOn: '', assignedBy: byId || '',
    returnedAt: '', returnedOn: '', returnedBy: '', note: '',
  };
  await store.create(TERRLOG_TAB, rec);
  return rec;
}

/* Called whenever a territory changes hands. Does nothing when the holder has
   not actually changed, so re-saving the sheet does not fill the history with
   entries that record nothing. */
async function recordHandover(store, territory, prevOwnerId, nextOwnerId, nameOf, byId, nowIso, today, note) {
  if (String(prevOwnerId || '') === String(nextOwnerId || '')) return { changed: false };
  /* Somebody who has held it since before the card existed still gets a line
     saying so — otherwise handing it on would erase the only evidence. */
  if (prevOwnerId) await ensureOpen(store, territory, prevOwnerId, nameOf(prevOwnerId), byId, nowIso, today);
  await closeOpen(store, territory, byId, nowIso, today, note);
  if (nextOwnerId) await openNew(store, territory, nextOwnerId, nameOf(nextOwnerId), byId, nowIso, today, note);
  return { changed: true };
}

module.exports = {
  TERRLOG_TAB, newId, isOpen, byNewest, readLog, openFor,
  closeOpen, openNew, ensureOpen, recordHandover,
};
