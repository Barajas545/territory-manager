/* El idioma y el censo.

   La prueba que de verdad importa aqui es una sola: un domicilio SIN idioma
   escrito tiene que seguir viendose. Los domicilios que ya existen no tienen
   ese campo lleno, y si "vacio" contara como "no es de nosotros", la app se
   abriria con el territorio en blanco y el grupo se quedaria sin trabajo el
   domingo.

   Las funciones se sacan del propio index.html en vez de copiarlas, para que
   la prueba no pueda quedar verificando una version vieja de la verdad. */

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
  let j = src.indexOf('{', i), nivel = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') nivel++;
    else if (src[k] === '}' && --nivel === 0) return src.slice(i, k + 1);
  }
  throw new Error(name + ' quedó sin cerrar');
};

/* El contexto trae lo que esas funciones leen de afuera: el idioma de la
   congregación y la lista de los demás. Se declaran aquí igual que en la app,
   y si allá cambiaran sin cambiar aquí, las pruebas de canonLang lo dirían. */
const sandbox = {
  congLang: 'Español',
  esc: s => String(s),
  OTROS_IDIOMAS: ['Inglés', 'Mixteco', 'Señas Americano'],
  SIN_SABER: 'Sin saber',
};
vm.createContext(sandbox);
vm.runInContext([
  take('normLang'), take('isOurLang'), take('langTag'),
  take('langOptions'), take('canonLang'),
].join('\n'), sandbox);
const { normLang, isOurLang, langTag, langOptions, canonLang } = sandbox;

const casa = lang => ({ HouseLanguage: lang });

// ══ la regla que protege lo que ya existe ══════════════════════════════
check('SIN idioma escrito, el domicilio SE VE', isOurLang(casa('')) === true);
check('y tampoco se le pone etiqueta', langTag(casa('')) === '', langTag(casa('')));
check('un campo con solo espacios cuenta igual que vacío', isOurLang(casa('   ')) === true);
check('undefined tampoco lo esconde', isOurLang({}) === true);

// ══ el idioma del grupo, escrito de todas las formas ═══════════════════
['Español', 'español', 'ESPAÑOL', 'Espanol', 'espanol', '  Español  '].forEach(v => {
  check(`"${v}" cuenta como nuestro`, isOurLang(casa(v)) === true, isOurLang(casa(v)));
});

// ══ los demás se esconden de la vista de todos los días ════════════════
check('otro idioma NO es nuestro', isOurLang(casa('Inglés')) === false);
check('"Sin saber" tampoco', isOurLang(casa('Sin saber')) === false);
check('"sin saber" sin acentos ni mayúsculas, igual', isOurLang(casa('sin saber')) === false);

// ══ y se distinguen entre sí ═══════════════════════════════════════════
check('el censo se marca como "sin saber"',
  /sin saber/.test(langTag(casa('Sin saber'))), langTag(casa('Sin saber')));
check('y otro idioma se marca con su nombre',
  /Inglés/.test(langTag(casa('Inglés'))), langTag(casa('Inglés')));
check('son dos marcas distintas, no la misma',
  langTag(casa('Sin saber')) !== langTag(casa('Inglés')));

// ══ las tres marcas, y que no se confundan ════════════════════════════
check('el idioma del grupo SÍ lleva marca propia',
  /lang-ours/.test(langTag(casa('Español'))), langTag(casa('Español')));
check('y dice cuál es, no solo que es el nuestro',
  /Español/.test(langTag(casa('Español'))));
check('las tres marcas son distintas entre sí',
  new Set([langTag(casa('Español')), langTag(casa('Inglés')), langTag(casa('Sin saber'))]).size === 3);

// ══ el mismo idioma escrito de dos formas es UN idioma ════════════════
check('"ingles" se guarda como "Inglés"', canonLang('ingles') === 'Inglés', canonLang('ingles'));
check('"INGLÉS" también', canonLang('INGLÉS') === 'Inglés', canonLang('INGLÉS'));
check('"señas americano" se acomoda', canonLang('señas americano') === 'Señas Americano');
check('"espanol" cae en el idioma del grupo', canonLang('espanol') === 'Español');
check('un idioma que no está en la lista se respeta tal cual',
  canonLang('Zapoteco') === 'Zapoteco', canonLang('Zapoteco'));
check('y vacío sigue vacío', canonLang('   ') === '');

check('los idiomas ofrecidos empiezan por el de la congregación',
  langOptions()[0] === 'Español', langOptions().join(','));
check('y no repiten el del grupo más abajo',
  langOptions().filter(v => normLang(v) === normLang('Español')).length === 1);

// ══ si la congregación cambiara de idioma ══════════════════════════════
sandbox.congLang = 'Inglés';
check('con la congregación en inglés, el inglés pasa a ser el nuestro',
  isOurLang(casa('Inglés')) === true);
check('y el español pasa a ser el otro', isOurLang(casa('Español')) === false);
check('pero lo que no tiene idioma se sigue viendo', isOurLang(casa('')) === true);
sandbox.congLang = 'Español';

/* ══ TODOS los territorios preparados ══════════════════════════════════
   El bucle recorre el indice, no una lista escrita aqui: el dia que se agregue
   otro territorio queda revisado sin que nadie se acuerde de venir a añadirlo.
   Estas son las cosas que valen para cualquiera. */
const indice = JSON.parse(fs.readFileSync(path.join(ROOT, 'territorios/index.json'), 'utf8'));
check('el índice lista al menos un territorio', indice.territorios.length > 0);

