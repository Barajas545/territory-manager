/* One-shot migration: copy every tab from the Google Sheet into SharePoint,
   then verify field-by-field that nothing changed on the way across.

   Deliberately a temporary endpoint. It is removed once the move is done.

   POST /api/migrate  { action: 'plan' | 'copy' | 'verify', confirm?: 'MIGRATE' }

   - plan   reads both sides and reports what would be copied. Writes nothing.
   - copy   refuses unless the destination list is empty, so running it twice
            cannot duplicate anything.
   - verify re-reads both sides and diffs every field of every record.
*/

const { google } = require('googleapis');
const SP = require('./_sp');
const AS = require('./_assign');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const MIGRATE_KEY = process.env.MIGRATE_KEY || '';

const HOUSES = {
  name: 'Houses',
  cols: ['id','HouseAddress','HouseCity','HouseState','HouseZIP',
    'HouseTerritoryNumber','HouseTerritoryAssingnedTo','HouseLanguage',
    'HouseLastVisitDate','HouseGPSCoordinates','HouseNotes','HousePersonalNotes',
    'HouseResutsOnVisit1','HouseResutsOnVisit2','HouseResutsOnVisit3',
    'HouseResutsOnVisit4','HouseResutsOnVisit5','HouseVerifiedOnMaps',
    'HouseReturnVisits','HouseUpdatedAt','HouseVisitLog','HouseDeleted'],
};
const USERS = {
  name: 'Users',
  cols: ['id','name','phone','email','role','passHash','passSalt','setupCode',
    'mustSetup','active','createdAt','updatedAt'],
};
const PRESENCE = { name: 'Presence', cols: ['userId','territory','lat','lng','acc','ts'] };
const VOICE = { name: 'Voice', cols: ['id','territory','userId','ts','dur','audio'] };

// Presence and Voice are ephemeral by design — both expire within hours, so
// copying them across would move nothing but stale rows.
const SPECS = [HOUSES, USERS, AS.TERR_TAB, AS.ASSIGN_TAB];

const colLetter = n => {
  let s = '', x = n;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return s;
};

function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function readSheet(sheets, spec) {
  const range = `${spec.name}!A:${colLetter(spec.cols.length - 1)}`;
  let rows = [];
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    rows = r.data.values || [];
  } catch (e) { return []; }
  const hdr = rows[0] || [];
  const offset = hdr[0] === spec.cols[0] ? 1 : 0; // tolerate a missing header
  return rows.slice(offset).filter(r => r && r[0] !== undefined && r[0] !== '')
    .map(r => {
      const o = {};
      spec.cols.forEach((c, j) => { o[c] = r[j] !== undefined ? String(r[j]) : ''; });
      return o;
    });
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Identity differs per tab; Territories are keyed by name, everything else by id.
const keyOf = (spec, r) => (spec.name === AS.TERR_TAB.name ? r.name : r.id);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    if (!SP.configured()) return res.status(400).json({ error: 'SharePoint is not configured' });
    const body = await parseBody(req);
    const action = String(body.action || 'plan');

    // Copy and verify move real data, so they need the shared key. Plan is
    // read-only and reports counts only.
    if (action !== 'plan') {
      if (!MIGRATE_KEY) return res.status(403).json({ error: 'MIGRATE_KEY is not set on this deployment' });
      if (String(body.key || '') !== MIGRATE_KEY) return res.status(403).json({ error: 'Wrong migration key' });
    }

    const sheets = sheetsClient();
    const out = { action, backend: 'sharepoint', tabs: {} };

    if (action === 'plan') {
      for (const spec of SPECS) {
        const src = await readSheet(sheets, spec);
        let dst = [];
        try { dst = await SP.readList(spec); } catch (e) { dst = []; }
        out.tabs[spec.name] = { inSheet: src.length, inSharePoint: dst.length };
      }
      return res.json(out);
    }

    if (action === 'copy') {
      if (String(body.confirm) !== 'MIGRATE')
        return res.status(400).json({ error: 'Pass confirm:"MIGRATE"' });
      for (const spec of SPECS) {
        const src = await readSheet(sheets, spec);
        const dst = await SP.readList(spec);
        if (dst.length) {
          // Refusing beats merging: a partial re-run must never duplicate rows.
          out.tabs[spec.name] = { skipped: true, reason: 'destination already has ' + dst.length + ' rows' };
          continue;
        }
        let copied = 0;
        for (const rec of src) { await SP.createItem(spec, rec); copied++; }
        out.tabs[spec.name] = { copied, source: src.length };
      }
      return res.json(out);
    }

    if (action === 'verify') {
      let mismatches = 0;
      for (const spec of SPECS) {
        const src = await readSheet(sheets, spec);
        const dst = await SP.readList(spec);
        const dstBy = new Map();
        dst.forEach(r => dstBy.set(keyOf(spec, r), r));
        const problems = [];
        src.forEach(s => {
          const d = dstBy.get(keyOf(spec, s));
          if (!d) { problems.push({ key: keyOf(spec, s), issue: 'missing in SharePoint' }); return; }
          spec.cols.forEach(c => {
            if (String(s[c] || '') !== String(d[c] || ''))
              problems.push({ key: keyOf(spec, s), field: c,
                sheet: String(s[c] || '').slice(0, 60), sharePoint: String(d[c] || '').slice(0, 60) });
          });
        });
        mismatches += problems.length;
        out.tabs[spec.name] = {
          inSheet: src.length, inSharePoint: dst.length,
          extraInSharePoint: dst.length - src.length,
          problems: problems.slice(0, 25),
          problemCount: problems.length,
        };
      }
      out.identical = mismatches === 0;
      return res.json(out);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
