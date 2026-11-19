import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWords, containsWord, generate, validateText } from '../server/sentences.mjs';
const library = JSON.parse(
 readFileSync(new URL('../content/dictations.json', import.meta.url), 'utf8')
);
test('les listes de vingt mots sont couvertes par un texte suivi', () => {
 assert.ok(library.length >= 6);
 for (const p of library) {
  assert.equal(p.words.length, 20);
  assert.deepEqual(validateText(p, p.words).missing, [], p.id);
 }
 assert.deepEqual(parseWords([' forêt ', 'forêt']), ['forêt']);
 assert.throws(() => parseWords(['<script>']));
 assert.ok(containsWord('L’arbre est près de l’école.', "l'école"));
 assert.ok(!containsWord('Un chocolat.', 'chat'));
 assert.ok(!containsWord('Une foret.', 'forêt'));
});
test('un texte incomplet est repris avec la liste exacte et jamais remplacé par des phrases préexistantes', async () => {
 const prev = { ...process.env };
 process.env.AI_PROVIDER = 'ollama';
 process.env.OLLAMA_URL = 'http://local-model:11434';
 let calls = 0;
 const mock = async (url, o) => {
  const body = JSON.parse(o.body);
  assert.notEqual(body.think, true);
  calls++;
  return new Response(
   JSON.stringify({
    message: {
     content: JSON.stringify(
      calls === 1
       ? {
          title: 'Le jardin',
          text:
           'Les enfants jouent dans le jardin puis rentrent à la maison pour préparer leur goûter.'
         }
       : {
          title: 'Le jardin',
          text:
           'Dans le jardin, les enfants regardent un ornithorynque dessiné dans leur livre avant de rentrer à la maison.'
         }
     )
    }
   })
  );
 };
 try {
  const r = await generate(['ornithorynque', 'jardin'], {}, mock);
  assert.equal(calls, 2);
  assert.deepEqual(r.missing, []);
  assert.ok(r.text.includes('ornithorynque'));
  assert.ok(r.text.includes('jardin'));
 } finally {
  for (const k of ['AI_PROVIDER', 'OLLAMA_URL'])
   if (prev[k] === undefined) delete process.env[k];
   else process.env[k] = prev[k];
 }
});
test('une génération qui oublie toujours un mot est signalée comme un échec', async () => {
 const prev = { ...process.env };
 process.env.AI_PROVIDER = 'ollama';
 process.env.OLLAMA_URL = 'http://local-model:11434';
 let calls = 0;
 try {
  await assert.rejects(
   () =>
    generate(['forêt'], {}, async () => {
     calls++;
     return new Response(
      JSON.stringify({
       message: {
        content: JSON.stringify({
         title: 'Le jardin',
         text:
          'Les enfants jouent dans le jardin puis rentrent à la maison pour préparer leur goûter.'
        })
       }
      })
     );
    }),
   /oublie encore/
  );
  assert.equal(calls, 3);
  assert.throws(() =>
   validateText({ title: 'Texte', text: '<script>' + library[0].text }, library[0].words)
  );
 } finally {
  for (const k of ['AI_PROVIDER', 'OLLAMA_URL'])
   if (prev[k] === undefined) delete process.env[k];
   else process.env[k] = prev[k];
 }
});

test('le flux de rédaction supporte les accents et supprime une phrase interrompue', async () => {
 const { completeSentences } = await import('../server/sentences.mjs');
 assert.equal(
  completeSentences('Le jardin est calme. Un oiseau chante puis'),
  'Le jardin est calme.'
 );
 const prev = { ...process.env };
 process.env.AI_PROVIDER = 'ollama';
 process.env.OLLAMA_URL = 'http://model:11434';
 const text =
   'Les enfants traversent la forêt et regardent le jardin avant de rentrer à la maison.',
  bytes = new TextEncoder().encode(
   JSON.stringify({ message: { content: text }, done: true }) + '\n'
  );
 let progress = '';
 try {
  const r = await generate(
   ['forêt', 'jardin'],
   { onProgress: (t) => (progress = t) },
   async (url, o) => {
    assert.equal(JSON.parse(o.body).stream, true);
    return new Response(
     new ReadableStream({
      start(controller) {
       for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
       controller.close();
      }
     })
    );
   }
  );
  assert.equal(r.text, text);
  assert.equal(progress, text);
  assert.deepEqual(r.missing, []);
 } finally {
  for (const k of ['AI_PROVIDER', 'OLLAMA_URL'])
   if (prev[k] === undefined) delete process.env[k];
   else process.env[k] = prev[k];
 }
});

