import { refreshTokenGrant } from 'openid-client';

export function setupSchoolProfile(app, db, c, { config, fetcher, seal, unseal }) {
  const read = db.prepare('SELECT data FROM school_tokens WHERE session_hash=?');
  const insert = db.prepare('INSERT INTO school_tokens (session_hash,data) VALUES (?,?)');
  const replace = db.prepare('UPDATE school_tokens SET data=? WHERE session_hash=? AND data=?');
  const remove = db.prepare('DELETE FROM school_tokens WHERE session_hash=? AND data=?');
  const refreshing = new Map();

  function tokenData(tokens, previous) {
    return {
      access: tokens.access_token,
      refresh: tokens.refresh_token || previous?.refresh,
      expires: Date.now() + 1000 * Number(tokens.expires_in || 0)
    };
  }

  async function refresh(sessionHash, row, previous) {
    try {
      const { client } = await config();
      const result = tokenData(await refreshTokenGrant(client, previous.refresh), previous);
      const saved = replace.run(seal(JSON.stringify(result), c.tokenKey), sessionHash, row.data);
      if (saved.changes) return result.access;
      const current = read.get(sessionHash);
      return current ? JSON.parse(unseal(current.data, c.tokenKey)).access : null;
    } catch (error) {
      if (error.error !== 'invalid_grant') throw error;
      remove.run(sessionHash, row.data);
      const current = read.get(sessionHash);
      return current ? JSON.parse(unseal(current.data, c.tokenKey)).access : null;
    }
  }

  async function accessToken(sessionHash) {
    const row = read.get(sessionHash);
    if (!row) return null;
    const previous = JSON.parse(unseal(row.data, c.tokenKey));
    if (previous.expires > Date.now() + 15000) return previous.access;
    if (!previous.refresh) return null;
    if (!refreshing.has(sessionHash)) {
      refreshing.set(sessionHash, refresh(sessionHash, row, previous).finally(() => refreshing.delete(sessionHash)));
    }
    return refreshing.get(sessionHash);
  }

  async function proxy(req, res) {
    if (!req.user) return res.status(401).json({error: 'Connexion nécessaire.'});
    if (req.method === 'PUT' &&
        (!req.body || !Object.hasOwn(req.body, 'grade') ||
         !(req.body.grade === null || typeof req.body.grade === 'string' && req.body.grade.length <= 3) ||
         typeof req.body.revision !== 'string' || req.body.revision.length > 20)) {
      return res.status(400).json({error: 'Choisir une classe proposée dans la liste.'});
    }
    const reconnect = () => res.status(401).json({
      reconnect: true,
      error: 'Reconnecte-toi pour accéder à la classe du compte.'
    });
    try {
      const token = await accessToken(req.user.hash);
      if (!token) return reconnect();
      const headers = {accept: 'application/json', authorization: 'Bearer ' + token};
      const options = {method: req.method, headers};
      if (req.method === 'PUT') {
        headers['content-type'] = 'application/json';
        options.body = JSON.stringify({grade: req.body.grade, revision: req.body.revision});
      }
      const result = await fetcher(c.issuer + '/profil-scolaire', options);
      if (result.status === 401) return reconnect();
      if (result.status === 400) return res.status(400).json({error: 'Choisir une classe proposée dans la liste.'});
      if (result.ok || result.status === 409) return res.status(result.status).json(await result.json());
    } catch {
      // An unavailable shared profile should leave the application's own selector usable.
    }
    return res.status(503).json({error: 'La classe du compte est indisponible pour le moment.'});
  }

  app.get('/api/school-profile', proxy);
  app.put('/api/school-profile', proxy);
  return {
    save(sessionHash, tokens) {
      if (tokens.access_token) insert.run(sessionHash, seal(JSON.stringify(tokenData(tokens)), c.tokenKey));
    }
  };
}
