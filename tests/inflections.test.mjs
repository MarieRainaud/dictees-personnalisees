import test from 'node:test';
import assert from 'node:assert/strict';
import { containsWord, generate, parseWords, validateText } from '../server/sentences.mjs';
import { findImposedWords } from '../content/words.mjs';

test('les verbes réguliers, irréguliers et participes sont reconnus à partir de leur infinitif', () => {
 for (const [word, text] of [
  ['manger', 'Les enfants mangeaient leur repas.'],
  ['finir', 'Nous finissons notre travail.'],
  ['aller', 'Elles iront au jardin.'],
  ['être', 'Les enfants étaient très calmes.'],
  ['avoir', 'Nous avons une surprise.'],
  ['prendre', 'Elle prit son panier.'],
  ['faire', 'Ils feront une promenade.'],
  ['voir', 'Nous avons vu les oiseaux.'],
  ['écrire', 'Les lettres sont écrites.'],
  ['se promener', 'Elles se sont tranquillement promenées.'],
  ["s'enfuir", 'L’écureuil s’est enfui.']
 ])
  assert.ok(containsWord(text, word), word + ' : ' + text);
});
test('les accords nominaux et adjectivaux sont reconnus dans les deux sens, avec les pluriels irréguliers', () => {
 for (const [word, text] of [
  ['petit', 'Les petites filles observent.'],
  ['petites', 'Un petit garçon arrive.'],
  ['beau', 'Les belles fleurs poussent.'],
  ['vieux', 'Une vieille maison.'],
  ['nouveau', 'Des nouvelles chaussures.'],
  ['cheval', 'Les chevaux galopent.'],
  ['chevaux', 'Un cheval galope.'],
  ['animal', 'Des animaux jouent.'],
  ['blanc', 'Des feuilles blanches.'],
  ['roux', 'Des écureuils aux queues rousses.'],
  ['œil', 'Elle ouvre les yeux.'],
  ['fleur', 'Des fleurs poussent.'],
  ['petit chat', 'De petites chattes jouent.'],
  ["l'oiseau", 'Les oiseaux chantent.']
 ])
  assert.ok(containsWord(text, word), word + ' : ' + text);
});
test('les flexions ne valident ni les synonymes, ni les dérivés, ni les accents manquants', () => {
 for (const [word, text] of [
  ['chat', 'Du chocolat chaud.'],
  ['forêt', 'Une foret.'],
  ['jardin', 'Le jardinier rentre.'],
  ['fleur', 'Le fleuriste arrive.'],
  ['cheval', 'Un poney galope.'],
  ['manger', 'Elle dévore son repas.'],
  ['jouet', 'Les enfants jouaient dehors.'],
  ['porte', 'Elle portait son panier.'],
  ['se promener', 'Elle promène son chien.'],
  ['bleu', 'Le ciel est blanc.']
 ])
  assert.equal(containsWord(text, word), false, word + ' : ' + text);
});

const words = [
 'enfant',
 'petit',
 'curieux',
 'aller',
 'forêt',
 'grand',
 'arbre',
 'observer',
 'oiseau',
 'roux',
 'écureuil',
 'beau',
 'fleur',
 'blanc',
 'ramasser',
 'feuille',
 'cheval',
 'marcher',
 'joyeux',
 'rentrer'
];
const text =
 'Les enfants curieux allaient dans la forêt avec leurs petites sœurs. Sous les grands arbres, elles ' +
 'observaient des oiseaux et des écureuils roux. Les filles ramassaient des feuilles et des fleurs ' +
 'blanches. De beaux chevaux marchaient près du chemin. Les enfants rentraient joyeux.';
