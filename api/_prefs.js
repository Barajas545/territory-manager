/* La version sencilla de la app, por persona.

   Hay hermanos a quienes el telefono se les dificulta y por eso no usan la
   app. Para ellos sobra casi todo: mapas, revisitas, filtros, busqueda. Lo
   unico que necesitan es la lista de su territorio y poder anotar que paso en
   cada puerta.

   Dos banderas y no una, porque son dos cosas distintas:
     simple  — como quiere ver la app quien la usa
     locked  — el administrador la dejo fija en sencilla

   Con `locked`, la persona no puede volver a la version completa por accidente
   y quedarse otra vez sin poder trabajar. Sin `locked`, cualquiera puede
   probar la version sencilla y regresar cuando quiera.

   Lista propia, no una columna en Users: _sp.js crea una lista solo cuando
   falta entera, asi que una columna nueva sobre una lista viva no se crea y la
   primera escritura romperia TODAS las cuentas. Es la lista que menos se puede
   arriesgar de todo el sistema.

   Con guion bajo al inicio, para que Vercel la trate como modulo y no ruta. */

const crypto = require('crypto');

const PREFS_TAB = {
  name: 'UserPrefs',
  cols: ['id', 'userId', 'simple', 'locked', 'updatedAt'],
};

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

async function readPrefs(store) {
  try { return await store.read(PREFS_TAB); }
  catch (e) { return []; }
}

const forUser = (rows, userId) => {
  const id = String(userId || '');
  return rows.filter(r => r && String(r.userId || '') === id)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
};

/* Lo que el telefono necesita saber: si se muestra sencilla, y si la persona
   puede cambiarlo. Sin renglon guardado, la app es la completa de siempre —
   nadie despierta un dia con una app distinta sin haberlo pedido. */
function stateFor(rows, userId) {
  const r = forUser(rows, userId);
  const locked = !!r && r.locked === '1';
  return { simple: locked || (!!r && r.simple === '1'), locked: locked };
}

/* Un renglon por persona, reemplazado y no agregado: esto es una preferencia,
   no un historial. */
async function setPrefs(store, userId, patch, nowIso) {
  const rows = await readPrefs(store);
  const existing = forUser(rows, userId);
  const cur = { simple: existing ? existing.simple : '', locked: existing ? existing.locked : '' };
  const rec = {
    id: existing ? existing.id : newId(),
    userId: String(userId || ''),
    simple: (patch.simple === undefined ? cur.simple === '1' : !!patch.simple) ? '1' : '',
    locked: (patch.locked === undefined ? cur.locked === '1' : !!patch.locked) ? '1' : '',
    updatedAt: nowIso,
  };
  if (existing) await store.update(PREFS_TAB, existing._key, rec);
  else await store.create(PREFS_TAB, rec);
  return { simple: rec.locked === '1' || rec.simple === '1', locked: rec.locked === '1' };
}

module.exports = { PREFS_TAB, newId, readPrefs, forUser, stateFor, setPrefs };
