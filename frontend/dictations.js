import { shell, $, esc, api, feedback } from './shared.js';
import library from '../content/dictations.json';
import { findImposedWords } from '../content/words.mjs';
import { verbTenses } from '../content/verb-tenses.mjs';
import { schoolGrades } from '../content/school-grades.mjs';
const ui = await shell({ title: 'Dictées personnalisées', icon: 'book' });
let saved = [],
 version = 0,
 currentId = null,
 busy = false;
try {
 const r = await ui.read('dictations');
 saved = r.value?.items || [];
 version = r.version;
} catch (e) {
 ui.status(e.message);
}
$('#tabs').remove();
$('#workspace').innerHTML =
 '<div class="layout dictation-layout"><aside class="stack sidebar"><section class="panel"><h2>Les ' +
 'mots de la dictée</h2><label>Liste<select id="preset"><option value="">Nouvelle liste</option>' +
 `${library.map((p) => `<option value="${p.id}">${esc(p.title)} - ${p.words.length} mots</option>`).join('')}` +
 '</select></label><label>Mots imposés<textarea id="words" rows="12" placeholder="Un mot par ligne, ' +
 'ou séparés par des virgules" spellcheck="true"></textarea></label><label>Thème facultatif<input ' +
 'id="theme" maxlength="160"></label><label>Classe de l’enfant<select id="school-grade"><option ' +
 'value="">Sans préférence</option>' +
 `${schoolGrades.map((grade) => `<option>${grade}</option>`).join('')}` +
 '</select></label><label>Temps des verbes<select id="verb-tense"><option value="">Sans ' +
 'préférence</option>' +
 `${verbTenses.map((tense) => `<option>${tense}</option>`).join('')}` +
 '</select></label><button class="primary" id="generate">Créer le texte</button><button ' +
 'id="cancel-generation" hidden>Annuler</button><div id="generation-state" role="status" ' +
 'aria-live="polite"></div></section><section class="panel"><h2>Dictées enregistrées</h2><div ' +
 'id="saved"></div></section></aside><section class="panel activity"><div class="screen-editor"><h2>' +
 'Le texte</h2><label>Titre<input id="title" maxlength="160"></label><label>Texte de la dictée<span ' +
 'class="dictation-editor"><span class="dictation-highlights" aria-hidden="true"><span ' +
 'id="text-highlights" class="dictation-text dictation-highlight-text"></span></span><textarea ' +
 'id="text" class="dictation-text" rows="15" spellcheck="true"></textarea></span></label><p ' +
 'id="word-count"></p><div id="coverage" class="chips" aria-label="Présence des mots imposés"></div>' +
 '<div class="actions"><button id="save" class="primary">Enregistrer</button><button id="new">' +
 'Nouvelle dictée</button></div><div class="actions"><button id="print-teacher">Imprimer le ' +
 'texte</button></div><p id="feedback" class="feedback" role="status"></p></div><article ' +
 'class="reading-sheet" id="print-sheet"></article></section></div>';
function words() {
 return [
  ...new Set(
   $('#words')
    .value.split(/[,;\n]+/)
    .map((w) => w.trim())
    .filter(Boolean)
  )
 ];
}
const editor = $('#text'),
 highlightLayer = $('#text-highlights');