test('les vingt mots restent contrôlés après conjugaison et accord, y compris après modification du texte', () => {
 assert.deepEqual(validateText({ title: 'Une promenade', text }, words).missing, []);
 const changed = text.replace('chevaux', 'poneys');
 assert.deepEqual(validateText({ title: 'Une promenade', text: changed }, words).missing, [
  'cheval'
 ]);
});
test('Gemini reçoit la consigne de conjuguer et accorder, sans modifier le fonctionnement du thème', async () => {
 const previous = { ...process.env };
 process.env.AI_PROVIDER = 'gemini';
 process.env.GEMINI_API_KEY = 'cle-fictive';
 let calls = 0;
 try {
  const result = await generate(
   words,
   { theme: 'Une promenade au printemps' },
   async (url, options) => {
    calls++;
    const body = JSON.parse(options.body),
     instruction = body.systemInstruction.parts[0].text,
     request = JSON.parse(body.contents[0].parts[0].text);
    assert.match(instruction, /accessible à tous les âges/);
    assert.doesNotMatch(instruction, /Ce repère est indicatif/);
    assert.doesNotMatch(instruction, /temps à privilégier/);
    assert.match(instruction, /Conjugue chaque verbe imposé/);
    assert.match(instruction, /accorde les noms/i);
    assert.doesNotMatch(
     instruction,
     /Ne remplace aucun mot par un synonyme, un pluriel ou une conjugaison/
    );
    assert.equal(request.theme, 'Une promenade au printemps');
    assert.deepEqual(request.mots_imposes, words);
    return new Response(
     JSON.stringify({
      candidates: [
       { content: { parts: [{ text: JSON.stringify({ title: 'Une promenade', text }) }] } }
      ]
     })
    );
   }
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.missing, []);
  assert.equal(result.title, 'Une promenade au printemps');
 } finally {
  for (const key of ['AI_PROVIDER', 'GEMINI_API_KEY'])
   if (previous[key] === undefined) delete process.env[key];
   else process.env[key] = previous[key];
 }
});
test('la réécriture conserve la reconnaissance des accords et redemande seulement les vrais oublis', async () => {
 const previous = { ...process.env };
 process.env.AI_PROVIDER = 'gemini';
 process.env.GEMINI_API_KEY = 'cle-fictive';
 let calls = 0;
 try {
  const result = await generate(
   words,
   { verbTense: 'Passé composé', schoolGrade: 'CP' },
   async (url, options) => {
    const body = JSON.parse(options.body),
     request = JSON.parse(body.contents[0].parts[0].text);
    calls++;
    assert.match(
     body.systemInstruction.parts[0].text,
     /classe de CP.*phrases très courtes.*Garde tous les mots imposés/
    );
    assert.match(
     body.systemInstruction.parts[0].text,
     /environ 40 mots.*Ce repère est indicatif. Dépasse-le si nécessaire/
    );
    assert.match(
     body.systemInstruction.parts[0].text,
     /« Passé composé ».*chaque fois qu’il convient.*Pour les verbes imposés.*Garde les autres temps/
    );
    if (calls === 2) {
     assert.deepEqual(request.mots_manquants, ['cheval']);
     assert.match(request.consigne, /conjuguer chaque verbe indiqué et accorde/);
    }
    return new Response(
     JSON.stringify({
      candidates: [
       {
        content: {
         parts: [
          {
           text: JSON.stringify({
            title: 'La promenade',
            text: calls === 1 ? text.replace('chevaux', 'poneys') : text
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
  assert.equal(calls, 2);
  assert.deepEqual(result.missing, []);
 } finally {
  for (const key of ['AI_PROVIDER', 'GEMINI_API_KEY'])
   if (previous[key] === undefined) delete process.env[key];
   else process.env[key] = previous[key];
 }
});

test('une même liste donne un repère de longueur plus court en CE1 qu’en CM1', async () => {
 const previousProvider = process.env.AI_PROVIDER,
  previousKey = process.env.GEMINI_API_KEY;
 process.env.AI_PROVIDER = 'gemini';
 process.env.GEMINI_API_KEY = 'cle-fictive';
 try {
  for (const [schoolGrade, guide] of [
   ['CE1', 48],
   ['CM1', 64]
  ]) {
   const result = await generate(words, { schoolGrade }, async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.systemInstruction.parts[0].text;
    assert.ok(prompt.includes(`classe de ${schoolGrade}`));
    assert.ok(prompt.includes(`environ ${guide} mots`));
    assert.match(prompt, /Dépasse-le si nécessaire pour conserver tous les mots imposés/);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text).mots_imposes, words);
    return new Response(
     JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text }) }] } }] })
    );
   });
   assert.deepEqual(result.missing, []);
   assert.equal(result.text, text);
  }
 } finally {
  if (previousProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = previousProvider;
  if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousKey;
 }
});

test('la génération reprend les verbes imposés restés à l’infinitif malgré les autres verbes à l’imparfait', async () => {
 const previousProvider = process.env.AI_PROVIDER,
  previousKey = process.env.GEMINI_API_KEY;
 process.env.AI_PROVIDER = 'gemini';
 process.env.GEMINI_API_KEY = 'cle-fictive';
 const list = ['jouer', 'nourrir', 's’épanouir', 'faire attention', 'rocher'];
 const incomplete =
  'Près du rocher, Lila aimait jouer et devait nourrir les lapins. Pour s’épanouir, ils avaient besoin de faire attention au froid.';
 const corrected =
  'Près du rocher, Lila jouait et nourrissait les lapins. Ils s’épanouissaient dans leur abri, car Lila faisait attention aux courants d’air.';
 let calls = 0;
 try {
  const result = await generate(
   list,
   { verbTense: 'Imparfait', schoolGrade: 'CE1' },
   async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.contents[0].parts[0].text);
    assert.deepEqual(input.exemples_de_conjugaison, {
     jouer: 'jouait',
     nourrir: 'nourrissait',
     's’épanouir': "s'épanouissait",
     'faire attention': 'faisait attention'
    });
    assert.match(
     body.systemInstruction.parts[0].text,
     /Conjugue chaque verbe imposé au moins une fois/
    );
    assert.match(
     body.systemInstruction.parts[0].text,
     /Applique en priorité ce temps aux verbes imposés eux-mêmes/
    );
    assert.match(
     body.systemInstruction.parts[0].text,
     /Chaque action doit découler de ce qui précède ou préparer la suite/
    );
    calls++;
    if (calls === 2) {
     assert.deepEqual(input.mots_manquants, []);
     assert.deepEqual(input.verbes_a_conjuguer, [
      'jouait',
      'nourrissait',
      "s'épanouissait",
      'faisait attention'
     ]);
     assert.match(input.consigne, /Privilégie le temps choisi pour ces verbes/);
    }
    return new Response(
     JSON.stringify({
      candidates: [
       {
        content: {
         parts: [{ text: JSON.stringify({ text: calls === 1 ? incomplete : corrected }) }]
        }
       }
      ]
     })
    );
   }
  );
  assert.equal(calls, 2);
  assert.equal(result.text, corrected);
 } finally {
  if (previousProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = previousProvider;
  if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousKey;
 }
});

