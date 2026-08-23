/* Team endpoint: accounts, territory assignment, live position sharing and
   push-to-talk voice, all on the same Google Sheet as the house data.

   One function with an `action` field rather than a file per route — this many
   tiny endpoints would otherwise each pay their own cold start.

   POST /api/team  { action, ... }
   Authenticated calls send  Authorization: Bearer <token>
*/

const crypto = require('crypto');
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const TABS = {
  users: {
    name: 'Users',
    cols: ['id','name','phone','email','role','passHash','passSalt','setupCode',
           'mustSetup','active','createdAt','updatedAt'],
  },
  territories: {
    name: 'Territories',
    cols: ['name','ownerId','assigneeIds','updatedAt'],
  },
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

    async function currentUser() {
      if (!claims) return null;
      const users = await readTab(sheets, TABS.users);
      const u = users.find(x => x.id === claims.uid);
      return u && u.active !== '0' ? u : null;
    }
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

    if (action === 'status') {
      const users = await readTab(sheets, TABS.users);
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
      const users = await readTab(sheets, TABS.users);
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
      await appendRow(sheets, TABS.users, rec);
      return res.json({ ok: true, token: sign({ uid: rec.id, exp: now + TOKEN_TTL_MS }), user: publicUser(rec) });
    }

    if (action === 'login') {
      const users = await readTab(sheets, TABS.users);
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
      const users = await readTab(sheets, TABS.users);
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
      await writeRow(sheets, TABS.users, u._row, updated);
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
      await writeRow(sheets, TABS.users, u._row,
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
      await writeRow(sheets, TABS.users, u._row, updated);
      return res.json({ ok: true, user: publicUser(updated) });
    }

    /* ══ ADMIN ══ */

    if (action === 'listUsers') {
      await requireAdmin();
      const users = await readTab(sheets, TABS.users);
      // The pending setup code is shown to the admin only, so they can pass it on.
      return res.json({ ok: true, users: users.map(u => Object.assign(publicUser(u),
        { setupCode: u.mustSetup === '1' ? u.setupCode : '' })) });
    }

    if (action === 'createUser') {
      await requireAdmin();
      const users = await readTab(sheets, TABS.users);
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
      await appendRow(sheets, TABS.users, rec);
      return res.json({ ok: true, user: publicUser(rec), setupCode: code });
    }

    if (action === 'resetPassword') {
      await requireAdmin();
      const users = await readTab(sheets, TABS.users);
      const u = users.find(x => x.id === body.id);
      if (!u) return res.status(404).json({ error: 'No such user' });
      const code = setupCode();
      await writeRow(sheets, TABS.users, u._row, Object.assign({}, u,
        { passHash: '', passSalt: '', setupCode: code, mustSetup: '1', updatedAt: nowIso }));
      return res.json({ ok: true, setupCode: code });
    }

    if (action === 'setUserActive') {
      const me = await requireAdmin();
      const users = await readTab(sheets, TABS.users);
      const u = users.find(x => x.id === body.id);
      if (!u) return res.status(404).json({ error: 'No such user' });
      const active = body.active ? '1' : '0';
      if (u.id === me.id && active === '0')
        return res.status(400).json({ error: 'You cannot deactivate yourself' });
      if (active === '0' && u.role === 'admin' &&
          users.filter(x => x.role === 'admin' && x.active !== '0').length <= 1)
        return res.status(400).json({ error: 'That is the only admin left' });
      await writeRow(sheets, TABS.users, u._row, Object.assign({}, u, { active, updatedAt: nowIso }));
      return res.json({ ok: true });
    }

    if (action === 'setUserRole') {
      const me = await requireAdmin();
      const users = await readTab(sheets, TABS.users);
      const u = users.find(x => x.id === body.id);
      if (!u) return res.status(404).json({ error: 'No such user' });
      const role = body.role === 'admin' ? 'admin' : 'user';
      if (u.id === me.id && role !== 'admin')
        return res.status(400).json({ error: 'You cannot remove your own admin access' });
      await writeRow(sheets, TABS.users, u._row, Object.assign({}, u, { role, updatedAt: nowIso }));
      return res.json({ ok: true });
    }

    /* ══ TERRITORY ASSIGNMENT ══ */

    if (action === 'listTerritories') {
      const me = await requireUser();
      const [terrs, users] = await Promise.all([
        readTab(sheets, TABS.territories), readTab(sheets, TABS.users),
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
      const terrs = await readTab(sheets, TABS.territories);
      const existing = terrs.find(t => t.name === name);
      if (existing && existing.ownerId && existing.ownerId !== me.id && me.role !== 'admin')
        return res.status(403).json({ error: 'Only the person this territory is assigned to can change it' });

      const ownerId = body.ownerId !== undefined ? String(body.ownerId || '') : (existing ? existing.ownerId : me.id);
      const assigneeIds = Array.isArray(body.assigneeIds)
        ? body.assigneeIds.filter(x => typeof x === 'string' && x).join(',')
        : (existing ? existing.assigneeIds : '');
      const rec = { name, ownerId, assigneeIds, updatedAt: nowIso };
      if (existing) await writeRow(sheets, TABS.territories, existing._row, rec);
      else await appendRow(sheets, TABS.territories, rec);
      return res.json({ ok: true });
    }

    /* Everyone the territory is shared with — owner plus assignees. */
    async function teamFor(territory) {
      const terrs = await readTab(sheets, TABS.territories);
      const t = terrs.find(x => x.name === territory);
      if (!t) return null;
      const ids = new Set(String(t.assigneeIds || '').split(',').filter(Boolean));
      if (t.ownerId) ids.add(t.ownerId);
      return ids;
    }

    /* ══ LIVE POSITION ══ */

    if (action === 'postPresence') {
      const me = await requireUser();
      const territory = String(body.territory || '').trim();
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!territory || !isFinite(lat) || !isFinite(lng))
        return res.status(400).json({ error: 'territory, lat and lng are required' });

      const rows = await readTab(sheets, TABS.presence);
      const mine = rows.find(r => r.userId === me.id && r.territory === territory);
      const rec = { userId: me.id, territory, lat: lat.toFixed(6), lng: lng.toFixed(6),
                    acc: Math.round(Number(body.acc) || 0), ts: String(now) };
      if (mine) await writeRow(sheets, TABS.presence, mine._row, rec);
      else await appendRow(sheets, TABS.presence, rec);
      return res.json({ ok: true });
    }

    if (action === 'getPresence') {
      const me = await requireUser();
      const territory = String(body.territory || '').trim();
      const team = await teamFor(territory);
      const [rows, users] = await Promise.all([
        readTab(sheets, TABS.presence), readTab(sheets, TABS.users),
      ]);
      const byId = {};
      users.forEach(u => { byId[u.id] = publicUser(u); });
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

    if (action === 'clearPresence') {
      const me = await requireUser();
      const rows = await readTab(sheets, TABS.presence);
      const mine = rows.filter(r => r.userId === me.id).map(r => r._row);
      await deleteRows(sheets, TABS.presence, mine);
      return res.json({ ok: true });
    }

    /* ══ PUSH-TO-TALK ══ */

    if (action === 'postVoice') {
      const me = await requireUser();
      const territory = String(body.territory || '').trim();
      const audio = String(body.audio || '');
      if (!territory) return res.status(400).json({ error: 'Territory is required' });
      if (!audio) return res.status(400).json({ error: 'No audio' });
      if (audio.length > MAX_AUDIO_CHARS)
        return res.status(413).json({ error: 'That message is too long — keep it under about 10 seconds' });

      const rows = await readTab(sheets, TABS.voice);
      // Prune expired clips in the same pass, so the tab cannot grow forever.
      const stale = rows.filter(r => now - Number(r.ts || 0) > VOICE_TTL_MS).map(r => r._row);
      if (stale.length) await deleteRows(sheets, TABS.voice, stale);

      const rec = { id: uid(), territory, userId: me.id, ts: String(now),
                    dur: Math.round(Number(body.dur) || 0), audio };
      await appendRow(sheets, TABS.voice, rec);
      return res.json({ ok: true, id: rec.id, ts: now });
    }

    if (action === 'getVoice') {
      const me = await requireUser();
      const territory = String(body.territory || '').trim();
      const since = Number(body.since || 0);
      const team = await teamFor(territory);
      const [rows, users] = await Promise.all([
        readTab(sheets, TABS.voice), readTab(sheets, TABS.users),
      ]);
      const byId = {};
      users.forEach(u => { byId[u.id] = publicUser(u); });
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
    const code = err && err.code === 401 ? 401 : err && err.code === 403 ? 403 : 500;
    if (code === 500) console.error(err);
    res.status(code).json({ error: err.message || 'Server error' });
  }
};
