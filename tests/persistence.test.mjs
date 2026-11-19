import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, readRecord, writeRecord, backupDatabase } from '../server/db.mjs';
test('les données survivent à une réouverture et une sauvegarde SQLite est restaurable', async () => {
 const parent = join(tmpdir(), 'atelier-education-tests');
 mkdirSync(parent, { recursive: true });
 const dir = mkdtempSync(join(parent, 'sqlite-')),
  source = join(dir, 'source.sqlite'),
  destination = join(dir, 'backup.sqlite');
 let db;
 try {
  db = openDatabase(source);
  writeRecord(db, 'alice', 'progress', { correct: 2, total: 4 }, 0);
  writeRecord(db, 'bob', 'progress', { correct: 1, total: 2 }, 0);
  await backupDatabase(db, destination);
  db.close();
  db = openDatabase(source);
  assert.deepEqual(readRecord(db, 'alice', 'progress').value, { correct: 2, total: 4 });
  db.close();
  db = openDatabase(destination);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(readRecord(db, 'bob', 'progress').value.total, 2);
  assert.equal(readRecord(db, 'alice', 'progress').value.total, 4);
  assert.equal(readRecord(db, 'charlie', 'progress').value, null);
 } finally {
  db?.close();
  for (const name of [
   'source.sqlite',
   'source.sqlite-wal',
   'source.sqlite-shm',
   'backup.sqlite',
   'backup.sqlite-wal',
   'backup.sqlite-shm'
  ]) {
   const path = join(dir, name);
   if (existsSync(path)) unlinkSync(path);
  }
  rmdirSync(dir);
 }
});
