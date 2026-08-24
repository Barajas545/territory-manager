/* House records.

   Storage runs through _store.js, so this file no longer knows or cares
   whether the rows live in SharePoint or a Google Sheet. Records are
   addressed by their opaque `_key`; the row arithmetic that used to live here
   — and the corruption it caused when a delete shifted a neighbour — is gone
   by construction. */

const { claimsFrom } = require('./_auth');
const { makeStore } = require('./_store');
const AS = require('./_assign');
const SC = require('./_scope');

const HOUSES = {
  name: 'Houses',
  cols: [
    'id','HouseAddress','HouseCity','HouseState','HouseZIP',
    'HouseTerritoryNumber','HouseTerritoryAssingnedTo','HouseLanguage',
    'HouseLastVisitDate','HouseGPSCoordinates','HouseNotes','HousePersonalNotes',
    'HouseResutsOnVisit1','HouseResutsOnVisit2','HouseResutsOnVisit3',
    'HouseResutsOnVisit4','HouseResutsOnVisit5','HouseVerifiedOnMaps',
    'HouseReturnVisits','HouseUpdatedAt','HouseVisitLog','HouseDeleted',
  ],
};

// Server-owned. A client may not write these directly.
const SERVER_FIELDS = new Set(['HouseUpdatedAt']);

/* Which territory a house belongs to, and whether it exists, decide who can
   see it — so they are not ordinary fields. Only an admin may move a house
   between territories, and nobody deletes by writing a flag: that is what the
   DELETE branch is for. */
const CONTROLLED_FIELDS = new Set(['HouseTerritoryNumber', 'HouseDeleted']);

/* Append-only JSON logs, merged by UNION of entry id rather than overwritten.
   Field-level last-write-wins cannot protect these: two devices write the same
   key, so one device's notes would simply vanish. */
const ARRAY_FIELDS = new Set(['HouseReturnVisits', 'HouseVisitLog']);

// Derived from HouseVisitLog on every write; clients never set them.
const DERIVED_SLOTS = ['HouseResutsOnVisit1','HouseResutsOnVisit2','HouseResutsOnVisit3',
  'HouseResutsOnVisit4','HouseResutsOnVisit5'];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* `refused` collects what was dropped rather than dropping it silently: a
   field refusal that vanishes is how a phone comes to believe a write landed. */
