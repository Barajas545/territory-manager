/* Shared session verification.
   Underscore-prefixed, so Vercel treats it as a module rather than a route. */

const crypto = require('crypto');

/* Prefer an explicit AUTH_SECRET; otherwise derive one from the service-account
   key so the app works without a second manual setup step. Both are server-side
   only. Must match the value used to sign in api/team.js. */
function secret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const k = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');
  return crypto.createHash('sha256')
    .update('tm-auth|' + (k.private_key_id || '') + '|' + (k.client_email || ''))
    .digest('hex');
}

const b64u = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + mac;
}

function verify(token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, mac] = token.split('.');
  const expect = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  // Constant-time compare: an early-exit compare leaks the signature byte by byte.
  const a = Buffer.from(mac || ''), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(unb64u(body).toString('utf8')); } catch (e) { return null; }
  if (!p || !p.exp || Date.now() > p.exp) return null;
  return p;
}

/* Pull the session out of a request, or null. */
function claimsFrom(req) {
  const raw = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  return verify(raw);
}

module.exports = { secret, sign, verify, claimsFrom, b64u, unb64u };
