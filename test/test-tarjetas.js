/* Las tarjetas de territorio y su mapa pequeño.

   El selector era una lista de texto —"Atascadero 4 · 18 casas"— y para
   escoger qué trabajar hoy eso dice poco. La tarjeta dice dónde queda, cuánto
   mide, qué parte falta por trabajar y si alguien ya lo tiene.

   El mapa pequeño se dibuja a mano: mosaicos como <image> dentro de un SVG, con
   el contorno y las casas encima en el mismo sistema de coordenadas. Si la
   cuenta de dónde va cada cosa está mal, el contorno queda corrido de las
   calles y la tarjeta miente sobre lo que cubre el territorio. Por eso la parte
   más probada es esa cuenta, con coordenadas REALES de Paso Robles 3 y de
   Atascadero 4.

   Las funciones se sacan del propio index.html en vez de copiarlas, para que la
   prueba no pueda quedar verificando una versión vieja de la verdad. */

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

/* Coordenadas REALES: los edificios que el servicio de direcciones ubicó al
   probar la búsqueda contra las hojas de papel. */
const PR3 = [[35.606604,-120.662236],[35.606129,-120.66218],[35.605839,-120.662756],[35.605222,-120.662411],[35.604885,-120.662291],[35.604602,-120.662654],[35.604779,-120.662166],[35.60561,-120.665543],[35.60594,-120.665414],[35.602011,-120.664524],[35.604351,-120.665725],[35.603842,-120.664051],[35.603843,-120.663783],[35.605298,-120.658481],[35.605298,-120.658456],[35.605295,-120.657853],[35.605295,-120.657828],[35.605294,-120.657802],[35.605532,-120.658402],[35.60507,-120.657474],[35.60557,-120.657235],[35.605385,-120.656709],[35.605356,-120.656567],[35.605748,-120.656454],[35.605075,-120.655851],[35.605072,-120.655463]];
const A4 = [[35.478509,-120.664976],[35.469163,-120.654577],[35.468749,-120.654904],[35.474742,-120.658979],[35.475587,-120.660167],[35.476392,-120.659333],[35.455543,-120.713997],[35.460014,-120.712156],[35.467044,-120.658447],[35.480226,-120.661904],[35.480804,-120.66246]];

const caja = {};
vm.createContext(caja);
vm.runInContext(['tileX', 'tileY', 'tileUrl', 'worldX', 'worldY', 'miniFrame'].map(take).join('\n'), caja);
const { tileX, tileY, worldX, worldY, miniFrame } = caja;

// ══ la proyección coincide con la que ya usa la app ════════════════════
/* worldX/worldY son tileX/tileY sin redondear. Si no coincidieran, el contorno
   se pintaría en un mosaico y la calle en otro. */
let todoCoincide = true;
[[35.6066, -120.6622], [35.4555, -120.714], [0, 0], [-33.9, 151.2]].forEach(([la, lo]) => {
  [9, 12, 15, 17].forEach(z => {
    if (Math.floor(worldX(lo, z) / 256) !== tileX(lo, z)) todoCoincide = false;
    if (Math.floor(worldY(la, z) / 256) !== tileY(la, z)) todoCoincide = false;
  });
});
check('la proyección coincide con tileX/tileY de la app en todos los zooms', todoCoincide);

// ══ el encuadre, con los territorios de verdad ═════════════════════════
const W = 320, H = 160, PAD = 12;
const dentro = (f, pts) => pts.filter(([la, lo]) => {
  const [x, y] = f.px(la, lo); return x >= 0 && x <= W && y >= 0 && y <= H;
}).length;

let f = miniFrame(PR3, W, H, PAD);
check('Paso Robles 3: todos los edificios caen dentro del mapa',
  dentro(f, PR3) === PR3.length, dentro(f, PR3) + '/' + PR3.length);
check('y se acerca lo más que puede sin cortar nada', f.z >= 14, 'zoom ' + f.z);
check('con pocos mosaicos', f.tiles.length <= 6, f.tiles.length + ' mosaicos');

f = miniFrame(A4, W, H, PAD);
check('Atascadero 4 —6.7 km de punta a punta— también cabe entero',
  dentro(f, A4) === A4.length, dentro(f, A4) + '/' + A4.length);
check('a un zoom donde todavía se ven las calles', f.z >= 11, 'zoom ' + f.z);

/* Los mosaicos tienen que tapar la caja entera: un hueco sería una franja gris
   en medio del mapa. */
