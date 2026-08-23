/* One storage interface over two backends.

   The endpoints talk to this, not to Google Sheets or SharePoint directly, so
   switching backends is a configuration change rather than a rewrite. If the
   SP_* variables are present we use SharePoint; otherwise we fall back to the
   Sheet. That fallback IS the rollback plan: remove one variable and the app
   returns to Sheets on the next deploy.

   Rows are addressed by an opaque `_key`. On Sheets that is the row number, on
   SharePoint the list item id. Callers must never do arithmetic on it — the
   row-shifting bugs that arithmetic caused are exactly what we are leaving
   behind.

   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

const { google } = require('googleapis');
const SP = require('./_sp');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const colLetter = n => {
  let s = '', x = n;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return s;
};

const cell = v => (v === undefined || v === null ? '' : String(v));

/* A store lives for one request. Module scope would let a warm instance serve
   one user rows cached for another. */
function makeStore() {
  const useSP = SP.configured();
  const cache = new Map();
  let _sheets = null;

  function sheets() {
    if (_sheets) return _sheets;
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    _sheets = google.sheets({ version: 'v4', auth });
    return _sheets;
  }

  /* ── Google Sheets ── */
  async function shEnsure(spec) {
    const meta = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID });
    const found = meta.data.sheets.find(s => s.properties.title === spec.name);
    if (found) return found.properties.sheetId;
    const res = await sheets().spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: spec.name } } }] },
    });
    await sheets().spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${spec.name}!A1:${colLetter(spec.cols.length - 1)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [spec.cols] },
    });
    return res.data.replies[0].addSheet.properties.sheetId;
  }

  function shRowsToRecords(rows, spec) {
    return rows.slice(1)
      .map((r, i) => ({ r, key: i + 2 }))
      .filter(x => x.r && x.r[0] !== undefined && x.r[0] !== '')
      .map(x => {
        const o = { _key: x.key };
        spec.cols.forEach((c, j) => { o[c] = x.r[j] !== undefined ? x.r[j] : ''; });
        return o;
      });
  }

  async function shRead(spec) {
    const range = `${spec.name}!A:${colLetter(spec.cols.length - 1)}`;
    let rows;
    try {
      const r = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
      rows = r.data.values || [];
    } catch (e) { await shEnsure(spec); return []; }

    const hdr = rows[0] || [];
    const isHeader = hdr[0] === spec.cols[0];
    if (!rows.length || (isHeader && !spec.cols.every((c, i) => hdr[i] === c))) {
      await shEnsure(spec);
      await sheets().spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${spec.name}!A1:${colLetter(spec.cols.length - 1)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [spec.cols] },
      });
      if (!rows.length) return [];
    } else if (rows.length && !isHeader) {
      // Row 1 holds data, not a header. Insert one above rather than
      // overwriting a real record.
      await sheets().spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ insertDimension: {
          range: { sheetId: await shEnsure(spec), dimension: 'ROWS', startIndex: 0, endIndex: 1 } } }] },
      });
      await sheets().spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${spec.name}!A1:${colLetter(spec.cols.length - 1)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [spec.cols] },
      });
      return shRowsToRecords([spec.cols].concat(rows), spec);
    }
    return shRowsToRecords(rows, spec);
  }

  async function shCreate(spec, obj) {
    await shEnsure(spec);
    await sheets().spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${spec.name}!A:${colLetter(spec.cols.length - 1)}`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [spec.cols.map(c => cell(obj[c]))] },
    });
    return null; // the row number is not known without re-reading
  }

  async function shCreateMany(spec, objs) {
    if (!objs.length) return;
    await shEnsure(spec);
    await sheets().spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${spec.name}!A:${colLetter(spec.cols.length - 1)}`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: objs.map(o => spec.cols.map(c => cell(o[c]))) },
    });
  }

  async function shUpdateMany(spec, entries) {
    if (!entries.length) return;
    const last = colLetter(spec.cols.length - 1);
    await sheets().spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: entries.map(e => ({
          range: `${spec.name}!A${e.key}:${last}${e.key}`,
          values: [spec.cols.map(c => cell(e.obj[c]))],
        })),
      },
    });
  }

  async function shRemove(spec, keys) {
    if (!keys.length) return;
    const tabId = await shEnsure(spec);
    // Descending, so removing one row does not shift the next one's index.
    const desc = keys.slice().sort((a, b) => b - a);
    await sheets().spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: desc.map(k => ({
        deleteDimension: { range: { sheetId: tabId, dimension: 'ROWS', startIndex: k - 1, endIndex: k } } })) },
    });
  }

  /* ── SharePoint ── */
  const spRead = async spec =>
    (await SP.readList(spec)).map(r => Object.assign({}, r, { _key: r._row }));

  async function spUpdateMany(spec, entries) {
    if (!entries.length) return;
    if (entries.length === 1) return SP.updateItem(spec, entries[0].key, entries[0].obj);
    const base = await SP.itemPath(spec);
    const res = await SP.batch(entries.map(e => ({
      method: 'PATCH', url: `${base}/${e.key}/fields`, body: SP.toFields(spec, e.obj),
    })));
    const bad = res.filter(r => r.status >= 400);
    if (bad.length) throw new Error('SharePoint rejected ' + bad.length + ' update(s): ' +
      JSON.stringify(bad[0].body && bad[0].body.error || bad[0].status).slice(0, 200));
  }

  async function spCreateMany(spec, objs) {
    for (const o of objs) await SP.createItem(spec, o);
  }

  async function spRemove(spec, keys) {
    for (const k of keys) await SP.deleteItem(spec, k);
  }

  /* ── public interface ── */
  async function read(spec) {
    if (!cache.has(spec.name)) cache.set(spec.name, await (useSP ? spRead(spec) : shRead(spec)));
    return cache.get(spec.name);
  }
  const invalidate = spec => cache.delete(spec.name);

  return {
    backend: useSP ? 'sharepoint' : 'sheets',
    read,
    readFresh: async spec => { invalidate(spec); return read(spec); },
    async create(spec, obj) {
      invalidate(spec);
      return useSP ? SP.createItem(spec, obj) : shCreate(spec, obj);
    },
    async createMany(spec, objs) {
      if (!objs || !objs.length) return;
      invalidate(spec);
      return useSP ? spCreateMany(spec, objs) : shCreateMany(spec, objs);
    },
    async update(spec, key, obj) {
      invalidate(spec);
      return useSP ? SP.updateItem(spec, key, obj) : shUpdateMany(spec, [{ key, obj }]);
    },
    async updateMany(spec, entries) {
      if (!entries || !entries.length) return;
      invalidate(spec);
      return useSP ? spUpdateMany(spec, entries) : shUpdateMany(spec, entries);
    },
    async remove(spec, keys) {
      if (!keys || !keys.length) return;
      invalidate(spec);
      return useSP ? spRemove(spec, keys) : shRemove(spec, keys);
    },
  };
}

module.exports = { makeStore, colLetter };
