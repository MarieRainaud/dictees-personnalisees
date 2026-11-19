import "./shared.css";
export const esc = (s) =>
 String(s ?? "").replace(
  /[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
 );
export const $ = (s, root = document) => root.querySelector(s);
export const shuffle = (list) => {
 const out = [...list];
 for (let i = out.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [out[i], out[j]] = [out[j], out[i]];
 }
 return out;
};
export const icons = {
 book: "book-open",
 fraction: "divide",
 clock: "clock",
 english: "language",
 history: "timeline"
};
export const icon = (name) =>
 `<span class="image-icon icon-${icons[name] || icons.book}" aria-hidden="true"></span>`;
export async function api(path, options = {}) {
 const res = await fetch(path, {
   ...options,
   headers: { "Content-Type": "application/json", ...options.headers }
  }),
  data = await res.json().catch(() => ({ error: "Le serveur ne répond pas." }));
 if (!res.ok) throw new Error(data.error || "La demande n’a pas abouti.");
 return data;
}
let outcomeTimer;
export function clearOutcome() {
 clearTimeout(outcomeTimer);
 $("#answer-result")?.remove();
 $(".activity")?.classList.remove("answer-correct");
}
export function answerResult(text, correct = true) {
 clearOutcome();
 if (!correct) return;
 const banner = document.createElement("div");
 banner.id = "answer-result";
 banner.className = "answer-result";
 banner.setAttribute("role", "status");
 banner.setAttribute("aria-live", "assertive");
 banner.innerHTML =
  '<span class="answer-result-icon" aria-hidden="true">✓</span><div><strong>Bonne réponse !</strong>' +
  '<span></span></div><button type="button" aria-label="Fermer la confirmation">×</button>';
 banner.querySelector("span:last-child").textContent = text;
 banner.querySelector("button").onclick = clearOutcome;
 document.body.append(banner);
 $(".activity")?.classList.add("answer-correct");
 outcomeTimer = setTimeout(clearOutcome, 5000);
}
export function feedback(text, good = false) {
 const node = $("#feedback");
 if (node) {
  node.className = "feedback " + (good ? "good" : "retry");
  node.textContent = text;
 }
 if (good && text && document.body.dataset.activity !== "book") answerResult(text, true);
 if (!text || !good) clearOutcome();
}
import { setupSchoolProfile } from "./school-profile.js";

export async function shell(meta) {
 document.body.dataset.activity = meta.icon;
 document.title = meta.title + " - L’atelier de ninette";
 $("#app").innerHTML =
  '<a class="skip" href="#main">Aller au contenu</a><div class="shell site-shell"><header ' +
  'class="site-header"><nav aria-label="Compte" id="account"></nav></header><main id="main"><h1 ' +
  'class="app-title"><span class="title-icon">' +
  `${icon(meta.icon)}` +
  "</span>" +
  `${esc(meta.title)}` +
  '</h1><div class="global-status" id="status" role="status"></div><nav class="nav" id="tabs" ' +
  'aria-label="Activités"></nav><div id="workspace"></div></main><footer class="site-footer"><a ' +
  'class="footer-signature" href="https://portfolio--ninette.ctn.rs/"><img class="footer-logo" ' +
  'src="/images/logo.svg" alt="" loading="lazy" decoding="async"><span>L’atelier de ninette</span></a>' +
  '<p class="footer-hosting">Hébergé par Simple Containers</p>' +
  '<div class="social-links"><a href="https://www.linkedin.com/in/marie-rainaud" target="_blank" ' +
  'rel="noreferrer" aria-label="LinkedIn, nouvel onglet"><span class="image-icon icon-linkedin" ' +
  'aria-hidden="true"></span><span>LinkedIn</span></a><a href="https://github.com/MarieRainaud" ' +
  'target="_blank" rel="noreferrer" aria-label="GitHub, nouvel onglet"><span class="image-icon ' +
  'icon-github" aria-hidden="true"></span><span>GitHub</span></a></div></footer></div>';
 let session = { user: null, accountConfigured: false, aiAvailable: false },
  progress = { correct: 0, total: 0 },
  progressVersion = 0,
  queue = Promise.resolve();
 const status = (text) => {
  $("#status").textContent = text;
 };
 try {
  session = await api("/api/session");
 } catch (e) {
  status(e.message);
 }
 $("#account").innerHTML = session.user
  ? '<details class="account-menu"><summary>Compte</summary><div><a href="/auth/account">Compte de ' +
    'l’atelier</a><a href="/api/export">Exporter les données</a><form method="post" ' +
    'action="/auth/logout"><button type="submit">Déconnexion</button></form></div></details>'
  : '<a class="nav-button login-link" href="/auth/login">Connexion</a>';
 const errors = {
  invalid: "La connexion n’a pas abouti.",
  unavailable: "Le service Comptes est indisponible.",
  configuration: "La connexion aux Comptes reste à configurer.",
  cancelled: "Connexion annulée.",
  logout: "La session de cette application est fermée."
 };
 const code = new URLSearchParams(location.search).get("auth_error");
 if (code) {
  status(errors[code] || "Connexion interrompue.");
  history.replaceState(null, "", location.pathname);
 }
 const noticeHost = document.createElement("div");
 if (session.user) $("#tabs").before(noticeHost);
 const schoolTask = session.user
  ? setupSchoolProfile($("#account .account-menu > div"), "/api/school-profile", { noticeHost })
  : null;
 if (session.user)
  try {
   const r = await api("/api/records/progress");
   progress = r.value || progress;
   progressVersion = r.version;
  } catch (e) {
   status(e.message);
  }
 const paintScore = () => {
  if ($("#score"))
   $("#score").innerHTML = `<strong>${progress.correct}</strong><span>sur ${progress.total}</span>`;
 };
 const scorePanel = () =>
  '<section class="panel score-panel"><h2>Résultats</h2><div class="score" id="score"></div></section>';
 const school = await schoolTask;
 return {
  session,
  school,
  status,
  scorePanel,
  paintScore,
  async read(key) {
   return session.user ? api("/api/records/" + key) : { value: null, version: 0 };
  },
  async save(key, value, version) {
   if (!session.user) throw new Error("Connexion nécessaire pour enregistrer.");
   return api("/api/records/" + key, { method: "PUT", body: JSON.stringify({ value, version }) });
  },
  record(correct) {
   queue = queue.then(async () => {
    progress = { correct: progress.correct + (correct ? 1 : 0), total: progress.total + 1 };
    paintScore();
    if (session.user)
     try {
      const r = await api("/api/records/progress", {
       method: "PUT",
       body: JSON.stringify({ value: progress, version: progressVersion })
      });
      progressVersion = r.version;
     } catch (e) {
      status(e.message);
     }
   });
   return queue;
  },
  tabs(items, onChange, selected) {
   $("#tabs").innerHTML = items
    .map(
     ([id, title]) =>
      `<button type="button" data-tab="${id}" aria-pressed="${id === selected}">${esc(title)}</button>`
    )
    .join("");
   $("#tabs").onclick = (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    clearOutcome();
    $("#tabs")
     .querySelectorAll("button")
     .forEach((n) => n.setAttribute("aria-pressed", String(n === b)));
    onChange(b.dataset.tab);
   };
  }
 };
}
