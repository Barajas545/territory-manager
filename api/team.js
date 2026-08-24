/* Team endpoint: accounts, territory assignment, live position sharing and
   push-to-talk voice, stored alongside the house data.

   One function with an `action` field rather than a file per route — this many
   tiny endpoints would otherwise each pay their own cold start.

   POST /api/team  { action, ... }
   Authenticated calls send  Authorization: Bearer <token>
*/

const crypto = require('crypto');
const AS = require('./_assign');
const SC = require('./_scope');
const ST = require('./_settings');
const { makeStore } = require('./_store');
// Session tokens are signed and verified in _auth.js, so the territory
// endpoint validates them with exactly the code that issues them here.
const { sign, verify } = require('./_auth');

const TABS = {
  users: {
    name: 'Users',
    cols: ['id','name','phone','email','role','passHash','passSalt','setupCode',
           'mustSetup','active','createdAt','updatedAt'],
  },
  territories: AS.TERR_TAB,
  assignments: AS.ASSIGN_TAB,
  settings: ST.SETTINGS_TAB,
  presence: {
    name: 'Presence',
    cols: ['userId','territory','lat','lng','acc','ts'],
  },
  voice: {
    name: 'Voice',
    cols: ['id','territory','userId','ts','dur','audio'],
  },
};

/* A clip lives in one field. SharePoint holds 100k characters and a Sheets
   cell 50k, so the smaller of the two sets the cap; oversized clips are
   refused rather than written as a truncated, unplayable blob. */
const MAX_AUDIO_CHARS = 45000;
const VOICE_TTL_MS = 6 * 60 * 60 * 1000;   // clips older than this are pruned
const PRESENCE_TTL_MS = 30 * 60 * 1000;    // a position older than this is stale
const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days: re-login in the field is painful

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { hash: h, salt: s };
}

