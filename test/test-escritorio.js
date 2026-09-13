/* La versión de escritorio, para quien administra.

   Esta prueba existe por tres fallos que ya ocurrieron una vez, y que en el
   teléfono no se ven nunca:

   1. El mapa de la pantalla partida salía INVISIBLE. El mapa no se apaga con
      display como las demás vistas —se queda montado para que Leaflet no se
      reinicie y pierda mosaicos— sino con visibility. Al partir la pantalla se
      le devolvió el display, que nunca le habían quitado, y no la visibilidad.
      Resultado: 810 px de nada al lado de la lista, con los mosaicos cargados.

   2. La lista en dos columnas crecía HACIA UN LADO. Las columnas de CSS dentro
      de algo que se desplaza no parten la lista y siguen hacia abajo: van
      creando columnas de lado. Con 9 domicilios no se notaba; con 60 la lista
      medía 3386 px de ancho y el desplazamiento vertical dejaba de servir.

   3. Al invitado le quedaba una franja muerta de 212 px. Se le esconde la barra
      de pestañas entera, pero la rejilla seguía apartándole el sitio.

   Y la regla que protege a todo el grupo: el teléfono no se toca. Todo lo de
   escritorio vive dentro de una media query, y aquí se comprueba que así sea. */

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

/* Saca un bloque contando llaves, para no depender de dónde termina. */
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

const esc = bloque('@media (min-width:1024px){');

