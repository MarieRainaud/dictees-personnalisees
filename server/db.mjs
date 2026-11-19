import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function openDatabase(path) {
 if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
 const db = new DatabaseSync(path);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
 db.exec(
  'CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,subject TEXT NOT NULL,name TEXT NOT ' +
   'NULL,expires INTEGER NOT NULL,id_token TEXT NOT NULL,sid TEXT NOT NULL);\n CREATE TABLE IF NOT ' +
   'EXISTS school_tokens(session_hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,data ' +
   'TEXT NOT NULL);\n CREATE TABLE IF NOT EXISTS flows(hash TEXT PRIMARY KEY,browser TEXT NOT ' +
   'NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL);\n CREATE TABLE IF NOT ' +
   'EXISTS records(subject TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,version INTEGER NOT ' +
   'NULL,updated TEXT NOT NULL,PRIMARY KEY(subject,key));\n CREATE TABLE IF NOT EXISTS replays(jti TEXT ' +
   'PRIMARY KEY,expires INTEGER NOT NULL);\n CREATE TABLE IF NOT EXISTS usage(subject TEXT NOT NULL,day ' +
   'TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(subject,day));'
 );
 return db;
}
export async function backupDatabase(db, path) {
 mkdirSync(dirname(resolve(path)), { recursive: true });
 await backup(db, path);
}
export function readRecord(db, subject, key) {
 const row = db.prepare('SELECT * FROM records WHERE subject=? AND key=?').get(subject, key);
 return row
  ? { value: JSON.parse(row.value), version: row.version, updated: row.updated }
  : { value: null, version: 0, updated: null };
}
export function writeRecord(db, subject, key, value, version) {
 db.exec('BEGIN IMMEDIATE');
 try {
  const prev = readRecord(db, subject, key);
  if (prev.version !== version) {
   db.exec('ROLLBACK');
   return null;
  }
  const updated = new Date().toISOString(),
   next = version + 1;
  db
   .prepare(
    'INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(subject,key) DO UPDATE SET value=excluded.value,version=excluded.version,updated=excluded.updated'
   )
   .run(subject, key, JSON.stringify(value), next, updated);
  db.exec('COMMIT');
  return { value, version: next, updated };
 } catch (e) {
  db.exec('ROLLBACK');
  throw e;
 }
}