test('le contrôle reconnaît les formes conjuguées et les homographes employés comme noms', () => {
 const strict = { conjugated: true };
 assert.equal(containsWord('Elle voulait offrir une fleur.', 'offrir', strict), false);
 assert.equal(containsWord('Elle a offert une fleur.', 'offrir', strict), true);
 assert.equal(containsWord('Ils allaient partir.', 'aller', strict), true);
 assert.equal(containsWord('Ils allaient partir.', 'partir', strict), false);
 assert.equal(containsWord('Ils vont au dîner.', 'dîner', strict), true);
 assert.equal(containsWord('Ils veulent dîner.', 'dîner', strict), false);
 assert.equal(containsWord('Ils s’étaient épanouis.', 's’épanouir', strict), true);
 assert.equal(containsWord('Elle allait lire.', 'lire/écrire', strict), false);
 assert.equal(containsWord('Elle écrivait.', 'lire/écrire', strict), true);
});

test('une entrée avec une barre oblique accepte les formes et leurs accords, sans les compter deux fois', () => {
 const list = parseWords(['loi', 'laïc / laïque', 'au lieu de']);
 assert.deepEqual(list, ['loi', 'laïc/laïque', 'au lieu de']);
 assert.ok(containsWord('Les écoles sont laïques.', 'laïc/laïque'));
 assert.ok(containsWord('L’enseignement est laïc.', 'laïc/laïque'));
 assert.ok(containsWord('Les écoles sont laïques.', 'laïc'));
 assert.ok(containsWord('Il part au jardin.', 'école/jardin'));
 assert.ok(!containsWord('Les oiseaux chantent.', 'école/jardin'));
 assert.throws(() => parseWords(['laïc/']));
 assert.throws(() => parseWords(['laïc//laïque']));
});

test('une phrase complète peut être très courte', () => {
 assert.deepEqual(validateText({ title: 'Dictée', text: 'Elle lit.' }, ['lire']).missing, []);
});

test('seule la première occurrence de chaque mot imposé est surlignée', () => {
 const passage =
  'Des écoles laïques ouvrirent. Les chevaux partirent, puis un cheval revint. Une école laïque ouvrit.';
 const list = ['cheval', 'laïc/laïque', 'ouvrir', 'forêt'];
 const { present, ranges } = findImposedWords(passage, list);
 assert.deepEqual([...present], ['cheval', 'laïc/laïque', 'ouvrir']);
 assert.deepEqual(
  ranges.map(({ start, end }) => passage.slice(start, end)),
  ['laïques', 'ouvrirent', 'chevaux']
 );
 const edited = passage.replace('chevaux', 'poneys');
 const updated = findImposedWords(edited, list);
 assert.deepEqual(
  updated.ranges.map(({ start, end }) => edited.slice(start, end)),
  ['laïques', 'ouvrirent', 'cheval']
 );
});
