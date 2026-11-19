import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { openDatabase } from '../server/db.mjs';
import { validateConfig, seal, unseal } from '../server/oidc.mjs';
const secret = 'local-test-secret',
 tokenKey = randomBytes(32).toString('hex');
let provider, server, base, issuer, db, keys, appConfig, meta;
const codes = new Map();
let finishGeneration;
const listen = (app) =>
 new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
 });
const cookie = (res) => res.headers.getSetCookie().map((s) => s.split(';')[0]);
async function signed(payload, aud = meta.slug) {
 return new SignJWT(payload)
  .setProtectedHeader({ alg: 'RS256', kid: 'education-test' })
  .setIssuer(issuer)
  .setAudience(aud)
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(keys.privateKey);
}
before(async () => {
 keys = await generateKeyPair('RS256');
 const jwk = await exportJWK(keys.publicKey);
 const p = express();
 p.use(express.urlencoded({ extended: false }));
 p.get('/realms/comptes/.well-known/openid-configuration', (req, res) =>
  res.json({
   issuer,
   authorization_endpoint: issuer + '/protocol/openid-connect/auth',
   token_endpoint: issuer + '/protocol/openid-connect/token',
   jwks_uri: issuer + '/protocol/openid-connect/certs',
   end_session_endpoint: issuer + '/protocol/openid-connect/logout',
   response_types_supported: ['code'],
   subject_types_supported: ['public'],
   id_token_signing_alg_values_supported: ['RS256'],
   token_endpoint_auth_methods_supported: ['client_secret_post'],
   code_challenge_methods_supported: ['S256']
  })
 );
 p.get('/realms/comptes/protocol/openid-connect/certs', (req, res) =>
  res.json({ keys: [{ ...jwk, kid: 'education-test', alg: 'RS256', use: 'sig' }] })
 );
 p.post('/realms/comptes/protocol/openid-connect/token', async (req, res) => {
  const flow = codes.get(req.body.code);
  if (!flow || req.body.client_secret !== secret) return res.sendStatus(400);
  codes.delete(req.body.code);
  res.json({
   access_token: 'access',
   token_type: 'Bearer',
   expires_in: 300,
   id_token: await signed({
    sub: flow.sub,
    nonce: flow.nonce,
    auth_time: Math.floor(Date.now() / 1000),
    preferred_username: flow.sub,
    sid: 'sid-' + flow.sub
   })
  });
 });
 provider = await listen(p);
 issuer = `http://127.0.0.1:${provider.address().port}/realms/comptes`;
 db = openDatabase(':memory:');
 const instance = createApp({
  db,
  origin: 'http://127.0.0.1:8102',
  issuer,
  secret,
  tokenKey,
  secure: false,
  internal: '',
  generateText: (words, { onProgress, signal }) =>
   new Promise((resolve, reject) => {
    signal?.addEventListener(
     'abort',
     () => reject(Object.assign(new Error('cancelled'), { publicMessage: 'Création annulée.' })),
     { once: true }
    );
    onProgress('Le chemin traverse la forêt et les enfants écoutent les oiseaux.');
    finishGeneration = () =>
     resolve({
      title: 'Une promenade',
      text: 'Le chemin traverse la forêt et les enfants écoutent les oiseaux.',
      words,
      missing: []
     });
   })
 });
 meta = instance.c;
 appConfig = instance.c;
 server = await listen(instance.app);
 base = `http://127.0.0.1:${server.address().port}`;
 appConfig.origin = base;
});
after(async () => {
 await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => provider.close(r))]);
 db.close();
});
async function login(sub) {
 const response = await fetch(base + '/auth/login', { redirect: 'manual' });
 assert.equal(response.status, 303);
 const url = new URL(response.headers.get('location')),
  state = url.searchParams.get('state'),
  nonce = url.searchParams.get('nonce');
 assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
 const code = randomBytes(12).toString('hex');
 codes.set(code, { sub, nonce });
 const flowCookie = cookie(response).join('; '),
  callback = `${base}/auth/callback?state=${state}&code=${code}`;
 const done = await fetch(callback, { headers: { cookie: flowCookie }, redirect: 'manual' });
 assert.equal(done.status, 303);
 assert.equal(done.headers.get('location'), '/');
 return {
  cookie: cookie(done)
   .filter((s) => !s.startsWith('atelier_' + meta.slug.replaceAll('-', '_') + '_flow='))
   .join('; '),
  callback,
  flowCookie
 };
}
const request = (path, session, options = {}) =>
 fetch(base + path, {
  ...options,
  headers: {
   cookie: session?.cookie || '',
   ...(options.method ? { origin: base, 'content-type': 'application/json' } : {}),
   ...options.headers
  }
 });