indice.territorios.forEach(t => {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'territorios', t.file), 'utf8'));
  const hs = d.houses || [];
  const et = s => t.name + ': ' + s;
  check(et('el archivo trae domicilios'), hs.length > 0, hs.length);
  check(et('el nombre del índice coincide con el del archivo'),
    d.territory === t.name, d.territory);
  check(et('ninguna dirección viene vacía'), hs.every(h => /\S/.test(h.HouseAddress)));
  check(et('ninguna dirección se repite'),
    new Set(hs.map(h => h.HouseAddress.toLowerCase())).size === hs.length);
  check(et('toda dirección empieza por su número'),
    hs.every(h => /^\d/.test(h.HouseAddress)), hs.find(h => !/^\d/.test(h.HouseAddress)));
  check(et('todos llevan código postal de 5 dígitos'),
    hs.every(h => /^\d{5}$/.test(h.HouseZIP)));
  check(et('todos llevan ciudad y estado'),
    hs.every(h => h.HouseCity && /^[A-Z]{2}$/.test(h.HouseState)));
  check(et('todos caen en ESTE territorio'),
    hs.every(h => h.HouseTerritoryNumber === d.territory));
  check(et('todos llevan idioma anotado'), hs.every(h => /\S/.test(h.HouseLanguage)));
  const conDnv = hs.filter(h => h.dnv);
  check(et('cada No visitar trae razón y fecha bien formada'),
    conDnv.every(h => h.dnv.reason && /^\d{4}-\d{2}-\d{2}$/.test(h.dnv.date)),
    JSON.stringify(conDnv.map(h => h.dnv.date)));
  check(et('ninguna fecha de No visitar viene del futuro'),
    conDnv.every(h => h.dnv.date <= new Date().toISOString().slice(0, 10)));
});

// ══ Atascadero 4, lo que dice su hoja ═════════════════════════════════
const a4 = JSON.parse(fs.readFileSync(path.join(ROOT, 'territorios/atascadero-a4.json'), 'utf8')).houses;
check('A4 trae 18 domicilios', a4.length === 18, a4.length);
check('A4: los dos No visitar con sus fechas',
  a4.filter(h => h.dnv).map(h => h.dnv.date).sort().join(',') === '2018-07-23,2024-01-04',
  a4.filter(h => h.dnv).map(h => h.dnv.date).sort().join(','));
check('A4: el 9460 queda como departamento A',
  a4.some(h => h.HouseAddress === '9460 El Parque Ave #A'));
check('A4: la nota de la calle rural bajó a sus dos domicilios',
  a4.filter(h => /Los Altos/.test(h.HouseAddress)).every(h => h.HouseNotes === 'Rural'));
check('A4: el de Colorado Rd avisa que queda fuera del mapa',
  /fuera del área marcada/i.test(a4.find(h => /Colorado/.test(h.HouseAddress)).HouseNotes));
check('A4: todo es de Atascadero 93422',
  a4.every(h => h.HouseCity === 'Atascadero' && h.HouseZIP === '93422'));

// ══ el territorio que se va a importar ═════════════════════════════════
const terr = JSON.parse(fs.readFileSync(path.join(ROOT, 'territorios/paso-robles-3.json'), 'utf8'));
const casas = terr.houses;
check('Paso Robles 3 trae 61 domicilios', casas.length === 61, casas.length);
check('36 en el idioma de la congregación',
  casas.filter(h => isOurLang(h)).length === 36, casas.filter(h => isOurLang(h)).length);
check('25 para el censo',
  casas.filter(h => normLang(h.HouseLanguage) === 'sin saber').length === 25);
check('todos llevan el código postal de Paso Robles',
  casas.every(h => h.HouseZIP === '93446'));
check('todos llevan ciudad y estado',
  casas.every(h => h.HouseCity === 'Paso Robles' && h.HouseState === 'CA'));
check('ninguna dirección viene vacía', casas.every(h => /\S/.test(h.HouseAddress)));
check('no hay direcciones repetidas',
  new Set(casas.map(h => h.HouseAddress.toLowerCase())).size === casas.length);

// Los cinco edificios, completos de 1 a 8.
['1225', '1227', '1275', '1277', '1279'].forEach(num => {
  const units = casas.filter(h => h.HouseAddress.startsWith(num + ' Stoney Creek Rd #'))
    .map(h => +h.HouseAddress.split('#')[1]).sort((a, b) => a - b);
  check(`el edificio ${num} queda del 1 al 8`,
    units.join(',') === '1,2,3,4,5,6,7,8', units.join(','));
});

// Los cuatro "No visitar", con su fecha.
const dnv = casas.filter(h => h.dnv);
check('cuatro domicilios con No visitar', dnv.length === 4, dnv.length);
check('cada uno con su razón y su fecha',
  dnv.every(h => h.dnv.reason && /^\d{4}-\d{2}-\d{2}$/.test(h.dnv.date)),
  JSON.stringify(dnv.map(h => h.dnv.date)));
check('el de 1275 #5 guarda la fecha de la hoja',
  casas.find(h => h.HouseAddress === '1275 Stoney Creek Rd #5').dnv.date === '2026-03-07');
check('y el de Bel Air 2183 la suya',
  casas.find(h => h.HouseAddress === '2183 Bel Air Pl').dnv.date === '2025-03-31');

// El 1131 iba una sola vez.
check('1131 Stoney Creek queda una sola vez',
  casas.filter(h => h.HouseAddress === '1131 Stoney Creek Rd').length === 1);

console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
process.exit(fails ? 1 : 0);
