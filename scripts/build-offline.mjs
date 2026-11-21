import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const assetFiles = await readdir(new URL('assets/', dist));
const outputFiles = await readdir(dist);
const files = ['index.html', ...assetFiles.sort().map(name => 'assets/' + name)];
if (outputFiles.includes('firebase.local.json')) files.push('firebase.local.json');

const worker = await readFile(new URL('../src/offline-worker.js', import.meta.url), 'utf8');
const headers = await readFile(new URL('../firebase.json', import.meta.url));
const payloads = await Promise.all(files.map(name => readFile(new URL(name, dist))));
const release = createHash('sha256').update(worker).update(headers);
for (const [index, name] of files.entries()) release.update(name).update(payloads[index]);
const version = release.digest('hex').slice(0, 16);
const html = payloads[0].toString('utf8');
if (!html.includes('</head>')) throw Error('The built app is missing its head element.');
payloads[0] = Buffer.from(html.replace('</head>', `<meta name="two-charts-offline-build" content="${version}">\n</head>`));
const manifest = {version, files: Object.fromEntries(files.map((name, index) => [
  name, createHash('sha256').update(payloads[index]).digest('hex'),
]))};
await writeFile(new URL('index.html', dist), payloads[0]);
await writeFile(new URL('offline-worker.js', dist), 'const offline = ' + JSON.stringify(manifest) + ';\n' + worker);
