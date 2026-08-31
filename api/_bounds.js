/* Los limites de cada territorio, dibujados sobre el mapa.

   Sirven para una pregunta que hoy no se puede contestar: ¿esta cubierta toda
   la ciudad, o hay calles que no le tocan a nadie? Con los limites dibujados,
   una casa que cae fuera de todos ellos se puede señalar sola.

   Lista propia, no una columna en Territories: _sp.js crea una lista solo
   cuando falta entera, asi que una columna nueva sobre una lista viva nunca se
   crea y la primera escritura romperia el reparto de territorios. Una lista
   nueva si se crea bien en la primera lectura.

   Con guion bajo al inicio, para que Vercel la trate como modulo y no como
   ruta. */

const crypto = require('crypto');

const BOUNDS_TAB = {
  name: 'TerritoryBounds',
  cols: ['id', 'territory', 'points', 'updatedAt', 'updatedBy'],
};

/* Un limite se dibuja tocando la pantalla, asi que en la practica son decenas
   de puntos, no cientos. El tope existe para que un error de programacion no
   llene la celda, no porque alguien vaya a acercarse. */
const MAX_POINTS = 300;

// Seis decimales son ~11 cm. Mas que eso solo engorda la celda.
const round6 = n => Math.round(n * 1e6) / 1e6;

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

/* Acepta [[lat,lng],...] o [{lat,lng},...] y devuelve siempre pares. Un punto
   que no es un punto se descarta en silencio: vale mas un limite con un vertice
   de menos que un error a media calle. */
function cleanPoints(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < arr.length && out.length < MAX_POINTS; i++) {
    const p = arr[i];
    if (!p || typeof p !== 'object') continue;
    const rawLat = Array.isArray(p) ? p[0] : p.lat;
    const rawLng = Array.isArray(p) ? p[1] : p.lng;
    /* null, undefined y '' se vuelven 0 al pasar por Number(), y (0,0) es un
       punto perfectamente valido en medio del Atlantico: un hueco en la lista
       se habria dibujado como un vertice a miles de kilometros, deformando el
       poligono y dejando fuera de sus limites a media ciudad. */
    if (rawLat === null || rawLat === undefined || rawLat === '') continue;
    if (rawLng === null || rawLng === undefined || rawLng === '') continue;
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push([round6(lat), round6(lng)]);
  }
  return out;
}

function parsePoints(str) {
  if (!str) return [];
  try { return cleanPoints(JSON.parse(str)); } catch (e) { return []; }
}

async function readBounds(store) {
  try { return await store.read(BOUNDS_TAB); }
  catch (e) { return []; }
}

// El mas reciente gana, por si dos telefonos guardaron el mismo territorio.
const forTerritory = (rows, name) => {
  const key = String(name || '').trim().toLowerCase();
  return rows.filter(r => r && String(r.territory || '').trim().toLowerCase() === key)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
};

/* Un limite por territorio, reemplazado y no agregado: esto es un dibujo, no
   un historial. Guardar cero puntos lo borra del mapa sin borrar el renglon,
   igual que un mensaje que se vacia. */
async function setBounds(store, territory, rawPoints, whoId, nowIso) {
  const points = cleanPoints(rawPoints);
  const rows = await readBounds(store);
  const existing = forTerritory(rows, territory);
  const rec = {
    id: existing ? existing.id : newId(),
    territory: String(territory || '').trim(),
    points: points.length ? JSON.stringify(points) : '',
    updatedAt: nowIso,
    updatedBy: whoId || '',
  };
  if (existing) await store.update(BOUNDS_TAB, existing._key, rec);
  else await store.create(BOUNDS_TAB, rec);
  return points;
}

module.exports = {
  BOUNDS_TAB, MAX_POINTS, newId, cleanPoints, parsePoints,
  readBounds, forTerritory, setBounds,
};
