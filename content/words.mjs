import lexicon from './inflections.json' with { type: 'json' };

export function parseWords(input) {
 if (!Array.isArray(input) || input.length < 1 || input.length > 40)
  throw new Error('Une liste de 1 à 40 mots est attendue.');
 const words = [
  ...new Set(
   input.map((w) =>
    typeof w === 'string'
     ? w
        .trim()
        .normalize('NFC')
        .replace(/\s*\/\s*/g, '/')
     : ''
   )
  )
 ];
 if (
  words.some(
   (w) =>
    !w || w.length > 40 || w.split('/').some((form) => !/^\p{L}+(?:[’' -]\p{L}+)*$/u.test(form))
  )
 )
  throw new Error(
   'Entrée invalide. La barre oblique sépare des formes, par exemple « laïc/laïque ».'
  );
 return words;
}

const clean = (s) =>
 s
  .normalize('NFC')
  .toLocaleLowerCase('fr')
  .replaceAll('’', "'")
  .replaceAll('œ', 'oe')
  .replaceAll('æ', 'ae');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nominal = new Map(),
 verbal = new Map(),
 infinitives = new Map(),
 patterns = new Map(),
 conjugatedPatterns = new Map();
const expand = (stem, pattern) =>
 lexicon.patterns[pattern].split('|').map((suffix) => stem + suffix);
function index(map, forms) {
 for (const form of forms) {
  if (!map.has(form)) map.set(form, []);
  map.get(form).push(forms);
 }
}
for (const [stem, pattern] of lexicon.nominal) index(nominal, expand(stem, pattern));
index(nominal, ['laïc', 'laïque', 'laïcs', 'laïques']);
for (const [lemma, stem, pattern] of lexicon.verbal) {
 const forms = expand(stem, pattern);
 infinitives.set(lemma, forms);
 index(verbal, forms);
}
function atom(word, conjugated = false) {
 const forms = infinitives.get(word) || [
  ...new Set((nominal.get(word) || verbal.get(word) || []).flat())
 ];
 const variants =
  conjugated && infinitives.has(word) ? forms.filter((form) => form !== word) : [word, ...forms];
 return (
  '(?:' +
  [...new Set(variants)]
   .sort((a, b) => b.length - a.length)
   .map(escape)
   .join('|') +
  ')'
 );
}
function phrase(word, conjugated = false) {
 const reflexive = /^(?:se\s+|s')(\p{L}+)(.*)$/u.exec(word);
 if (reflexive && infinitives.has(reflexive[1]))
  return (
   "(?:(?:me|te|se|nous|vous)\\s+|[mts]')(?:(?:\\p{L}+)\\s+){0,2}" +
   atom(reflexive[1], conjugated) +
   phrase(reflexive[2])
  );
 if (word.startsWith("l'")) return "(?:l'|(?:le|la|les)\\s+)" + phrase(word.slice(2));
 if (word.startsWith("d'")) return "(?:d'|(?:de|des)\\s+)" + phrase(word.slice(2));
 return word
  .split(/([ '-])/)
  .map((part, index) =>
   /^\p{L}+$/u.test(part)
    ? atom(part, conjugated && index === 0)
    : part === ' '
      ? '\\s+'
      : escape(part)
  )
  .join('');
}
function expression(form, conjugated) {
 if (conjugated && infinitives.has(form) && nominal.has(form)) {
  // Un infinitif homographe peut être un nom, par exemple « un rocher ».
  const determiner =
   "(?<=(?:un|une|le|la|les|du|des|au|aux|ce|cet|cette|ces|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|nos|votre|vos|leur|leurs)\\s+|l')";
  const nounForms = [...new Set(nominal.get(form).flat())].map(escape).join('|');
  return '(?:' + phrase(form, true) + '|' + determiner + '(?:' + nounForms + '))(?!\\p{L})';
 }
 const end = '(?!\\p{L})';
 if (!form.endsWith(' de')) return phrase(form, conjugated) + end;
 // Une expression terminée par « de » garde son identité avec l’élision ou la contraction.
 return phrase(form.slice(0, -3), conjugated) + '\\s+(?:(?:des|du|de)' + end + "|d'(?=\\p{L}))";
}
function patternFor(word, conjugated = false) {
 const cache = conjugated ? conjugatedPatterns : patterns;
 const input = clean(word)
  .split('/')
  .map((form) => form.trim())
  .filter(Boolean)
  .join('/');
 if (!input) return null;
 let pattern = cache.get(input);
 if (!pattern) {
  pattern = new RegExp(
   '(?<!\\p{L})' +
    '(?:' +
    input
     .split('/')
     .map((form) => expression(form, conjugated))
     .join('|') +
    ')',
   'u'
  );
  if (cache.size >= 1000) cache.clear();
  cache.set(input, pattern);
 }
 return pattern;
}

const imperfectExceptions = new Map([
 ['être', 'était'],
 ['avoir', 'avait'],
 ['savoir', 'savait']
]);
export function imperfectExamples(list) {
 const examples = {};
 for (const word of list) {
  const normalized = clean(word);
  if (normalized.includes('/')) continue;
  const match = /^(?:(s'|se\s+))?(\p{L}+)(.*)$/u.exec(normalized);
  if (!match) continue;
  const [, reflexive, lemma, tail] = match;
  const forms = infinitives.get(lemma);
  if (
   !forms ||
   (!reflexive && !tail && nominal.has(lemma) && !['aller', 'avoir', 'être'].includes(lemma))
  )
   continue;
  // L’imparfait se forme sur le radical de « nous » au présent, sauf pour « être ».
  const presentStem = forms
   .filter((form) => form.endsWith('ons'))
   .map((form) => form.slice(0, -3))
   .find((stem) => forms.includes(stem + 'ant') && forms.includes(stem + 'ait'));
  const thirdPerson = imperfectExceptions.get(lemma) || (presentStem && presentStem + 'ait');
  if (!thirdPerson) continue;
  const prefix = reflexive ? (/^[aeiouyàâéèêëîïôùûü]/u.test(thirdPerson) ? "s'" : 'se ') : '';
  examples[word] = prefix + thirdPerson + tail;
 }
 return examples;
}

export function containsWord(text, word, { conjugated = false } = {}) {
 return patternFor(word, conjugated)?.test(clean(text)) ?? false;
}

export function findImposedWords(text, list) {
 // Conserve les positions dans le texte d’origine malgré les ligatures et les accents combinés.
 let normalized = '';
 const starts = [],
  ends = [];
 for (const part of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
  const value = clean(part[0]);
  normalized += value;
  for (let i = 0; i < value.length; i++) {
   starts.push(part.index);
   ends.push(part.index + part[0].length);
  }
 }
 const present = new Set(),
  matches = [];
 for (const word of list) {
  const match = patternFor(word)?.exec(normalized);
  if (!match) continue;
  present.add(word);
  matches.push({ start: starts[match.index], end: ends[match.index + match[0].length - 1] });
 }
 matches.sort((a, b) => a.start - b.start || a.end - b.end);
 const ranges = [];
 for (const match of matches) {
  const last = ranges.at(-1);
  if (last && match.start < last.end) last.end = Math.max(last.end, match.end);
  else ranges.push(match);
 }
 return { present, ranges };
}
