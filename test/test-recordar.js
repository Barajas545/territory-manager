/* Recordar el último territorio, dentro de la misma salida.

   El teléfono cierra la app en segundo plano cuando quiere —iOS sobre todo—, y
   cada vez que se volvía a abrir empezaba en "Todos" y ofrecía otra vez las
   tarjetas. A media calle, eso es buscar el territorio cada vez que se
   desbloquea el teléfono.

   Ahora se recuerda en el teléfono con la hora, y se vuelve a él sin preguntar
   mientras sea la misma salida: menos de 3 horas sin usar la app. Pasado eso es
   otra salida y se pregunta como siempre.

   Lo que más importa probar aquí son los bordes, porque ahí se cuela lo que
   no debe: el invitado que no debe heredar nada, "Mis Revisitas" que
   enseñaría las revisitas de otros, la persona que entra en un teléfono
   ajeno, el territorio que ya no existe. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = process.argv[2] || path.resolve(__dirname, '..');

let fails = 0, checks = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const bloque = desde => {
  const i = src.indexOf(desde);
  if (i === -1) throw new Error('no se encontró: ' + desde);
  let nivel = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') nivel++;
    else if (src[k] === '}' && --nivel === 0) return src.slice(i, k + 1);
  }
  throw new Error('quedó sin cerrar: ' + desde);
};
const take = name => bloque('function ' + name + '(');

/* ══ ninguna función se define dos veces ══════════════════════════════
   Las pruebas sacan cada función buscando la PRIMERA "function X(". Si alguien
   la vuelve a definir más abajo, el navegador usa la ÚLTIMA: la prueba y el
   teléfono correrían código distinto, y la prueba pasaría en verde sobre algo
   que ya no existe. */
