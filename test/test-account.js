/* El correo como usuario, y la version sencilla.

   Lo que mas importa aqui no es que lo nuevo funcione, sino que lo viejo no se
   rompa: las cuentas que ya existen tienen que poder seguir entrando, y la
   lista Users no puede haber crecido ni una columna.

   Corre los manejadores de verdad contra un almacen en memoria. */

const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const p = f => path.join(ROOT, 'api', f);

const DB = {};
let seq = 1;
const clone = o => JSON.parse(JSON.stringify(o));

function fakeStore() {
  return {
    backend: 'memory',
    async read(spec) { return (DB[spec.name] || []).map(clone); },
    async readFresh(spec) { return (DB[spec.name] || []).map(clone); },
    async create(spec, obj) {
      DB[spec.name] = DB[spec.name] || [];
      const rec = clone(obj); rec._key = 'k' + (seq++); DB[spec.name].push(rec);
    },
    async createMany(spec, objs) { for (const o of objs) await this.create(spec, o); },
    async update(spec, key, obj) {
      const rows = DB[spec.name] || [];
      const i = rows.findIndex(r => r._key === key);
      if (i !== -1) { const rec = clone(obj); rec._key = key; rows[i] = rec; }
    },
    async updateMany(spec, entries) { for (const e of entries) await this.update(spec, e.key, e.obj); },
    async remove(spec, keys) { DB[spec.name] = (DB[spec.name] || []).filter(r => keys.indexOf(r._key) === -1); },
  };
}
const storePath = require.resolve(p('_store.js'));
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true,
  exports: { makeStore: fakeStore, colLetter: () => 'A' } };

process.env.AUTH_SECRET = 'local-account-test-secret';
const { sign } = require(p('_auth.js'));
const PF = require(p('_prefs.js'));
const team = require(p('team.js'));

function call(handler, { method = 'POST', token = '', body = null } = {}) {
  return new Promise(resolve => {
    const req = { method, headers: token ? { authorization: 'Bearer ' + token } : {}, body: body || undefined, on() {} };
    const res = { _status: 200, setHeader() {}, status(s) { this._status = s; return this; },
      json(o) { resolve({ status: this._status, body: o }); return this; },
      end() { resolve({ status: this._status, body: null }); return this; } };
    handler(req, res);
  });
}
const T = (tok, action, payload) => call(team, { body: Object.assign({ action }, payload || {}), token: tok });

let fails = 0, checks = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && extra !== '' ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const now = Date.now();
const USERS_COLS = 12;

DB.Users = [];
DB.Houses = [];
DB.Assignments = [];

const tok = uid => sign({ uid, exp: now + 3600e3 });