const cubre = fr => {
  for (let x = 0; x < W; x += 8) for (let y = 0; y < H; y += 8) {
    if (!fr.tiles.some(t => x >= t.l && x < t.l + 256 && y >= t.t && y < t.t + 256)) return false;
  }
  return true;
};
check('los mosaicos tapan la caja entera, sin huecos', cubre(miniFrame(PR3, W, H, PAD)) && cubre(miniFrame(A4, W, H, PAD)));

// ══ los extremos ═══════════════════════════════════════════════════════
f = miniFrame([[35.6, -120.66]], W, H, PAD);
check('una sola casa no se acerca hasta las tejas: tope en 17', f.z === 17, 'zoom ' + f.z);
check('y queda en el centro', Math.abs(f.px(35.6, -120.66)[0] - W / 2) < 1 && Math.abs(f.px(35.6, -120.66)[1] - H / 2) < 1);
f = miniFrame([[35.0, -121.5], [36.2, -119.6]], W, H, PAD);
check('algo enorme no se aleja más allá de 9', f.z === 9, 'zoom ' + f.z);
check('ningún mosaico pide una fila que no existe',
  [miniFrame([[85, 0]], W, H, PAD), miniFrame([[-85, 0]], W, H, PAD)]
    .every(fr => fr.tiles.every(t => t.y >= 0 && t.y < Math.pow(2, fr.z))));

// ══ el dibujo ══════════════════════════════════════════════════════════
const dib = {
  MINI_W: W, MINI_H: H,
  pinColor: s => ({ recent: '#12805C', due: '#B54708', overdue: '#B42318', never: '#6B7488' }[s] || '#6B7488'),
};
vm.createContext(dib);
vm.runInContext(['tileX', 'tileY', 'tileUrl', 'worldX', 'worldY', 'miniFrame', 'sinLejanas', 'miniMapHTML']
  .map(take).join('\n'), dib);

let html = dib.miniMapHTML({ polys: [], pts: [] });
check('sin contorno ni casas ubicadas, lo dice en vez de enseñar un mapa vacío',
  /Sin ubicación/.test(html) && !/<svg/.test(html));

html = dib.miniMapHTML({ polys: [A4.slice(0, 4)], pts: [] });
check('con solo el contorno ya hay mapa', /<svg/.test(html) && /<polygon/.test(html));
check('los mosaicos salen del MISMO servidor que el mapa grande',
  (html.match(/href="([^"]+)"/g) || []).every(h => /tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png/.test(h)),
  'si no, no los encontraría el mapa descargado para trabajar sin internet');

html = dib.miniMapHTML({ polys: [], pts: [{ lat: 35.6, lng: -120.66, s: 'never' },
  { lat: 35.601, lng: -120.661, s: 'overdue' }] });
check('cada casa es un punto', (html.match(/<circle/g) || []).length === 2);
check('del color de su última visita',
  /fill="#6B7488"/.test(html) && /fill="#B42318"/.test(html),
  'se ve de un vistazo qué parte falta por trabajar');
check('el SVG se escala con la tarjeta sin medir nada',
  /viewBox="0 0 320 160"/.test(html) && /preserveAspectRatio/.test(html));

// ══ lo que lleva la tarjeta ════════════════════════════════════════════
const hoy = Date.now();
const hace = d => new Date(hoy - d * 864e5).toISOString().slice(0, 10);
const casa = (gps, ultima) => ({ HouseGPSCoordinates: gps || '', HouseLastVisitDate: ultima || '' });

const datos = {
  teamTerritories: [{ name: 'A4', owner: { name: 'Ilmy Barajas' }, assignedOn: '2026-09-01', assignees: [] },
                    { name: 'PR3', owner: null }],
  visitStatus: v => { if (!v) return 'never'; const d = (hoy - Date.parse(v)) / 864e5;
    return d <= 30 ? 'recent' : d <= 90 ? 'due' : 'overdue'; },
  parseGPS: v => { if (!v) return null; const p = String(v).split(',').map(x => parseFloat(x));
    return p.length === 2 && !isNaN(p[0]) ? { lat: p[0], lng: p[1] } : null; },
  dnvState: h => ({ on: !!h.dnv }),
};
vm.createContext(datos);
vm.runInContext(take('terrCardData'), datos);
const d = datos.terrCardData('A4', 'A4', [
  casa('35.47, -120.66', ''), casa('35.471, -120.661', hace(200)),
  casa('', hace(5)), casa('', ''),
], [A4.slice(0, 4), [[1, 1], [2, 2]], null]);
check('cuenta las casas', d.houses === 4, d.houses);
check('cuántas nunca se han visitado', d.nunca === 2, d.nunca);
check('cuántas están atrasadas', d.atras === 1, d.atras);
check('cuántas no están en el mapa', d.sin === 2, d.sin);
check('solo pinta las que tienen ubicación', d.pts.length === 2, d.pts.length);
check('un contorno de menos de 3 puntos no es una figura y se descarta',
  d.polys.length === 1, d.polys.length);
