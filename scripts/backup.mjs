import { openDatabase, backupDatabase } from '../server/db.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url)),
    source = process.env.DATA_PATH || resolve(root, 'data/application.sqlite'),
    target = process.argv[2];
if (!target) {
    console.error('Indiquer un chemin de destination pour la sauvegarde SQLite.');
    process.exit(1);
}
if (resolve(source) === resolve(target)) {
    console.error('La destination doit être différente de la base active.');
    process.exit(1);
}
if (!existsSync(source) || existsSync(resolve(target))) {
    console.error('La base source doit exister et la destination doit être un nouveau fichier.');
    process.exit(1);
}
const db = openDatabase(source);
try {
    await backupDatabase(db, resolve(target));
    console.log('Sauvegarde cohérente créée.');
} finally {
    db.close();
}
