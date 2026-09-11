/* Las cuentas de los pedazos del mapa, contra valores conocidos.
   Si esto esta mal, se descarga el mapa equivocado sin que nadie se entere. */

function tileX(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
function tileY(lat, z) {
  var r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}

let fails = 0, checks = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

// Valores que cualquiera puede verificar en el wiki de OSM.
check('z=0 solo tiene un pedazo', tileX(0, 0) === 0 && tileY(0, 0) === 0);
check('z=1, el meridiano cae en x=1', tileX(0, 1) === 1, tileX(0, 1));
check('z=1, el ecuador cae en y=1', tileY(0, 1) === 1, tileY(0, 1));
check('Greenwich, z=10 → x=512', tileX(0, 10) === 512, tileX(0, 10));

/* Atascadero. Comprobado contra la conversion inversa: el pedazo que sale
   tiene que CONTENER el punto de donde salio. */
const lat = 35.4890, lng = -120.6700;
for (const z of [13, 14, 15, 16, 17, 18]) {
  const x = tileX(lng, z), y = tileY(lat, z);
  const m = Math.pow(2, z);
  const oesteDeg = x / m * 360 - 180;
  const esteDeg = (x + 1) / m * 360 - 180;
  const norte = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / m))) * 180 / Math.PI;
  const sur = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / m))) * 180 / Math.PI;
  check(`z=${z}: el pedazo contiene el punto`,
    lng >= oesteDeg && lng < esteDeg && lat <= norte && lat > sur,
    `x=${x} y=${y}`);
}

/* Cuantos pedazos saldrian de verdad. El territorio real del grupo mide como
   3 km de lado; se mide eso, no un caso inventado. */
function tilesNeeded(pts) {
  let minLat = pts[0].lat, maxLat = pts[0].lat, minLng = pts[0].lng, maxLng = pts[0].lng;
  pts.forEach(q => {
    if (q.lat < minLat) minLat = q.lat; if (q.lat > maxLat) maxLat = q.lat;
    if (q.lng < minLng) minLng = q.lng; if (q.lng > maxLng) maxLng = q.lng;
  });
  const pad = 0.004;
  minLat -= pad; maxLat += pad; minLng -= pad; maxLng += pad;
  const set = new Set();
  const add = (z, x, y) => { const m = Math.pow(2, z); if (x >= 0 && y >= 0 && x < m && y < m) set.add(z + '/' + x + '/' + y); };
  for (let z = 13; z <= 17; z++) {
    const x0 = tileX(minLng, z) - 1, x1 = tileX(maxLng, z) + 1;
    const y0 = tileY(maxLat, z) - 1, y1 = tileY(minLat, z) + 1;
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) add(z, i, j);
  }
  for (let z = 18; z <= 18; z++) {
    pts.forEach(q => {
      const cx = tileX(q.lng, z), cy = tileY(q.lat, z);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) add(z, cx + i, cy + j);
    });
  }
  return set.size;
}

// 45 domicilios repartidos en un cuadro de ~3 km, como el territorio de verdad.
const reales = [];
for (let i = 0; i < 45; i++) {
  reales.push({ lat: 35.480 + (i % 7) * 0.0045, lng: -120.680 + Math.floor(i / 7) * 0.0060 });
}
const total = tilesNeeded(reales);
console.log(`\n45 domicilios en ~3 km → ${total} pedazos, como ${(total * 14 / 1024).toFixed(1)} MB`);
check('cabe de sobra bajo el tope de 2500', total < 2500, total);
check('y no es un numero absurdo de pedir', total > 40 && total < 1200, total);

// Un solo domicilio: el caso chico no debe bajar medio pais.
const uno = tilesNeeded([{ lat: 35.489, lng: -120.670 }]);
console.log(`1 domicilio → ${uno} pedazos`);
check('un solo domicilio baja poquito', uno < 120, uno);

console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
process.exit(fails ? 1 : 0);
