export const schoolGrades = ['CP', 'CE1', 'CE2', 'CM1', 'CM2', '6e', '5e', '4e', '3e'];
const gradeLabel = grade => grade?.replace(/e$/, 'ᵉ');
const unavailable = 'La classe du compte est indisponible pour le moment.';

export async function setupSchoolProfile(host, endpoint, { noticeHost = host, accountPage = false } = {}) {
  const listeners = new Set();
  let profile, problem, confirming = false;

  async function request(method, body, timeout) {
    const options = {method, headers: {accept: 'application/json'}, cache: 'no-store', signal: AbortSignal.timeout(timeout)};
    if (body) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const result = await fetch(endpoint, options);
    const data = await result.json().catch(() => ({}));
    if (!result.ok) throw { status: result.status, data };
    return data;
  }

  async function load(timeout) {
    try {
      profile = await request('GET', null, timeout);
      problem = null;
    } catch (error) {
      problem = error;
    }
  }

  await load(3500);
  const api = {
    get grade() { return profile?.grade ?? null; },
    onChange(callback) { listeners.add(callback); }
  };
  if (accountPage && problem?.status === 401) return api;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'school-profile-trigger';
  trigger.textContent = accountPage ? 'Classe de l’enfant' : 'Classe du compte';
  trigger.setAttribute('aria-haspopup', 'dialog');
  host.append(trigger);

  const reminder = document.createElement('section');
  reminder.className = 'school-profile-reminder';
  reminder.setAttribute('aria-label', 'Rappel de rentrée');
  reminder.setAttribute('aria-live', 'polite');
  reminder.innerHTML = '<p></p><button type="button" aria-haspopup="dialog">Confirmer la classe</button>';
  noticeHost.append(reminder);

  const dialog = document.createElement('dialog');
  dialog.className = 'school-profile-dialog';
  dialog.setAttribute('aria-labelledby', 'school-profile-title');
  dialog.innerHTML = '<form><h2 id="school-profile-title">Classe de l’enfant</h2><p class="school-profile-intro" hidden></p>' +
    '<label>Classe du compte<select name="grade"><option value="">Sans classe</option>' +
    schoolGrades.map(grade => '<option value="' + grade + '">' + gradeLabel(grade) + '</option>').join('') +
    '</select></label><p class="school-profile-status" role="status" hidden></p>' +
    '<div class="school-profile-actions"><button type="button" data-cancel>Fermer</button>' +
    '<button type="button" data-retry hidden>Réessayer</button><a href="/auth/login" data-reconnect hidden>Se reconnecter</a>' +
    '<button type="submit" class="primary" data-save>Enregistrer</button></div></form>';
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const select = form.elements.grade;
  const intro = dialog.querySelector('.school-profile-intro');
  const status = dialog.querySelector('.school-profile-status');
  const save = dialog.querySelector('[data-save]');
  const retry = dialog.querySelector('[data-retry]');
  const reconnect = dialog.querySelector('[data-reconnect]');

  function updateReminder() {
    reminder.hidden = !profile?.confirmationDue;
    reminder.querySelector('p').textContent = profile?.confirmationDue
      ? 'Rentrée ' + profile.schoolYear + '. Confirme la classe de l’enfant.' : '';
  }

  function showStatus(message = '') {
    status.textContent = message;
    status.hidden = !message;
  }

  function renderForm(message = '') {
    const canEdit = !!profile && !problem;
    select.disabled = save.disabled = !canEdit;
    select.value = (confirming ? profile?.suggestedGrade ?? profile?.grade : profile?.grade) ?? '';
    const hint = confirming && profile?.confirmationDue
      ? 'Classe actuelle ' + gradeLabel(profile.grade) + '. ' +
        (profile.suggestedGrade ? 'Tu peux confirmer la classe proposée ou en choisir une autre.'
          : 'Si l’enfant a terminé le collège, tu peux choisir « Sans classe ».') : '';
    intro.textContent = hint;
    intro.hidden = !hint;
    save.textContent = confirming ? 'Confirmer' : 'Enregistrer';
    reconnect.hidden = accountPage || !problem?.data?.reconnect;
    retry.hidden = !problem || !reconnect.hidden;
    showStatus(message || (problem ? problem.data?.error || unavailable : ''));
  }

  function notifyChange() {
    updateReminder();
    listeners.forEach(callback => callback(api.grade));
  }

  function open(confirm) {
    confirming = confirm;
    renderForm();
    dialog.showModal();
  }

  trigger.onclick = () => open(false);
  reminder.querySelector('button').onclick = () => open(true);
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  retry.onclick = async () => {
    retry.disabled = true;
    showStatus('Chargement de la classe…');
    await load(12000);
    retry.disabled = false;
    renderForm();
    notifyChange();
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (!profile || problem || save.disabled) return;
    const grade = select.value || null;
    select.disabled = save.disabled = true;
    showStatus('');
    try {
      profile = await request('PUT', {grade, revision: profile.revision}, 12000);
    } catch (error) {
      if (error.status === 409) {
        profile = error.data;
        renderForm('La classe a changé dans une autre fenêtre. Vérifie-la avant de confirmer.');
        notifyChange();
      } else if (error.data?.reconnect || !error.status || error.status === 503) {
        problem = error;
        renderForm();
      } else {
        renderForm(error.data?.error || unavailable);
      }
      return;
    }
    renderForm();
    dialog.close();
    notifyChange();
    trigger.focus();
  };

  let refreshing = false;
  window.addEventListener('focus', async () => {
    if (dialog.open || refreshing) return;
    refreshing = true;
    const previous = profile;
    const previousProblem = problem;
    await load(3500);
    refreshing = false;
    if (problem && profile) problem = previousProblem;
    if (profile?.revision !== previous?.revision ||
        profile?.confirmationDue !== previous?.confirmationDue) notifyChange();
  });
  updateReminder();
  return api;
}
