/* Team endpoint: accounts, territory assignment, live position sharing and
   push-to-talk voice, all on the same Google Sheet as the house data.

   One function with an `action` field rather than a file per route — this many
   tiny endpoints would otherwise each pay their own cold start.

   POST /api/team  { action, ... }
   Authenticated calls send  Authorization: Bearer <token>
*/

const crypto = require('crypto');
const { google } = require('googleapis');
const AS = require('./_assign');
const SP = require('./_sp');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const TABS = {
  users: {
    name: 'Users',
    cols: ['id','name','phone','email','role','passHash','passSalt','setupCode',
           'mustSetup','active','createdAt','updatedAt'],
  },
  territories: AS.TERR_TAB,
  assignments: AS.ASSIGN_TAB,
  presence: {
    name: 'Presence',
    cols: ['userId','territory','lat','lng','acc','ts'],
  },
  voice: {
    name: 'Voice',
    cols: ['id','territory','userId','ts','dur','audio'],
  },
};

const colLetter = n => {
  let s = '', x = n;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return s;
};

/* A voice clip lives in one cell. Sheets caps a cell at 50k characters, so the
   client is told to keep clips short and we refuse anything larger rather than
   writing a truncated, unplayable blob. */
const MAX_AUDIO_CHARS = 45000;
const VOICE_TTL_MS = 6 * 60 * 60 * 1000;   // clips older than this are pruned
const PRESENCE_TTL_MS = 30 * 60 * 1000;    // a position older than this is stale
const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days: re-login in the field is painful

function getAuth() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/* Signing secret. Prefer an explicit AUTH_SECRET, but fall back to a value
   derived from the service-account key so the app works without a second
   manual setup step. Both are server-side only and never leave the function. */
function secret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const k = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');
  return crypto.createHash('sha256')
    .update('tm-auth|' + (k.private_key_id || '') + '|' + (k.client_email || ''))
    .digest('hex');
}

const b64u = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + mac;
}

function verify(token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, mac] = token.split('.');
  const expect = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  // Constant-time compare: a length-varying or early-exit compare leaks the
  // signature one byte at a time.
  const a = Buffer.from(mac || ''), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(unb64u(body).toString('utf8')); } catch (e) { return null; }
  if (!p || !p.exp || Date.now() > p.exp) return null;
  return p;
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { hash: h, salt: s };
}

function passwordMatches(password, hash, salt) {
  if (!hash || !salt) return false;
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
// Unambiguous alphabet: no O/0, I/1, so a code read aloud cannot be mistyped.
const setupCode = () => Array.from(crypto.randomBytes(6))
  .map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 6e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* ── sheet helpers ── */
async function ensureTab(sheets, spec) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const found = meta.data.sheets.find(s => s.properties.title === spec.name);
  if (found) return found.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: spec.name } } }] },
  });
  const id = res.data.replies[0].addSheet.properties.sheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${spec.name}!A1:${colLetter(spec.cols.length - 1)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [spec.cols] },
  });
  return id;
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

