import * as oidc from 'openid-client';
import { setupSchoolProfile } from './school-profile.mjs';
import { createRemoteJWKSet, jwtVerify, customFetch as joseFetch } from 'jose';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const hash = (s) => createHash('sha256').update(s).digest('hex');
const local = (u) => ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
export function validateConfig(c) {
 const origin = new URL(c.origin);
 if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
  throw new Error('APP_ORIGIN invalide');
 if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local(origin)))
  throw new Error('HTTPS requis');
 if (c.issuer) {
  const issuer = new URL(c.issuer);
  if (
   issuer.search ||
   issuer.hash ||
   issuer.username ||
   issuer.password ||
   (issuer.protocol !== 'https:' &&
    !(issuer.protocol === 'http:' && local(issuer) && local(origin)))
  )
   throw new Error('OIDC_ISSUER invalide');
  if (!c.secret || !/^[a-f0-9]{64}$/i.test(c.tokenKey))
   throw new Error('Secret OIDC ou SESSION_KEY manquant');
 }
 if (!local(origin) && !c.issuer) throw new Error('Comptes partagés requis hors du mode local');
 if (!local(origin) && !c.secure) throw new Error('Cookies sécurisés requis');
}
export function seal(value, key) {
 const iv = randomBytes(12),
  cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv),
  body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
 return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function unseal(value, key) {
 const raw = Buffer.from(value, 'base64url'),
  cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), raw.subarray(0, 12));
 cipher.setAuthTag(raw.subarray(12, 28));
 return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8');
}
export function setupAuth(app, db, c) {
 validateConfig(c);
 const cookie = `atelier_${c.slug.replaceAll('-', '_')}`,
  flowCookie = cookie + '_flow';
 const opts = { httpOnly: true, secure: c.secure, sameSite: 'lax', path: '/' };
 let cached;
 const now = () => Date.now();
 const fetcher = async (input, options = {}) => {
  const u = new URL(input),
   base = new URL(c.issuer);
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname + '/'))
   throw new Error('Fournisseur inattendu');
  const target = c.internal ? new URL(u.pathname + u.search, c.internal) : u;
  return fetch(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
 };
 async function config() {
  if (cached && cached.until > now()) return cached;
  const issuer = new URL(c.issuer),
   execute = [oidc.enableNonRepudiationChecks];
  if (issuer.protocol === 'http:') execute.push(oidc.allowInsecureRequests);
  const client = await oidc.discovery(
   issuer,
   c.slug,
   { client_secret: c.secret, id_token_signed_response_alg: 'RS256' },
   oidc.ClientSecretPost(c.secret),
   { execute, [oidc.customFetch]: fetcher, timeout: 10 }
  );
  const meta = client.serverMetadata();
  for (const k of [
   'authorization_endpoint',
   'token_endpoint',
   'jwks_uri',
   'end_session_endpoint'
  ]) {
   const u = new URL(meta[k]);
   if (u.origin !== issuer.origin || !u.pathname.startsWith(issuer.pathname + '/'))
    throw new Error('Fournisseur inattendu');
  }
  cached = {
   client,
   meta,
   jwks: createRemoteJWKSet(new URL(meta.jwks_uri), {
    [joseFetch]: fetcher,
    timeoutDuration: 10000
   }),
   until: now() + 300000
  };
  return cached;
 }
 app.use((req, res, next) => {
  const token = req.cookies[cookie];
  if (token) {
   const row = db
    .prepare('SELECT * FROM sessions WHERE hash=? AND expires>?')
    .get(hash(token), now());
   if (row) req.user = row;
  }
  next();
 });
 const schoolProfile = setupSchoolProfile(app, db, c, { config, fetcher, seal, unseal });
 const error = (res, code) => {
  res.clearCookie(flowCookie, opts);
  return res.redirect(303, '/?auth_error=' + code);
 };
 app.get('/auth/login', async (req, res) => {
  if (!c.issuer) return error(res, 'configuration');
  try {
   const { client } = await config(),
    state = oidc.randomState(),
    nonce = oidc.randomNonce(),
    verifier = oidc.randomPKCECodeVerifier(),
    browser = randomBytes(32).toString('base64url');
   db.prepare('DELETE FROM flows WHERE expires<?').run(now());
   if (db.prepare('SELECT count(*) n FROM flows').get().n > 300) return error(res, 'unavailable');
   db
    .prepare('INSERT INTO flows VALUES(?,?,?,?,?)')
    .run(hash(state), hash(browser), verifier, nonce, now() + 600000);
   const url = oidc.buildAuthorizationUrl(client, {
    redirect_uri: c.origin + '/auth/callback',
    scope: 'openid profile',
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    max_age: '43200',
    ui_locales: 'fr'
   });
   res.cookie(flowCookie, browser, { ...opts, maxAge: 600000 });
   res.redirect(303, url.href);
  } catch {
   return error(res, 'unavailable');
  }
 });
 app.get('/auth/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '',
   browser = req.cookies[flowCookie];
  if (!state || state.length > 256 || !browser) return error(res, 'invalid');
  const f = db
   .prepare('SELECT * FROM flows WHERE hash=? AND browser=? AND expires>?')
   .get(hash(state), hash(browser), now());
  if (!f) return error(res, 'invalid');
  db.prepare('DELETE FROM flows WHERE hash=?').run(hash(state));
  if (req.query.error) return error(res, 'cancelled');
  try {
   const { client } = await config(),
    url = new URL(req.originalUrl, c.origin),
    tokens = await oidc.authorizationCodeGrant(client, url, {
     pkceCodeVerifier: f.verifier,
     expectedState: state,
     expectedNonce: f.nonce,
     idTokenExpected: true,
     maxAge: 43200
    });
   const claims = tokens.claims();
   if (
    !claims ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 255 ||
    !Number.isFinite(claims.auth_time) ||
    claims.auth_time > now() / 1000 + 30 ||
    claims.auth_time < now() / 1000 - 43200 ||
    (claims.azp && claims.azp !== c.slug)
   )
    throw new Error('Identité invalide');
   const subject = hash(c.issuer + '|' + claims.sub),
    token = randomBytes(32).toString('base64url'),
    expires = Math.min(now() + 43200000, (claims.auth_time + 43200) * 1000);
   const sessionHash = hash(token);
   db.exec('BEGIN IMMEDIATE');
   try {
    db
     .prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)')
     .run(
      sessionHash,
      subject,
      String(claims.given_name || claims.preferred_username || 'Compte atelier').slice(0, 80),
      expires,
      seal(tokens.id_token, c.tokenKey),
      String(claims.sid || '').slice(0, 255)
     );
    schoolProfile.save(sessionHash, tokens);
    db.exec('COMMIT');
   } catch (error) {
    db.exec('ROLLBACK');
    throw error;
   }
   res.clearCookie(flowCookie, opts);
   res.cookie(cookie, token, { ...opts, maxAge: expires - now() });
   res.redirect(303, '/');
  } catch {
   return error(res, 'invalid');
  }
 });
 app.get('/auth/account', (req, res) =>
  c.issuer ? res.redirect(303, c.issuer + '/account/') : error(res, 'configuration')
 );
 app.post('/auth/logout', async (req, res) => {
  const session = req.user;
  let target = '/';
  if (session) {
   db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);
   if (c.issuer)
    try {
     const { client } = await config();
     target = oidc.buildEndSessionUrl(client, {
      id_token_hint: unseal(session.id_token, c.tokenKey),
      post_logout_redirect_uri: c.origin + '/',
      ui_locales: 'fr'
     }).href;
    } catch {
     target = '/?auth_error=logout';
    }
  }
  res.clearCookie(cookie, opts);
  res.redirect(303, target);
 });
 app.post('/auth/backchannel-logout', async (req, res) => {
  if (!c.issuer) return res.sendStatus(404);
  try {
   const raw = req.body?.logout_token;
   if (typeof raw !== 'string' || raw.length > 16000) throw new Error();
   const { jwks } = await config(),
    { payload: p } = await jwtVerify(raw, jwks, {
     issuer: c.issuer,
     audience: c.slug,
     algorithms: ['RS256'],
     clockTolerance: 30
    });
   if (
    typeof p.jti !== 'string' ||
    !p.jti ||
    p.jti.length > 255 ||
    !Number.isFinite(p.iat) ||
    Math.abs(now() / 1000 - p.iat) > 300 ||
    p.nonce !== undefined ||
    (!p.sid && !p.sub) ||
    JSON.stringify(p.events?.['http://schemas.openid.net/event/backchannel-logout']) !== '{}'
   )
    throw new Error();
   db.prepare('DELETE FROM replays WHERE expires<?').run(now());
   db.prepare('INSERT INTO replays VALUES(?,?)').run(p.jti, now() + 600000);
   if (p.sub && p.sid)
    db
     .prepare('DELETE FROM sessions WHERE subject=? AND sid=?')
     .run(hash(c.issuer + '|' + p.sub), p.sid);
   else if (p.sub)
    db.prepare('DELETE FROM sessions WHERE subject=?').run(hash(c.issuer + '|' + p.sub));
   else db.prepare('DELETE FROM sessions WHERE sid=?').run(p.sid);
   return res.sendStatus(204);
  } catch {
   return res.sendStatus(400);
  }
 });
 return { cookie, config };
}
