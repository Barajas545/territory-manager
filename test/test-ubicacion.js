/* Dónde están las casas en el mapa.

   Esta suite nace de algo concreto: dos territorios se capturaron desde una
   hoja de papel que solo traía direcciones, así que sus 79 domicilios no tienen
   coordenadas. En el mapa no aparecía ni un alfiler, y al cambiar de territorio
   el mapa ni se movía — fitPins solo juntaba coordenadas de casas, y sin
   ninguna no llamaba a fitBounds.

   Peor: el aviso decía "✓ Todas las casas quedan dentro" sobre 18 casas que no
   están en el mapa. Una casa sin coordenadas no puede caer FUERA de un
   polígono, así que contaba como si estuviera dentro. Dar por cubierto lo que
   no se ha mirado es la peor clase de error que puede tener esta pantalla: el
   mapa existe justamente para ver qué falta.

   Las funciones se sacan del propio index.html en vez de copiarlas, para que
   la prueba no pueda quedar verificando una versión vieja de la verdad. */

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

/* Una casa con coordenadas y otra sin ellas: el caso entero cabe en eso. */
const conGPS = (terr, lat, lng) =>
  ({ id: 'c' + lat, HouseTerritoryNumber: terr, HouseGPSCoordinates: lat + ', ' + lng });
const sinGPS = (terr, n) =>
  ({ id: 's' + n, HouseTerritoryNumber: terr, HouseGPSCoordinates: '' });

// ══ EL ENCUADRE ════════════════════════════════════════════════════════
const CONTORNO = [[35.50, -120.68], [35.50, -120.66], [35.48, -120.66], [35.48, -120.68]];

function cajaFit(estado) {
  const encuadres = [];
  const caja = {
    mapReady: true, RV_TERR: '__rv__',
    terrFilter: estado.terrFilter,
    records: estado.records,
    teamTerritories: estado.teamTerritories || [],
    inTerrFilter: h => caja.terrFilter === 'all' ||
      (h.HouseTerritoryNumber || 'Unassigned') === caja.terrFilter,
    parseGPS: v => {
      if (!v) return null;
      const p = String(v).split(',').map(s => parseFloat(s.trim()));
      return p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]) ? { lat: p[0], lng: p[1] } : null;
    },
    boundsFor: name => (caja.teamTerritories.find(t => t.name === name) || {}).bounds || [],
    map: { fitBounds(pts, opts) { encuadres.push({ pts, opts }); } },
  };
  vm.createContext(caja);
  vm.runInContext(take('fitPins') + '\n' + take('housesUnplaced'), caja);
  return { caja, encuadres };
}

/* EL CASO DEL USUARIO: un territorio capturado de una hoja de papel. Ni una
   sola coordenada, pero sí un límite marcado — que es lo único que dice dónde
   queda. Antes de esto el mapa no se movía ni un píxel. */
let { caja, encuadres } = cajaFit({
  terrFilter: 'Atascadero 4',
  records: [sinGPS('Atascadero 4', 1), sinGPS('Atascadero 4', 2)],
  teamTerritories: [{ name: 'Atascadero 4', bounds: CONTORNO }],
});
caja.fitPins();
check('un territorio SIN coordenadas pero CON límite sí encuadra el mapa',
  encuadres.length === 1, encuadres.length);
check('y encuadra sobre el contorno marcado',
  encuadres.length === 1 && encuadres[0].pts.length === 4, encuadres.length && encuadres[0].pts.length);

// Sin coordenadas y sin límite no hay nada que mirar: no se mueve el mapa.
({ caja, encuadres } = cajaFit({
  terrFilter: 'Atascadero 4',
  records: [sinGPS('Atascadero 4', 1)],
  teamTerritories: [{ name: 'Atascadero 4', bounds: [] }],
}));
caja.fitPins();
check('sin coordenadas y sin límite NO se mueve el mapa a ningún lado',
  encuadres.length === 0, 'llamadas a fitBounds: ' + encuadres.length);