check('sabe quién lo tiene', d.owner && d.owner.name === 'Ilmy Barajas');
check('y que es un territorio registrado de verdad', d.real === true);
check('"Todos" no es un territorio registrado',
  datos.terrCardData('all', 'Todos', [], []).real === false);

/* ══ LO QUE ENCONTRÓ LA REVISIÓN ═══════════════════════════════════════ */

/* Una puerta No visitar no está pendiente. Contarla como "nunca visitada"
   invitaba a ir justo ahí; Atascadero 4 trae dos. */
const dnv = datos.terrCardData('A4', 'A4', [
  Object.assign(casa('', ''), { dnv: true }),
  Object.assign(casa('', hace(400)), { dnv: true }),
  casa('', ''),
], []);
check('una puerta No visitar NO cuenta como nunca visitada', dnv.nunca === 1, dnv.nunca);
check('ni como atrasada', dnv.atras === 0, dnv.atras);
check('pero sí cuenta entre las casas del territorio', dnv.houses === 3, dnv.houses);

/* Un vértice que no es un par de números no entra al contorno: [null,null]
   se volvería (0,0), en el golfo de Guinea, y el encuadre se iría al océano. */
const malos = datos.terrCardData('A4', 'A4', [],
  [[[35.47, -120.66], [null, null], [35.48, -120.65], ['x', 'y'], [35.46, -120.64]]]);
check('un vértice que no es un par de números se descarta',
  malos.polys.length === 1 && malos.polys[0].length === 3, JSON.stringify(malos.polys));

/* Una coordenada absurda —"0, 0" de un dedo que se resbaló— alejaba el
   encuadre hasta el océano y el territorio quedaba hecho un punto. */
const conCero = PR3.map(([la, lo]) => ({ lat: la, lng: lo, s: 'never' }))
  .concat([{ lat: 0, lng: 0, s: 'never' }]);
