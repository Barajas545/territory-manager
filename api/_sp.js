/* SharePoint storage, via Microsoft Graph.

   Replaces the Google Sheets layer. Same shapes in and out, so the endpoints
   above barely change — a "tab" is a SharePoint list, a "row" is a list item,
   and `_row` carries the item id instead of a spreadsheet row number.

   Why the move: Sheets allows 60 reads a minute for the whole service
   account, which two car groups out at once would exhaust. SharePoint gives
   this app 1,250 resource units a minute per tenant — roughly ten times the
   room — and list items have stable ids, so the row-shifting hazards that
   spreadsheets have simply do not exist here.

   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

/* Trimmed on the way in. Copying an id out of the Azure portal very easily
   picks up a trailing newline, and an untrimmed one corrupts the sign-in URL
   or the site path with an error that points nowhere near the real cause. */
const env = k => String(process.env[k] || '').trim();

const TENANT = env('SP_TENANT_ID');
const CLIENT_ID = env('SP_CLIENT_ID');
const CLIENT_SECRET = env('SP_CLIENT_SECRET');
const SITE_URL = env('SP_SITE_URL');   // https://contoso.sharepoint.com/sites/Territory
const SITE_ID_ENV = env('SP_SITE_ID'); // optional, skips the lookup

const GRAPH = 'https://graph.microsoft.com/v1.0';

function configured() {
  return !!(TENANT && CLIENT_ID && CLIENT_SECRET && (SITE_URL || SITE_ID_ENV));
}

/* ── auth ──
   App-only token, cached in module scope. It is not user-specific, so a warm
   instance reusing it is correct rather than a leak, and it saves a token
   round trip on every single call. */
let _tok = null, _tokExp = 0;
async function token() {
  const now = Date.now();
  if (_tok && now < _tokExp - 60000) return _tok;
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) {
    throw new Error('SharePoint sign-in failed: ' + (j.error_description || j.error || res.status));
  }
  _tok = j.access_token;
  _tokExp = now + (Number(j.expires_in || 3600) * 1000);
  return _tok;
}

/* Microsoft requires honouring Retry-After; retrying sooner counts against the
   quota and extends the throttle, so an eager retry actively makes it worse. */
