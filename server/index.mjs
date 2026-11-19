import { randomUUID, createHmac } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { openDatabase, readRecord, writeRecord } from './db.mjs';
import { setupAuth } from './oidc.mjs';
import { generate, parseWords, generatorAvailable } from './sentences.mjs';
import { verbTenses } from '../content/verb-tenses.mjs';
import { schoolGrades } from '../content/school-grades.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function createApp(overrides = {}) {
 const meta = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8'));
 const c = {
  ...meta,
  origin: (process.env.APP_ORIGIN || `http://127.0.0.1:${meta.port}`).replace(/\/$/, ''),
  issuer: (process.env.OIDC_ISSUER || '').replace(/\/$/, ''),
  secret: process.env.OIDC_CLIENT_SECRET || '',
  tokenKey: process.env.SESSION_KEY || '',
  internal: process.env.OIDC_INTERNAL_ORIGIN || '',
  secure: process.env.SECURE_COOKIES === '1',
  ...overrides
 };
 const db =
  overrides.db ||
  openDatabase(process.env.DATA_PATH || resolve(root, 'data', 'application.sqlite'));
 const app = express();
 app.disable('x-powered-by');
 app.set('trust proxy', 1);
 app.use(
  helmet({
   contentSecurityPolicy: {
    directives: {
     defaultSrc: ["'self'"],
     scriptSrc: ["'self'"],
     styleSrc: ["'self'", "'unsafe-inline'"],
     imgSrc: ["'self'", 'data:'],
     connectSrc: ["'self'"],
     fontSrc: ["'self'"],
     objectSrc: ["'none'"],
     frameAncestors: ["'none'"],
     formAction: ["'self'", ...(c.issuer ? [new URL(c.issuer).origin] : [])],
     upgradeInsecureRequests: c.secure ? [] : null
    }
   },
   strictTransportSecurity: c.secure ? undefined : false,
   referrerPolicy: { policy: 'same-origin' }
  })
 );
 app.use(compression());
 app.use(cookieParser());
 app.use(express.json({ limit: '160kb', strict: true }));
 app.use(express.urlencoded({ extended: false, limit: '20kb' }));
 app.use(['/api', '/auth'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (
   ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) &&
   req.path !== '/backchannel-logout'
  ) {
   if (req.get('origin') !== c.origin)
    return res.status(403).json({ error: 'Origine de la demande refusée.' });
   if (req.path !== '/logout' && !req.is('application/json'))
    return res.status(415).json({ error: 'Format JSON requis.' });
  }
  next();
 });
 app.use(
  '/auth',
  rateLimit({ windowMs: 60000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false })
 );
 const auth = setupAuth(app, db, c);
 const canonicalOrigin = new URL(c.origin);
 const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
 const localAliases = new Set();
 if (loopbackHosts.includes(canonicalOrigin.hostname)) {
  const port = canonicalOrigin.port ? ':' + canonicalOrigin.port : '';
  for (const hostname of loopbackHosts) {
   if (hostname !== canonicalOrigin.hostname) localAliases.add(hostname + port);
  }
 }
 const requireUser = (req, res, next) =>
  req.user
   ? next()
   : res.status(401).json({ error: 'Connexion aux Comptes partagés nécessaire pour enregistrer.' });
 app.get('/api/health', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ status: 'ok', application: meta.slug });
 });
 app.get('/api/session', (req, res) =>
  res.json({
   user: req.user ? { name: req.user.name } : null,
   accountConfigured: !!c.issuer,
   aiAvailable: meta.slug === 'dictees-personnalisees' && generatorAvailable()
  })
 );
 const allowed = new Set(['progress', 'dictations']);
 app.get('/api/records/:key', requireUser, (req, res) =>
  allowed.has(req.params.key)
   ? res.json(readRecord(db, req.user.subject, req.params.key))
   : res.sendStatus(404)
 );
 app.put('/api/records/:key', requireUser, (req, res) => {
  const { key } = req.params,
   { value, version } = req.body || {};
  if (!allowed.has(key)) return res.sendStatus(404);
  if (
   !Number.isSafeInteger(version) ||
   version < 0 ||
   !value ||
   typeof value !== 'object' ||
   Array.isArray(value)
  )
   return res.status(400).json({ error: 'Données invalides.' });
  if (
   key === 'progress' &&
   (!Number.isSafeInteger(value.correct) ||
    !Number.isSafeInteger(value.total) ||
    value.correct < 0 ||
    value.total < value.correct ||
    value.total > 1000000)
  )
   return res.status(400).json({ error: 'Progression invalide.' });
  if (
   key === 'dictations' &&
   (!Array.isArray(value.items) ||
    value.items.length > 100 ||
    value.items.some(
     (i) =>
      !i ||
      typeof i.id !== 'string' ||
      typeof i.title !== 'string' ||
      i.title.length > 160 ||
      typeof i.text !== 'string' ||
      i.text.length > 12000 ||
      !Array.isArray(i.words) ||
      i.words.length > 40 ||
      i.words.some((w) => typeof w !== 'string' || w.length > 40)
    ))
  )
   return res.status(400).json({ error: 'Dictée invalide.' });
  if (JSON.stringify(value).length > 130000)
   return res.status(413).json({ error: 'La sauvegarde est trop volumineuse.' });
  const result = writeRecord(db, req.user.subject, key, value, version);
  return result
   ? res.json(result)
   : res
      .status(409)
      .json({
       error: 'Une autre fenêtre a modifié ces données. Recharger les données avant de réessayer.'
      });
 });
 app.get('/api/export', requireUser, (req, res) => {
  const rows = db
   .prepare('SELECT key,value,updated FROM records WHERE subject=?')
   .all(req.user.subject);
  res.set('Content-Disposition', `attachment; filename="${meta.slug}-donnees.json"`);
  res.json({
   application: meta.slug,
   exported: new Date().toISOString(),
   records: rows.map((r) => ({ ...r, value: JSON.parse(r.value) }))
  });
 });
 const jobs = new Map(),
  generateText = overrides.generateText || generate,
  quotaKey = c.tokenKey || randomUUID();
 const sweep = () => {
  for (const [id, job] of jobs)
   if (job.finished && Date.now() - job.finished > 3600000) jobs.delete(id);
 };
 app.get(
  '/api/sentences/:id',
  rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }),
  (req, res) => {
   if (meta.slug !== 'dictees-personnalisees') return res.sendStatus(404);
   sweep();
   const job = jobs.get(req.params.id);
   if (!job || (job.owner && job.owner !== req.user?.subject))
    return res
     .status(404)
     .json({ error: 'Cette création est introuvable. La liste de mots reste disponible.' });
   res.json({
    state: job.state,
    draft: job.draft,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {})
   });
  }
 );
 app.delete('/api/sentences/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || (job.owner && job.owner !== req.user?.subject)) return res.sendStatus(404);
  if (job.state === 'working') job.controller.abort();
  res.json({ cancelled: true });
 });
 app.post(
  '/api/sentences',
  rateLimit({ windowMs: 60000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false }),
  async (req, res) => {
   if (meta.slug !== 'dictees-personnalisees') return res.sendStatus(404);
   let words;
   try {
    words = parseWords(req.body?.words);
   } catch (e) {
    return res.status(400).json({ error: e.message });
   }
   const options = {
    theme: req.body?.theme,
    verbTense: req.body?.verbTense,
    schoolGrade: req.body?.schoolGrade
   };
   if (
    options.schoolGrade !== undefined &&
    options.schoolGrade !== '' &&
    !schoolGrades.includes(options.schoolGrade)
   )
    return res.status(400).json({ error: 'Choisir une classe proposée dans la liste.' });
   if (
    options.verbTense !== undefined &&
    options.verbTense !== '' &&
    !verbTenses.includes(options.verbTense)
   )
    return res.status(400).json({ error: 'Choisir un temps des verbes proposé dans la liste.' });
   const paid = process.env.AI_PROVIDER === 'gemini';
   if (app.locals.generating)
    return res
     .status(429)
     .json({ error: 'Un texte est déjà en préparation. Réessayer dans un instant.' });
   if (paid) {
    const subject =
      req.user?.subject ||
      'guest:' +
       createHmac('sha256', quotaKey)
        .update(req.ip || req.socket.remoteAddress || 'local')
        .digest('hex'),
     day = new Date().toISOString().slice(0, 10),
     u = db.prepare('SELECT count FROM usage WHERE subject=? AND day=?').get(subject, day);
    if (u?.count >= 20)
     return res.status(429).json({ error: 'Les 20 créations de la journée sont utilisées.' });
    db
     .prepare(
      'INSERT INTO usage VALUES(?,?,1) ON CONFLICT(subject,day) DO UPDATE SET count=count+1'
     )
     .run(subject, day);
   }
   app.locals.generating = true;
   if (req.body?.async === true) {
    sweep();
    if (jobs.size >= 50) {
     app.locals.generating = false;
     return res.status(429).json({ error: 'Réessayer un peu plus tard.' });
    }
    const id = randomUUID(),
     job = {
      owner: req.user?.subject || null,
      state: 'working',
      draft: '',
      finished: 0,
      controller: new AbortController()
     };
    jobs.set(id, job);
    void generateText(words, {
     ...options,
     signal: job.controller.signal,
     onProgress: (text) => {
      job.draft = text;
     }
    })
     .then(
      (result) => {
       job.result = result;
       job.draft = result.text;
       job.state = 'done';
      },
      (error) => {
       job.error = error.publicMessage || 'La création n’a pas abouti. Le texte reste modifiable.';
       job.state = 'failed';
      }
     )
     .finally(() => {
      job.finished = Date.now();
      app.locals.generating = false;
     });
    return res.status(202).json({ job: id });
   }
   try {
    return res.json(await generateText(words, options));
   } catch (e) {
    return res
     .status(e.status || 502)
     .json({
      error: e.publicMessage || 'Le moteur de dictée est indisponible. Réessayer dans un instant.'
     });
   } finally {
    app.locals.generating = false;
   }
  }
 );
 app.use(express.static(resolve(root, 'dist'), { index: false, maxAge: 0 }));
 app.get('/', (req, res) => {
  if (localAliases.has(req.get('host')?.toLowerCase()))
   return res.redirect(302, canonicalOrigin.origin + req.originalUrl);
  return res.sendFile(resolve(root, 'dist', 'index.html'));
 });
 app.use((req, res) => res.status(404).json({ error: 'Page introuvable.' }));
 app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res
   .status(err.type === 'entity.too.large' ? 413 : err instanceof SyntaxError ? 400 : 500)
   .json({
    error:
     err.type === 'entity.too.large'
      ? 'Données trop volumineuses.'
      : err instanceof SyntaxError
        ? 'Données invalides.'
        : 'Une erreur est survenue. Réessayer dans un instant.'
   });
 });
 return { app, db, c, auth };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const { app, c } = createApp();
 const port = Number(process.env.PORT || c.port);
 app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`${c.title} - ${c.origin}`));
}
