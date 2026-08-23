/* House records.

   Storage runs through _store.js, so this file no longer knows or cares
   whether the rows live in SharePoint or a Google Sheet. Records are
   addressed by their opaque `_key`; the row arithmetic that used to live here
   — and the corruption it caused when a delete shifted a neighbour — is gone
   by construction. */

const { claimsFrom } = require('./_auth');
const { makeStore } = require('./_store');
const AS = require('./_assign');

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

function sanitize(updates) {
  const clean = {};
  Object.keys(updates || {}).forEach(k => {
    if (k !== 'id' && !SERVER_FIELDS.has(k) && HOUSES.cols.includes(k)) clean[k] = updates[k];
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

    /* A guest token carries a work packet rather than an account. It may only
       ever see and touch the specific houses it was handed, and only while the
       packet is live — so scope is resolved here, once, before any handler
       runs, rather than trusted to each branch remembering to check. */
    let scope = null;
    if (claims.g) {
      const packet = await AS.loadPacket(store, claims.g, Date.now());
      if (!packet.state.ok) return res.status(403).json({ error: packet.state.reason });
      scope = new Set(AS.houseIdList(packet.assignment));
      if (req.method === 'DELETE' || req.method === 'POST') {
        return res.status(403).json({ error: 'Guests can record visits, not add or remove houses' });
      }
    }
    const inScope = id => !scope || scope.has(id);

    /* ── GET ── */
    if (req.method === 'GET') {
      const all = (await store.read(HOUSES)).filter(isLive);
      const visible = scope ? all.filter(r => scope.has(r.id)) : all;
      return res.json(visible.map(publicRec));
    }

    /* ── POST: create one ── */
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const rec = sanitize(body);
      // Honour a client-supplied id so a house created offline keeps its
      // identity after sync, instead of needing an id remap.
      rec.id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : uid();
      rec.HouseVisitLog = seedLog(rec) || rec.HouseVisitLog || '';
      deriveSlots(rec);
      rec.HouseUpdatedAt = now;
      await store.create(HOUSES, rec);
      return res.json({ id: rec.id, HouseUpdatedAt: now });
    }

    /* ── PATCH: update one ── */
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      if (!inScope(body.id)) return res.status(403).json({ error: 'That house is not on your list' });
      const rows = await store.read(HOUSES);
      const existing = rows.find(r => r.id === body.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });

      const merged = mergeRow(existing, sanitize(body), now);
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
      const rows = await store.read(HOUSES);
      const existing = rows.find(r => r.id === body.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
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
      if (scope) {
        // Silently drop what a guest may not touch instead of rejecting the
        // whole batch: one stray id must not strand the visits they did record.
        creates = [];
        deletes = [];
        updates = updates.filter(u => u && inScope(u.id));
      }

      const rows = await store.read(HOUSES);
      const byId = new Map();
      rows.forEach(r => { if (r.id) byId.set(r.id, r); });

      const deleteSet = new Set(deletes);
      const conflicts = [];
      const applied = { created: [], updated: [], deleted: [], missing: [] };
      const pending = new Map(); // id -> merged record, one write per record

      for (const u of updates) {
        if (!u || typeof u.id !== 'string' || deleteSet.has(u.id)) continue;
        const existing = pending.get(u.id) || byId.get(u.id);
        if (!existing) { applied.missing.push(u.id); continue; }
        if (u._base && existing.HouseUpdatedAt && existing.HouseUpdatedAt > u._base) {
          conflicts.push({ id: u.id, remote: publicRec(existing) });
        }
        const merged = mergeRow(existing, sanitize(u), now);
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
        const rec = sanitize(c);
        rec.id = (typeof c.id === 'string' && c.id.trim()) ? c.id.trim() : uid();
        if (byId.has(rec.id) || deleteSet.has(rec.id)) continue;
        rec.HouseVisitLog = seedLog(rec) || rec.HouseVisitLog || '';
        deriveSlots(rec);
        rec.HouseUpdatedAt = now;
        newRows.push(rec);
        applied.created.push(rec.id);
      }
      if (newRows.length) await store.createMany(HOUSES, newRows);

      // Read back so the client ends the sync in a known-good state.
      const after = (await store.readFresh(HOUSES)).filter(isLive);
      const records = (scope ? after.filter(r => scope.has(r.id)) : after).map(publicRec);
      return res.json({ ok: true, applied, conflicts, records, serverTime: now });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    const msg = (err && err.message) || 'Server error';
    res.status(/throttl|quota|429/i.test(msg) ? 429 : 500)
      .json({ error: /throttl|quota|429/i.test(msg) ? 'Too busy right now — try again in a moment' : msg });
  }
};