let highlightedText = '';
function markedText(text, ranges) {
 let html = '',
  offset = 0;
 for (const { start, end } of ranges) {
  html +=
   esc(text.slice(offset, start)) +
   '<mark class="imposed-word">' +
   esc(text.slice(start, end)) +
   '</mark>';
  offset = end;
 }
 return html + esc(text.slice(offset));
}
function syncHighlightScroll() {
 highlightLayer.style.transform =
  'translate(' + -editor.scrollLeft + 'px,' + -editor.scrollTop + 'px)';
}
function syncHighlightLayout() {
 const style = getComputedStyle(editor);
 highlightLayer.style.width =
  editor.clientWidth +
  parseFloat(style.borderLeftWidth) +
  parseFloat(style.borderRightWidth) +
  'px';
 syncHighlightScroll();
}
editor.addEventListener('scroll', syncHighlightScroll, { passive: true });
new ResizeObserver(syncHighlightLayout).observe(editor);
function coverage() {
 const list = words(),
  text = editor.value,
  n = text.trim() ? text.trim().split(/\s+/).length : 0;
 const { present, ranges } = findImposedWords(text, list);
 highlightedText = markedText(text, ranges);
 highlightLayer.innerHTML = highlightedText + '\n';
 syncHighlightLayout();
 $('#coverage').innerHTML = list
  .map(
   (w) =>
    '<span class="chip ' +
    (present.has(w) ? 'done' : 'missing') +
    '">' +
    (present.has(w) ? '✓' : '○') +
    ' ' +
    esc(w) +
    '</span>'
  )
  .join('');
 $('#word-count').textContent =
  present.size + '/' + list.length + ' mots imposés présents · ' + n + ' mots dans le texte';
}
function updateGenerateLabel() {
 const adapting = $('#preset').value && ($('#school-grade').value || $('#verb-tense').value);
 $('#generate').textContent = adapting ? 'Adapter l’exemple' : 'Créer le texte';
}
function loadPreset(id) {
 const example = library.find((p) => p.id === id);
 currentId = null;
 $('#preset').value = example?.id || '';
 $('#words').value = example?.words.join('\n') || '';
 $('#title').value = example?.title || '';
 $('#text').value = example?.text || example?.sentences?.join('\n\n') || '';
 updateGenerateLabel();
 coverage();
 feedback('');
}
function paintSaved() {
 $('#saved').innerHTML = saved.length
  ? saved
     .map(
      (s) =>
       `<div class="saved-item"><p class="saved-title">${esc(s.title)}</p><button data-load="${esc(s.id)}">Ouvrir</button></div>`
     )
     .join('')
  : '<p>Aucune dictée enregistrée.</p>';
 $('[id="saved"]').onclick = (e) => {
  if (busy) return;
  const p = saved.find((s) => s.id === e.target.closest('[data-load]')?.dataset.load);
  if (!p) return;
  currentId = p.id;
  $('#title').value = p.title;
  $('#text').value = p.text;
  $('#words').value = p.words.join('\n');
  $('#preset').value = '';
  updateGenerateLabel();
  coverage();
  feedback('');
 };
}
function lock(locked) {
 for (const id of [
  'generate',
  'preset',
  'words',
  'theme',
  'school-grade',
  'verb-tense',
  'new',
  'save'
 ])
  $('#' + id).disabled = locked || (id === 'generate' && !ui.session.aiAvailable);
 $('#text').readOnly = locked;
 $('#title').readOnly = locked;
 $('#workspace').setAttribute('aria-busy', String(locked));
}
const jobKey = 'dictation-active-job';
let activeJob = null;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function followJob(id) {
 let errors = 0;
 for (let turn = 0; turn < 600; turn++) {
  let state;
  try {
   state = await api('/api/sentences/' + encodeURIComponent(id));
   errors = 0;
  } catch (e) {
   if (++errors >= 3) throw e;
   await pause(2000);
   continue;
  }
  if (state.state === 'done') return state.result;
  if (state.state === 'failed') {
   try {
    sessionStorage.removeItem(jobKey);
   } catch {}
   throw new Error(state.error);
  }
  await pause(2000);
 }
 throw new Error(
  'La création dure trop longtemps. Recharger la page pour retrouver son avancement.'
 );
}
async function generate(resume = null) {
 if (busy) return;
 if (!ui.session.aiAvailable) return feedback('Création de texte indisponible.');
 const list = resume?.words || words();
 if (!list.length) return feedback('Saisir les mots de la dictée.');
 if (list.length > 40) return feedback('La liste peut contenir jusqu’à 40 mots.');
 const generation = {
  words: list,
  theme: $('#theme').value,
  schoolGrade: $('#school-grade').value,
  verbTense: $('#verb-tense').value
 };
 const presetId = $('#preset').value,
  exampleTitle = presetId ? $('#title').value.trim() : '';
 busy = true;
 lock(true);
 feedback('');
 $('#generation-state').className = 'busy-state';
 $('#generation-state').innerHTML =
  '<span class="spinner" aria-hidden="true"></span>Création du texte…';
 try {
  let id = resume?.job;
  if (!id) {
   const started = await api('/api/sentences', {
    method: 'POST',
    body: JSON.stringify({ ...generation, async: true })
   });
   id = started.job;
  }
  activeJob = id;
  $('#cancel-generation').hidden = false;
  try {
   sessionStorage.setItem(
    jobKey,
    JSON.stringify({ ...generation, job: id, presetId, exampleTitle })
   );
  } catch {}
  const r = await followJob(id);
  try {
   sessionStorage.removeItem(jobKey);
  } catch {}
  if (typeof r?.text !== 'string' || !r.text.trim())
   throw new Error('Aucun texte complet reçu. Relancer la création.');
  const { present } = findImposedWords(r.text, list),
   missing = list.filter((word) => !present.has(word));
  if (missing.length)
   throw new Error(
    'Le texte proposé oublie encore : ' + missing.join(', ') + '. Relancer la création.'
   );
  $('#title').value = exampleTitle || r.title;
  $('#text').value = r.text;
  currentId = null;
  coverage();
  feedback('Texte créé. Tous les mots imposés sont présents.', true);
 } catch (e) {
  const state = $('#generation-state');
  state.className = 'feedback retry';
  state.textContent = e.message;
 } finally {
  busy = false;
  activeJob = null;
  $('#cancel-generation').hidden = true;
  lock(false);
  const state = $('#generation-state');
  if (state.className === 'busy-state') state.textContent = '';
 }
}
async function save() {
 if (busy) return;
 if (!ui.session.user)
  return feedback('Connexion au compte de l’atelier nécessaire pour enregistrer.');
 if (!$('#title').value.trim() || !$('#text').value.trim())
  return feedback('Ajouter un titre et un texte.');
 if (words().length > 40) return feedback('La liste peut contenir jusqu’à 40 mots.');
 const item = {
   id: currentId || crypto.randomUUID(),
   title: $('#title').value.trim(),
   text: $('#text').value,
   words: words(),
   updated: new Date().toISOString()
  },
  items = [item, ...saved.filter((s) => s.id !== item.id)];
 busy = true;
 lock(true);
 try {
  const r = await ui.save('dictations', { items }, version);
  saved = items;
  version = r.version;
  currentId = item.id;
  paintSaved();
  feedback('Dictée enregistrée.', true);
 } catch (e) {
  feedback(e.message);
 } finally {
  busy = false;
  lock(false);
 }
}
function print() {
 coverage();
 const title = $('#title').value.trim() || 'Dictée';
 $('#print-sheet').innerHTML =
  `<h1>${esc(title)}</h1><div class="printed-text">${highlightedText}</div>`;
 const pageTitle = document.title;
 document.title = title + ' - Dictée personnalisée';
 window.addEventListener(
  'afterprint',
  () => {
   document.title = pageTitle;
  },
  { once: true }
 );
 window.print();
}
const classSelect = $('#school-grade');
let accountGrade = ui.school?.grade || '';
classSelect.value = accountGrade;
ui.school?.onChange((grade) => {
 const next = grade || '';
 if (!classSelect.disabled && classSelect.value === accountGrade) {
  classSelect.value = next;
  updateGenerateLabel();
 }
 accountGrade = next;
});
$('#cancel-generation').onclick = async () => {
 if (!activeJob) return;
 $('#cancel-generation').disabled = true;
 try {
  await api('/api/sentences/' + encodeURIComponent(activeJob), { method: 'DELETE', body: '{}' });
 } catch (e) {
  feedback(e.message);
 } finally {
  $('#cancel-generation').disabled = false;
 }
};
$('#generate').onclick = () => generate();
$('#words').oninput = () => {
 $('#preset').value = '';
 updateGenerateLabel();
 coverage();
};
$('#school-grade').onchange = updateGenerateLabel;
$('#verb-tense').onchange = updateGenerateLabel;
$('#text').oninput = coverage;
$('#preset').onchange = (e) => loadPreset(e.target.value);
$('#save').onclick = save;
$('#new').onclick = () => {
 try {
  sessionStorage.removeItem(jobKey);
 } catch {}
 $('#theme').value = '';
 classSelect.value = accountGrade;
 $('#verb-tense').value = '';
 loadPreset('');
};
$('#print-teacher').onclick = print;
paintSaved();
loadPreset(library[0].id);

try {
 const pending = JSON.parse(sessionStorage.getItem(jobKey) || 'null');
 if (
  pending &&
  /^[a-f0-9-]{36}$/.test(pending.job) &&
  Array.isArray(pending.words) &&
  pending.words.length <= 40 &&
  pending.words.every((w) => typeof w === 'string')
 ) {
  $('#preset').value = library.find((p) => p.id === pending.presetId)?.id || '';
  $('#words').value = pending.words.join('\n');
  $('#theme').value = String(pending.theme || '').slice(0, 160);
  $('#school-grade').value = schoolGrades.includes(pending.schoolGrade) ? pending.schoolGrade : '';
  $('#verb-tense').value = verbTenses.includes(pending.verbTense) ? pending.verbTense : '';
  $('#title').value =
   String(pending.exampleTitle || '').slice(0, 160) ||
   $('#theme').value.trim() ||
   'Dictée personnalisée';
  $('#text').value = '';
  updateGenerateLabel();
  coverage();
  void generate(pending);
 }
} catch {}

if (!ui.session.aiAvailable) {
 $('#generate').disabled = true;
 $('#generation-state').textContent = 'Création de texte indisponible.';
}
