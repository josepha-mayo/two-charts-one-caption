import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const assetFiles = await readdir(new URL('assets/', dist));
const outputFiles = await readdir(dist);
const files = ['index.html', ...assetFiles.sort().map(name => 'assets/' + name)];
if (outputFiles.includes('firebase.local.json')) files.push('firebase.local.json');

const worker = await readFile(new URL('../src/offline-worker.js', import.meta.url), 'utf8');
const hash = createHash('sha256').update(worker);
for (const name of files) {
  hash.update(name).update(await readFile(new URL(name, dist)));
}
const manifest = {version: hash.digest('hex').slice(0, 16), files};
await writeFile(new URL('offline-worker.js', dist), 'const offline = ' + JSON.stringify(manifest) + ';\n' + worker);