const nombres = (src.match(/^function [A-Za-z0-9_]+\(/gm) || []).map(x => x.slice(9, -1));
const vistos = {}, repetidas = [];
nombres.forEach(n => { if (vistos[n]) repetidas.push(n); vistos[n] = 1; });
check('ninguna función de primer nivel se define dos veces', repetidas.length === 0,
  repetidas.join(', ') || nombres.length + ' funciones, todas distintas');

const HORA = 3600e3;
const GAP_SRC = (src.match(/var TERR_GAP=([^;]+);/) || [])[1];
check('una salida son 3 horas sin usar la app', GAP_SRC === '3*3600e3', GAP_SRC);

// ── un teléfono de mentira ──────────────────────────────────────────────
function telefono(cambios) {
  const almacen = {};
  const c = Object.assign({
    localStorage: {
      getItem: k => (k in almacen ? almacen[k] : null),
      setItem: (k, v) => { almacen[k] = String(v); },
      removeItem: k => { delete almacen[k]; },
    },
    Date, JSON,
    TERR_KEY: 'tm_terr', TERR_GAP: 3 * HORA, RV_TERR: '__rv__',
    guestMode: false, authToken: 'tok', me: { id: 'u1' },
    terrFilter: 'all', entryPickDone: false,
    records: [{ HouseTerritoryNumber: 'A3' }, { HouseTerritoryNumber: 'A4' }],
    guestCodeFromUrl: () => '',
    terrMap() { const m = {}; c.records.forEach(h => { m[h.HouseTerritoryNumber] = [h]; }); return m; },
  }, cambios || {});
  c._almacen = almacen;
  vm.createContext(c);
  vm.runInContext(['terrMemo', 'terrMemoFresh', 'forgetTerr', 'rememberTerr', 'touchTerrMemo', 'restoreTerrMemo']
    .map(take).join('\n'), c);
  return c;
}
const guarda = (c, m) => { c._almacen.tm_terr = JSON.stringify(m); };
const leida = c => JSON.parse(c._almacen.tm_terr || 'null');

// ══ leer lo guardado ═════════════════════════════════════════════════════
let t = telefono();
check('sin nada guardado, no hay memoria', t.terrMemo() === null);
t._almacen.tm_terr = 'esto no es json';
check('basura en el almacén no rompe nada', t.terrMemo() === null);
guarda(t, { t: 'A3' });
check('una memoria sin hora no vale', t.terrMemo() === null);
guarda(t, { t: 'A3', at: Date.now() - 2 * HORA });
check('dos horas después sigue siendo la misma salida', !!t.terrMemoFresh());
guarda(t, { t: 'A3', at: Date.now() - 3 * HORA - 1000 });
check('pasadas las tres horas ya es otra salida', t.terrMemoFresh() === null);

// ══ escribir ═════════════════════════════════════════════════════════════
t = telefono({ terrFilter: 'A4' });
t.rememberTerr();
check('escoger recuerda el territorio', leida(t) && leida(t).t === 'A4', JSON.stringify(leida(t)));
check('con la hora de ahora', leida(t) && Date.now() - leida(t).at < 2000);
check('y de quién es', leida(t) && leida(t).u === 'u1');

/* "Mis Revisitas" no se guarda: sin sesión confirmada todavía, myRVs devuelve
   las revisitas de TODOS, y al abrir se verían las de otros por un momento. */
t = telefono({ terrFilter: '__rv__' });
t.rememberTerr();
check('"Mis Revisitas" no se recuerda: se guarda como Todos', leida(t).t === 'all', leida(t).t);

t = telefono({ terrFilter: 'A4', guestMode: true });
t.rememberTerr();
check('el invitado no escribe nada: su territorio es el de su paquete', leida(t) === null);
t = telefono({ terrFilter: 'A4', authToken: '' });
t.rememberTerr();
check('sin sesión no se escribe nada', leida(t) === null);

// Al abrir, "me" todavía no llega: se conserva de quién era la memoria.
t = telefono({ terrFilter: 'A4', me: null });
guarda(t, { t: 'A3', at: 1, u: 'u1' });
t.rememberTerr();
check('sin "me" todavía, conserva de quién era', leida(t).u === 'u1', leida(t).u);

// ── irse a segundo plano ────────────────────────────────────────────────
t = telefono({ terrFilter: 'A4' });
t.touchTerrMemo();
check('irse a segundo plano sin haber escogido NO inventa una memoria', leida(t) === null,
  'si cerró las tarjetas sin escoger, se le pregunta la próxima vez');
guarda(t, { t: 'A4', at: Date.now() - 2 * HORA, u: 'u1' });
t.touchTerrMemo();
check('con algo escogido, irse refresca la hora', Date.now() - leida(t).at < 2000,
  'cuenta cuánto lleva SIN usarse, no cuánto hace que escogió');

// ══ al abrir ═════════════════════════════════════════════════════════════
t = telefono();
guarda(t, { t: 'A4', at: Date.now() - HORA, u: 'u1' });
t.restoreTerrMemo();
check('dentro de la misma salida, abre directo en el territorio', t.terrFilter === 'A4', t.terrFilter);
check('y ya no se le ofrecen las tarjetas', t.entryPickDone === true);

t = telefono();
guarda(t, { t: 'all', at: Date.now() - HORA, u: 'u1' });
t.restoreTerrMemo();
check('si escogió Todos, también se respeta y no se pregunta otra vez',
  t.terrFilter === 'all' && t.entryPickDone === true);

t = telefono();
guarda(t, { t: 'A4', at: Date.now() - 4 * HORA, u: 'u1' });
t.restoreTerrMemo();
check('otra salida: abre en Todos como siempre', t.terrFilter === 'all');
check('y se le preguntará', t.entryPickDone === false);
check('y la memoria vieja se olvida', leida(t) === null);

t = telefono();
guarda(t, { t: 'Atascadero 9', at: Date.now() - HORA, u: 'u1' });
t.restoreTerrMemo();
check('un territorio que ya no está en el teléfono no se restaura', t.terrFilter === 'all');
check('y se olvida', leida(t) === null);

/* El invitado: uno que vuelve ya tiene guestMode, pero uno que llega por
   enlace ?g= todavía no cuando esto corre, porque eso es asíncrono. */
t = telefono({ guestMode: true });
guarda(t, { t: 'A4', at: Date.now(), u: 'u1' });
t.restoreTerrMemo();
check('al invitado que vuelve no se le restaura nada', t.terrFilter === 'all');
t = telefono({ guestCodeFromUrl: () => 'ABC123' });
guarda(t, { t: 'A4', at: Date.now(), u: 'u1' });
t.restoreTerrMemo();
check('ni al que llega por un enlace de invitado', t.terrFilter === 'all',
  'guestMode todavía es false en ese momento');
t = telefono({ authToken: '' });
guarda(t, { t: 'A4', at: Date.now(), u: 'u1' });
t.restoreTerrMemo();
check('sin sesión no se restaura nada', t.terrFilter === 'all');

/* Se restaura ANTES del primer pintado y sin red: en el campo muchas veces no
   hay señal, y la lista abre ya en el territorio, sin parpadear por Todos. */
check('se restaura antes de pintar la lista, con las casas del teléfono',
  /records=buildRecords\(\);[\s\S]{0,140}restoreTerrMemo\(\);\s*renderHouses\(\);/.test(src));
check('y no espera a la red: no mira scope ni me',
  !/scope\./.test(take('restoreTerrMemo')) && !/\bme\b/.test(take('restoreTerrMemo')));

// ══ las tarjetas al entrar respetan la memoria ═══════════════════════════
const decide = cambios => {
  const abiertas = [];
  const c = Object.assign({
    entryPickDone: false, scope: { at: 1, kind: 'admin' },
    records: [{ HouseTerritoryNumber: 'A3' }, { HouseTerritoryNumber: 'A4' }],
    guestMode: false, simpleMode: false, needsAuth: false, me: { id: 'u1' },
    terrFilter: 'all', openSheets: [], fresca: null,
    terrMap() { const m = {}; c.records.forEach(h => { m[h.HouseTerritoryNumber] = 1; }); return m; },
    terrMemoFresh() { return c.fresca; },
    openTerrPicker(t) { abiertas.push(t); },
  }, cambios);
  vm.createContext(c);
  vm.runInContext(take('maybeEntryPick'), c);
  c.maybeEntryPick(c.nueva);
  return abiertas.length > 0;
};
check('sin memoria, se ofrecen como antes', decide({}));
check('con una memoria de esta salida, no', !decide({ fresca: { t: 'all' } }),
  'escogió hace un rato, aunque haya sido Todos');
check('volver tras horas, con el territorio de antes puesto, SÍ se ofrecen',
  decide({ nueva: true, terrFilter: 'A4' }));
check('sin ser una salida nueva, con territorio puesto, no',
  !decide({ terrFilter: 'A4' }));

check('volver de segundo plano mira la hora ANTES de refrescarla',
  /if\(document\.visibilityState==="hidden"\)\{stashDrafts\(\);touchTerrMemo\(\);return;\}[\s\S]{0,400}if\(m&&Date\.now\(\)-m\.at>=TERR_GAP\)\{\s*forgetTerr\(\);entryPickDone=false;maybeEntryPick\(true\);/.test(src),
  'touchTerrMemo solo corre al irse; al volver todavía dice cuándo se fue');
check('cerrar la app también refresca la hora', /addEventListener\("pagehide",touchTerrMemo\)/.test(src));
check('escoger una tarjeta lo recuerda',
  /terrFilter=b\.dataset\.terr;closeSheet\("#sh-pick"\);\s*rememberTerr\(\);/.test(src));

// ══ de quién es la memoria ═══════════════════════════════════════════════
const ss = take('setSession');
check('si entra OTRA persona en el teléfono, no hereda el territorio',
  /if\(user&&mm&&mm\.u&&mm\.u!==user\.id\)forgetTerr\(\);/.test(ss));
check('y no revienta cuando cerrar sesión llama sin usuario', /if\(user&&/.test(ss));
const so = take('signOut');
check('cerrar sesión olvida el territorio', /forgetTerr\(\);/.test(so));
check('y lo regresa a Todos', /terrFilter="all";/.test(so));
check('y vuelve a ofrecer las tarjetas al entrar de nuevo', /entryPickDone=false;/.test(so),
  'antes, quien salía y volvía a entrar sin recargar ya no las veía');
check('y olvida el alcance de la cuenta anterior', /scope=\{kind:"unknown"/.test(so));

// ══ renombrar y desaparecer ══════════════════════════════════════════════
check('renombrar un territorio renombra también lo recordado',
  /if\(mm&&mm\.t===viejo\)\{mm\.t=r\.to;/.test(src),
  'si no, el siguiente arranque buscaría un nombre que ya no existe');
check('un territorio que deja de estar regresa la lista a Todos',
  /!terrMap\(\)\[terrFilter\]\)\{\s*terrFilter="all";forgetTerr\(\);/.test(src),
  'antes la lista se quedaba vacía sin decir por qué');
check('pero no a media marca de un límite', /&&!drawing&&!terrMap\(\)\[terrFilter\]/.test(src));
check('ni al invitado, que tiene el suyo', /&&!guestMode&&!drawing&&/.test(src));

console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
process.exit(fails ? 1 : 0);