test('l’annulation interrompt le calcul au lieu d’attendre sa durée maximale', async () => {
 const prev = { ...process.env };
 process.env.AI_PROVIDER = 'ollama';
 process.env.OLLAMA_URL = 'http://model:11434';
 const controller = new AbortController();
 try {
  const running = generate(
   ['forêt'],
   { signal: controller.signal },
   async (url, { signal }) =>
    new Promise((resolve, reject) => {
     signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), {
      once: true
     });
    })
  );
  controller.abort();
  await assert.rejects(() => running, /annulée/);
 } finally {
  for (const k of ['AI_PROVIDER', 'OLLAMA_URL'])
   if (prev[k] === undefined) delete process.env[k];
   else process.env[k] = prev[k];
 }
});

test('des notes en anglais contenant les mots imposés ne sont jamais une dictée validée', () => {
 assert.throws(
  () =>
   validateText(
    {
     title: 'Essai',
     text:
      'Okay, let me write the text. The user wants a French story. I need to use the required words forêt and jardin. First I should make a list.'
    },
    ['forêt', 'jardin']
   ),
  /français/
 );
});

test('la réécriture vérifie aussi les mots présents dans les versions précédentes', async () => {
 const prev = { ...process.env };
 process.env.AI_PROVIDER = 'ollama';
 process.env.OLLAMA_URL = 'http://model:11434';
 let calls = 0;
 const texts = [
  'Les enfants quittent le jardin et traversent la forêt avant de rentrer à la maison.',
  'Dans le jardin, les enfants observent un ornithorynque dessiné dans leur livre.',
  'Les enfants observent un ornithorynque dessiné dans leur livre, puis traversent le jardin et la forêt.'
 ];
 try {
  const result = await generate(
   ['jardin', 'forêt', 'ornithorynque'],
   {},
   async () => new Response(JSON.stringify({ message: { content: texts[calls++] } }))
  );
  assert.equal(calls, 3);
  assert.deepEqual(result.missing, []);
  for (const word of ['jardin', 'forêt', 'ornithorynque'])
   assert.ok(containsWord(result.text, word));
 } finally {
  for (const key of ['AI_PROVIDER', 'OLLAMA_URL'])
   if (prev[key] === undefined) delete process.env[key];
   else process.env[key] = prev[key];
 }
});

test('le service Gemini reçoit la clé côté serveur et les vingt mots exacts', async () => {
 const previous = { ...process.env };
 process.env.AI_PROVIDER = 'gemini';
 process.env.GEMINI_API_KEY = 'cle-fictive-pour-le-test';
 delete process.env.AI_MODEL;
 let calls = 0;
 try {
  const result = await generate(
   library[0].words,
   { theme: 'Une promenade' },
   async (url, options) => {
    calls++;
    assert.equal(new URL(url).hostname, 'generativelanguage.googleapis.com');
    assert.ok(url.includes('gemini-3.5-flash-lite'));
    assert.ok(!url.includes(process.env.GEMINI_API_KEY));
    assert.equal(options.headers['x-goog-api-key'], process.env.GEMINI_API_KEY);
    const request = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(request.contents[0].parts[0].text).mots_imposes, library[0].words);
    assert.equal(request.generationConfig.responseMimeType, 'application/json');
    assert.ok(request.generationConfig.maxOutputTokens >= 1600);
    assert.ok(!options.body.includes(process.env.GEMINI_API_KEY));
    return new Response(
     JSON.stringify({
      candidates: [
       {
        content: {
         parts: [
          {
           text: JSON.stringify({
            title: 'Une promenade',
            text:
             'En automne, nous partons souvent en promenade dans la forêt. Ensemble, nous suivons tranquillement ' +
             'un chemin humide entre les racines, la mousse, les feuilles et les branches. Soudain, derrière un ' +
             'arbre, un oiseau rompt le silence. Un écureuil passe près du panier de champignons, puis disparaît ' +
             'sous des feuilles orange.'
           })
          }
         ]
        }
       }
      ]
     })
    );
   }
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.missing, []);
  assert.equal(result.words.length, 20);
 } finally {
  for (const key of ['AI_PROVIDER', 'GEMINI_API_KEY', 'AI_MODEL'])
   if (previous[key] === undefined) delete process.env[key];
   else process.env[key] = previous[key];
 }
});
