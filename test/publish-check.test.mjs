import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {readChart, supportedDetail} from '../src/check.mjs';
import {localFacts, unverifiedCaptionExcerpts} from '../src/draft.mjs';
import {foodNationalExample} from '../src/sample.mjs';
import {createPublishCheck, readPublishCheck, runPublishCheck, suggestPublishRepair} from '../src/publish-check.mjs';

const example = name => new URL(`../examples/bus-cutoff/${name}`, import.meta.url);
const readExample = name => readFileSync(example(name), 'utf8');
const caption = readExample('caption.txt').trim();
const check = readPublishCheck(JSON.parse(readExample('caption-recheck.json')));

test('a saved cutoff caption keeps a combined category distinct from its separate parts', () => {
  const source = readChart('category,percent\nNorth,80\nSouth,80\nNorth and South,40');
  const changed = readChart('category,percent\nNorth and South,80\nSouth,40\nNorth,40');
  const question = {type: 'atLeast', cutoff: 70};
  const caption = supportedDetail(source, question, [1, 2]);
  assert.equal(caption, 'Only the 2 categories "North" and "South" reached at least 70%.');
  const saved = createPublishCheck(source, question, caption, localFacts(source, caption));
  assert.equal(runPublishCheck(source, caption, saved).status, 'explicit');
  assert.equal(runPublishCheck(changed, caption, saved).status, 'conflict');
  const replacement = suggestPublishRepair(changed, caption, saved);
  assert.equal(replacement.after, 'Only the category "North and South" reached at least 70%.');
  assert.equal(runPublishCheck(changed, replacement.caption, replacement.check).status, 'explicit');
});

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

test('a rate reaching the benchmark invalidates and repairs a saved below claim', () => {
  const {csv, caption, question} = foodNationalExample;
  const rows = readChart(csv);
  const claim = supportedDetail(rows, question, [1, 2, 4]);
  const published = `${caption} ${claim}`;
  const saved = createPublishCheck(rows, question, published, localFacts(rows, published));
  assert.equal(runPublishCheck(rows, published, saved).status, 'explicit');

  const hypothetical = rows.map(row => row.label === 'Midwest' ? {...row, value: 13.7} : row);
  const conflict = runPublishCheck(hypothetical, published, saved);
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.failedFacts, [claim]);
  const repaired = suggestPublishRepair(hypothetical, published, saved);
  assert.equal(repaired.after, 'Only Northeast and West fell below 13.7%.');
  assert.equal(repaired.caption, `${caption} ${repaired.after}`);
  assert.equal(runPublishCheck(hypothetical, repaired.caption, repaired.check).status, 'explicit');
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

test('repair replaces one reviewed sentence and keeps the other caption text and facts', () => {
  const refreshed = readChart(readExample('refreshed.csv')).reverse();
  const source = `  ${caption}\nRates refer to the original reporting period.  `;
  const archived = readPublishCheck({...check, caption: source});
  const repair = suggestPublishRepair(refreshed, source, archived);
  assert.equal(repair.before, 'Only Local and Select Bus Service reached at least 70%.');
  assert.equal(repair.after, 'Only Local reached at least 70%.');
  assert.equal(repair.caption, source.replace(repair.before, repair.after));
  assert.deepEqual(repair.check.claims.slice(0, -1), archived.claims.slice(0, -1));
  assert.deepEqual(runPublishCheck(refreshed, repair.caption, repair.check), {
    status: 'explicit',
    question: 'Which categories reached at least 70%?',
    sourceAnswer: 'Local',
    uncheckedWordingCount: 1,
  });
  const original = readChart(readExample('current.csv'));
  const reversed = suggestPublishRepair(original, repair.caption, repair.check);
  assert.equal(reversed.caption, source);
});

test('repair does not guess when the stale quote is duplicated, partial, or accompanied by other conflicts', () => {
  const refreshed = readChart(readExample('refreshed.csv'));
  const duplicate = readPublishCheck({...check, caption: `${caption} ${check.claims.at(-1).evidence}`});
  assert.equal(suggestPublishRepair(refreshed, duplicate.caption, duplicate), undefined);
  const staleRange = refreshed.map(row => row.label === 'Express' ? {...row, value: 62} : row);
  assert.equal(suggestPublishRepair(staleRange, caption, check), undefined);
  assert.equal(suggestPublishRepair(refreshed, caption + ' Unreviewed text.', check), undefined);
  const evidence = 'Local had the highest rate, at 71.5%.';
  const fragment = readPublishCheck({...check, question: 'highest', caption: `The draft incorrectly stated that ${evidence}`,
    claims: [{type: 'highest', ids: [1], value: 71.5, evidence}]});
  const changedRank = refreshed.map(row => row.label === 'Local' ? {...row, value: 68} : row);
  assert.equal(suggestPublishRepair(changedRank, fragment.caption, fragment), undefined);
});

test('repair verifies newly tied answers and a cutoff with no qualifying categories', () => {
  const rows = readChart('category,percent\nNorth,65\nSouth,65');
  const ranking = {type: 'highest', ids: [1], value: 70, evidence: 'North had the highest rate, at 70%.'};
  const cutoff = {type: 'atLeast', cutoff: 70, ids: [1], evidence: 'Only North reached at least 70%.'};
  for (const [claim, question, expected] of [
    [ranking, 'highest', 'North and South shared the highest rate, at 65%.'],
    [cutoff, {type: 'atLeast', cutoff: 70}, 'No categories reached 70%.'],
  ]) {
    const original = createPublishCheck(rows, question, claim.evidence, [claim]);
    const repair = suggestPublishRepair(rows, original.caption, original);
    assert.equal(repair.after, expected);
    assert.equal(runPublishCheck(rows, repair.caption, repair.check).status, 'explicit');
  }
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

test('CLI rechecks the chosen columns of a fresh spreadsheet export', t => {
  const directory = mkdtempSync(join(tmpdir(), 'two-charts-cli-'));
  const csvPath = join(directory, 'export.csv');
  const mapping = ['--category-column', 'Bus service', '--percent-column', 'On-time rate'];
  const script = fileURLToPath(new URL('../scripts/verify-caption.mjs', import.meta.url));
  const run = headers => spawnSync(process.execPath, [
    script, fileURLToPath(example('caption-recheck.json')), csvPath, fileURLToPath(example('caption.txt')), '--json', ...headers,
  ], {encoding: 'utf8'});
  t.after(() => {
    unlinkSync(csvPath);
    rmdirSync(directory);
  });
  writeFileSync(csvPath, '"Internal notes","On-time rate","Bus service"\r\nalpha,"71.5%",Local\r\n"note, private","70.5%",Select Bus Service\r\nbeta,65.1,Express\r\n');
  const valid = run(mapping);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).status, 'explicit');
  assert.doesNotMatch(valid.stdout, /Internal notes|note, private/);
  const missing = run(mapping.slice(0, 2));
  assert.equal(missing.status, 2);
  assert.match(JSON.parse(missing.stdout).message, /Specify both/);
});

test('a saved rate column prevents CI from passing the caption against last week’s data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'two-charts-rate-'));
  const csvPath = join(directory, 'export.csv');
  const checkPath = join(directory, 'check.json');
  const selected = {category: 'Bus service', rate: 'On-time rate'};
  const rows = readChart(readExample('current.csv'));
  const saved = createPublishCheck(rows, check.question, caption, check.claims, selected);
  writeFileSync(checkPath, JSON.stringify(saved));
  writeFileSync(csvPath, 'Last week rate,Bus service,On-time rate\n71.5,Local,71.5\n70.5,Select Bus Service,69.99\n65.1,Express,65.1\n');
  t.after(() => {
    unlinkSync(csvPath);
    unlinkSync(checkPath);
    rmdirSync(directory);
  });

  const script = fileURLToPath(new URL('../scripts/verify-caption.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [
    script, checkPath, csvPath, fileURLToPath(example('caption.txt')), '--json', ...args,
  ], {encoding: 'utf8'});
  const refreshed = run();
  assert.equal(refreshed.status, 1, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).status, 'conflict');
  const wrong = run('--category-column', 'Bus service', '--percent-column', 'Last week rate');
  assert.equal(wrong.status, 1, wrong.stderr);
  assert.match(JSON.parse(wrong.stdout).message, /saved for “On-time rate” grouped by “Bus service”/);
  const repair = suggestPublishRepair(readChart(readExample('refreshed.csv')), caption, saved, selected);
  assert.deepEqual(repair.check.columns, selected);
  assert.equal(suggestPublishRepair(rows, caption, saved), undefined);
});

