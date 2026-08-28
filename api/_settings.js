/* Org-wide settings: when handed-out numbers come back, and the time zone that
   decides when "midnight" is.

   Its own list rather than a column on an existing one. _sp.js creates a list
   only when the whole list is absent, so a new column on a live SharePoint list
   would never be provisioned: reads would come back empty and the first write
   would push an unknown field and be rejected, taking every territory write
   down with it. A brand-new list is created correctly on first read.

   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

const SETTINGS_TAB = {
  name: 'Settings',
  cols: ['key', 'value', 'updatedAt', 'updatedBy'],
};

/* What the rows are tinted with. Stored for the whole group so everybody's
   phone reads the same street the same way, and changeable by an admin. */
const COLOR_KEYS = ['colorAssigned', 'colorDnv', 'colorTalked'];
const DEFAULT_COLORS = {
  colorAssigned: '#1565C0',   // somebody is holding these numbers
  colorDnv: '#B42318',        // the household asked us not to call
  colorTalked: '#12805C',     // somebody was spoken to here
};
const isHexColor = v => /^#[0-9a-fA-F]{6}$/.test(String(v || ''));

// Nights a packet may live. 0 = tonight; 6 = a week of them.
const ALLOWED_NIGHTS = [0, 1, 2, 6];
const DEFAULT_NIGHTS = 0;
const DEFAULT_TZ = 'America/Los_Angeles';

// A ceiling no policy may pass, so a bad setting cannot hand out an open-ended
// packet. Comfortably past the longest allowed policy.
const HARD_MAX_MS = 8 * 24 * 60 * 60 * 1000;

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: String(tz) }); return true; }
  catch (e) { return false; }
}

/* Minutes east of UTC in `tz` at that instant. Vercel runs with TZ unset, so
   the server's own local time is UTC and `setHours(23,59,59)` there would land
   in the middle of the previous Pacific afternoon. */
function tzOffsetMin(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - (ms - (ms % 1000))) / 60000);
}

/* The instant `nights` local midnights from now. Resolved twice because the
   offset at the target can differ from the offset now, and a single pass gets
   the night of a daylight-saving change an hour wrong. */
function endOfNight(now, tz, nights) {
  const off = tzOffsetMin(now, tz);
  const wall = new Date(now + off * 60000);
  const want = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(),
    wall.getUTCDate() + Math.max(0, nights), 23, 59, 59, 999);
  const first = want - off * 60000;
  return want - tzOffsetMin(first, tz) * 60000;
}

/* The calendar day at that instant, where these people live. A record card
   says "12 March", and the server's own clock is UTC — so an evening handover
   in California would otherwise be written down as the following day. */
function localDay(ms, tz) {
  const off = tzOffsetMin(ms, tz || DEFAULT_TZ);
  return new Date(ms + off * 60000).toISOString().slice(0, 10);
}

/* Read lazily and only where it is needed — handing numbers out — so the
   per-request house paths never pay for it. */
async function readSettings(store) {
  let rows = [];
  try { rows = await store.read(SETTINGS_TAB); } catch (e) { rows = []; }
  const map = {};
  rows.forEach(r => { if (r && r.key) map[r.key] = r.value; });
  let nights = parseInt(map.returnNights, 10);
  if (ALLOWED_NIGHTS.indexOf(nights) === -1) nights = DEFAULT_NIGHTS;
  const tz = validTimeZone(map.timeZone) ? map.timeZone : DEFAULT_TZ;
  const colors = {};
  COLOR_KEYS.forEach(k => { colors[k] = isHexColor(map[k]) ? map[k] : DEFAULT_COLORS[k]; });
  return { nights: nights, tz: tz, colors: colors, raw: map };
}

async function writeSetting(store, key, value, who) {
  const rows = await store.read(SETTINGS_TAB);
  const rec = {
    key: key, value: String(value),
    updatedAt: new Date().toISOString(), updatedBy: who || '',
  };
  const existing = rows.find(r => r && r.key === key);
  if (existing) await store.update(SETTINGS_TAB, existing._key, rec);
  else await store.create(SETTINGS_TAB, rec);
}

/* How long a packet handed out now should last, under the current policy. */
async function packetExpiry(store, now) {
  const { nights, tz } = await readSettings(store);
  return Math.min(endOfNight(now, tz, nights), now + HARD_MAX_MS);
}

module.exports = {
  SETTINGS_TAB, ALLOWED_NIGHTS, DEFAULT_NIGHTS, DEFAULT_TZ, HARD_MAX_MS,
  COLOR_KEYS, DEFAULT_COLORS, isHexColor, localDay,
  validTimeZone, tzOffsetMin, endOfNight, readSettings, writeSetting, packetExpiry,
};