async function writeRow(sheets, spec, rowNum, obj) {
  const last = colLetter(spec.cols.length - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${spec.name}!A${rowNum}:${last}${rowNum}`,
    valueInputOption: 'RAW',
    requestBody: { values: [spec.cols.map(c => (obj[c] === undefined || obj[c] === null ? '' : String(obj[c])))] },
  });
}

async function writeRows(sheets, spec, entries) {
  if (!entries.length) return;
  const last = colLetter(spec.cols.length - 1);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: entries.map(e => ({
        range: `${spec.name}!A${e.row}:${last}${e.row}`,
        values: [spec.cols.map(c => (e.obj[c] === undefined || e.obj[c] === null ? '' : String(e.obj[c])))],
      })),
    },
  });
}

async function deleteRows(sheets, spec, rowNums) {
  if (!rowNums.length) return;
  const tabId = await ensureTab(sheets, spec);
  const desc = rowNums.slice().sort((a, b) => b - a);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: desc.map(r => ({
        deleteDimension: { range: { sheetId: tabId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } },
      })),
    },
  });
}

/* Never let a hash, salt or setup code reach a client. */
const publicUser = u => ({
  id: u.id, name: u.name, phone: u.phone, email: u.email,
  role: u.role || 'user', active: u.active !== '0',
  mustSetup: u.mustSetup === '1',
});

const norm = v => String(v || '').trim().toLowerCase();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const body = await parseBody(req);
    const action = String(body.action || '');
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const claims = verify(bearer);

    /* Sheets allows only 60 reads a minute for the whole service account, and
       several actions here legitimately need the same tab more than once
       (teamFor re-reads what its caller already read). Without this, a couple
       of people working together exhaust the quota and every request starts
       failing. The cache lives for one request only — module scope would serve
       one user another user's stale data. */
    const _cache = new Map();
    /* Sheets counts REQUESTS, not rows, so pulling four small tabs in one
       batchGet costs the same as pulling one. Almost every action here needs
       two or more of them, so the first read fetches the whole set at once.
       Voice is excluded on purpose: its rows carry base64 audio, and dragging
       that through every unrelated request would be pointlessly expensive. */
    const SMALL = [TABS.users, TABS.territories, TABS.assignments, TABS.presence];
    let _prefetched = false;
    async function prefetch() {
      if (_prefetched) return;
      _prefetched = true;
      try {
        const r = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SHEET_ID,
          ranges: SMALL.map(sp => `${sp.name}!A:${colLetter(sp.cols.length - 1)}`),
        });
        (r.data.valueRanges || []).forEach((vr, i) => {
          const sp = SMALL[i];
          const rows = vr.values || [];
          const hdr = rows[0] || [];
          // A tab whose header does not match yet needs the repairing path,
          // so leave it uncached and let readTab handle it.
          if (!rows.length || !sp.cols.every((c, j) => hdr[j] === c)) return;
          _cache.set(sp.name, rows.slice(1)
            .filter(rw => rw && rw[0] !== undefined && rw[0] !== '')
            .map((rw, k) => {
              const o = { _row: k + 2 };
              sp.cols.forEach((c, j) => { o[c] = rw[j] !== undefined ? rw[j] : ''; });
              return o;
            }));
        });
      } catch (e) { /* fall back to per-tab reads */ }
    }
    const rd = async spec => {
      if (SMALL.indexOf(spec) !== -1) await prefetch();
      if (!_cache.has(spec.name)) _cache.set(spec.name, await readTab(sheets, spec));
      return _cache.get(spec.name);
    };
    const wr = async (spec, row, obj) => { _cache.delete(spec.name); return writeRow(sheets, spec, row, obj); };
    const ap = async (spec, obj) => { _cache.delete(spec.name); return appendRow(sheets, spec, obj); };
    const dl = async (spec, rows) => { _cache.delete(spec.name); return deleteRows(sheets, spec, rows); };
    const wrs = async (spec, entries) => { _cache.delete(spec.name); return writeRows(sheets, spec, entries); };

    async function currentUser() {
      if (!claims || !claims.uid) return null;
      const users = await rd(TABS.users);
      const u = users.find(x => x.id === claims.uid);
      return u && u.active !== '0' ? u : null;
    }
    /* A guest is a real participant for the parts that matter in the field --
       being visible on the map and being able to talk -- but is not a user and
       owns nothing. Modelled as a synthetic identity rather than a row. */
    async function currentActor() {
      if (claims && claims.g) {
        const packet = await AS.loadPacket(sheets, claims.g, now);
        if (!packet.state.ok) { const e = new Error(packet.state.reason); e.code = 403; throw e; }
        return {
          id: 'g:' + packet.assignment.id,
          name: packet.assignment.guestName || 'Guest',
          role: 'guest',
          territory: packet.assignment.territory,
        };
      }
      const u = await currentUser();
      return u ? { id: u.id, name: u.name, role: u.role || 'user', territory: null } : null;
    }
    const requireActor = async () => {
      const a = await currentActor();
      if (!a) { const e = new Error('Not signed in'); e.code = 401; throw e; }
      return a;
    };
    const requireUser = async () => {
      const u = await currentUser();
      if (!u) { const e = new Error('Not signed in'); e.code = 401; throw e; }
      return u;
    };
    const requireAdmin = async () => {
      const u = await requireUser();
      if (u.role !== 'admin') { const e = new Error('Admins only'); e.code = 403; throw e; }
      return u;
    };

    /* ══ ACCOUNTS ══ */

    /* Migration diagnostic. Reports only whether each step works and what
       failed -- never a secret, never any territory data. Removed once the
       move to SharePoint is done. */
    if (action === 'spCheck') {
      const out = { configured: SP.configured(), steps: [] };
      if (!out.configured) {
        out.steps.push({ step: 'environment variables', ok: false,
          detail: 'One of SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SITE_URL is missing on this deployment' });
        return res.json(out);
      }
      out.steps.push({ step: 'environment variables', ok: true, detail: 'all four present' });
      let sid = null;
      try {
        sid = await SP.siteId();
        // The id is not a secret, but trim it so the response stays readable.
        out.steps.push({ step: 'sign in and find the site', ok: true, detail: String(sid).slice(0, 60) + '…' });
      } catch (e) {
        out.steps.push({ step: 'sign in and find the site', ok: false, detail: String(e.message).slice(0, 300) });
        return res.json(out);
      }
      try {
        const lists = await SP.graph('/sites/' + sid + '/lists?$select=displayName&$top=50');
        out.steps.push({ step: 'read the site', ok: true,
          detail: (lists.value || []).length + ' lists visible' });
        out.ready = true;
      } catch (e) {
        const msg = String(e.message);
        out.steps.push({ step: 'read the site', ok: false,
          detail: /accessDenied|Access denied|Either scp or roles/i.test(msg)
            ? 'Signed in, but this app has not been granted access to the site yet — the Graph permission grant is still needed'
            : msg.slice(0, 300) });
      }
      return res.json(out);
    }

    if (action === 'status') {
      const users = await rd(TABS.users);
      return res.json({
        ok: true,
        hasUsers: users.length > 0,
        adminCount: users.filter(u => u.role === 'admin' && u.active !== '0').length,
        me: claims ? publicUser((await currentUser()) || {}) : null,
      });
    }

    /* First-run only. Creates the very first admin, and refuses once any user
       exists — so it is open for exactly as long as there is nothing to protect. */
    if (action === 'bootstrapAdmin') {
      const users = await rd(TABS.users);
      if (users.length) return res.status(400).json({ error: 'Setup already completed' });
      const name = String(body.name || '').trim();
      const pw = String(body.password || '');
      if (!name) return res.status(400).json({ error: 'Name is required' });
      if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const { hash, salt } = hashPassword(pw);
      const rec = {
        id: uid(), name, phone: String(body.phone || '').trim(), email: String(body.email || '').trim(),
        role: 'admin', passHash: hash, passSalt: salt, setupCode: '', mustSetup: '0', active: '1',
        createdAt: nowIso, updatedAt: nowIso,
      };
      await ap(TABS.users, rec);
      return res.json({ ok: true, token: sign({ uid: rec.id, exp: now + TOKEN_TTL_MS }), user: publicUser(rec) });
    }

    if (action === 'login') {
      const users = await rd(TABS.users);
      const login = norm(body.login);
      const u = users.find(x => x.active !== '0' &&
        (norm(x.name) === login || norm(x.phone) === login ||
         norm(x.email) === login || norm(String(x.phone).replace(/\D/g, '')) === login.replace(/\D/g, '')));
      // Same message either way: distinguishing them tells an attacker which
      // names are real.
      if (!u || !passwordMatches(body.password, u.passHash, u.passSalt))
        return res.status(401).json({ error: 'Wrong name or password' });
      return res.json({
        ok: true,
        token: sign({ uid: u.id, exp: now + TOKEN_TTL_MS }),
        user: publicUser(u),
      });
    }

    /* First run for an invited person: they present the code the admin gave
       them, fill in their own contact details, and choose their password. */
    if (action === 'redeemSetup') {
      const users = await rd(TABS.users);
      const code = String(body.setupCode || '').trim().toUpperCase();
      const u = users.find(x => x.setupCode && x.setupCode === code && x.active !== '0');
      if (!u) return res.status(400).json({ error: 'That setup code is not valid' });
      const pw = String(body.password || '');
      if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

      const { hash, salt } = hashPassword(pw);
      const updated = Object.assign({}, u, {
        name: String(body.name || u.name || '').trim() || u.name,
        phone: String(body.phone || u.phone || '').trim(),
        email: String(body.email || u.email || '').trim(),
        passHash: hash, passSalt: salt,
        setupCode: '', mustSetup: '0', updatedAt: nowIso,
      });
      await wr(TABS.users, u._row, updated);
      return res.json({
        ok: true,
        token: sign({ uid: u.id, exp: now + TOKEN_TTL_MS }),
        user: publicUser(updated),
      });
    }

    if (action === 'changePassword') {
      const u = await requireUser();
      if (!passwordMatches(body.currentPassword, u.passHash, u.passSalt))
        return res.status(401).json({ error: 'Current password is wrong' });
      const pw = String(body.newPassword || '');
      if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const { hash, salt } = hashPassword(pw);
      await wr(TABS.users, u._row,
        Object.assign({}, u, { passHash: hash, passSalt: salt, updatedAt: nowIso }));
      return res.json({ ok: true });
    }

    if (action === 'updateMe') {
      const u = await requireUser();
      const updated = Object.assign({}, u, {
        name: String(body.name || u.name).trim() || u.name,
        phone: String(body.phone !== undefined ? body.phone : u.phone).trim(),
        email: String(body.email !== undefined ? body.email : u.email).trim(),
        updatedAt: nowIso,
      });
      await wr(TABS.users, u._row, updated);
      return res.json({ ok: true, user: publicUser(updated) });
    }

    /* ══ ADMIN ══ */

    if (action === 'listUsers') {
      await requireAdmin();
      const users = await rd(TABS.users);
      // The pending setup code is shown to the admin only, so they can pass it on.
      return res.json({ ok: true, users: users.map(u => Object.assign(publicUser(u),
        { setupCode: u.mustSetup === '1' ? u.setupCode : '' })) });
    }

    if (action === 'createUser') {
      await requireAdmin();
      const users = await rd(TABS.users);
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name is required' });
      if (users.some(u => norm(u.name) === norm(name) && u.active !== '0'))
        return res.status(400).json({ error: 'Someone with that name already exists' });
      const code = setupCode();
      const rec = {
        id: uid(), name, phone: String(body.phone || '').trim(), email: String(body.email || '').trim(),
        role: body.role === 'admin' ? 'admin' : 'user',
        passHash: '', passSalt: '', setupCode: code, mustSetup: '1', active: '1',
        createdAt: nowIso, updatedAt: nowIso,
      };
      await ap(TABS.users, rec);
      return res.json({ ok: true, user: publicUser(rec), setupCode: code });
    }

    if (action === 'resetPassword') {
      await requireAdmin();
      const users = await rd(TABS.users);
      const u = users.find(x => x.id === body.id);
      if (!u) return res.status(404).json({ error: 'No such user' });
      const code = setupCode();
      await wr(TABS.users, u._row, Object.assign({}, u,
        { passHash: '', passSalt: '', setupCode: code, mustSetup: '1', updatedAt: nowIso }));
      return res.json({ ok: true, setupCode: code });
    }

    if (action === 'setUserActive') {
      const me = await requireAdmin();
      const users = await rd(TABS.users);
      const u = users.find(x => x.id === body.id);
      if (!u) return res.status(404).json({ error: 'No such user' });
      const active = body.active ? '1' : '0';
      if (u.id === me.id && active === '0')
        return res.status(400).json({ error: 'You cannot deactivate yourself' });
      if (active === '0' && u.role === 'admin' &&
          users.filter(x => x.role === 'admin' && x.active !== '0').length <= 1)
        return res.status(400).json({ error: 'That is the only admin left' });
      await wr(TABS.users, u._row, Object.assign({}, u, { active, updatedAt: nowIso }));
      return res.json({ ok: true });
    }

    if (action === 'deleteUser') {
      const me = await requireAdmin();
      const users = await rd(TABS.users);
      const u = users.find(x => x.id === body.id);
      if (!u) return res.status(404).json({ error: 'No such user' });
      if (u.id === me.id) return res.status(400).json({ error: 'You cannot delete yourself' });
      if (u.role === 'admin' && users.filter(x => x.role === 'admin' && x.active !== '0').length <= 1)
        return res.status(400).json({ error: 'That is the only admin left' });
      await dl(TABS.users, [u._row]);
      // Take their position row with them; a ghost pin on the map is worse
      // than no pin.
      const pres = await rd(TABS.presence);
      await dl(TABS.presence, pres.filter(p => p.userId === u.id).map(p => p._row));
      return res.json({ ok: true });
    }

    if (action === 'deleteTerritory') {
      await requireAdmin();
      const terrs = await rd(TABS.territories);
      const t = terrs.find(x => x.name === String(body.territory || ''));
      if (!t) return res.status(404).json({ error: 'No such territory' });
      await dl(TABS.territories, [t._row]);
      return res.json({ ok: true });
    }

    if (action === 'setUserRole') {
      const me = await requireAdmin();
      const users = await rd(TABS.users);
      const u = users.find(x => x.id === body.id);
      if (!u) return res.status(404).json({ error: 'No such user' });
      const role = body.role === 'admin' ? 'admin' : 'user';
      if (u.id === me.id && role !== 'admin')
        return res.status(400).json({ error: 'You cannot remove your own admin access' });
      await wr(TABS.users, u._row, Object.assign({}, u, { role, updatedAt: nowIso }));
      return res.json({ ok: true });
    }

    /* ══ TERRITORY ASSIGNMENT ══ */

    if (action === 'listTerritories') {
      const me = await requireUser();
      const [terrs, users] = await Promise.all([
        rd(TABS.territories), rd(TABS.users),
      ]);
      const byId = {};
      users.forEach(u => { byId[u.id] = publicUser(u); });
      return res.json({
        ok: true,
        me: publicUser(me),
        users: users.filter(u => u.active !== '0').map(publicUser),
        territories: terrs.map(t => ({
          name: t.name,
          ownerId: t.ownerId,
          owner: byId[t.ownerId] || null,
          assigneeIds: String(t.assigneeIds || '').split(',').filter(Boolean),
          assignees: String(t.assigneeIds || '').split(',').filter(Boolean).map(id => byId[id]).filter(Boolean),
        })),
      });
    }

    /* Only the territory's owner or an admin may change who works it. An
       unclaimed territory can be claimed by any signed-in user. */
    if (action === 'assignTerritory') {
      const me = await requireUser();
      const name = String(body.territory || '').trim();
      if (!name) return res.status(400).json({ error: 'Territory is required' });
      const terrs = await rd(TABS.territories);
      const existing = terrs.find(t => t.name === name);
      if (existing && existing.ownerId && existing.ownerId !== me.id && me.role !== 'admin')
        return res.status(403).json({ error: 'Only the person this territory is assigned to can change it' });

      const ownerId = body.ownerId !== undefined ? String(body.ownerId || '') : (existing ? existing.ownerId : me.id);
      const assigneeIds = Array.isArray(body.assigneeIds)
        ? body.assigneeIds.filter(x => typeof x === 'string' && x).join(',')
        : (existing ? existing.assigneeIds : '');
      const rec = { name, ownerId, assigneeIds, updatedAt: nowIso };
      if (existing) await wr(TABS.territories, existing._row, rec);
      else await ap(TABS.territories, rec);
      return res.json({ ok: true });
    }

    /* Everyone the territory is shared with — owner plus assignees. */
    async function teamFor(territory) {
      const [terrs, assigns] = await Promise.all([
        rd(TABS.territories), rd(TABS.assignments),
      ]);
      const t = terrs.find(x => x.name === territory);
      if (!t) return null;
      const ids = new Set(String(t.assigneeIds || '').split(',').filter(Boolean));
      if (t.ownerId) ids.add(t.ownerId);
      // Anyone holding a live packet for this territory counts as present,
      // account or not — they are the ones actually at the doors.
      assigns.forEach(a => {
        if (a.territory !== territory) return;
        if (!AS.packetState(a, t, now).ok) return;
        if (a.assigneeId) ids.add(a.assigneeId);
        else ids.add('g:' + a.id);
      });
      return ids;
    }

    /* ══ WORK PACKETS ══
       The owner picks house numbers and hands them to one person for one
       session. Someone with an account gets them in their own app; someone
       without gets a QR code that opens a guest view limited to exactly
       those houses, for exactly today. */

    if (action === 'setTerritoryWorking') {
      const me = await requireUser();
      const name = String(body.territory || '').trim();
      if (!name) return res.status(400).json({ error: 'Territory is required' });
      const terrs = await rd(TABS.territories);
      const t = terrs.find(x => x.name === name);
      if (t && t.ownerId && t.ownerId !== me.id && me.role !== 'admin')
        return res.status(403).json({ error: 'Only the person this territory is assigned to can start it' });
      const rec = {
        name,
        ownerId: t ? (t.ownerId || me.id) : me.id,
        assigneeIds: t ? t.assigneeIds : '',
        updatedAt: nowIso,
        working: body.working ? '1' : '0',
      };
      if (t) await wr(TABS.territories, t._row, rec);
      else await ap(TABS.territories, rec);
      return res.json({ ok: true, working: rec.working === '1' });
    }

    if (action === 'createAssignment') {
      const me = await requireUser();
      const territory = String(body.territory || '').trim();
      const houseIds = Array.isArray(body.houseIds)
        ? body.houseIds.filter(x => typeof x === 'string' && x) : [];
      if (!territory) return res.status(400).json({ error: 'Territory is required' });
      if (!houseIds.length) return res.status(400).json({ error: 'Pick at least one house' });

      const terrs = await rd(TABS.territories);
      const t = terrs.find(x => x.name === territory);
      if (t && t.ownerId && t.ownerId !== me.id && me.role !== 'admin')
        return res.status(403).json({ error: 'Only the person this territory is assigned to can hand out numbers' });

      // Cap the lifetime server-side. A client asking for a year gets a day.
      const asked = Number(body.expiresAt || 0);
      const cap = now + AS.MAX_TTL_MS;
      const expiresAt = asked && asked > now && asked < cap ? asked : cap;

      const assigneeId = String(body.assigneeId || '').trim();
      const guestName = String(body.guestName || '').trim();
      if (!assigneeId && !guestName)
        return res.status(400).json({ error: 'Name the person, or pick an account' });

      const rec = {
        id: AS.newId(), territory, ownerId: me.id,
        assigneeId, guestName: assigneeId ? '' : guestName,
        guestCode: assigneeId ? '' : AS.guestCode(),
        houseIds: houseIds.join(','),
        createdAt: nowIso, expiresAt: String(expiresAt), active: '1',
      };
      await ap(TABS.assignments, rec);

      // Handing out numbers implies you are working the territory; not doing
      // this silently produces packets that refuse to open.
      const trec = {
        name: territory, ownerId: t ? (t.ownerId || me.id) : me.id,
        assigneeIds: t ? t.assigneeIds : '', updatedAt: nowIso, working: '1',
      };
      if (t) await wr(TABS.territories, t._row, trec);
      else await ap(TABS.territories, trec);

      return res.json({ ok: true, assignment: rec, guestCode: rec.guestCode, expiresAt });
    }

    if (action === 'listAssignments') {
      const me = await requireUser();
      const territory = String(body.territory || '').trim();
      const [assigns, users, terrs] = await Promise.all([
        rd(TABS.assignments), rd(TABS.users), rd(TABS.territories),
      ]);
      const byId = {}; users.forEach(u => { byId[u.id] = publicUser(u); });
      const t = terrs.find(x => x.name === territory);
      const mine = assigns.filter(a =>
        (!territory || a.territory === territory) &&
        a.active !== '0' &&
        Number(a.expiresAt || 0) > now &&
        (a.ownerId === me.id || me.role === 'admin')
      );
      return res.json({
        ok: true,
        working: !!(t && t.working === '1'),
        assignments: mine.map(a => ({
          id: a.id, territory: a.territory,
          assigneeId: a.assigneeId,
          who: a.assigneeId ? ((byId[a.assigneeId] || {}).name || 'Someone') : a.guestName,
          hasAccount: !!a.assigneeId,
          guestCode: a.guestCode,
          houseIds: AS.houseIdList(a),
          expiresAt: Number(a.expiresAt || 0),
        })),
      });
    }

    /* What the signed-in helper sees: packets handed to them. */
    if (action === 'myAssignments') {
      const me = await requireUser();
      const [assigns, terrs, users] = await Promise.all([
        rd(TABS.assignments), rd(TABS.territories), rd(TABS.users),
      ]);
      const byId = {}; users.forEach(u => { byId[u.id] = publicUser(u); });
      const out = assigns.filter(a => a.assigneeId === me.id).map(a => {
        const t = terrs.find(x => x.name === a.territory);
        const st = AS.packetState(a, t, now);
        return {
          id: a.id, territory: a.territory, houseIds: AS.houseIdList(a),
          from: (byId[a.ownerId] || {}).name || 'Someone',
          expiresAt: Number(a.expiresAt || 0), usable: st.ok, reason: st.reason || '',
        };
      }).filter(a => a.usable);
      return res.json({ ok: true, assignments: out });
    }

    if (action === 'revokeAssignment') {
      const me = await requireUser();
      const assigns = await rd(TABS.assignments);
      const a = assigns.find(x => x.id === String(body.id || ''));
      if (!a) return res.status(404).json({ error: 'No such assignment' });
      if (a.ownerId !== me.id && me.role !== 'admin')
        return res.status(403).json({ error: 'Only the owner can withdraw this' });
      await wr(TABS.assignments, a._row, Object.assign({}, a, { active: '0' }));
      return res.json({ ok: true });
    }

    /* Guest entry point. Deliberately unauthenticated: the code IS the
       credential, which is why it is single-purpose, scoped to a handful of
       houses, and dies with the day. */
    if (action === 'guestLogin') {
      const code = String(body.code || '').trim().toUpperCase();
      if (!code) return res.status(400).json({ error: 'No code' });
      const [assigns, terrs, users] = await Promise.all([
        rd(TABS.assignments), rd(TABS.territories), rd(TABS.users),
      ]);
      const a = assigns.find(x => x.guestCode && x.guestCode === code);
      const t = a ? terrs.find(x => x.name === a.territory) : null;
      const st = AS.packetState(a, t, now);
      if (!st.ok) return res.status(403).json({ error: st.reason });
      const owner = users.find(u => u.id === a.ownerId);
      return res.json({
        ok: true,
        token: sign({ g: a.id, exp: Math.min(Number(a.expiresAt), now + AS.MAX_TTL_MS) }),
        guest: {
          name: a.guestName, territory: a.territory,
          from: owner ? owner.name : 'the territory holder',
          houseIds: AS.houseIdList(a),
          expiresAt: Number(a.expiresAt || 0),
        },
      });
    }

    /* Lets a guest app notice it has been cut off without waiting for a write. */
    if (action === 'guestStatus') {
      if (!claims || !claims.g) return res.status(401).json({ error: 'Not a guest session' });
      const packet = await AS.loadPacket(sheets, claims.g, now);
      if (!packet.state.ok) return res.status(403).json({ error: packet.state.reason });
      return res.json({
        ok: true,
        territory: packet.assignment.territory,
        houseIds: AS.houseIdList(packet.assignment),
        expiresAt: Number(packet.assignment.expiresAt || 0),
      });
    }

    /* ══ LIVE POSITION ══ */

    if (action === 'postPresence') {
      const me = await requireActor();
      const territory = me.territory || String(body.territory || '').trim();
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!territory || !isFinite(lat) || !isFinite(lng))
        return res.status(400).json({ error: 'territory, lat and lng are required' });

      const rows = await rd(TABS.presence);
      const mine = rows.find(r => r.userId === me.id && r.territory === territory);
      const rec = { userId: me.id, territory, lat: lat.toFixed(6), lng: lng.toFixed(6),
                    acc: Math.round(Number(body.acc) || 0), ts: String(now) };
      if (mine) await wr(TABS.presence, mine._row, rec);
      else await ap(TABS.presence, rec);
      return res.json({ ok: true });
    }

    if (action === 'getPresence') {
      const me = await requireActor();
      const territory = me.territory || String(body.territory || '').trim();
      const team = await teamFor(territory);
      const [rows, users, assigns] = await Promise.all([
        rd(TABS.presence), rd(TABS.users), rd(TABS.assignments),
      ]);
      const byId = {};
      users.forEach(u => { byId[u.id] = publicUser(u); });
      assigns.forEach(a => { byId['g:' + a.id] = { name: a.guestName || 'Guest' }; });
      const out = rows.filter(r =>
        r.territory === territory &&
        r.userId !== me.id &&
        (!team || team.has(r.userId)) &&
        now - Number(r.ts || 0) < PRESENCE_TTL_MS
      ).map(r => ({
        userId: r.userId,
        name: (byId[r.userId] && byId[r.userId].name) || 'Someone',
        lat: Number(r.lat), lng: Number(r.lng), acc: Number(r.acc || 0), ts: Number(r.ts || 0),
      }));
      return res.json({ ok: true, people: out, serverTime: now });
    }

    /* The field poll: where everyone is, and anything they said, in one call.
       Two separate polls doubled both the request count and the tab reads for
       information that is always wanted together. */
    if (action === 'fieldPoll') {
      const me = await requireActor();
      const territory = me.territory || String(body.territory || '').trim();
      const since = Number(body.since || 0);
      const team = await teamFor(territory);
      const [pres, users, assigns] = await Promise.all([
        rd(TABS.presence), rd(TABS.users), rd(TABS.assignments),
      ]);
      const byId = {};
      users.forEach(u => { byId[u.id] = publicUser(u); });
      assigns.forEach(a => { byId['g:' + a.id] = { name: a.guestName || 'Guest' }; });

      if (body.lat !== undefined && body.lng !== undefined) {
        const lat = Number(body.lat), lng = Number(body.lng);
        if (isFinite(lat) && isFinite(lng) && territory) {
          const mine = pres.find(r => r.userId === me.id && r.territory === territory);
          const rec = { userId: me.id, territory, lat: lat.toFixed(6), lng: lng.toFixed(6),
                        acc: Math.round(Number(body.acc) || 0), ts: String(now) };
          if (mine) await wr(TABS.presence, mine._row, rec);
          else await ap(TABS.presence, rec);
        }
      }

      const people = pres.filter(r =>
        r.territory === territory && r.userId !== me.id &&
        (!team || team.has(r.userId)) && now - Number(r.ts || 0) < PRESENCE_TTL_MS
      ).map(r => ({
        userId: r.userId, name: (byId[r.userId] && byId[r.userId].name) || 'Someone',
        lat: Number(r.lat), lng: Number(r.lng), acc: Number(r.acc || 0), ts: Number(r.ts || 0),
      }));

      let clips = [];
      if (body.voice !== false) {
        const rows = await rd(TABS.voice);
        clips = rows.filter(c =>
          c.territory === territory && Number(c.ts || 0) > since && c.userId !== me.id &&
          (!team || team.has(c.userId)) && now - Number(c.ts || 0) < VOICE_TTL_MS
        ).sort((a, b) => Number(a.ts) - Number(b.ts)).slice(-5)
         .map(c => ({ id: c.id, userId: c.userId,
           name: (byId[c.userId] && byId[c.userId].name) || 'Someone',
           ts: Number(c.ts), dur: Number(c.dur || 0), audio: c.audio }));
      }
      return res.json({ ok: true, people, clips, serverTime: now });
    }

    if (action === 'clearPresence') {
      const me = await requireActor();
      const rows = await rd(TABS.presence);
      const mine = rows.filter(r => r.userId === me.id).map(r => r._row);
      await dl(TABS.presence, mine);
      return res.json({ ok: true });
    }

    /* ══ PUSH-TO-TALK ══ */

    if (action === 'postVoice') {
      const me = await requireActor();
      const territory = me.territory || String(body.territory || '').trim();
      const audio = String(body.audio || '');
      if (!territory) return res.status(400).json({ error: 'Territory is required' });
      if (!audio) return res.status(400).json({ error: 'No audio' });
      if (audio.length > MAX_AUDIO_CHARS)
        return res.status(413).json({ error: 'That message is too long — keep it under about 10 seconds' });

      const rows = await rd(TABS.voice);
      // Prune expired clips in the same pass, so the tab cannot grow forever.
      const stale = rows.filter(r => now - Number(r.ts || 0) > VOICE_TTL_MS).map(r => r._row);
      if (stale.length) await dl(TABS.voice, stale);

      const rec = { id: uid(), territory, userId: me.id, ts: String(now),
                    dur: Math.round(Number(body.dur) || 0), audio };
      await ap(TABS.voice, rec);
      return res.json({ ok: true, id: rec.id, ts: now });
    }

    if (action === 'getVoice') {
      const me = await requireActor();
      const territory = me.territory || String(body.territory || '').trim();
      const since = Number(body.since || 0);
      const team = await teamFor(territory);
      const [rows, users, assigns] = await Promise.all([
        rd(TABS.voice), rd(TABS.users), rd(TABS.assignments),
      ]);
      const byId = {};
      users.forEach(u => { byId[u.id] = publicUser(u); });
      assigns.forEach(a => { byId['g:' + a.id] = { name: a.guestName || 'Guest' }; });
      const clips = rows.filter(r =>
        r.territory === territory &&
        Number(r.ts || 0) > since &&
        r.userId !== me.id &&
        (!team || team.has(r.userId)) &&
        now - Number(r.ts || 0) < VOICE_TTL_MS
      ).sort((a, b) => Number(a.ts) - Number(b.ts)).slice(-5); // only the newest few
      return res.json({
        ok: true, serverTime: now,
        clips: clips.map(c => ({
          id: c.id, userId: c.userId,
          name: (byId[c.userId] && byId[c.userId].name) || 'Someone',
          ts: Number(c.ts), dur: Number(c.dur || 0), audio: c.audio,
        })),
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    const msg = (err && err.message) || 'Server error';
    let code = err && err.code === 401 ? 401 : err && err.code === 403 ? 403 : 500;
    if (/quota/i.test(msg)) { code = 429; }
    if (code === 500) console.error(err);
    res.status(code).json({ error: code === 429 ? 'Too busy right now — try again in a moment' : msg });
  }
};
