/* Work packets: a set of house numbers handed to one person for one session.

   Shared by /api/team (which creates them) and /api/territory (which enforces
   them), so the rules about what a guest may see live in exactly one place.

   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

const crypto = require('crypto');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

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

const colLetter = n => {
  let s = '', x = n;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return s;
};

// Read aloud or typed from a QR fallback, so no O/0 or I/1.
const guestCode = () => Array.from(crypto.randomBytes(7))
  .map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

async function ensureTab(sheets, spec) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const found = meta.data.sheets.find(s => s.properties.title === spec.name);
  if (found) return found.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: spec.name } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${spec.name}!A1:${colLetter(spec.cols.length - 1)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [spec.cols] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function readTab(sheets, spec) {
  const range = `${spec.name}!A:${colLetter(spec.cols.length - 1)}`;
  let rows;
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    rows = r.data.values || [];
  } catch (e) {
    await ensureTab(sheets, spec);
    return [];
  }
  const hdr = rows[0] || [];
  // Adding a column to a spec must not orphan the rows already there, so the
  // header is repaired in place and existing values keep their positions.
  if (!rows.length || !spec.cols.every((c, i) => hdr[i] === c)) {
    await ensureTab(sheets, spec);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${spec.name}!A1:${colLetter(spec.cols.length - 1)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [spec.cols] },
    });
    if (!rows.length) return [];
  }
  return rows.slice(1).filter(r => r && r[0] !== undefined && r[0] !== '')
    .map((r, i) => {
      const o = { _row: i + 2 };
      spec.cols.forEach((c, j) => { o[c] = r[j] !== undefined ? r[j] : ''; });
      return o;
    });
}

async function writeRow(sheets, spec, rowNum, obj) {
  const last = colLetter(spec.cols.length - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${spec.name}!A${rowNum}:${last}${rowNum}`,
    valueInputOption: 'RAW',
    requestBody: { values: [spec.cols.map(c => (obj[c] === undefined || obj[c] === null ? '' : String(obj[c])))] },
  });
}

async function appendRow(sheets, spec, obj) {
  await ensureTab(sheets, spec);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${spec.name}!A:${colLetter(spec.cols.length - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [spec.cols.map(c => (obj[c] === undefined || obj[c] === null ? '' : String(obj[c])))] },
  });
}

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

/* Parse a batchGet range back into records. */
function rowsToRecords(values, spec) {
  const rows = values || [];
  const hdr = rows[0] || [];
  if (!rows.length || !spec.cols.every((c, i) => hdr[i] === c)) return null; // needs repair
  return rows.slice(1).filter(r => r && r[0] !== undefined && r[0] !== '')
    .map((r, i) => {
      const o = { _row: i + 2 };
      spec.cols.forEach((c, j) => { o[c] = r[j] !== undefined ? r[j] : ''; });
      return o;
    });
}

/* One Sheets call for both tabs. This runs on every guest request, and the
   service account shares a 60-reads-per-minute budget across everyone, so
   halving it here is the difference between working and rate-limited. */
async function loadPacket(sheets, assignmentId, now) {
  let assigns = null, terrs = null;
  try {
    const r = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: [
        `${ASSIGN_TAB.name}!A:${colLetter(ASSIGN_TAB.cols.length - 1)}`,
        `${TERR_TAB.name}!A:${colLetter(TERR_TAB.cols.length - 1)}`,
      ],
    });
    const vr = r.data.valueRanges || [];
    assigns = rowsToRecords(vr[0] && vr[0].values, ASSIGN_TAB);
    terrs = rowsToRecords(vr[1] && vr[1].values, TERR_TAB);
  } catch (e) { /* fall through to the per-tab path, which also repairs headers */ }

  if (!assigns) assigns = await readTab(sheets, ASSIGN_TAB);
  if (!terrs) terrs = await readTab(sheets, TERR_TAB);

  const a = assigns.find(x => x.id === assignmentId);
  const t = a ? terrs.find(x => x.name === a.territory) : null;
  return { assignment: a || null, territory: t || null, state: packetState(a, t, now) };
}

module.exports = {
  ASSIGN_TAB, TERR_TAB, MAX_TTL_MS,
  colLetter, guestCode, newId,
  ensureTab, readTab, writeRow, appendRow,
  houseIdList, packetState, loadPacket,
};