test('les données privées refusent les visiteurs et les origines étrangères', async () => {
 assert.equal((await fetch(base + '/api/records/progress')).status, 401);
 assert.equal(
  (
   await fetch(base + '/api/records/progress', {
    method: 'PUT',
    headers: { origin: 'https://example.invalid', 'content-type': 'application/json' },
    body: '{}'
   })
  ).status,
  403
 );
 assert.equal(
  (await fetch(base + '/auth/callback?state=fake&code=fake', { redirect: 'manual' })).headers.get(
   'location'
  ),
  '/?auth_error=invalid'
 );
});
test('la connexion réelle OIDC ouvre une session HttpOnly sans jeton côté navigateur', async () => {
 const session = await login('alice');
 const me = await (await request('/api/session', session)).json();
 assert.equal(me.user.name, 'alice');
 assert.equal(me.access_token, undefined);
 const stored = db.prepare('SELECT id_token FROM sessions WHERE name=?').get('alice');
 assert.ok(!stored.id_token.startsWith('eyJ'));
 const replay = await fetch(session.callback, {
  headers: { cookie: session.flowCookie },
  redirect: 'manual'
 });
 assert.equal(replay.headers.get('location'), '/?auth_error=invalid');
});
test('les comptes sont isolés et les conflits de sauvegarde ne sont pas écrasés', async () => {
 const alice = await login('privacy-a'),
  bob = await login('privacy-b');
 const value = { correct: 2, total: 3 };
 let r = await request('/api/records/progress', alice, {
  method: 'PUT',
  body: JSON.stringify({ value, version: 0 })
 });
 assert.equal(r.status, 200);
 assert.equal((await (await request('/api/records/progress', bob)).json()).value, null);
 assert.deepEqual((await (await request('/api/export', bob)).json()).records, []);
 const updates = await Promise.all(
  [1, 2].map(() =>
   request('/api/records/progress', alice, {
    method: 'PUT',
    body: JSON.stringify({ value: { correct: 3, total: 4 }, version: 1 })
   })
  )
 );
 assert.deepEqual(updates.map((r) => r.status).sort(), [200, 409]);
 r = await request('/api/records/progress', alice, {
  method: 'PUT',
  body: JSON.stringify({ value: { correct: 9, total: 1 }, version: 2 })
 });
 assert.equal(r.status, 400);
});
test('les erreurs JSON sont contrôlées et les réponses de session ne sont pas mises en cache', async () => {
 const r = await fetch(base + '/api/session');
 assert.equal(r.headers.get('cache-control'), 'no-store');
 assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
 assert.equal(
  (
   await fetch(base + '/api/records/progress', {
    method: 'PUT',
    headers: { origin: base, 'content-type': 'application/json' },
    body: '{broken'
   })
  ).status,
  400
 );
});
test('un logout signé révoque la session et un rejeu est rejeté', async () => {
 const session = await login('logout-user');
 const token = await signed({
  jti: randomBytes(12).toString('hex'),
  sub: 'logout-user',
  sid: 'sid-logout-user',
  events: { 'http://schemas.openid.net/event/backchannel-logout': {} }
 });
 const send = () =>
  fetch(base + '/auth/backchannel-logout', {
   method: 'POST',
   headers: { 'content-type': 'application/x-www-form-urlencoded' },
   body: new URLSearchParams({ logout_token: token })
  });
 assert.equal((await send()).status, 204);
 assert.equal((await request('/api/records/progress', session)).status, 401);
 assert.equal((await send()).status, 400);
});
test('la déconnexion locale reste effective et fournit id_token_hint au compte commun', async () => {
 const session = await login('logout-click');
 const r = await request('/auth/logout', session, {
  method: 'POST',
  redirect: 'manual',
  body: '{}'
 });
 assert.equal(r.status, 303);
 const target = new URL(r.headers.get('location'));
 assert.ok(target.searchParams.get('id_token_hint'));
 assert.equal(target.searchParams.get('post_logout_redirect_uri'), base + '/');
 assert.equal((await request('/api/records/progress', session)).status, 401);
});
test('une configuration publique sans Comptes ou sans HTTPS est refusée', () => {
 assert.throws(() =>
  validateConfig({ origin: 'https://example.invalid', issuer: '', secure: true })
 );
 assert.throws(() =>
  validateConfig({ origin: 'http://example.invalid', issuer: '', secure: false })
 );
 const encrypted = seal('jeton-confidentiel', tokenKey);
 assert.equal(unseal(encrypted, tokenKey), 'jeton-confidentiel');
 assert.throws(() => unseal(encrypted, randomBytes(32).toString('hex')));
});

test('la création en tâche de fond répond immédiatement et reste privée entre comptes', async () => {
 const alice = await login('job-a'),
  bob = await login('job-b');
 let r = await request('/api/sentences', alice, {
  method: 'POST',
  body: JSON.stringify({ words: ['forêt'], async: true }),
  signal: AbortSignal.timeout(5000)
 });
 assert.equal(r.status, 202);
 const first = await r.json();
 assert.ok(first.job);
 let state = await (await request('/api/sentences/' + first.job, alice)).json();
 assert.equal(state.state, 'working');
 assert.match(state.draft, /forêt/);
 assert.equal((await request('/api/sentences/' + first.job, bob)).status, 404);
 assert.equal((await request('/api/sentences/' + first.job, null)).status, 404);
 assert.equal(
  (
   await request('/api/sentences', bob, {
    method: 'POST',
    body: JSON.stringify({ words: ['forêt'], async: true })
   })
  ).status,
  429
 );
 finishGeneration();
 await new Promise(setImmediate);
 state = await (await request('/api/sentences/' + first.job, alice)).json();
 assert.equal(state.state, 'done');
 assert.deepEqual(state.result.words, ['forêt']);
 r = await request('/api/sentences', bob, {
  method: 'POST',
  body: JSON.stringify({ words: ['forêt'], async: true })
 });
 assert.equal(r.status, 202);
 const second = await r.json();
 assert.notEqual(first.job, second.job);
 assert.equal((await request('/api/sentences/' + second.job, alice)).status, 404);
 assert.equal(
  (await request('/api/sentences/' + second.job, alice, { method: 'DELETE', body: '{}' })).status,
  404
 );
 assert.equal(
  (await request('/api/sentences/' + second.job, bob, { method: 'DELETE', body: '{}' })).status,
  200
 );
 await new Promise(setImmediate);
 const cancelled = await (await request('/api/sentences/' + second.job, bob)).json();
 assert.equal(cancelled.state, 'failed');
 assert.match(cancelled.error, /annulée/);
 assert.equal(
  (await request('/api/sentences/' + second.job, bob)).headers.get('cache-control'),
  'no-store'
 );
});
