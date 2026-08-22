const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Houses';
const FIELDS = [
  'id','HouseAddress','HouseCity','HouseState','HouseZIP',
  'HouseTerritoryNumber','HouseTerritoryAssingnedTo','HouseLanguage',
  'HouseLastVisitDate','HouseGPSCoordinates','HouseNotes','HousePersonalNotes',
  'HouseResutsOnVisit1','HouseResutsOnVisit2','HouseResutsOnVisit3',
  'HouseResutsOnVisit4','HouseResutsOnVisit5','HouseVerifiedOnMaps',
  'HouseReturnVisits','HouseUpdatedAt'
];
const LAST_COL = 'T'; // 20 fields = A–T
const RANGE = `${SHEET_NAME}!A:${LAST_COL}`;

// Server-owned. A client may not set these directly; the server stamps them so
// offline clients can compare their base version against the live row.
const SERVER_FIELDS = new Set(['HouseUpdatedAt']);

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

// Strip anything the client is not allowed to write.
function sanitize(updates) {
  const clean = {};
  Object.keys(updates || {}).forEach(k => {
    if (k !== 'id' && !SERVER_FIELDS.has(k) && FIELDS.includes(k)) clean[k] = updates[k];
  });
  return clean;
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

/* Read every row and repair the header if needed. Returns data rows only. */
async function readAll(sheets) {
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
  const rows = resp.data.values || [];
  const hdr = rows[0] || [];
  const isHeaderRow = hdr[0] === 'id';
  const headerOk = isHeaderRow && FIELDS.every((f, i) => hdr[i] === f);

  if (!rows.length || (isHeaderRow && !headerOk)) {
    // Empty sheet, or row 1 is genuinely a header that is missing newly added columns.
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:${LAST_COL}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [FIELDS] },
    });
    return { rows, dataRows: rows.slice(1), headerOffset: 1 };
  }

  if (rows.length && !isHeaderRow) {
    // Row 1 holds data (a POST landed before any GET). Insert a header above it
    // rather than destroying that record.
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
    // `rows` was read pre-insert, so every entry is data — and each has shifted down one.
    return { rows: [FIELDS].concat(rows), dataRows: rows, headerOffset: 1 };
  }

  return { rows, dataRows: rows.slice(1), headerOffset: 1 };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toISOString();

    /* ── GET: all records ── */
    if (req.method === 'GET') {
      const { dataRows } = await readAll(sheets);
      return res.json(dataRows.filter(r => r && r[0]).map(rowToRecord));
    }

    /* ── POST: create one house ── */
    if (req.method === 'POST') {
      const body = await parseBody(req);
      // Honor a client-supplied id so a house created offline keeps the same
      // identity after sync; otherwise the client would have to remap references.
      const rec = sanitize(body);
      rec.id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : uid();
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

    /* ── PATCH: update one house ── */
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      const id = body.id;
      const updates = sanitize(body);
      const { dataRows, headerOffset } = await readAll(sheets);
      const idx = dataRows.findIndex(r => r && r[0] === id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });

      const existing = rowToRecord(dataRows[idx]);
      const updated = { ...existing, ...updates, id, HouseUpdatedAt: now };
      const sheetRow = idx + headerOffset + 1; // 1-based row number in the sheet
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${sheetRow}:${LAST_COL}${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [recordToRow(updated)] },
      });
      return res.json({ ok: true, HouseUpdatedAt: now });
    }

    /* ── DELETE: remove one house ── */
    if (req.method === 'DELETE') {
      const body = await parseBody(req);
      const { dataRows, headerOffset } = await readAll(sheets);
      const idx = dataRows.findIndex(r => r && r[0] === body.id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });

      const start = idx + headerOffset; // 0-based index into the sheet grid
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId: await getTabId(sheets), dimension: 'ROWS', startIndex: start, endIndex: start + 1 },
            },
          }],
        },
      });
      return res.json({ ok: true });
    }

    /* ── PUT: bulk sync ──
       Body: { creates:[rec], updates:[{id,...fields,_base}], deletes:[id] }
       `_base` is the HouseUpdatedAt the client last saw. If the live row is newer,
       the update still applies (the user's typing is never thrown away) but the
       pre-update remote record is returned under `conflicts` so the client can
       keep it instead of losing it silently.

       Costs 4 Sheets calls regardless of how many changes are queued, so a long
       offline session syncs in one round trip. */
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

      // 1. Updates -> one batched value write across many ranges.
      const valueRanges = [];
      for (const u of updates) {
        if (!u || typeof u.id !== 'string') continue;
        if (deleteSet.has(u.id)) continue; // delete wins over update
        const idx = rowById.get(u.id);
        if (idx === undefined) { applied.missing.push(u.id); continue; }

        const existing = rowToRecord(dataRows[idx]);
        if (u._base && existing.HouseUpdatedAt && existing.HouseUpdatedAt > u._base) {
          conflicts.push({ id: u.id, remote: existing });
        }
        const merged = { ...existing, ...sanitize(u), id: u.id, HouseUpdatedAt: now };
        const sheetRow = idx + headerOffset + 1;
        valueRanges.push({
          range: `${SHEET_NAME}!A${sheetRow}:${LAST_COL}${sheetRow}`,
          values: [recordToRow(merged)],
        });
        applied.updated.push(u.id);
      }
      if (valueRanges.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { valueInputOption: 'RAW', data: valueRanges },
        });
      }

      // 2. Creates -> one append. Skips ids that already exist so a retried sync
      //    (e.g. the response was lost) cannot duplicate a house.
      const newRows = [];
      for (const c of creates) {
        if (!c) continue;
        const rec = sanitize(c);
        rec.id = (typeof c.id === 'string' && c.id.trim()) ? c.id.trim() : uid();
        if (rowById.has(rec.id) || deleteSet.has(rec.id)) continue;
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

      // 3. Deletes -> one batched request, descending so earlier removals do not
      //    shift the indices of later ones. Appends land after all existing rows,
      //    so indices read in step 0 are still valid here.
      const delIdx = deletes
        .map(id => rowById.get(id))
        .filter(i => i !== undefined)
        .sort((a, b) => b - a);
      deletes.forEach(id => { if (rowById.has(id)) applied.deleted.push(id); else applied.missing.push(id); });
      if (delIdx.length) {
        const tabId = await getTabId(sheets);
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: delIdx.map(i => ({
              deleteDimension: {
                range: { sheetId: tabId, dimension: 'ROWS', startIndex: i + headerOffset, endIndex: i + headerOffset + 1 },
              },
            })),
          },
        });
      }

      // 4. Return the authoritative snapshot so the client ends the sync in a
      //    known-good state without a second round trip.
      const after = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
      const records = (after.data.values || []).slice(1).filter(r => r && r[0]).map(rowToRecord);
      return res.json({ ok: true, applied, conflicts, records, serverTime: now });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