async function graph(path, opts, attempt) {
  opts = opts || {};
  attempt = attempt || 0;
  const t = await token();
  const res = await fetch(path.startsWith('http') ? path : GRAPH + path, {
    method: opts.method || 'GET',
    headers: Object.assign({
      Authorization: 'Bearer ' + t,
      'Content-Type': 'application/json',
      // Decorated traffic is prioritised over anonymous traffic by SharePoint.
      'User-Agent': 'NONISV|DCRFraming|TerritoryManager/2.5',
    }, opts.headers || {}),
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  if ((res.status === 429 || res.status === 503) && attempt < 3) {
    const wait = Math.max(1, Number(res.headers.get('retry-after') || Math.pow(2, attempt))) * 1000;
    await new Promise(r => setTimeout(r, Math.min(wait, 10000)));
    return graph(path, opts, attempt + 1);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || text.slice(0, 300) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

/* ── site + list resolution, cached for the life of the instance ── */
let _siteId = null;
async function siteId() {
  if (SITE_ID_ENV) return SITE_ID_ENV;
  if (_siteId) return _siteId;
  const u = new URL(SITE_URL);
  const path = u.pathname.replace(/^\/+|\/+$/g, '');
  const r = await graph(`/sites/${u.hostname}:/${path}`);
  _siteId = r.id;
  return _siteId;
}

/* SharePoint reserves a pile of column names (Title, Created, Author, Order…)
   and mangles anything with punctuation. Prefixing every field sidesteps the
   whole class of problem, and `id` maps onto Title so the natural key is the
   one column every list already has and indexes. */
const col = f => (f === 'id' ? 'Title' : 'tm' + f.charAt(0).toUpperCase() + f.slice(1));

const _lists = new Map();
async function listId(spec) {
  if (_lists.has(spec.name)) return _lists.get(spec.name);
  const sid = await siteId();
  const found = await graph(`/sites/${sid}/lists?$filter=displayName eq '${spec.name.replace(/'/g, "''")}'`);
  let id = found && found.value && found.value[0] && found.value[0].id;
  if (!id) id = await createList(spec, sid);
  _lists.set(spec.name, id);
  return id;
}

async function createList(spec, sid) {
  // Everything is multi-line text: single-line columns cap at 255 characters,
  // which the notes, the visit log and the voice payloads all exceed.
  const columns = spec.cols.filter(f => f !== 'id').map(f => ({
    name: col(f),
    text: { allowMultipleLines: true, maxLength: 100000, textType: 'plain' },
  }));
  const made = await graph(`/sites/${sid}/lists`, {
    method: 'POST',
    body: { displayName: spec.name, list: { template: 'genericList' }, columns },
  });
  return made.id;
}

/* ── reads ── */
function itemToRecord(item, spec) {
  const f = item.fields || {};
  const rec = { _row: item.id };
  spec.cols.forEach(name => { rec[name] = f[col(name)] !== undefined && f[col(name)] !== null ? String(f[col(name)]) : ''; });
  return rec;
}

async function readList(spec) {
  const sid = await siteId();
  const lid = await listId(spec);
  let url = `/sites/${sid}/lists/${lid}/items?expand=fields&$top=999`;
  const out = [];
  // Follow paging rather than silently returning the first page — a territory
  // that grew past 999 houses would otherwise lose the rest without a word.
  while (url) {
    const page = await graph(url);
    (page.value || []).forEach(it => out.push(itemToRecord(it, spec)));
    url = page['@odata.nextLink'] || null;
  }
  return out;
}

/* ── writes ── */
function toFields(spec, obj) {
  const f = {};
  spec.cols.forEach(name => {
    const v = obj[name];
    f[col(name)] = (v === undefined || v === null) ? '' : String(v);
  });
  return f;
}

async function createItem(spec, obj) {
  const sid = await siteId();
  const lid = await listId(spec);
  const made = await graph(`/sites/${sid}/lists/${lid}/items`, {
    method: 'POST', body: { fields: toFields(spec, obj) },
  });
  return made.id;
}

async function updateItem(spec, itemId, obj) {
  const sid = await siteId();
  const lid = await listId(spec);
  await graph(`/sites/${sid}/lists/${lid}/items/${itemId}/fields`, {
    method: 'PATCH', body: toFields(spec, obj),
  });
}

async function deleteItem(spec, itemId) {
  const sid = await siteId();
  const lid = await listId(spec);
  await graph(`/sites/${sid}/lists/${lid}/items/${itemId}`, { method: 'DELETE' });
}

/* Graph accepts 20 sub-requests per batch. Used for bulk sync, where a long
   offline session can queue dozens of edits at once. */
async function batch(requests) {
  if (!requests.length) return [];
  const out = [];
  for (let i = 0; i < requests.length; i += 20) {
    const chunk = requests.slice(i, i + 20);
    const r = await graph('/$batch', {
      method: 'POST',
      body: {
        requests: chunk.map((q, n) => ({
          id: String(n + 1), method: q.method, url: q.url,
          ...(q.body ? { body: q.body, headers: { 'Content-Type': 'application/json' } } : {}),
        })),
      },
    });
    (r.responses || []).sort((a, b) => Number(a.id) - Number(b.id)).forEach(x => out.push(x));
  }
  return out;
}

/* Relative URLs for use inside batch(). */
async function itemPath(spec, itemId) {
  const sid = await siteId();
  const lid = await listId(spec);
  return `/sites/${sid}/lists/${lid}/items${itemId ? '/' + itemId : ''}`;
}

module.exports = {
  configured, graph, siteId, listId, readList,
  createItem, updateItem, deleteItem, batch, itemPath, toFields, col,
};
