/* Qué dirección se le entrega al navegador.

   Esto existe por un error concreto: la linea decia

       var q = h.HouseGPSCoordinates || fullAddr(h);

   y como casi todos los domicilios tienen coordenadas, al navegador nunca le
   llegaba la direccion — le llegaba un par de numeros. En el carro eso pinta
   un alfiler sin calle, y quien maneja no puede confirmar que sea la casa.

   Se prueban las funciones tal como estan escritas en index.html: se extraen
   del archivo, no se copian aqui, para que la prueba no pueda quedar
   verificando una version vieja de la verdad. */

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

// Sacar del archivo las dos funciones que deciden el destino.
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
/* Se cuentan las llaves en vez de usar una expresion: una de las dos funciones
   cabe en un renglon y la otra no, y un patron que sirviera para las dos seria
   mas fragil que contar. */
const take = name => {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('no se encontró ' + name + ' en index.html');
  let j = src.indexOf('{', i), nivel = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') nivel++;
    else if (src[k] === '}' && --nivel === 0) return src.slice(i, k + 1);
  }
  throw new Error(name + ' quedó sin cerrar');
};
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(take('fullAddr') + '\n' + take('navTarget'), sandbox);
const { fullAddr, navTarget } = sandbox;

const casa = (o) => Object.assign({
  HouseAddress: '', HouseCity: '', HouseState: '', HouseZIP: '', HouseGPSCoordinates: '',
}, o);

// ── el codigo postal viaja ───────────────────────────────────────────────
const completa = casa({
  HouseAddress: '6440 Ardilla Rd #1', HouseCity: 'Atascadero',
  HouseState: 'CA', HouseZIP: '93422', HouseGPSCoordinates: '35.4890,-120.6700',
});
check('la dirección incluye el código postal',
  /93422/.test(navTarget(completa)), navTarget(completa));
check('y la calle con su número',
  /6440 Ardilla Rd #1/.test(navTarget(completa)), navTarget(completa));
check('y la ciudad y el estado',
  /Atascadero/.test(navTarget(completa)) && /CA/.test(navTarget(completa)));

// ── el error que se vino a corregir ──────────────────────────────────────
check('NO se mandan las coordenadas cuando hay dirección',
  navTarget(completa).indexOf('35.489') === -1, navTarget(completa));
check('el destino es legible para quien maneja',
  navTarget(completa) === '6440 Ardilla Rd #1, Atascadero, CA, 93422',
  navTarget(completa));

// ── pero sin dirección, las coordenadas salvan el viaje ──────────────────
const soloGps = casa({ HouseGPSCoordinates: '35.4916,-120.6674' });
check('sin dirección escrita, se usan las coordenadas',
  navTarget(soloGps) === '35.4916,-120.6674', navTarget(soloGps));

// ── domicilios a medias: se manda lo que haya, sin huecos ────────────────
const sinZip = casa({ HouseAddress: '7860 Atascadero Ave', HouseCity: 'Atascadero', HouseState: 'CA' });
check('sin código postal se manda igual, sin comas de sobra',
  navTarget(sinZip) === '7860 Atascadero Ave, Atascadero, CA', navTarget(sinZip));
const soloCalle = casa({ HouseAddress: '7860 Atascadero Ave' });
check('con solo la calle, se manda la calle', navTarget(soloCalle) === '7860 Atascadero Ave');

// ── un domicilio vacío no debe mandar nada ───────────────────────────────
check('un domicilio sin nada no manda un destino falso', navTarget(casa({})) === '',
  JSON.stringify(navTarget(casa({}))));

// ── lo que se le entrega al Tesla ────────────────────────────────────────
/* La app del Tesla lee la direccion de lo que se le comparte. Si ahi fuera un
   par de coordenadas, el carro llevaria a un alfiler sin nombre. */
const paraElCarro = navTarget(completa);
check('lo que recibe el carro es una dirección postal, no coordenadas',
  /^\d+ .+, .+, [A-Z]{2}, \d{5}$/.test(paraElCarro), paraElCarro);

console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
process.exit(fails ? 1 : 0);
