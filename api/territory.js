const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Houses';
const FIELDS = [
  'id','HouseAddress','HouseCity','HouseState','HouseZIP',
  'HouseTerritoryNumber','HouseTerritoryAssingnedTo','HouseLanguage',
  'HouseLastVisitDate','HouseGPSCoordinates','HouseNotes','HousePersonalNotes',
  'HouseResutsOnVisit1','HouseResutsOnVisit2','HouseResutsOnVisit3',
  'HouseResutsOnVisit4','HouseResutsOnVisit5'
];
const LAST_COL = 'Q'; // 17 fields = A–Q
const RANGE = `${SHEET_NAME}!A:${LAST_COL}`;

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    /* ── GET all records ── */
    if (req.method === 'GET') {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
      const rows = resp.data.values || [];
      // row 0 is the header; skip it and skip blank rows
      const records = rows.slice(1).filter(r => r && r[0]).map(rowToRecord);
      return res.json(records);
    }

    /* ── POST: create new house ── */
    if (req.method === 'POST') {
      const body = await parseBody(req);
      body.id = uid();
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: RANGE,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [recordToRow(body)] },
      });
      return res.json({ id: body.id });
    }

    /* ── PATCH: update fields on an existing house ── */
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      const { id, ...updates } = body;
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
      const rows = resp.data.values || [];
      const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === id);
      if (rowIndex === -1) return res.status(404).json({ error: 'Not found' });

      const existing = rowToRecord(rows[rowIndex]);
      const updated = { ...existing, ...updates };
      const sheetRow = rowIndex + 1; // 1-based, header is row 1 so data rows start at 2
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${sheetRow}:${LAST_COL}${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [recordToRow(updated)] },
      });
      return res.json({ ok: true });
    }

    /* ── DELETE: remove a house row ── */
    if (req.method === 'DELETE') {
      const body = await parseBody(req);
      const { id } = body;
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
      const rows = resp.data.values || [];
      const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === id);
      if (rowIndex === -1) return res.status(404).json({ error: 'Not found' });

      // Get the numeric sheetId of the "Houses" tab
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
      const tab = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
      const sheetTabId = tab ? tab.properties.sheetId : 0;

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: { sheetId: sheetTabId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 }
            }
          }]
        },
      });
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