// Con las dos cosas, el encuadre las abarca a las dos.
({ caja, encuadres } = cajaFit({
  terrFilter: 'Atascadero 4',
  records: [conGPS('Atascadero 4', 35.49, -120.67), sinGPS('Atascadero 4', 1)],
  teamTerritories: [{ name: 'Atascadero 4', bounds: CONTORNO }],
}));
caja.fitPins();
check('con casas Y límite, el encuadre abarca las dos cosas',
  encuadres[0].pts.length === 5, encuadres[0].pts.length);

// El territorio del vecino no arrastra el encuadre.
({ caja, encuadres } = cajaFit({
  terrFilter: 'Atascadero 4',
  records: [conGPS('Atascadero 4', 35.49, -120.67), conGPS('Paso Robles 3', 35.62, -120.69)],
  teamTerritories: [
    { name: 'Atascadero 4', bounds: CONTORNO },
    { name: 'Paso Robles 3', bounds: [[35.63, -120.70], [35.63, -120.68], [35.61, -120.68]] }],
}));
caja.fitPins();
check('el territorio de al lado NO entra en el encuadre',
  encuadres[0].pts.length === 5, encuadres[0].pts.length);

// "Todos los territorios": el mapa completo, incluidos los que solo tienen contorno.
({ caja, encuadres } = cajaFit({
  terrFilter: 'all',
  records: [conGPS('Atascadero 4', 35.49, -120.67)],
  teamTerritories: [
    { name: 'Atascadero 4', bounds: CONTORNO },
    { name: 'Paso Robles 3', bounds: [[35.63, -120.70], [35.63, -120.68], [35.61, -120.68]] }],
}));
caja.fitPins();
check('"Todos los territorios" abarca todos los contornos',
  encuadres[0].pts.length === 8, encuadres[0].pts.length);

// Mis Revisitas no es un territorio con contorno.
({ caja, encuadres } = cajaFit({
  terrFilter: '__rv__',
  records: [conGPS('Atascadero 4', 35.49, -120.67)],
  teamTerritories: [{ name: 'Atascadero 4', bounds: CONTORNO }],
}));
caja.fitPins();
check('Mis Revisitas no arrastra el contorno de ningún territorio',
  encuadres.length === 0 || encuadres[0].pts.length === 0,
  encuadres.length ? encuadres[0].pts.length : 0);

// ══ CUÁLES NO ESTÁN EN EL MAPA ═════════════════════════════════════════
({ caja } = cajaFit({
  terrFilter: 'Atascadero 4',
  records: [conGPS('Atascadero 4', 35.49, -120.67), sinGPS('Atascadero 4', 1),
    sinGPS('Atascadero 4', 2), sinGPS('Paso Robles 3', 3)],
  teamTerritories: [],
}));
check('cuenta las casas de ESTE territorio que no están en el mapa',
  caja.housesUnplaced().length === 2, caja.housesUnplaced().length);
caja.terrFilter = 'all';
check('y con todos los territorios, todas las que faltan',
  caja.housesUnplaced().length === 3, caja.housesUnplaced().length);

// ══ EL AVISO NO PUEDE DAR POR CUBIERTO LO QUE NO SE HA MIRADO ══════════
function cajaChip(estado) {
  const chip = {
    textContent: '', onclick: null, _c: new Set(),
    classList: {
      add(c) { chip._c.add(c); }, remove(c) { chip._c.delete(c); },
      contains: c => chip._c.has(c),
    },
  };
  const caja = {
    $: () => chip,
    records: estado.records,
    drawing: estado.drawing || null,
    scope: { kind: 'admin' },
    terrFilter: estado.terrFilter || 'all',
    RV_TERR: '__rv__',
    housesOutside: () => estado.fuera || [],
    inTerrFilter: h => caja.terrFilter === 'all' ||
      (h.HouseTerritoryNumber || 'Unassigned') === caja.terrFilter,
    parseGPS: v => {
      if (!v) return null;
      const p = String(v).split(',').map(s => parseFloat(s.trim()));
      return p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]) ? { lat: p[0], lng: p[1] } : null;
    },
    inPoly: (lat, lng, poly) => {
      let dentro = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
        if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) dentro = !dentro;
      }
      return dentro;
    },
    map: { fitBounds() {} },
  };
  vm.createContext(caja);
  vm.runInContext(take('housesUnplaced') + '\n' + take('refreshCoverage'), caja);
  return { caja, chip };
}