function sanitize(updates, grant, refused) {
  const clean = {};
  const isAdmin = !grant || grant.kind === 'admin';
  Object.keys(updates || {}).forEach(k => {
    if (k === 'id' || SERVER_FIELDS.has(k) || !HOUSES.cols.includes(k)) return;
    if (!isAdmin && CONTROLLED_FIELDS.has(k)) { if (refused) refused.push(k); return; }
    clean[k] = updates[k];
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

/* Seed ids are derived from the slot's CONTENT, not its position. With a
   positional id, a device holding a stale copy re-seeds 'legacy2' with the old
   text and the union overwrites an edit made elsewhere. Keyed by content, a
   stale re-seed produces a separate entry — a duplicate is recoverable, an
   overwritten note is not. The client computes this identically. */
function legacyId(i, text) {
  const s = String(text || '');
  let h = 0;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
  return 'lg' + (i + 1) + '-' + (h >>> 0).toString(36);
}

/* A record predating the visit log has history only in the five slot columns.
   Seed a log from them once, so the first append does not appear to erase them. */
function seedLog(rec) {
  const existing = parseArr(rec.HouseVisitLog);
  if (existing.length) return rec.HouseVisitLog;
  const seeded = [];
  DERIVED_SLOTS.forEach((f, i) => {
    if (rec[f]) seeded.push({ i: legacyId(i, rec[f]), d: rec.HouseLastVisitDate || '', t: rec[f] });
  });
  return seeded.length ? JSON.stringify(seeded) : '';
}

/* The five slot columns are a projection of the last five live log entries.
   Keeping them means the printed territory sheet and older clients still work,
   while the log remains the source of truth. */
function deriveSlots(rec) {
  const all = parseArr(rec.HouseVisitLog);
  // No log at all means a record predating the log — leave its slots alone.
  // A log whose entries are ALL tombstoned is different: every visit was
  // deleted, so the slots must clear too, or deleted text lingers forever.
  if (!all.length) return;
  const live = all.filter(e => e && !e.x);
  live.sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')));
  const last5 = live.slice(-5);
  DERIVED_SLOTS.forEach((f, i) => { rec[f] = last5[i] ? String(last5[i].t || '') : ''; });
  if (live.length) {
    const lastD = live[live.length - 1].d;
    if (lastD) rec.HouseLastVisitDate = lastD;
  }
}

/* The one place merge policy lives. Runs against the record the store just
   read, not a snapshot the client fetched seconds ago. */
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

const isLive = rec => rec && rec.id && rec.HouseDeleted !== '1';
// Strip storage bookkeeping before anything reaches a client.
const publicRec = rec => {
  const o = {};
  HOUSES.cols.forEach(c => { o[c] = rec[c] !== undefined ? rec[c] : ''; });
  return o;
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  // Authorization must be listed, or the browser's preflight rejects every
  // authenticated request before it is ever sent.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* Every method needs a session. These are real households with real notes
     about them; an open endpoint meant anyone holding the URL could read the
     lot. Auth actions live on /api/team, which stays reachable so a signed-out
     app can still get back in. */
  const claims = claimsFrom(req);
  if (!claims) return res.status(401).json({ error: 'Sign in to use this territory' });

  try {
    const store = makeStore();
    const now = new Date().toISOString();

    /* What this session may see and touch, resolved once before any branch
       runs. There is deliberately no `inScope` catch-all closure: one shared
       helper is exactly how DELETE came to ship with no check at all, so every
       branch below states its own rule. */
    const grant = await SC.resolveGrants(store, claims, Date.now());
    // Rows are cached per request by the store, so this is one read, not five.
    const withHouses = async () => {
      const rows = await store.read(HOUSES);
      SC.attachHouses(grant, rows);
      return rows;
    };
    const canRead = id => grant.read === null || grant.read.has(id);
    const canWrite = id => grant.write === null || grant.write.has(id);
    const ownsTerritory = t => grant.territories === null ||
      grant.kind === 'admin' || grant.territories.has(SC.norm(t));

    /* ── GET ── */
    if (req.method === 'GET') {
      const all = (await withHouses()).filter(isLive);
      /* An empty answer is 200 and [], never 403: the client turns a 403 into
         "sign in to see your territory", which is a lie to somebody who is
         signed in and simply holds nothing today. */
      const visible = grant.read === null ? all : all.filter(r => grant.read.has(r.id));
      return res.json(visible.map(publicRec));
    }

    /* ── POST: create one ── */
    if (req.method === 'POST') {
      const body = await parseBody(req);
      if (!grant.canCreate) {
        return res.status(403).json({ error: grant.kind === 'guest'
          ? 'Guests can record visits, not add or remove houses'
          : 'Only someone with a territory can add a house' });
      }
      const rec = sanitize(body, grant);
      const terr = grant.kind === 'admin' ? String(body.HouseTerritoryNumber || '')
        : String(body.HouseTerritoryNumber || '');
      if (!terr.trim()) return res.status(400).json({ error: 'Which territory is this house in?' });
      if (!ownsTerritory(terr)) return res.status(403).json({ error: 'That territory is not yours' });
      rec.HouseTerritoryNumber = terr;
      // Honour a client-supplied id so a house created offline keeps its
      // identity after sync, instead of needing an id remap.
      rec.id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : uid();
      /* Two rows sharing an id makes every later lookup a coin toss, and would
         let a made-up id pull somebody else's house into this scope. The bulk
         path has always guarded this; the single-create path had not. */
      const already = await store.read(HOUSES);
      if (already.some(r => r.id === rec.id))
        return res.status(409).json({ error: 'A house with that id already exists' });
      rec.HouseVisitLog = seedLog(rec) || rec.HouseVisitLog || '';
      deriveSlots(rec);
      rec.HouseUpdatedAt = now;
      await store.create(HOUSES, rec);
      return res.json({ id: rec.id, HouseUpdatedAt: now });
    }

    /* ── PATCH: update one ── */
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      const rows = await withHouses();
      if (!canWrite(body.id)) return res.status(403).json({ error: 'That house is not on your list' });
      const existing = rows.find(r => r.id === body.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });

      let fields;
      if (grant.grace && grant.grace.has(body.id)) {
        // Their numbers have come back. They may still finish uploading the
        // notes they wrote, and nothing else.
        const g = SC.graceFilter(body, existing, parseArr, entryKey, seedLog);
        if (!Object.keys(g.fields).length)
          return res.status(403).json({ error: 'Those numbers have been returned' });
        fields = g.fields;
      } else {
        fields = sanitize(body, grant);
      }
      const merged = mergeRow(existing, fields, now);
      merged.id = body.id;
      await store.update(HOUSES, existing._key, merged);
      return res.json({ ok: true, HouseUpdatedAt: now });
    }

    /* ── DELETE: soft ──
       Never removes the row. A hard delete used to shift every later row's
       index, so a concurrent write resolved a moment earlier landed on the
       wrong house. A flag cannot do that. */
    if (req.method === 'DELETE') {
      const body = await parseBody(req);
      if (!grant.canDelete) {
        return res.status(403).json({ error: grant.kind === 'guest'
          ? 'Guests can record visits, not add or remove houses'
          : 'Only someone with a territory can remove a house' });
      }
      const rows = await withHouses();
      const existing = rows.find(r => r.id === body.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      // Being handed a house is not authority to delete it.
      if (!canRead(body.id) || !ownsTerritory(existing.HouseTerritoryNumber))
        return res.status(403).json({ error: 'That house is not yours to remove' });
      const rec = Object.assign({}, existing, { HouseDeleted: '1', HouseUpdatedAt: now });
      await store.update(HOUSES, existing._key, rec);
      return res.json({ ok: true });
    }

    /* ── PUT: bulk sync ──
       { creates:[rec], updates:[{id,...fields,_base}], deletes:[id] }
       One read, one batched write, one read back, however deep the queue —
       so a long offline session uploads in one round trip. */
    if (req.method === 'PUT') {
      const body = await parseBody(req);
      let creates = Array.isArray(body.creates) ? body.creates : [];
      let updates = Array.isArray(body.updates) ? body.updates : [];
      let deletes = Array.isArray(body.deletes) ? body.deletes.filter(x => typeof x === 'string') : [];

      const rows = await withHouses();
      const byId = new Map();
      rows.forEach(r => { if (r.id) byId.set(r.id, r); });

      /* Anything refused is named and handed back, never folded into
         `applied.missing` — the phone keeps that work in its queue and can show
         it to the person who wrote it. Silence here is how notes disappear. */
      const rejected = [];
      const refuse = (id, op, code, reason, fields) => {
        rejected.push({ id: id, op: op, code: code, reason: reason, fields: fields || undefined });
      };

      if (!grant.canCreate) {
        creates.forEach(c => refuse(c && c.id, 'create', 'no_create', 'Only someone with a territory can add a house'));
        creates = [];
      } else {
        creates = creates.filter(c => {
          if (c && ownsTerritory(c.HouseTerritoryNumber)) return true;
          refuse(c && c.id, 'create', 'wrong_territory', 'That territory is not yours');
          return false;
        });
      }

      if (!grant.canDelete) {
        deletes.forEach(id => refuse(id, 'delete', 'no_delete', 'Only someone with a territory can remove a house'));
        deletes = [];
      } else {
        deletes = deletes.filter(id => {
          const row = byId.get(id);
          if (row && canRead(id) && ownsTerritory(row.HouseTerritoryNumber)) return true;
          if (row) refuse(id, 'delete', 'out_of_scope', 'That house is not yours to remove');
          return !row;   // an unknown id falls through to `missing`, as before
        });
      }

      const graced = new Map();   // id -> fields a graced writer may still add
      updates = updates.filter(u => {
        if (!u || typeof u.id !== 'string') return false;
        if (canRead(u.id)) return true;
        if (grant.grace && grant.grace.has(u.id)) {
          const existing = byId.get(u.id);
          if (!existing) return true;   // handled as `missing` below
          const g = SC.graceFilter(u, existing, parseArr, entryKey, seedLog);
          if (!Object.keys(g.fields).length) {
            refuse(u.id, 'update', 'grace_field', 'Those numbers have been returned', g.refusedFields);
            return false;
          }
          if (g.refusedFields.length)
            refuse(u.id, 'update', 'grace_field', 'Those numbers have been returned', g.refusedFields);
          graced.set(u.id, g.fields);
          return true;
        }
        refuse(u.id, 'update', 'out_of_scope', 'Those numbers are not assigned to you');
        return false;
      });

      /* A phone that predates this rule cannot be told what was refused, so it
         would clear its queue believing everything landed. Refuse the whole
         batch instead — its own catch leaves the queue on disk untouched. */
      if (rejected.length && String(req.headers['x-tm-client'] || '') !== '3') {
        return res.status(409).json({
          error: 'Update the app — some of what this phone saved is no longer yours to change.',
        });
      }

      const deleteSet = new Set(deletes);
      const conflicts = [];
      const applied = { created: [], updated: [], deleted: [], missing: [] };
      const pending = new Map(); // id -> merged record, one write per record

      for (const u of updates) {
        if (!u || typeof u.id !== 'string' || deleteSet.has(u.id)) continue;
        const existing = pending.get(u.id) || byId.get(u.id);
        if (!existing) { applied.missing.push(u.id); continue; }
        // Only ids that survived the checks above ever reach this point, which
        // matters: a conflict hands the whole remote record back, notes and all.
        if (u._base && existing.HouseUpdatedAt && existing.HouseUpdatedAt > u._base) {
          conflicts.push({ id: u.id, remote: publicRec(existing) });
        }
        const merged = mergeRow(existing, graced.get(u.id) || sanitize(u, grant), now);
        merged.id = u.id;
        merged._key = existing._key;
        pending.set(u.id, merged);
        applied.updated.push(u.id);
      }

      for (const id of deletes) {
        const existing = pending.get(id) || byId.get(id);
        if (!existing) { applied.missing.push(id); continue; }
        const rec = Object.assign({}, existing, { HouseDeleted: '1', HouseUpdatedAt: now });
        rec._key = existing._key;
        pending.set(id, rec);
        applied.deleted.push(id);
      }

      if (pending.size) {
        await store.updateMany(HOUSES,
          Array.from(pending.values()).map(r => ({ key: r._key, obj: r })));
      }

      // Creates last. Existing ids are skipped, so a retried sync — one whose
      // response was lost — cannot duplicate a house.
      const newRows = [];
      for (const c of creates) {
        if (!c) continue;
        const rec = sanitize(c, grant);
        if (c.HouseTerritoryNumber) rec.HouseTerritoryNumber = String(c.HouseTerritoryNumber);
        rec.id = (typeof c.id === 'string' && c.id.trim()) ? c.id.trim() : uid();
        if (byId.has(rec.id) || deleteSet.has(rec.id)) continue;
        rec.HouseVisitLog = seedLog(rec) || rec.HouseVisitLog || '';
        deriveSlots(rec);
        rec.HouseUpdatedAt = now;
        newRows.push(rec);
        applied.created.push(rec.id);
      }
      if (newRows.length) await store.createMany(HOUSES, newRows);

      // A house just created here is legitimately theirs, but the scope was
      // computed from the rows as they were before the write.
      if (grant.read) applied.created.forEach(id => grant.read.add(id));

      // Read back so the client ends the sync in a known-good state.
      const after = (await store.readFresh(HOUSES)).filter(isLive);
      const records = (grant.read === null ? after : after.filter(r => grant.read.has(r.id))).map(publicRec);
      return res.json({ ok: true, applied, rejected, conflicts, records, serverTime: now });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const msg = (err && err.message) || 'Server error';
    /* An authorization refusal is an answer, not a crash: it carries its own
       status and its own sentence, and must not be flattened into a 500. */
    if (err && err.code >= 400 && err.code < 600) return res.status(err.code).json({ error: msg });
    console.error(err);
    res.status(/throttl|quota|429/i.test(msg) ? 429 : 500)
      .json({ error: /throttl|quota|429/i.test(msg) ? 'Too busy right now — try again in a moment' : msg });
  }
};