(async () => {
  /* Las cuentas se crean por el camino de verdad, no a mano: inventar el hash
     de la contraseña seria probar mi suposicion, no la app. */
  let r = await T('', 'bootstrapAdmin', { name: 'Ada Admin', phone: '5551111', password: 'secreto1' });
  check('la primera cuenta ya no se crea sin correo', r.status === 400, JSON.stringify(r.body));
  r = await T('', 'bootstrapAdmin', { name: 'Ada Admin', phone: '5551111',
    email: 'ada@ejemplo.com', password: 'secreto1' });
  check('con correo, la primera cuenta queda lista', r.status === 200 && !!r.body.token,
    JSON.stringify(r.body).slice(0, 50));
  const ADMIN = r.body.token;
  DB.Territories = [{ name: 'T-1', ownerId: r.body.user.id, assigneeIds: '', working: '1', updatedAt: '', _key: 't1' }];

  // Una cuenta de las de antes: se le quita el correo, como las que ya existen.
  r = await T(ADMIN, 'createUser', { name: 'Hermano Antiguo', phone: '5552222' });
  const codeViejo = r.body.setupCode;
  await T('', 'redeemSetup', { setupCode: codeViejo, name: 'Hermano Antiguo',
    phone: '5552222', email: 'antiguo@ejemplo.com', password: 'secreto2' });
  DB.Users.find(u => u.name === 'Hermano Antiguo').email = '';

  // ══ nadie se queda fuera ═══════════════════════════════════════════════
  r = await T('', 'login', { login: 'ada@ejemplo.com', password: 'secreto1' });
  check('se entra con el correo', r.status === 200 && !!r.body.token, r.status);
  r = await T('', 'login', { login: 'Hermano Antiguo', password: 'secreto2' });
  check('una cuenta VIEJA sin correo sigue entrando con su nombre',
    r.status === 200 && !!r.body.token, JSON.stringify(r.body).slice(0, 60));
  r = await T('', 'login', { login: '5552222', password: 'secreto2' });
  check('y con su teléfono', r.status === 200 && !!r.body.token, r.status);
  r = await T('', 'login', { login: 'ada@ejemplo.com', password: 'no-es' });
  check('con la contraseña mala no entra', r.status === 401, r.status);

  // ══ el correo al crear una cuenta ══════════════════════════════════════
  r = await T(ADMIN, 'createUser', { name: 'Nuevo Uno', email: 'no-es-correo' });
  check('un correo mal escrito se rechaza al dar de alta', r.status === 400, JSON.stringify(r.body));
  r = await T(ADMIN, 'createUser', { name: 'Nuevo Uno', email: 'ada@ejemplo.com' });
  check('y un correo que ya es de otra cuenta también', r.status === 400, JSON.stringify(r.body));

  r = await T(ADMIN, 'createUser', { name: 'Nuevo Uno' });
  check('sin correo sí se da de alta: lo escribe la persona con su código',
    r.status === 200 && !!r.body.setupCode, JSON.stringify(r.body).slice(0, 60));
  const code = r.body.setupCode;

  r = await T('', 'redeemSetup', { setupCode: code, name: 'Nuevo Uno', password: 'contra123' });
  check('estrenar el código SIN correo se rechaza', r.status === 400, JSON.stringify(r.body));
  r = await T('', 'redeemSetup', { setupCode: code, name: 'Nuevo Uno',
    email: 'ada@ejemplo.com', password: 'contra123' });
  check('con un correo ya usado, también', r.status === 400, JSON.stringify(r.body));
  r = await T('', 'redeemSetup', { setupCode: code, name: 'Nuevo Uno',
    email: 'nuevo@ejemplo.com', password: 'contra123' });
  check('con un correo propio, la cuenta queda lista', r.status === 200 && !!r.body.token,
    JSON.stringify(r.body).slice(0, 60));
  r = await T('', 'login', { login: 'nuevo@ejemplo.com', password: 'contra123' });
  check('y esa persona entra con su correo', r.status === 200 && !!r.body.token, r.status);
  const NUEVO = r.body.token;
  const nuevoId = r.body.user.id;

  // ══ la versión sencilla ════════════════════════════════════════════════
  r = await T(NUEVO, 'listTerritories', {});
  check('de arranque, la app es la completa', r.body.me.simple === false, String(r.body.me.simple));
  check('y nadie se la dejó fija', r.body.me.locked === false, String(r.body.me.locked));

  r = await T(NUEVO, 'setMyMode', { simple: true });
  check('uno puede encenderse la versión sencilla', r.body.simple === true, JSON.stringify(r.body));
  r = await T(NUEVO, 'listTerritories', {});
  check('y el teléfono se entera al arrancar', r.body.me.simple === true, String(r.body.me.simple));
  r = await T(NUEVO, 'setMyMode', { simple: false });
  check('y puede regresar a la completa', r.body.simple === false, JSON.stringify(r.body));

  // ══ dejársela fija ═════════════════════════════════════════════════════
  r = await T(NUEVO, 'setUserMode', { userId: nuevoId, simple: true, locked: true });
  check('quien no es administrador no se la fija a nadie', r.status === 403, JSON.stringify(r.body));

  r = await T(ADMIN, 'setUserMode', { userId: nuevoId, simple: true, locked: true });
  check('el administrador sí', r.status === 200 && r.body.locked === true, JSON.stringify(r.body));
  r = await T(NUEVO, 'listTerritories', {});
  check('a esa persona le queda encendida', r.body.me.simple === true, String(r.body.me.simple));
  r = await T(NUEVO, 'setMyMode', { simple: false });
  check('y ya no puede apagarla sin querer', r.status === 403, JSON.stringify(r.body));
  r = await T(NUEVO, 'listTerritories', {});
  check('sigue encendida después del intento', r.body.me.simple === true, String(r.body.me.simple));

  r = await T(ADMIN, 'setUserMode', { userId: nuevoId, simple: true, locked: false });
  check('el administrador la puede soltar', r.body.locked === false, JSON.stringify(r.body));
  r = await T(NUEVO, 'setMyMode', { simple: false });
  check('y entonces sí se apaga', r.body.simple === false, JSON.stringify(r.body));

  // ══ se reemplaza, no se acumula ════════════════════════════════════════
  check('una persona tiene UN renglón de preferencias, no varios',
    (DB.UserPrefs || []).filter(x => x.userId === nuevoId).length === 1,
    (DB.UserPrefs || []).length);

  r = await T(ADMIN, 'setUserMode', { userId: 'no-existe', simple: true });
  check('no se le puede fijar a alguien que no existe', r.status === 404, JSON.stringify(r.body));

  // ══ la garantía que sostiene todo lo demás ═════════════════════════════
  const SC = require(p('_scope.js'));
  check('NO se agregó ninguna columna a Users: siguen ' + USERS_COLS,
    Object.keys(DB.Users[0]).filter(k => k !== '_key').length === USERS_COLS,
    Object.keys(DB.Users[0]).filter(k => k !== '_key').length);
  check('las preferencias viven en su propia lista',
    PF.PREFS_TAB.name === 'UserPrefs' && !!SC, PF.PREFS_TAB.name);

  console.log(`\n${fails === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : fails + ' of ' + checks + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