/* EL AVISO QUE MENTÍA. 18 casas sin una sola coordenada, y el letrero salía en
   verde diciendo que todas quedaban dentro del límite. */
let r = cajaChip({
  terrFilter: 'Atascadero 4',
  records: [sinGPS('Atascadero 4', 1), sinGPS('Atascadero 4', 2)],
  drawing: { terr: 'Atascadero 4', points: CONTORNO },
});
r.caja.refreshCoverage();
check('con casas sin ubicación, el aviso NO dice que están todas dentro',
  !/Todas las casas quedan dentro/.test(r.chip.textContent), r.chip.textContent);
check('dice cuántas faltan por ubicar', /2 casas sin ubicación/.test(r.chip.textContent),
  r.chip.textContent);
check('y NO se pinta de verde', !r.chip.classList.contains('ok'));

// Con todas ubicadas y todas dentro, el verde sí se lo ha ganado.
r = cajaChip({
  terrFilter: 'Atascadero 4',
  records: [conGPS('Atascadero 4', 35.49, -120.67)],
  drawing: { terr: 'Atascadero 4', points: CONTORNO },
});
r.caja.refreshCoverage();
check('con todas ubicadas y dentro, sí dice que están todas dentro',
  /Todas las casas quedan dentro/.test(r.chip.textContent), r.chip.textContent);
check('y ahí sí se pinta de verde', r.chip.classList.contains('ok'));

// Una fuera del límite manda sobre las que faltan por ubicar: es lo accionable.
r = cajaChip({
  terrFilter: 'Atascadero 4',
  records: [conGPS('Atascadero 4', 35.60, -120.90), sinGPS('Atascadero 4', 1)],
  drawing: { terr: 'Atascadero 4', points: CONTORNO },
});
r.caja.refreshCoverage();
check('una casa fuera del límite manda sobre las que faltan por ubicar',
  /queda fuera/.test(r.chip.textContent), r.chip.textContent);

// Menos de tres puntos no es una figura: no hay nada que evaluar todavía.
r = cajaChip({
  terrFilter: 'Atascadero 4',
  records: [sinGPS('Atascadero 4', 1)],
  drawing: { terr: 'Atascadero 4', points: [[35.49, -120.67]] },
});
r.caja.refreshCoverage();
check('con un solo punto el aviso se calla', !r.chip.classList.contains('on'));

/* Y fuera del modo de marcar: el aviso es lo único que explica por qué el mapa
   se ve vacío. */
r = cajaChip({
  terrFilter: 'Atascadero 4',
  records: [sinGPS('Atascadero 4', 1), sinGPS('Atascadero 4', 2), sinGPS('Atascadero 4', 3)],
});
r.caja.refreshCoverage();
check('sin marcar límites, el aviso explica por qué el mapa se ve vacío',
  /3 casas sin ubicación en el mapa/.test(r.chip.textContent), r.chip.textContent);
check('y está encendido para que se vea', r.chip.classList.contains('on'));

// Con todo ubicado y nada fuera, no hay nada que decir.
r = cajaChip({
  terrFilter: 'Atascadero 4',
  records: [conGPS('Atascadero 4', 35.49, -120.67)],
});
r.caja.refreshCoverage();
check('con todo en su sitio, el aviso se apaga', !r.chip.classList.contains('on'));

// Lo de siempre manda: una casa fuera de los límites se sigue avisando primero.
r = cajaChip({
  terrFilter: 'Atascadero 4',
  records: [sinGPS('Atascadero 4', 1)],
  fuera: [conGPS('Atascadero 4', 35.60, -120.90)],
});
r.caja.refreshCoverage();
check('una casa fuera de los límites se sigue avisando antes que nada',
  /fuera de los límites/.test(r.chip.textContent), r.chip.textContent);

