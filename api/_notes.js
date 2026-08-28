/* A word from the person who handed the numbers over.

   "Start at the top of the street", "the dog on 6440 is friendly", "ring twice".
   It is the one thing a helper needs that the list itself cannot say, and it is
   the only text on their screen that is not an address.

   Its own list, not a column on Assignments: _sp.js provisions a list only when
   the whole list is absent, so a new column on a live list is never created and
   the first write would break every hand-out. A brand-new list is created
   correctly on first read.

   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

const crypto = require('crypto');

const NOTES_TAB = {
  name: 'PacketNotes',
  cols: ['id', 'assignmentId', 'fromId', 'fromName', 'text', 'updatedAt'],
};

// Long enough for directions, short enough to read at a door.
const MAX_LEN = 400;

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

async function readNotes(store) {
  try { return await store.read(NOTES_TAB); }
  catch (e) { return []; }
}

const forPacket = (rows, assignmentId) =>
  rows.filter(r => r && r.assignmentId === assignmentId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;

/* One note per hand-out, replaced rather than appended: this is a message, not
   a record — the helper should read the current one, not a thread. */
async function setNote(store, assignmentId, text, fromId, fromName, nowIso) {
  const clean = String(text || '').trim().slice(0, MAX_LEN);
  const rows = await readNotes(store);
  const existing = forPacket(rows, assignmentId);
  if (!clean) {
    // Clearing it leaves an empty note rather than a deleted row, so the
    // helper's screen simply loses the line.
    if (existing) {
      const rec = Object.assign({}, existing, { text: '', updatedAt: nowIso });
      delete rec._key;
      await store.update(NOTES_TAB, existing._key, rec);
    }
    return '';
  }
  const rec = {
    id: existing ? existing.id : newId(),
    assignmentId: assignmentId,
    fromId: fromId || '', fromName: fromName || '',
    text: clean, updatedAt: nowIso,
  };
  if (existing) await store.update(NOTES_TAB, existing._key, rec);
  else await store.create(NOTES_TAB, rec);
  return clean;
}

module.exports = { NOTES_TAB, MAX_LEN, newId, readNotes, forPacket, setNote };
