const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Houses';
const FIELDS = [
  'id','HouseAddress','HouseCity','HouseState','HouseZIP',
  'HouseTerritoryNumber','HouseTerritoryAssingnedTo','HouseLanguage',
  'HouseLastVisitDate','HouseGPSCoordinates','HouseNotes','HousePersonalNotes',
  'HouseResutsOnVisit1','HouseResutsOnVisit2','HouseResutsOnVisit3',
  'HouseResutsOnVisit4','HouseResutsOnVisit5','HouseVerifiedOnMaps',
  'HouseReturnVisits','HouseUpdatedAt','HouseVisitLog','HouseDeleted'
];
const LAST_COL = 'V'; // 22 fields = A–V
const RANGE = `${SHEET_NAME}!A:${LAST_COL}`;

// Server-owned. A client may not write these directly.
const SERVER_FIELDS = new Set(['HouseUpdatedAt']);

/* Append-only JSON logs. These are merged by UNION of entry id, never
   overwritten wholesale — that is what makes two offline phones safe.
   Field-level last-write-wins cannot protect these: both devices write the
   same key, so one device's notes would simply vanish. */
const ARRAY_FIELDS = new Set(['HouseReturnVisits', 'HouseVisitLog']);

// Derived from HouseVisitLog on every write; clients never set them.
const DERIVED_SLOTS = ['HouseResutsOnVisit1','HouseResutsOnVisit2','HouseResutsOnVisit3',
  'HouseResutsOnVisit4','HouseResutsOnVisit5'];

function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function rowToRecord(row) {
  const rec = {};
  FIELDS.forEach((f, i) => { rec[f] = (row[i] !== undefined ? row[i] : ''); });
  return rec;
}

function recordToRow(rec) {
  return FIELDS.map(f => rec[f] !== undefined && rec[f] !== null ? String(rec[f]) : '');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function sanitize(updates) {
  const clean = {};
  Object.keys(updates || {}).forEach(k => {
    if (k !== 'id' && !SERVER_FIELDS.has(k) && FIELDS.includes(k)) clean[k] = updates[k];
  });
  return clean;
}

function parseArr(s) {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}

// Entries carry a stable `i`. Anything without one falls back to its shape,
// which still de-duplicates identical legacy entries.
const entryKey = e => (e && e.i ? String(e.i) : JSON.stringify(e));

/* Union two logs by entry id. A tombstone (x:1) always wins, so deleting a
   note on one device is not resurrected by a sync from another. */
function unionLog(existingStr, incomingStr) {
  const map = new Map();
  const take = e => {
    const k = entryKey(e);
    const prev = map.get(k);
    if (prev && prev.x && !e.x) return; // never un-delete
    map.set(k, e);
  };
  parseArr(existingStr).forEach(take);
  parseArr(incomingStr).forEach(take);
  const out = Array.from(map.values()).sort((a, b) => {
    const d = String(a.d || '').localeCompare(String(b.d || ''));
    return d !== 0 ? d : entryKey(a).localeCompare(entryKey(b));
  });
  return JSON.stringify(out);
}

/* A record predating the visit log has history only in the five slot columns.
   Seed a log from them once, so the first append does not appear to erase them. */
function seedLog(rec) {
  const existing = parseArr(rec.HouseVisitLog);
  if (existing.length) return rec.HouseVisitLog;
  const seeded = [];
  DERIVED_SLOTS.forEach((f, i) => {
    if (rec[f]) seeded.push({ i: 'legacy' + (i + 1), d: rec.HouseLastVisitDate || '', t: rec[f] });
  });
  return seeded.length ? JSON.stringify(seeded) : '';
}

/* The five slot columns are a projection of the last five live log entries.
   Keeping them means the printed territory sheet and older clients still work,
   while the log remains the source of truth. */
function deriveSlots(rec) {
  const live = parseArr(rec.HouseVisitLog).filter(e => e && !e.x);
  if (!live.length) return; // legacy row with no log — leave its slots alone
  live.sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')));
  const last5 = live.slice(-5);
  DERIVED_SLOTS.forEach((f, i) => { rec[f] = last5[i] ? String(last5[i].t || '') : ''; });
  const lastD = live[live.length - 1].d;
  if (lastD) rec.HouseLastVisitDate = lastD;
}

/* The one place merge policy lives. Runs against the row the server just read,
   not a snapshot the client fetched seconds ago. */
function mergeRow(existing, updates, now) {
  const merged = Object.assign({}, existing);
  Object.keys(updates).forEach(k => {
    if (ARRAY_FIELDS.has(k)) {
      const base = k === 'HouseVisitLog' ? seedLog(existing) : existing[k];
      merged[k] = unionLog(base, updates[k]);
    } else if (DERIVED_SLOTS.indexOf(k) !== -1) {
      // ignored: recomputed from the log below
    } else {
      merged[k] = updates[k];
    }
  });
  deriveSlots(merged);
  merged.HouseUpdatedAt = now;
  return merged;
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function getTabId(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tab = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  return tab ? tab.properties.sheetId : 0;
}

async function readAll(sheets) {
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
  const rows = resp.data.values || [];
  const hdr = rows[0] || [];
  const isHeaderRow = hdr[0] === 'id';
  const headerOk = isHeaderRow && FIELDS.every((f, i) => hdr[i] === f);

  if (!rows.length || (isHeaderRow && !headerOk)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:${LAST_COL}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [FIELDS] },
    });
    return { dataRows: rows.slice(1), headerOffset: 1 };
  }

  if (rows.length && !isHeaderRow) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId: await getTabId(sheets), dimension: 'ROWS', startIndex: 0, endIndex: 1 },
          },
        }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:${LAST_COL}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [FIELDS] },
    });
    return { dataRows: rows, headerOffset: 1 };
  }

  return { dataRows: rows.slice(1), headerOffset: 1 };
}