test('a resolved question can leave contextual prose for editorial review', t => {
  const directory = mkdtempSync(join(tmpdir(), 'two-charts-wording-'));
  const captionPath = join(directory, 'caption.txt');
  const checkPath = join(directory, 'check.json');
  const excerpt = 'Dr. North tentatively attributed the result to PRIVATE_CONTEXT.';
  const text = excerpt + '\r\n' + caption;
  const rows = readChart(readExample('current.csv'));
  const saved = createPublishCheck(rows, check.question, text, check.claims);
  assert.deepEqual(unverifiedCaptionExcerpts(rows, text, saved.claims), [excerpt]);
  assert.deepEqual(unverifiedCaptionExcerpts(rows, caption, check.claims), []);
  const interpretation = 'Express came in at 65.1% after five years of upgrades.';
  assert.deepEqual(unverifiedCaptionExcerpts(rows, interpretation, [
    {type: 'value', id: 3, value: 65.1, evidence: interpretation},
  ]), [interpretation]);
  writeFileSync(checkPath, JSON.stringify(saved));
  writeFileSync(captionPath, text);
  t.after(() => {
    unlinkSync(checkPath);
    unlinkSync(captionPath);
    rmdirSync(directory);
  });

  const script = fileURLToPath(new URL('../scripts/verify-caption.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [
    script, checkPath, fileURLToPath(example('current.csv')), captionPath, '--json', ...args,
  ], {encoding: 'utf8'});
  const ordinary = run();
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(JSON.parse(ordinary.stdout).status, 'explicit');
  const strict = run('--require-checked-wording');
  assert.equal(strict.status, 1, strict.stderr);
  assert.deepEqual(
    [JSON.parse(strict.stdout).status, JSON.parse(strict.stdout).uncheckedWordingCount],
    ['review_required', 1],
  );
  assert.doesNotMatch(ordinary.stdout + strict.stdout, /PRIVATE_CONTEXT/);
});
