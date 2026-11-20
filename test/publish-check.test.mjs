import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {readChart} from '../src/check.mjs';
import {createPublishCheck, readPublishCheck, runPublishCheck} from '../src/publish-check.mjs';

const example = name => new URL(`../examples/bus-cutoff/${name}`, import.meta.url);
const readExample = name => readFileSync(example(name), 'utf8');
const caption = readExample('caption.txt').trim();
const check = readPublishCheck(JSON.parse(readExample('caption-recheck.json')));

test('publication check survives reordered rows and flags exactly the stale cutoff claim', () => {
  const csv = readExample('current.csv');
  const original = readChart(csv);
  const saved = createPublishCheck(original, check.question, caption, check.claims);
  assert.deepEqual(saved, check);
  const reordered = original.slice().reverse();
  assert.deepEqual(runPublishCheck(reordered, caption, saved), {
    status: 'explicit',
    question: 'Which categories reached at least 70%?',
    sourceAnswer: 'Local and Select Bus Service',
  });
  const refreshed = runPublishCheck(readChart(readExample('refreshed.csv')), caption, saved);
  assert.deepEqual(refreshed, {
    status: 'conflict',
    question: 'Which categories reached at least 70%?',
    sourceAnswer: 'Local',
    failedFacts: ['Only Local and Select Bus Service reached at least 70%.'],
  });
  assert.doesNotMatch(JSON.stringify(saved), /70\.5|69\.99|private|spreadsheet/);
});

test('changed captions and categories require review, while unrelated data changes can pass', () => {
  assert.equal(runPublishCheck(readChart(readExample('current.csv')), caption + ' New text.', check).status, 'review_required');
  assert.equal(runPublishCheck(readChart(readExample('current.csv').replace('Local', 'Rapid')), caption, check).status, 'review_required');
  assert.equal(runPublishCheck(readChart(readExample('current.csv').replace('70.5', '70.25')), caption + '\r\n', check).status, 'explicit');
  assert.throws(() => readPublishCheck({...check, claims: []}), /at least one reviewed fact/);
  assert.throws(() => readPublishCheck({...check, version: 9}), /version 1/);
  assert.throws(() => readPublishCheck({...check, labels: ['Local', 'local']}), /unique/);
  assert.throws(() => readPublishCheck({...check, claims: [{...check.claims[0], evidence: 'made-up quote'}]}), /exact excerpt/);
});

test('a legacy saved rank claim flags a changed rate when the ranking is unchanged', () => {
  const rows = readChart('category,percent\nNorth,80\nCentral,64\nSouth,48');
  const evidence = 'North had the highest rate, at 78%.';
  const legacy = readPublishCheck({
    version: 1,
    labels: rows.map(row => row.label),
    question: 'highest',
    caption: evidence,
    claims: [{type: 'highest', ids: [1], evidence}],
  });
  const result = runPublishCheck(rows, evidence, legacy);
  assert.equal(result.status, 'conflict');
  assert.equal(result.sourceAnswer, 'North');
  assert.deepEqual(result.failedFacts, [evidence]);
});

test('legacy cutoff checks preserve a partial quote and surface unsupported evidence', () => {
  const rows = readChart('category,percent\nNorth,78\nCentral,64\nSouth,48');
  const question = {type: 'atLeast', cutoff: 70};
  const load = caption => readPublishCheck({
    version: 1,
    labels: rows.map(row => row.label),
    question,
    caption,
    claims: [{...question, ids: [1], evidence: caption}],
  });
  const positive = 'North reached at least 70%.';
  const recognized = load(positive);
  assert.equal(recognized.claims[0].type, 'atLeastSome');
  assert.equal(runPublishCheck(rows, positive, recognized).status, 'ambiguous');
  const vague = 'North reached 70%.';
  assert.equal(runPublishCheck(rows, vague, load(vague)).status, 'review_required');
});

test('CLI JSON reports a pass, a publish failure, and invalid inputs with distinct exit codes', () => {
  const path = fileURLToPath(new URL('../scripts/verify-caption.mjs', import.meta.url));
  const run = name => spawnSync(process.execPath, [
    path, fileURLToPath(example('caption-recheck.json')), fileURLToPath(example(name)), fileURLToPath(example('caption.txt')), '--json',
  ], {encoding: 'utf8'});
  for (const [name, exit, status] of [['current.csv', 0, 'explicit'], ['refreshed.csv', 1, 'conflict'], ['absent.csv', 2, 'invalid_input']]) {
    const runResult = run(name);
    assert.equal(runResult.status, exit, runResult.stderr);
    assert.equal(JSON.parse(runResult.stdout).status, status);
  }
});
