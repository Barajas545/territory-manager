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

const sandbox = { congLang: 'Español', esc: s => String(s) };
vm.createContext(sandbox);
vm.runInContext(take('normLang') + '\n' + take('isOurLang') + '\n' + take('langTag'), sandbox);
const { normLang, isOurLang, langTag } = sandbox;

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

// ══ si la congregación cambiara de idioma ══════════════════════════════
sandbox.congLang = 'Inglés';
check('con la congregación en inglés, el inglés pasa a ser el nuestro',
  isOurLang(casa('Inglés')) === true);
check('y el español pasa a ser el otro', isOurLang(casa('Español')) === false);
check('pero lo que no tiene idioma se sigue viendo', isOurLang(casa('')) === true);
sandbox.congLang = 'Español';

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