/* ══ BUSCAR DONDE QUEDA UNA DIRECCION ═══════════════════════════════════
   Las respuestas de abajo NO estan inventadas: son las que devolvio de verdad
   el servicio al probarlo con direcciones de la hoja de Atascadero y de Paso
   Robles. */
const geo = {
  normLang: v => String(v || '').trim().toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n'),
  parseGPS: v => {
    if (!v) return null;
    const p = String(v).split(',').map(x => parseFloat(x.trim()));
    return p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]) &&
      Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 ? { lat: p[0], lng: p[1] } : null;
  },
};
vm.createContext(geo);
vm.runInContext([take('geoKey'), take('calleNorm'), take('geoAceptar')].join('\n'), geo);

const casa = (dir, zip) => ({ HouseAddress: dir, HouseCity: 'Atascadero',
  HouseState: 'CA', HouseZIP: zip || '93422' });

// ── el edificio se busca una vez y vale para sus ocho departamentos ────
check('el número de departamento no se le pregunta al servicio',
  geo.geoKey({ HouseAddress: '1225 Stoney Creek Rd #4', HouseCity: 'Paso Robles',
    HouseState: 'CA', HouseZIP: '93446' }) ===
  geo.geoKey({ HouseAddress: '1225 Stoney Creek Rd #8', HouseCity: 'Paso Robles',
    HouseState: 'CA', HouseZIP: '93446' }),
  'los ocho departamentos están en el mismo sitio: una búsqueda, no ocho');
check('dos edificios distintos NO comparten búsqueda',
  geo.geoKey(casa('1225 Stoney Creek Rd')) !== geo.geoKey(casa('1227 Stoney Creek Rd')));
check('una dirección sin número no se busca',
  geo.geoKey(casa('Traila atrás de la casa')) === '',
  'sin número no hay nada que verificar, y verificar es lo único que protege');

// ── St y Street son la misma calle ────────────────────────────────────
check('"Cason St" y "Cason Street" son la misma calle',
  geo.calleNorm('8980 Cason St') === geo.calleNorm('Cason Street'));
check('"San Andres Ave" y "San Andres Avenue" también',
  geo.calleNorm('8550 San Andres Ave') === geo.calleNorm('San Andres Avenue'));
check('"Stoney Creek Rd" y "Stoney Creek Road" también',
  geo.calleNorm('1225 Stoney Creek Rd') === geo.calleNorm('Stoney Creek Road'));
check('pero dos calles distintas NO se confunden',
  geo.calleNorm('8550 San Andres Ave') !== geo.calleNorm('Cason Street'));
check('y "El Camino Real" no pierde su nombre',
  geo.calleNorm('7905 El Camino Real') === 'el camino real',
  geo.calleNorm('7905 El Camino Real'));

// ── la respuesta buena, tal cual la devolvió el servicio ──────────────
const BUENA = { lat: '35.4802258', lon: '-120.6619043', addresstype: 'building',
  address: { house_number: '8550', road: 'San Andres Avenue', city: 'Atascadero',
    postcode: '93422' } };
let g = geo.geoAceptar(casa('8550 San Andres Ave'), BUENA);
check('una dirección que coincide en todo se acepta', !!g);
check('y con las coordenadas que devolvió',
  g && Math.abs(g.lat - 35.4802258) < 1e-6 && Math.abs(g.lng + 120.6619043) < 1e-6);

/* ── EL CASO PELIGROSO ──────────────────────────────────────────────────
   "99999 San Andres Ave": la calle existe, el número no. El servicio contesta
   con el CENTRO DE LA CALLE — tipo "road", sin número de casa. Aceptarlo
   dejaría la casa a cuadras de donde es. */
const CENTRO_DE_CALLE = { lat: '35.4831', lon: '-120.6647', addresstype: 'road',
  address: { road: 'San Andres Avenue', city: 'Atascadero', postcode: '93422' } };
check('el CENTRO DE LA CALLE se rechaza: no trae número de casa',
  geo.geoAceptar(casa('99999 San Andres Ave'), CENTRO_DE_CALLE) === null,
  'es la regla que impide dejar una casa a cuadras de donde es');