function passwordMatches(password, hash, salt) {
  if (!hash || !salt) return false;
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  // Constant time: an early-exit compare leaks the hash a byte at a time.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
// Unambiguous alphabet: no O/0 or I/1, so a code read aloud cannot be mistyped.
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
  /* X-TM-Client must be listed too: a header the browser does not recognise
     turns every request into a preflight, and an unlisted one fails there —
     before it is ever sent. */
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-TM-Client');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const body = await parseBody(req);
    const action = String(body.action || '');
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const claims = verify(bearer);

    /* Storage runs through the store, which uses SharePoint when configured
       and falls back to the Sheet otherwise. It caches reads for the life of a
       single request, because several actions here legitimately need the same
       table twice (teamFor re-reads what its caller just read). */
    const store = makeStore();
    const rd = spec => store.read(spec);
    const wr = (spec, key, obj) => store.update(spec, key, obj);
    const ap = (spec, obj) => store.create(spec, obj);
    const dl = (spec, keys) => store.remove(spec, keys);
    const wrs = (spec, entries) => store.updateMany(spec, entries);

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
        const packet = await AS.loadPacket(store, claims.g, now);
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
    /* 401 means "you are not signed in" and the app responds by signing out.
       A token that verifies but names a deleted or deactivated account is a
       different thing, and answering 401 there would wipe the phone's queue of
       unsent notes on the way out. */
    const requireUser = async () => {
      if (!claims || !claims.uid) { const e = new Error('Not signed in'); e.code = 401; throw e; }
      const users = await rd(TABS.users);
      const u = users.find(x => x.id === claims.uid);
      if (!u) { const e = new Error('This account no longer exists'); e.code = 403; throw e; }
      if (u.active === '0') { const e = new Error('This account has been turned off'); e.code = 403; throw e; }
      return u;
    };
    const requireAdmin = async () => {
      const u = await requireUser();
      if (SC.norm(u.role) !== 'admin') { const e = new Error('Admins only'); e.code = 403; throw e; }
      return u;
    };

    /* ══ ACCOUNTS ══ */

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
      await wr(TABS.users, u._key, updated);
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
      await wr(TABS.users, u._key,
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
      await wr(TABS.users, u._key, updated);
      return res.json({ ok: true, user: publicUser(updated) });
    }

    /* ══ ADMIN ══ */

    /* When handed-out numbers come back. Read on the admin screen, which is
       already admin-only and already loading the people list, so this costs no
       extra round trip and adds nothing to the boot path. */
    if (action === 'setReturnPolicy') {
      const admin = await requireAdmin();
      const nights = parseInt(body.nights, 10);
      if (ST.ALLOWED_NIGHTS.indexOf(nights) === -1)
        return res.status(400).json({ error: 'Pick one of the offered options' });
      await ST.writeSetting(store, 'returnNights', nights, admin.id);
      return res.json({ ok: true, nights: nights });
    }

    if (action === 'setOrgTimeZone') {
      const admin = await requireAdmin();
      const tz = String(body.tz || '').trim();
      if (!ST.validTimeZone(tz)) return res.status(400).json({ error: 'That is not a time zone name' });
      await ST.writeSetting(store, 'timeZone', tz, admin.id);
      return res.json({ ok: true, tz: tz });
    }

    if (action === 'listUsers') {
      await requireAdmin();
      const users = await rd(TABS.users);
      const policy = await ST.readSettings(store);
      // The pending setup code is shown to the admin only, so they can pass it on.
      return res.json({
        ok: true,
        users: users.map(u => Object.assign(publicUser(u),
          { setupCode: u.mustSetup === '1' ? u.setupCode : '' })),
        policy: { nights: policy.nights, tz: policy.tz, options: ST.ALLOWED_NIGHTS },
      });
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
      await wr(TABS.users, u._key, Object.assign({}, u,
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
      await wr(TABS.users, u._key, Object.assign({}, u, { active, updatedAt: nowIso }));
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
      await dl(TABS.users, [u._key]);
      // Take their position row with them; a ghost pin on the map is worse
      // than no pin.
      const pres = await rd(TABS.presence);
      await dl(TABS.presence, pres.filter(p => p.userId === u.id).map(p => p._key));
      return res.json({ ok: true });
    }

    if (action === 'deleteTerritory') {
      await requireAdmin();
      const terrs = await rd(TABS.territories);
      const t = terrs.find(x => x.name === String(body.territory || ''));
      if (!t) return res.status(404).json({ error: 'No such territory' });
      await dl(TABS.territories, [t._key]);
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
      await wr(TABS.users, u._key, Object.assign({}, u, { role, updatedAt: nowIso }));
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
      const grant = await SC.resolveGrants(store, claims, now);
      const isAdmin = grant.kind === 'admin';
      const mine = t => isAdmin || grant.territories.has(SC.norm(t.name)) ||
        grant.packets.some(a => SC.norm(a.territory) === SC.norm(t.name));
      const display = set => terrs.filter(t => set.has(SC.norm(t.name))).map(t => t.name);
      /* The roster is needed to pick who to hand numbers to. Everyone's phone
         number and email is not. */
      const roster = users.filter(u => u.active !== '0')
        .map(u => (isAdmin ? publicUser(u) : { id: u.id, name: u.name, role: 'user', active: true }));
      return res.json({
        ok: true,
        me: publicUser(me),
        scope: {
          kind: grant.kind,
          territories: isAdmin ? terrs.map(t => t.name) : display(grant.territories),
          owned: isAdmin ? terrs.map(t => t.name) : display(grant.owned),
          canCreate: grant.canCreate || isAdmin,
          canDelete: grant.canDelete || isAdmin,
          canHandOut: grant.canHandOut || isAdmin,
          empty: grant.empty, reason: grant.reason,
        },
        users: roster,
        territories: terrs.filter(mine).map(t => ({
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
    /* Who a territory belongs to is an admin decision. The old guard passed
       whenever the row was missing or had no owner, and then defaulted the
       owner to the caller — so anyone signed in could take a territory, and
       with it every house in it. */
    if (action === 'assignTerritory') {
      const me = await requireAdmin();
      const name = String(body.territory || '').trim();
      if (!name) return res.status(400).json({ error: 'Territory is required' });
      const terrs = await rd(TABS.territories);
      const existing = terrs.find(t => t.name === name);

      const ownerId = body.ownerId !== undefined ? String(body.ownerId || '') : (existing ? existing.ownerId : me.id);
      const assigneeIds = Array.isArray(body.assigneeIds)
        ? body.assigneeIds.filter(x => typeof x === 'string' && x).join(',')
        : (existing ? existing.assigneeIds : '');
      /* Carry `working` forward. A write names every column in the spec and
         blanks the ones it omits, so saving this sheet used to clear the flag
         — which quietly ended every helper's access mid-afternoon. */
      const rec = {
        name, ownerId, assigneeIds, updatedAt: nowIso,
        working: existing ? (existing.working || '0') : '0',
      };
      if (existing) await wr(TABS.territories, existing._key, rec);
      else await ap(TABS.territories, rec);
      return res.json({ ok: true });
    }

    /* Everyone the territory is shared with — owner plus assignees. */
    async function teamFor(territory) {
      const [terrs, assigns] = await Promise.all([
        rd(TABS.territories), rd(TABS.assignments),
      ]);
      const t = terrs.find(x => SC.norm(x.name) === SC.norm(territory));
      /* An empty Set, not null. Every caller reads `!team || team.has(id)`, so
         null there disabled the filter entirely for any territory without a
         row — which is exactly the case where nobody has been vouched for. */
      if (!t) return new Set();
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
      const t = terrs.find(x => SC.norm(x.name) === SC.norm(name));
      // Never creates a row: a territory that does not exist cannot be started,
      // and inventing one here was a way to become an owner.
      if (!t) return res.status(404).json({ error: 'No such territory' });
      /* Not assignees — this switch ends EVERYONE's access at once. Taking back
         what you personally handed out is the narrower right, and revoke
         already offers it. */
      if (t.ownerId !== me.id && me.role !== 'admin')
        return res.status(403).json({ error: 'Only the person this territory is assigned to can start it' });
      const rec = Object.assign({}, t, {
        updatedAt: nowIso,
        working: body.working ? '1' : '0',
      });
      delete rec._key;
      await wr(TABS.territories, t._key, rec);
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
      const t = terrs.find(x => SC.norm(x.name) === SC.norm(territory));
      if (!t) return res.status(404).json({ error: 'No such territory' });
      const shared = SC.splitIds(t.assigneeIds).indexOf(me.id) !== -1;
      if (t.ownerId !== me.id && !shared && me.role !== 'admin')
        return res.status(403).json({ error: 'Only the person this territory is assigned to can hand out numbers' });

      /* The houses must actually be the giver's to give. Without this an owner
         of one territory could mint a packet full of another territory's ids
         and the scope resolver would faithfully honour it. */
      const houses = await rd(SC.HOUSES_TAB);
      const byId = new Map();
      houses.forEach(h => { if (h.id) byId.set(h.id, h); });
      const wrong = houseIds.filter(id => {
        const h = byId.get(id);
        return !h || h.HouseDeleted === '1' || SC.norm(h.HouseTerritoryNumber) !== SC.norm(territory);
      });
      if (wrong.length) return res.status(400).json({
        error: wrong.length + ' of those numbers are not in ' + territory,
      });
      /* An address somebody asked us not to call on again is not work to hand
         out. Existing packets are left alone — the state is read from the house
         at the door, not baked into the packet. */
      const retired = houseIds.filter(id => SC.dnvState(byId.get(id)).on);
      if (retired.length) return res.status(400).json({
        error: retired.length + ' of those numbers are marked Do Not Visit',
      });

      /* When they come back is the org's policy, not the phone's opinion.
         The old code took the client's number when it looked sane and fell
         back to a flat 20 hours otherwise — so a device with a wrong clock got
         MORE time, and "midnight" was only ever true by coincidence. */
      const expiresAt = await ST.packetExpiry(store, now);

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
      if (t) await wr(TABS.territories, t._key, trec);
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
      const t = terrs.find(x => SC.norm(x.name) === SC.norm(territory));
      // Whether some other group is out working today is not this caller's
      // business, so the flag rides along only for a territory they are in.
      const inTerritory = !!t && (me.role === 'admin' || t.ownerId === me.id ||
        SC.splitIds(t.assigneeIds).indexOf(me.id) !== -1);
      const mine = assigns.filter(a =>
        (!territory || a.territory === territory) &&
        a.active !== '0' &&
        Number(a.expiresAt || 0) > now &&
        (a.ownerId === me.id || me.role === 'admin')
      );
      return res.json({
        ok: true,
        working: inTerritory && t.working === '1',
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
      });
      /* Ended packets are kept, with their reason. The endpoint computed one
         and threw it away, so somebody whose numbers had been stopped saw a
         blank screen instead of "they come back when he starts again". */
      return res.json({ ok: true, assignments: out });
    }

    if (action === 'revokeAssignment') {
      const me = await requireUser();
      const assigns = await rd(TABS.assignments);
      const a = assigns.find(x => x.id === String(body.id || ''));
      if (!a) return res.status(404).json({ error: 'No such assignment' });
      const terrs2 = await rd(TABS.territories);
      const t2 = terrs2.find(x => SC.norm(x.name) === SC.norm(a.territory));
      const isTerrOwner = !!t2 && t2.ownerId === me.id;
      if (a.ownerId !== me.id && !isTerrOwner && me.role !== 'admin')
        return res.status(403).json({ error: 'Only the owner can withdraw this' });
      await wr(TABS.assignments, a._key, Object.assign({}, a, { active: '0' }));
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
      const packet = await AS.loadPacket(store, claims.g, now);
      if (!packet.state.ok) return res.status(403).json({ error: packet.state.reason });
      return res.json({
        ok: true,
        territory: packet.assignment.territory,
        houseIds: AS.houseIdList(packet.assignment),
        expiresAt: Number(packet.assignment.expiresAt || 0),
      });
    }

    /* ══ LIVE POSITION ══ */

    /* The rows returned were already filtered by team membership, but the
       caller's own membership was never checked — so any signed-in account
       could drop a pin or broadcast audio into any group's channel just by
       naming their territory. Guests satisfy this for free: teamFor counts
       whoever holds a live packet. */
    const requireChannel = async (territory, me) => {
      const team = await teamFor(territory);
      if (!team.has(me.id)) { const e = new Error('You are not working that territory'); e.code = 403; throw e; }
    };

    if (action === 'postPresence') {
      const me = await requireActor();
      const territory = me.territory || String(body.territory || '').trim();
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!territory || !isFinite(lat) || !isFinite(lng))
        return res.status(400).json({ error: 'territory, lat and lng are required' });
      await requireChannel(territory, me);

      const rows = await rd(TABS.presence);
      const mine = rows.find(r => r.userId === me.id && r.territory === territory);
      const rec = { userId: me.id, territory, lat: lat.toFixed(6), lng: lng.toFixed(6),
                    acc: Math.round(Number(body.acc) || 0), ts: String(now) };
      if (mine) await wr(TABS.presence, mine._key, rec);
      else await ap(TABS.presence, rec);
      return res.json({ ok: true });
    }

    if (action === 'getPresence') {
      const me = await requireActor();
      const territory = me.territory || String(body.territory || '').trim();
      await requireChannel(territory, me);
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
      await requireChannel(territory, me);
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
          if (mine) await wr(TABS.presence, mine._key, rec);
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
      const mine = rows.filter(r => r.userId === me.id).map(r => r._key);
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
      await requireChannel(territory, me);

      const rows = await rd(TABS.voice);
      // Prune expired clips in the same pass, so the tab cannot grow forever.
      const stale = rows.filter(r => now - Number(r.ts || 0) > VOICE_TTL_MS).map(r => r._key);
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
      await requireChannel(territory, me);
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