html = dib.miniMapHTML({ polys: [], pts: conCero });
const zConCero = +(html.match(/tile\.openstreetmap\.org\/(\d+)\//) || [])[1];
const zSinCero = +(dib.miniMapHTML({ polys: [], pts: conCero.slice(0, -1) })
  .match(/tile\.openstreetmap\.org\/(\d+)\//) || [])[1];
check('una casa en "0, 0" no aleja el encuadre hasta el océano',
  zConCero === zSinCero, 'zoom ' + zConCero + ' con ella, ' + zSinCero + ' sin ella');
check('con pocas casas no se descarta ninguna: no hay "mitad" de qué fiarse',
  dib.sinLejanas([{ lat: 0, lng: 0 }, { lat: 35.6, lng: -120.66 }]).length === 2);

/* Sin crossorigin la respuesta llega opaca y el service worker no la guarda:
   sin señal la tarjeta no tendría mapa. */
html = dib.miniMapHTML({ polys: [A4.slice(0, 4)], pts: [] });
check('los mosaicos de la tarjeta se piden con cors',
  (html.match(/<image /g) || []).length === (html.match(/crossorigin="anonymous"/g) || []).length &&
  /crossorigin="anonymous"/.test(html));
check('y se traslapan un pixel: sin eso, al escalar se ven rayitas entre mosaicos',
  /width="257" height="257"/.test(html) && !/width="256"/.test(html));
check('el mapita no recibe toques: dentro del botón abría "guardar imagen"',
  /\.tc-map\{[^}]*pointer-events:none/.test(src));
check('el crédito a OpenStreetMap va al pie de las tarjetas', /Mapas © OpenStreetMap/.test(src));

/* El fallo viejo que salió de rebote: el mapa grande pedía sus mosaicos sin
   crossOrigin, la respuesta llegaba opaca, y el service worker —con razón— no
   guarda respuestas opacas. La caché de "lo que ya se ha visto" nunca guardó
   nada. */
check('el mapa grande también pide sus mosaicos con cors',
  /L\.tileLayer\("https:\/\/tile\.openstreetmap\.org[^)]*crossOrigin:true/.test(src));
check('y la descarga sigue en modo cors, así que lo guardado no es opaco',
  /fetch\(url,\{mode:"cors"\}\)/.test(src),
  'si fuera opaco, pedir con cors rompería el mapa sin señal');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
check('el service worker sigue sin guardar respuestas opacas',
  /res\.type !== 'opaque'/.test(sw),
  'no puede ver si una opaca es un mosaico o una página de error');

/* "Sin ubicación" cuenta TODAS las casas, las del censo incluidas, como el
   botón de ubicar. Antes la tarjeta de Paso Robles decía un número y el botón
   otro. */
const conCenso = datos.terrCardData('PR3', 'PR3', [casa('', '')], [], 2,
  [casa('', ''), casa('', ''), casa('', ''), casa('35.6, -120.66', '')]);
check('"sin ubicación" cuenta también las del censo, como el botón de ubicar',
  conCenso.sin === 3, conCenso.sin);
check('pero el mapita solo pinta las que enseña la lista',
  conCenso.pts.length === 0, conCenso.pts.length);

/* La No visitar va en el mapita de su propio color, no como "nunca visitada". */
const conDnv = datos.terrCardData('A4', 'A4',
  [Object.assign(casa('35.47, -120.66', ''), { dnv: true }), casa('35.471, -120.661', '')], []);
check('una puerta No visitar se marca como tal en el mapita',
  conDnv.pts.some(q => q.s === 'dnv') && conDnv.pts.some(q => q.s === 'never'));
html = dib.miniMapHTML({ polys: [], pts: conDnv.pts });
check('y se pinta con la clase de No visitar, no con el gris de "nunca"',
  /<circle class="tc-dnv"/.test(html));
check('con el rojo de respaldo si los colores del servidor no han llegado',
  /circle\.tc-dnv\{fill:var\(--c-dnv,#B42318\)/.test(src));

// Cerrar sesión no deja los territorios de la cuenta anterior.
check('cerrar sesión vacía los territorios y las personas',
  /teamTerritories=\[\];teamUsers=\[\];/.test(take('signOut')),
  'si no, las tarjetas enseñarían los dueños de la cuenta anterior');

/* La tarjeta cuenta lo mismo que va a enseñar la lista. Paso Robles 3 decía
   "61 casas" y al tocarlo la lista enseñaba 36. */
const otp = take('openTerrPicker');
check('la tarjeta cuenta lo que va a enseñar la lista',
  /var seVe=function\(h\)\{return censusOn\|\|isOurLang\(h\);\};/.test(otp));
check('y las escondidas del censo se dicen aparte', /\+'\+d\.ocultas\+' del censo/.test(src));

// ══ cómo se ve, según quién mira ═══════════════════════════════════════
const ver = (kind, d, filtro) => {
  const c = {
    scope: { kind }, terrFilter: filtro || 'all',
    esc: s => String(s), fmtDate: s => s,
    miniMapHTML: () => '<svg class="tc-map"></svg>',
  };
  vm.createContext(c);
  vm.runInContext(take('terrCardHTML'), c);
  return c.terrCardHTML(d);
};
const conDueño = Object.assign({}, d, { polys: [] });
html = ver('admin', conDueño);
check('el administrador ve quién lo tiene', /Ilmy Barajas/.test(html));
check('y desde cuándo', /desde 2026-09-01/.test(html));
check('y si todavía no tiene límite dibujado', /Sin límite/.test(html));
html = ver('admin', Object.assign({}, d, { owner: null }));
check('uno sin dueño dice que está libre', /Libre/.test(html));
html = ver('holder', conDueño);
check('a un publicador no se le enseña el reparto', !/Ilmy Barajas/.test(html) && !/Libre/.test(html));
check('ni lo del límite, que no puede arreglar', !/Sin límite/.test(html));
check('pero sí cuántas casas faltan por ubicar', /2 sin ubicación/.test(html));
check('la tarjeta lleva data-terr: la escoge el mismo manejador de siempre',
  /data-terr="A4"/.test(html),
  'así hereda la pregunta de no perder un límite a medio dibujar');
check('la que se está viendo va marcada', / on"/.test(ver('admin', d, 'A4')));
check('y las demás no', !/ on"/.test(ver('admin', d, 'otro')));
check('marcada también para el lector de pantalla, no solo con el color',
  /aria-current="true"/.test(ver('admin', d, 'A4')) && !/aria-current/.test(ver('admin', d, 'otro')));

// ══ cuándo se ofrecen solas al entrar ══════════════════════════════════
const decide = cambios => {
  const abiertas = [];
  const c = Object.assign({
    entryPickDone: false, scope: { at: 1, kind: 'admin' },
    records: [{ HouseTerritoryNumber: 'A3' }, { HouseTerritoryNumber: 'A4' }],
    guestMode: false, simpleMode: false, needsAuth: false, me: { id: 'u1' },
    terrFilter: 'all', openSheets: [],
    terrMap() { const m = {}; c.records.forEach(h => { m[h.HouseTerritoryNumber] = 1; }); return m; },
    openTerrPicker(t) { abiertas.push(t); },
    // Sin memoria de esta salida: el caso de siempre. Lo recordado se prueba en test-recordar.js.
    terrMemoFresh: () => null,
  }, cambios);
  vm.createContext(c);
  vm.runInContext(take('maybeEntryPick'), c);
  c.maybeEntryPick();
  return { abrio: abiertas.length > 0, titulo: abiertas[0], hecho: c.entryPickDone };
};

let r = decide({});
check('el administrador con dos territorios las ve al entrar', r.abrio);
check('con la pregunta de entrada', r.titulo === '¿Qué territorio vas a trabajar?', r.titulo);
check('al invitado NO: trae sus números', !decide({ guestMode: true }).abrio);
check('a la versión sencilla NO: una pantalla más es un estorbo', !decide({ simpleMode: true }).abrio);
check('a quien solo tiene números sueltos NO', !decide({ scope: { at: 1, kind: 'numbers' } }).abrio);
check('a quien tiene UN solo territorio NO: no hay nada que escoger',
  !decide({ records: [{ HouseTerritoryNumber: 'A3' }] }).abrio);
check('las casas sin territorio no cuentan como un segundo territorio',
  !decide({ records: [{ HouseTerritoryNumber: 'A3' }, { HouseTerritoryNumber: 'Unassigned' }] }).abrio);
check('si ya escogió, NO', !decide({ terrFilter: 'A4' }).abrio);
check('si está haciendo otra cosa con una hoja abierta, NO', !decide({ openSheets: ['#sh-auth'] }).abrio);
/* En un teléfono recién estrenado las casas llegan después que los
   territorios: decidir en ese momento sería decidir con cero casas. */
r = decide({ records: [] });
check('sin las casas todavía, espera en vez de decidir', !r.abrio && !r.hecho,
  'se vuelve a preguntar al terminar la sincronización');
r = decide({ scope: { at: 0, kind: 'unknown' } });
check('sin saber quién es todavía, espera', !r.abrio && !r.hecho);
check('una vez decidido, no vuelve a salir en toda la apertura',
  !decide({ entryPickDone: true }).abrio);
check('se pregunta desde los dos sitios: al saber quién es y al tener las casas',
  /drawBounds\(\);refreshCoverage\(\);\s*maybeEntryPick\(\);/.test(src) &&
  /records=buildRecords\(\);[\s\S]{0,500}?renderHouses\(\);renderRV\(\);refreshMapPins\(\);buildTerrSub\(\);\s*maybeEntryPick\(\);/.test(src));

// ══ el botón de arriba y la hoja ═══════════════════════════════════════
/* openTerrPicker es manejador de clic de #scopeBtn: le llega el evento como
   primer argumento. Sin cuidado, el título de la hoja diría "[object
   MouseEvent]". */
check('abierta desde el botón de arriba, el título no es el evento del clic',
  /typeof titulo==="string"\?titulo:"Territorios"/.test(take('openTerrPicker')));
check('la tarjeta de "Todos" no se llama como un territorio',
  !/terrCardData\("all",scopeLabel\(\)/.test(src),
  'scopeLabel() devuelve el nombre del territorio a quien solo tiene uno');
check('"Sin territorio" va al final, no entre los de verdad',
  /if\(a==="Unassigned"\)return 1;/.test(take('openTerrPicker')));

// ══ escritorio y teléfono ══════════════════════════════════════════════
const esc = bloque('@media (min-width:1024px){');
check('en escritorio van en rejilla', /\.sheet\.wide \.tcards\{grid-template-columns:repeat\(auto-fill/.test(esc));
check('y la hoja se ensancha para ellas', /\.sheet\.wide\{max-width:/.test(esc));
check('la rejilla vive DENTRO del corte de escritorio que ya existía',
  (src.match(/@media \(min-width:\d+px\)/g) || []).join(',') === '@media (min-width:700px),@media (min-width:1024px)');
check('al cerrarse, la hoja vuelve a su ancho para lo demás',
  /if\(sel==="#sh-pick"\)s\.classList\.remove\("wide"\)/.test(take('closeSheet')),
  'la misma hoja la usan el correo, la contraseña y otras pantallas');
check('en teléfono, una sola columna', /\.tcards\{display:grid;grid-template-columns:1fr;/.test(src));
check('sin señal queda el fondo liso con el contorno y las casas',
  /\.tc-map\{[^}]*background:var\(--surface-2\)/.test(src));

console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
process.exit(fails ? 1 : 0);