const isLive = rec => rec && rec.id && rec.HouseDeleted !== '1';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toISOString();

    /* ── GET ── */
    if (req.method === 'GET') {
      const { dataRows } = await readAll(sheets);
      return res.json(dataRows.filter(r => r && r[0]).map(rowToRecord).filter(isLive));
    }

    /* ── POST: create one ── */
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const rec = sanitize(body);
      rec.id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : uid();
      deriveSlots(rec);
      rec.HouseUpdatedAt = now;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: RANGE,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [recordToRow(rec)] },
      });
      return res.json({ id: rec.id, HouseUpdatedAt: now });
    }

    /* ── PATCH: update one ── */
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      const { dataRows, headerOffset } = await readAll(sheets);
      const idx = dataRows.findIndex(r => r && r[0] === body.id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });

      const merged = mergeRow(rowToRecord(dataRows[idx]), sanitize(body), now);
      merged.id = body.id;
      const sheetRow = idx + headerOffset + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${sheetRow}:${LAST_COL}${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [recordToRow(merged)] },
      });
      return res.json({ ok: true, HouseUpdatedAt: now });
    }

    /* ── DELETE: soft ──
       Never removes the row. Deleting shifts every later row's index, and a
       concurrent write that resolved its index a moment earlier would then land
       on the wrong house — corrupting one record with another's data. A flag
       cannot do that. */
    if (req.method === 'DELETE') {
      const body = await parseBody(req);
      const { dataRows, headerOffset } = await readAll(sheets);
      const idx = dataRows.findIndex(r => r && r[0] === body.id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });

      const rec = rowToRecord(dataRows[idx]);
      rec.HouseDeleted = '1';
      rec.HouseUpdatedAt = now;
      const sheetRow = idx + headerOffset + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${sheetRow}:${LAST_COL}${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [recordToRow(rec)] },
      });
      return res.json({ ok: true });
    }

    /* ── PUT: bulk sync ──
       { creates:[rec], updates:[{id,...fields,_base}], deletes:[id] }
       Costs a fixed 3 Sheets calls no matter how deep the queue, so a long
       offline session uploads in one round trip. */
    if (req.method === 'PUT') {
      const body = await parseBody(req);
      const creates = Array.isArray(body.creates) ? body.creates : [];
      const updates = Array.isArray(body.updates) ? body.updates : [];
      const deletes = Array.isArray(body.deletes) ? body.deletes.filter(x => typeof x === 'string') : [];

      const { dataRows, headerOffset } = await readAll(sheets);
      const rowById = new Map();
      dataRows.forEach((r, i) => { if (r && r[0]) rowById.set(r[0], i); });

      const deleteSet = new Set(deletes);
      const conflicts = [];
      const applied = { created: [], updated: [], deleted: [], missing: [] };
      const writes = new Map(); // rowIndex -> merged record (one write per row)

      for (const u of updates) {
        if (!u || typeof u.id !== 'string' || deleteSet.has(u.id)) continue;
        const idx = rowById.get(u.id);
        if (idx === undefined) { applied.missing.push(u.id); continue; }
        const existing = writes.get(idx) || rowToRecord(dataRows[idx]);
        if (u._base && existing.HouseUpdatedAt && existing.HouseUpdatedAt > u._base) {
          conflicts.push({ id: u.id, remote: existing });
        }
        const merged = mergeRow(existing, sanitize(u), now);
        merged.id = u.id;
        writes.set(idx, merged);
        applied.updated.push(u.id);
      }

      for (const id of deletes) {
        const idx = rowById.get(id);
        if (idx === undefined) { applied.missing.push(id); continue; }
        const rec = writes.get(idx) || rowToRecord(dataRows[idx]);
        rec.HouseDeleted = '1';
        rec.HouseUpdatedAt = now;
        writes.set(idx, rec);
        applied.deleted.push(id);
      }

      if (writes.size) {
        const data = [];
        writes.forEach((rec, idx) => {
          const sheetRow = idx + headerOffset + 1;
          data.push({ range: `${SHEET_NAME}!A${sheetRow}:${LAST_COL}${sheetRow}`, values: [recordToRow(rec)] });
        });
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { valueInputOption: 'RAW', data },
        });
      }

      // Creates last. Appends land after existing rows, so the indices above
      // stay valid. Existing ids are skipped, making a retried sync harmless.
      const newRows = [];
      for (const c of creates) {
        if (!c) continue;
        const rec = sanitize(c);
        rec.id = (typeof c.id === 'string' && c.id.trim()) ? c.id.trim() : uid();
        if (rowById.has(rec.id) || deleteSet.has(rec.id)) continue;
        rec.HouseVisitLog = seedLog(rec) || rec.HouseVisitLog || '';
        deriveSlots(rec);
        rec.HouseUpdatedAt = now;
        newRows.push(recordToRow(rec));
        applied.created.push(rec.id);
      }
      if (newRows.length) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: RANGE,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: newRows },
        });
      }

      const after = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
      const records = (after.data.values || []).slice(1).filter(r => r && r[0]).map(rowToRecord).filter(isLive);
      return res.json({ ok: true, applied, conflicts, records, serverTime: now });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
