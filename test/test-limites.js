/* Marcar límites de territorio con un ratón.

   El fallo que justifica esta suite entera: UN CLIC SOBRE UN VÉRTICE LO
   BORRABA. Leaflet no considera arrastre nada menor a 3 px (el clickTolerance
   de su Draggable), así que correr un vértice dos píxeles para cuadrarlo con la
   esquina de la calle —que es exactamente para lo que sirve un ratón— no
   disparaba dragstart ni drag: al soltar salía un clic y el punto desaparecía,
   sin aviso. Con el dedo nunca se ve, porque con el dedo nunca se mueve menos
   de 3 px.

   Aquí se amarran las dos mitades: con ratón el clic ELIGE, y con dedo el toque
   sigue borrando exactamente como antes. Si alguien un día simplifica ese
   `if(finePointer())`, esta suite lo detiene.

   Y se amarra la guardia del teclado, que es donde un atajo se convierte en
   estropicio: Ctrl+Z mientras se escribe en la casilla de búsqueda —que en
   pantalla partida está a la vista al mismo tiempo que el mapa— tiene que
   deshacer el TEXTO, nunca el límite. */

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

const bloque = (desde) => {
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

// ══ el ratón se reconoce por el puntero, no por el ancho ═══════════════
const raton = bloque('@media (hover:hover) and (pointer:fine){');
check('hay un bloque que pregunta por el puntero, no por el ancho',
  raton.length > 0);
check('y NO lleva min-width, que rompería la prueba del corte único',
  !/min-width/.test(raton));
check('la prueba de JS pregunta lo mismo que el CSS',
  /matchMedia\("\(hover:hover\) and \(pointer:fine\)"\)/.test(take('finePointer')));

// ══ la cruz del teléfono se retira cuando hay ratón ════════════════════
/* El botón "＋ Poner punto aquí" no solo sobraba: era un blanco de 168x40 en el
   centro EXACTO del mapa que atrapaba el clic y ponía el vértice en el centro,
   hasta 70 px de donde se había apuntado. */
check('con ratón se esconden la cruz y el botón ＋',
  /#xhair\.on,#xhairAdd\.on\{display:none/.test(raton));
check('pero siguen existiendo para el dedo',
  /#xhair\.on\{display:block/.test(src) && /#xhairAdd\.on\{display:block/.test(src));

// ══ señas que antes no existían ════════════════════════════════════════
check('el cursor dice que se arrastra, no que se hace clic',
  /#map\.drawing \.leaflet-marker-icon\{cursor:grab/.test(raton));
check('y al arrastrar cambia',
  /cursor:grabbing/.test(raton));
check('el vértice crece al pasarle el puntero',
  /\.bv-h:hover\{transform:scale/.test(raton));
check('y el punto de en medio enseña en qué se va a convertir',
  /\.bm-h:hover\{transform:scale/.test(raton));
check('el vértice elegido lleva aro propio',
  /\.bv-h\.sel\{box-shadow/.test(raton));
check('las teclas se dibujan en la barra',
  /\.db-s kbd\{/.test(raton));

// ══ la barra deja libre el mapa ════════════════════════════════════════
const esc = bloque('@media (min-width:1024px){');
check('la barra de marcar deja de cruzar el mapa',
  /#drawBar\{left:10px;right:auto;width:\d+px/.test(esc),
  (esc.match(/#drawBar\{[^}]*/) || [''])[0]);
check('y sus botones dejan de estirarse a un tercio de pantalla',
  /#drawBar button\{flex:1 1 auto/.test(esc));

// ══ los pines dejan de robarse el clic ═════════════════════════════════
check('los pines de casa llevan clase propia',
  /L\.divIcon\(\{className:"house-pin"/.test(src));
check('y mientras se marca no atrapan el clic',
  /body\.drawing \.house-pin\{pointer-events:none/.test(src));
check('la regla NO se escribe sobre .leaflet-marker-icon',
  !/body\.drawing \.leaflet-marker-icon\{pointer-events:none/.test(src),
  'los tiradores del límite son marker-icons y quedarían muertos');
check('un globo abierto se cierra al entrar a marcar',
  /map\.closePopup\(\)/.test(take('startDrawBounds')),
  'si no, se queda una tarjeta encima comiéndose los clics del editor');

// ══ entrar a marcar NO le mueve el mapa a nadie ════════════════════════
/* Elegir el territorio ya llama fitPins, así que el mapa viene puesto; y
   reencuadrar de todas formas le arrancaba el mapa al hermano que acaba de
   acercarse a mano a la esquina donde está parado. */
check('marcar no reencuadra el mapa por su cuenta',
  !/fitBounds/.test(take('startDrawBounds')),
  (take('startDrawBounds').match(/fitBounds[^;]*/) || [''])[0]);

// ══ un doble clic no deja dos vértices ═════════════════════════════════
check('dos puntos muy juntos y muy seguidos cuentan como uno',
  /ultPtXY\.distanceTo\(xy\)<12/.test(src) && /t-ultPtT<400/.test(src));

// ══ el vecino, como guía ═══════════════════════════════════════════════
check('mientras se marca, el límite vecino se pinta de rayas',
  /dashArray:guia\?/.test(take('drawBounds')));
check('y sin relleno, para poder dibujar pegado a él',
  /fillOpacity:guia\?0:/.test(take('drawBounds')));

// ══ el clic: con ratón elige, con dedo borra ═══════════════════════════
const pv = take('paintVertices');
check('la bifurcación existe y pregunta por el puntero',
  /if\(finePointer\(\)\)\{[\s\S]{0,120}selVertex=/.test(pv));
check('con dedo se sigue llamando a quitar el vértice',
  /removeVertex\(i\)/.test(pv));
check('el clic que cierra un arrastre no cuenta',
  /if\(arrastrado\)return;/.test(pv));
check('y la bandera se reinicia al APRETAR, no por reloj',
  /m\.on\("mousedown",function\(\)\{arrastrado=false;\}\)/.test(pv),
  'mousedown siempre llega antes que cualquier clic');
check('clic derecho quita el vértice',
  /m\.on\("contextmenu"/.test(pv) && /removeVertex\(i\)/.test(pv));
check('el elegido fuera de rango se limpia al repintar',
  /if\(selVertex!==null&&\(selVertex<0\|\|selVertex>=pts\.length\)\)selVertex=null/.test(pv));

// ══ el teclado, corriendo de verdad ════════════════════════════════════
const llamadas = [];
const caja = {
  drawing: null, openSheets: [], selVertex: null, mapReady: true,
  paintDraw() { llamadas.push('paintDraw'); },
  saveBounds() { llamadas.push('saveBounds'); },
  histUndo() { llamadas.push('histUndo'); },
  removeVertex(i) { llamadas.push('removeVertex:' + i); },
  nudgeVertex(dx, dy) { llamadas.push('nudge:' + dx + ',' + dy); },
  cancelDrawBounds() { llamadas.push('cancelDrawBounds'); return true; },
  $: () => ({ disabled: caja.guardarApagado }),
  guardarApagado: false,
  window: { matchMedia: () => ({ matches: true }) },
};
vm.createContext(caja);
vm.runInContext(take('onDrawKey'), caja);
const { onDrawKey } = caja;

const tecla = (k, extra) => {
  llamadas.length = 0;
  const e = Object.assign({
    key: k, target: { tagName: 'BODY' }, ctrlKey: false, metaKey: false,
    shiftKey: false, altKey: false,
    preventDefault() { llamadas.push('preventDefault'); },
    stopPropagation() { llamadas.push('stopPropagation'); },
  }, extra || {});
  onDrawKey(e);
  return llamadas.slice();
};

caja.drawing = null;
check('sin dibujo abierto no existe ni un atajo', tecla('Escape').length === 0);

caja.drawing = { terr: 'A3', points: [[1, 1], [2, 2], [3, 3]], hist: [1] };
caja.openSheets = ['#sh-detail'];
check('con una hoja abierta el editor no toca nada',
  tecla('Escape').length === 0, 'la hoja manda, y Escape la cierra');
caja.openSheets = [];

/* La casilla de búsqueda está a la vista al mismo tiempo que el mapa en
   pantalla partida: ahí Ctrl+Z y Supr son del texto, no del límite. */
['INPUT', 'TEXTAREA', 'SELECT'].forEach(tn => {
  check(`escribiendo en ${tn}, Ctrl+Z NO deshace el límite`,
    tecla('z', { ctrlKey: true, target: { tagName: tn } }).length === 0);
});
check('ni en algo editable a mano',
  tecla('z', { ctrlKey: true, target: { tagName: 'DIV', isContentEditable: true } }).length === 0);
check('y Supr tampoco borra un vértice mientras se escribe',
  tecla('Delete', { target: { tagName: 'INPUT' } }).length === 0);

caja.selVertex = 1;
check('Esc primero suelta el vértice elegido',
  tecla('Escape').indexOf('paintDraw') !== -1 && caja.selVertex === null);
check('y recién el segundo Esc sale del editor',
  tecla('Escape').indexOf('cancelDrawBounds') !== -1);

check('Ctrl+Z deshace', tecla('z', { ctrlKey: true }).indexOf('histUndo') !== -1);
check('Cmd+Z también, para una Mac', tecla('z', { metaKey: true }).indexOf('histUndo') !== -1);
check('Ctrl+Shift+Z NO deshace (está reservado para rehacer)',
  tecla('z', { ctrlKey: true, shiftKey: true }).indexOf('histUndo') === -1);

check('Enter guarda', tecla('Enter').indexOf('saveBounds') !== -1);
caja.guardarApagado = true;
check('pero no cuando Guardar está apagado (menos de 3 puntos)',
  tecla('Enter').indexOf('saveBounds') === -1);
caja.guardarApagado = false;
check('y un botón con el foco se activa solo, sin doble guardado',
  tecla('Enter', { target: { tagName: 'BUTTON' } }).length === 0);

caja.selVertex = 2;
check('Supr quita el vértice elegido',
  tecla('Delete').indexOf('removeVertex:2') !== -1);
check('Retroceso igual, y sin navegar hacia atrás',
  tecla('Backspace').indexOf('preventDefault') !== -1);

check('las flechas empujan el vértice elegido',
  tecla('ArrowRight').indexOf('nudge:1,0') !== -1);
check('con Shift empujan diez veces más',
  tecla('ArrowUp', { shiftKey: true }).indexOf('nudge:0,-10') !== -1);
caja.selVertex = null;
/* Sin vértice elegido las flechas son de Leaflet: desplazan el mapa. Si aquí se
   llamara preventDefault, el mapa dejaría de moverse con el teclado. */
check('SIN vértice elegido las flechas se dejan pasar a Leaflet',
  tecla('ArrowRight').length === 0, 'si no, el mapa deja de desplazarse con el teclado');

check('el manejador se registra en fase de CAPTURA',
  /addEventListener\("keydown",onDrawKey,true\)/.test(src),
  'Leaflet se queda las flechas con stopPropagation; en burbuja no llegaría ninguna');

// ══ quitar un vértice ══════════════════════════════════════════════════
const caja2 = {
  drawing: { points: [[1, 1], [2, 2], [3, 3]], hist: [] },
  selVertex: 2, histPush() { caja2.empujado = true; }, repaintSoon() {},
};
vm.createContext(caja2);
vm.runInContext(take('removeVertex'), caja2);
caja2.removeVertex(1);
check('quitar un vértice lo saca de la lista', caja2.drawing.points.length === 2);
check('guarda un paso para deshacer antes', caja2.empujado === true);
check('y suelta la elección, porque los índices se corrieron', caja2.selVertex === null);
caja2.removeVertex(9);
check('un índice imposible no hace nada', caja2.drawing.points.length === 2);
caja2.removeVertex(null);
check('y null tampoco', caja2.drawing.points.length === 2);

// ══ cancelar avisa si de verdad salió ══════════════════════════════════
const caja3 = {
  drawing: { hist: [1] }, endDrawBounds() { caja3.salio = true; },
  confirm: () => false,
};
vm.createContext(caja3);
vm.runInContext(take('cancelDrawBounds'), caja3);
check('si el usuario se arrepiente, cancelar devuelve false',
  caja3.cancelDrawBounds() === false && !caja3.salio);
caja3.confirm = () => true;
check('y si acepta, sale y devuelve true',
  caja3.cancelDrawBounds() === true && caja3.salio === true);
const caja4 = { drawing: { hist: [] }, endDrawBounds() { caja4.salio = true; },
  confirm() { caja4.pregunto = true; return true; } };
vm.createContext(caja4);
vm.runInContext(take('cancelDrawBounds'), caja4);
caja4.cancelDrawBounds();
check('sin nada que perder no pregunta nada', !caja4.pregunto && caja4.salio);

check('cambiar de territorio con el dibujo abierto cierra el editor primero',
  /if\(drawing&&!cancelDrawBounds\(\)\)return;/.test(src),
  'antes el mapa se iba al otro territorio y el límite se guardaba en el viejo');

// ══ el contador en vivo ════════════════════════════════════════════════
const rc = take('refreshCoverage');
check('mientras se marca, el aviso cuenta las casas de ESE territorio',
  /HouseTerritoryNumber\|\|"Unassigned"\)===drawing\.terr/.test(rc),
  (rc.match(/HouseTerritoryNumber[^;]*/) || [''])[0]);
check('y NO usa inTerrFilter, que filtra también por idioma',
  !/inTerrFilter/.test(rc),
  'el número se movería solo al prender el censo');
check('con menos de 3 puntos no hay figura que evaluar, y el aviso se calla',
  /drawing\.points\.length<3/.test(rc),
  'si no, gritaría "faltan 47 casas" antes del primer clic');
check('cuando ya no falta ninguna lo dice en verde',
  /chip\.classList\.add\("ok"\)/.test(rc) && /#coverChip\.ok\{/.test(src));

// ══ EL TELÉFONO NO SE TOCA ═════════════════════════════════════════════
check('el texto de dedo sigue palabra por palabra',
  /toca uno para quitarlo · toca un punto chico para insertar/.test(src));
check('y el de la cruz también',
  /Centra la cruz en una esquina y toca ＋/.test(src));
check('el texto de ratón es otra rama, no un reemplazo',
  /fino\?"Haz clic en el mapa para poner cada esquina\."/.test(src));

console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
process.exit(fails ? 1 : 0);
