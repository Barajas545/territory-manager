/* Work packets: a set of house numbers handed to one person for one session.

   Shared by /api/team (which creates them) and /api/territory (which enforces
   them), so the rules about what a guest may see live in exactly one place.

   Storage-agnostic: callers pass in a store from _store.js, so this works the
   same on SharePoint or Sheets.

   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

const crypto = require('crypto');

const ASSIGN_TAB = {
  name: 'Assignments',
  cols: ['id','territory','ownerId','assigneeId','guestName','guestCode',
         'houseIds','createdAt','expiresAt','active'],
};

const TERR_TAB = {
  name: 'Territories',
  cols: ['name','ownerId','assigneeIds','updatedAt','working'],
};

// A packet cannot outlive the day it was handed out, whatever the client asks for.
const MAX_TTL_MS = 20 * 60 * 60 * 1000;

// Read aloud or typed from a QR fallback, so no O/0 or I/1.
const guestCode = () => Array.from(crypto.randomBytes(7))
  .map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

const houseIdList = a => String((a && a.houseIds) || '').split(',').filter(Boolean);

/* A packet is usable only while all of these hold: it has not been revoked,
   it has not expired, and the territory is still marked as being worked.
   That last one is the owner's kill switch — one toggle ends everyone's
   access without having to revoke each packet. */
function packetState(assignment, territoryRow, now) {
  if (!assignment) return { ok: false, reason: 'That code is not valid' };
  if (assignment.active === '0') return { ok: false, reason: 'This assignment was withdrawn' };
  const exp = Number(assignment.expiresAt || 0);
  if (exp && now > exp) return { ok: false, reason: 'This assignment has expired' };
  if (!territoryRow || territoryRow.working !== '1')
    return { ok: false, reason: 'This territory is not being worked right now' };
  return { ok: true };
}

async function loadPacket(store, assignmentId, now) {
  const [assigns, terrs] = await Promise.all([
    store.read(ASSIGN_TAB), store.read(TERR_TAB),
  ]);
  const a = assigns.find(x => x.id === assignmentId);
  const t = a ? terrs.find(x => x.name === a.territory) : null;
  return { assignment: a || null, territory: t || null, state: packetState(a, t, now) };
}

module.exports = {
  ASSIGN_TAB, TERR_TAB, MAX_TTL_MS,
  guestCode, newId, houseIdList, packetState, loadPacket,
};