// ══ 1. el mapa de la pantalla partida tiene que VERSE ══════════════════
check('la pantalla partida le devuelve la visibilidad al mapa',
  /body\.split\s+#view-map\{[^}]*visibility:visible/.test(esc));
check('y también los punteros, para poder arrastrarlo',
  /body\.split\s+#view-map\{[^}]*pointer-events:auto/.test(esc));
check('el mapa sigue montado cuando no es la vista activa',
  /#view-map\{display:flex;visibility:hidden/.test(src),
  'si se apagara con display, Leaflet se reiniciaría y perdería los mosaicos');

// ══ 2. la lista se queda en UNA columna ═══════════════════════════
/* Se intentó repartirla en dos de dos maneras y las dos salieron mal. Aquí
   quedan cerradas las dos puertas. La segunda hace más falta que la primera:
   no se ve en el navegador hasta que uno mide la altura de un renglón. */
check('NADA de column-count: crecía hacia un lado y mataba el desplazamiento',
  !/column-count\s*:/.test(src), (src.match(/column-count\s*:[^;]*/) || [''])[0]);
check('la lista NO es rejilla: encogía cada renglón a su min-height',
  !/#houseList\{[^}]*display:grid/.test(esc),
  (esc.match(/#houseList\{[^}]*/) || [''])[0]);
check('sigue siendo una lista normal que se desplaza hacia abajo',
  /\.scroller\{flex:1;overflow-y:auto/.test(src));
check('y un renglón solo pide un mínimo, para crecer con lo que traiga',
  /\.house\{[\s\S]{0,140}min-height:62px/.test(src));

// ══ 3. al invitado no se le aparta sitio para una barra que no tiene ═══
check('sin barra de pestañas, la rejilla es de una sola columna',
  /body\.guest\s+#app\{grid-template-columns:1fr/.test(esc));
check('y las vistas empiezan en la orilla',
  /body\.guest\s+#views\{grid-column:1/.test(esc));
check('el invitado sí tiene la barra escondida',
  /body\.guest\s+#tabbar,/.test(src));

// ══ la forma de escritorio ═════════════════════════════════════════════
check('la app suelta el ancho de teléfono',
  /#app\{max-width:none/.test(esc));
check('la barra de pestañas se pone de lado',
  /#tabbar\{flex-direction:column/.test(esc));
check('con renglones que se alcanzan con el ratón',
  /\.tab\{[^}]*height:44px/.test(esc));
check('la lista y el mapa comparten la pantalla',
  /body\.split\s+#views\{display:grid;grid-template-columns:/.test(esc));
check('la lista tiene un mínimo para no quedar angosta',
  /minmax\(400px,34%\)/.test(esc));
check('sin pantalla partida la lista se queda centrada',
  /body:not\(\.split\)\s+#houseList\{max-width:900px;margin-inline:auto/.test(esc));
check('un solo corte de tamaño para escritorio, no dos',
  (src.match(/@media \(min-width:\d+px\)/g) || []).join(',') ===
    '@media (min-width:700px),@media (min-width:1024px)',
  (src.match(/@media \(min-width:\d+px\)/g) || []).join(','));

// ══ las hojas dejan de ser gesto de teléfono ═══════════════════════════
check('las hojas se centran a lo alto y a lo ancho',
  /\.sheet\{[^}]*left:50%;top:50%;bottom:auto/.test(esc));
check('y abren en el centro exacto',
  /\.sheet\.open\{transform:translate\(-50%,-50%\)/.test(esc));
check('sin la barrita de arrastrar',
  /\.sheet\s+\.grab\{display:none/.test(esc));

// ══ EL TELÉFONO NO SE TOCA ═════════════════════════════════════════════
check('la hoja de teléfono sigue subiendo desde abajo',
  /\.sheet\{\s*position:fixed;left:0;right:0;bottom:0/.test(src));
check('y sigue entrando con translateY',
  /transform:translateY\(101%\)/.test(src));
check('la barra de pestañas sigue siendo de altura fija por defecto',
  /#tabbar\{/.test(src) && !/^\s*#tabbar\{flex-direction:column/m.test(src.slice(0, src.indexOf(esc))));
check('el ancho de teléfono de 700px sigue en su sitio',
  /@media \(min-width:700px\)/.test(src));
check('todo lo de escritorio vive dentro de la media query',
  esc.includes('body.split') && !src.slice(0, src.indexOf(esc)).includes('body.split'));

// ══ quién ve la pantalla partida ═══════════════════════════════════════
const take = name => {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('no se encontró ' + name);
  let nivel = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') nivel++;
    else if (src[k] === '}' && --nivel === 0) return src.slice(i, k + 1);
  }
  throw new Error(name + ' quedó sin cerrar');
};

const clases = new Set();
const caja = {
  guestMode: false, simpleMode: false, scope: { kind: 'admin' }, ancho: 1440,
  initMap() { caja.mapaIniciado = true; },
  setTimeout(f) { f(); },
  map: { invalidateSize() { caja.remedido = true; } },
  window: { matchMedia: q => ({ matches: caja.ancho >= +q.match(/\d+/)[0] }) },
  document: {
    body: {
      classList: {
        toggle(c, on) { on ? clases.add(c) : clases.delete(c); },
        contains: c => clases.has(c),
      },
    },
  },
};
vm.createContext(caja);
vm.runInContext([take('deskSplit'), take('applySplit')].join('\n'), caja);
const { deskSplit, applySplit } = caja;

const escenario = (cambios) => {
  Object.assign(caja, { guestMode: false, simpleMode: false, ancho: 1440 });
  caja.scope = { kind: 'admin' };
  Object.assign(caja, cambios);
};

escenario({});
check('el administrador en computadora SÍ ve la pantalla partida', deskSplit() === true);
escenario({ ancho: 1023 });
check('en un teléfono NO, aunque sea administrador', deskSplit() === false);
escenario({ guestMode: true });
check('el invitado NO', deskSplit() === false);
escenario({ simpleMode: true });
check('la versión simplificada NO', deskSplit() === false,
  'media pantalla de mapa le quitaría la mitad de los domicilios de la vista');
escenario({ scope: { kind: 'holder' } });
check('quien solo sale a tocar puertas NO', deskSplit() === false);
escenario({ scope: { kind: 'none' } });
check('sin territorio asignado tampoco', deskSplit() === false);

// ══ y en qué pestaña ═══════════════════════════════════════════════════
escenario({});
applySplit('houses');
check('Territorio parte la pantalla', clases.has('split'));
check('y le avisa al mapa que cambió de tamaño', caja.remedido === true,
  'si no, Leaflet dibuja con el tamaño que tenía escondido y corta los mosaicos');
applySplit('map');
check('Mapa se queda con el mapa SOLO, a todo lo ancho', !clases.has('split'),
  'los límites se dibujan vértice por vértice: ahí cada pixel cuenta');
applySplit('rv');
check('Mis Revisitas no parte la pantalla', !clases.has('split'));
applySplit('more');
check('Opciones tampoco', !clases.has('split'));
applySplit('houses');
check('y al volver a Territorio regresa', clases.has('split'));
escenario({ ancho: 1023 });
applySplit('houses');
check('al angostar la ventana la partida se quita sola', !clases.has('split'));

check('la ventana avisa cuando cambia de tamaño',
  /addEventListener\("resize",function\(\)\{[\s\S]{0,120}applySplit/.test(src));
check('y se vuelve a mirar cuando se sabe quién es el usuario',
  /El reparto depende de si es administrador/.test(src));

console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
process.exit(fails ? 1 : 0);