// ── el número que no es el nuestro ────────────────────────────────────
check('un número distinto al nuestro se rechaza',
  geo.geoAceptar(casa('8555 San Andres Ave'), BUENA) === null);

// ── la calle que se llama igual en otro pueblo ────────────────────────
const OTRO_PUEBLO = { lat: '35.6052', lon: '-120.6584', addresstype: 'building',
  address: { house_number: '8550', road: 'San Andres Avenue', city: 'Paso Robles',
    postcode: '93446' } };
check('el mismo número y la misma calle en otro código postal se rechaza',
  geo.geoAceptar(casa('8550 San Andres Ave'), OTRO_PUEBLO) === null,
  'por aquí hay calles que se llaman igual en dos pueblos');

// ── otra calle con nuestro número ─────────────────────────────────────
const OTRA_CALLE = { lat: '35.4687', lon: '-120.6549', addresstype: 'building',
  address: { house_number: '8550', road: 'Cason Street', city: 'Atascadero',
    postcode: '93422' } };
check('nuestro número pero en otra calle se rechaza',
  geo.geoAceptar(casa('8550 San Andres Ave'), OTRA_CALLE) === null);

// ── el pueblo que contesta ────────────────────────────────────────────
const OTRO_PUEBLO_MISMO_CP = { lat: '35.60', lon: '-120.65', addresstype: 'building',
  address: { house_number: '8550', road: 'San Andres Avenue', city: 'Templeton',
    postcode: '93422' } };
check('si contesta otro pueblo se rechaza',
  geo.geoAceptar(casa('8550 San Andres Ave'), OTRO_PUEBLO_MISMO_CP) === null);
const SIN_PUEBLO = { lat: '35.4600143', lon: '-120.7121562', addresstype: 'building',
  address: { house_number: '13925', road: 'Los Altos Road', postcode: '93422' } };
check('pero una dirección rural sin pueblo NO se rechaza por eso',
  !!geo.geoAceptar(casa('13925 Los Altos Rd'), SIN_PUEBLO),
  'venir sin pueblo no la hace sospechosa');

// ── un edificio de departamentos: el servicio lo llama "place", no "building"
const EDIFICIO = { lat: '35.6052983', lon: '-120.6584806', addresstype: 'place',
  address: { house_number: '1227', road: 'Stoney Creek Road', city: 'Paso Robles',
    postcode: '93446' } };
check('un edificio de departamentos se acepta aunque no lo llamen "building"',
  !!geo.geoAceptar({ HouseAddress: '1227 Stoney Creek Rd #6', HouseCity: 'Paso Robles',
    HouseState: 'CA', HouseZIP: '93446' }, EDIFICIO),
  'filtrar por tipo "building" habría dejado fuera los cinco edificios de Paso Robles');

// ── basura y silencio ─────────────────────────────────────────────────
check('sin respuesta, la casa se queda sin ubicar',
  geo.geoAceptar(casa('8550 San Andres Ave'), null) === null);
check('coordenadas que no son números se rechazan',
  geo.geoAceptar(casa('8550 San Andres Ave'),
    { lat: 'x', lon: 'y', address: { house_number: '8550', road: 'San Andres Avenue',
      postcode: '93422' } }) === null);
check('una latitud imposible se rechaza',
  geo.geoAceptar(casa('8550 San Andres Ave'),
    { lat: '999', lon: '-120.66', address: { house_number: '8550',
      road: 'San Andres Avenue', postcode: '93422' } }) === null);

// ── lo que ya está confirmado no se toca ──────────────────────────────
check('solo se buscan las casas SIN coordenadas',
  /housesUnplaced\(\)/.test(take('locateHouses')),
  'una coordenada tomada parado frente a la casa vale más que cualquier búsqueda');
check('se dice en voz alta que las direcciones salen a OpenStreetMap',
  /se envían a OpenStreetMap/.test(src),
  'es dato del grupo saliendo a un servicio de fuera: se pregunta antes');
check('y se respeta el ritmo que pide el servicio',
  /setTimeout\(paso,1300\)/.test(src));

console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
process.exit(fails ? 1 : 0);
