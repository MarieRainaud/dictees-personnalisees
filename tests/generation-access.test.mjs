import { get } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';
import { openDatabase } from '../server/db.mjs';
async function withGuestServer(run) {
 const previous = process.env.AI_PROVIDER;
 process.env.AI_PROVIDER = 'gemini';
 const db = openDatabase(':memory:'),
  requestedOptions = [];
 let finishGeneration;
 const { app } = createApp({
   db,
   origin: 'https://dictees.example',
   issuer: 'https://comptes.example/realms/comptes',
   secret: 'test-client-secret',
   tokenKey: 'a'.repeat(64),
   secure: true,
   generateText: async (words, { onProgress, signal, verbTense, schoolGrade } = {}) => {
    requestedOptions.push({ verbTense, schoolGrade });
    const result = {
     title: 'La forêt',
     text: 'Les enfants traversent la forêt et observent les oiseaux avant de rentrer à la maison.',
     words,
     missing: []
    };
    if (onProgress)
     return new Promise((resolve, reject) => {
      onProgress(result.text);
      finishGeneration = () => resolve(result);
      signal.addEventListener(
       'abort',
       () => reject(Object.assign(new Error('annulée'), { publicMessage: 'Création annulée.' })),
       { once: true }
      );
     });
    return result;
   }
  }),
  server = app.listen(0, '127.0.0.1');
 await new Promise((resolve) => server.once('listening', resolve));
 const base = 'http://127.0.0.1:' + server.address().port;
 const request = (path, options = {}) =>
  fetch(base + path, {
   ...options,
   headers: {
    Origin: 'https://dictees.example',
    'Content-Type': 'application/json',
    ...options.headers
   }
  });
 try {
  await run({ request, db, requestedOptions, finish: () => finishGeneration() });
 } finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  if (previous === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = previous;
 }
}
test('un visiteur peut créer un texte Gemini avant connexion, même avec HTTPS en production', () =>
 withGuestServer(async ({ request }) => {
  const r = await request('/api/sentences', {
   method: 'POST',
   body: JSON.stringify({ words: ['forêt'] })
  });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).words, ['forêt']);
  assert.equal((await request('/api/records/dictations')).status, 401);
  assert.equal(
   (
    await request('/api/records/dictations', {
     method: 'PUT',
     body: JSON.stringify({ value: { items: [] }, version: 0 })
    })
   ).status,
   401
  );
  assert.equal((await request('/api/export')).status, 401);
  assert.equal(
   (
    await request('/api/sentences', {
     method: 'POST',
     headers: { Origin: 'https://foreign.example' },
     body: JSON.stringify({ words: ['forêt'] })
    })
   ).status,
   403
  );
 }));
test('un visiteur retrouve et annule sa création en cours sans connexion', () =>
 withGuestServer(async ({ request, finish }) => {
  const start = await request('/api/sentences', {
   method: 'POST',
   body: JSON.stringify({ words: ['forêt'], async: true })
  });
  assert.equal(start.status, 202);
  const { job } = await start.json();
  assert.match(job, /^[a-f0-9-]{36}$/);
  let state = await (await request('/api/sentences/' + job)).json();
  assert.equal(state.state, 'working');
  assert.match(state.draft, /forêt/);
  finish();
  await new Promise(setImmediate);
  state = await (await request('/api/sentences/' + job)).json();
  assert.equal(state.state, 'done');
  assert.deepEqual(state.result.words, ['forêt']);
  assert.equal((await request('/api/sentences/00000000-0000-0000-0000-000000000000')).status, 404);
  const next = await request('/api/sentences', {
   method: 'POST',
   body: JSON.stringify({ words: ['forêt'], async: true })
  });
  const second = await next.json();
  assert.equal(
   (await request('/api/sentences/' + second.job, { method: 'DELETE', body: '{}' })).status,
   200
  );
  await new Promise(setImmediate);
  state = await (await request('/api/sentences/' + second.job)).json();
  assert.equal(state.state, 'failed');
  assert.match(state.error, /annulée/);
 }));
test('la classe et le temps facultatifs sont transmis aux deux modes de génération', () =>
 withGuestServer(async ({ request, db, requestedOptions, finish }) => {
  const send = (options = {}) =>
   request('/api/sentences', {
    method: 'POST',
    body: JSON.stringify({ words: ['forêt'], ...options })
   });
  assert.equal((await send({ verbTense: 'Temps inconnu' })).status, 400);
  assert.equal((await send({ schoolGrade: '2de' })).status, 400);
  assert.equal(db.prepare('SELECT count(*) AS total FROM usage').get().total, 0);
  assert.equal((await send()).status, 200);
  assert.equal((await send({ verbTense: '', schoolGrade: '' })).status, 200);
  assert.equal((await send({ verbTense: 'Passé composé', schoolGrade: 'CP' })).status, 200);
  const background = await send({ verbTense: 'Imparfait', schoolGrade: 'CM2', async: true });
  assert.equal(background.status, 202);
  assert.deepEqual(requestedOptions, [
   { verbTense: undefined, schoolGrade: undefined },
   { verbTense: '', schoolGrade: '' },
   { verbTense: 'Passé composé', schoolGrade: 'CP' },
   { verbTense: 'Imparfait', schoolGrade: 'CM2' }
  ]);
  finish();
 }));
test('le quota Gemini couvre aussi les visiteurs sans conserver leur adresse en clair', () =>
 withGuestServer(async ({ request, db }) => {
  const send = () =>
   request('/api/sentences', { method: 'POST', body: JSON.stringify({ words: ['forêt'] }) });
  assert.equal((await send()).status, 200);
  const usage = db.prepare('SELECT * FROM usage').get();
  assert.match(usage.subject, /^guest:[a-f0-9]{64}$/);
  assert.equal(usage.count, 1);
  db.prepare('UPDATE usage SET count=20 WHERE subject=? AND day=?').run(usage.subject, usage.day);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /20 créations/);
 }));
test('un alias local ouvre la page à l’adresse configurée et les écritures gardent leur contrôle d’origine', async () => {
 const db = openDatabase(':memory:');
 const server = createApp({
  db,
  origin: 'http://127.0.0.1:8122',
  issuer: '',
  secure: false
 }).app.listen(0, '127.0.0.1');
 try {
  await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await new Promise((resolve, reject) => {
   get(base + '/?test=1', { headers: { Host: 'localhost:8122' } }, (res) => {
    res.resume();
    resolve(res);
   }).on('error', reject);
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, 'http://127.0.0.1:8122/?test=1');
  const post = (origin) =>
   fetch(base + '/api/sentences', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{"words":[]}'
   });
  assert.equal((await post('http://localhost:8122')).status, 403);
  assert.equal((await post('https://foreign.example')).status, 403);
  assert.equal((await post('http://127.0.0.1:8122')).status, 400);
 } finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
 }
});
test('une liste de mots déposée comme texte ne remplace pas un récit', async () => {
 const { validateText } = await import('../server/sentences.mjs'),
  words = [
   'forêt',
   'chemin',
   'feuilles',
   'branches',
   'silence',
   'oiseau',
   'écureuil',
   'panier',
   'champignons',
   'humide',
   'mousse',
   'racines',
   'promenade',
   'automne',
   'orange',
   'souvent',
   'ensemble',
   'soudain',
   'derrière',
   'tranquillement'
  ];
 assert.throws(
  () => validateText({ title: 'Fausse dictée', text: words.join(', ') + '.' }, words),
  /phrases complètes/
 );
});
