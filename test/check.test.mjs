import test from 'node:test';
import assert from 'node:assert/strict';
import {readChart, checkCaption, validateClaims, answer, supportedDetail, fits} from '../src/check.mjs';
import {localFacts, cloudPrompt, localPrompt, reviewCloudClaims} from '../src/draft.mjs';
import {questionPrompt, readQuestionDraft} from '../src/brief.mjs';
import {sampleCsv, sampleCaption} from '../src/sample.mjs';
import {
  addReaderResponse, createReaderLink, createReaderTest, encodeResponse, readReaderLink,
  readerCounts, readerResponseId, restoreReaderTest, saveReaderTest,
} from '../src/reader.mjs';

const sample = readChart(sampleCsv);
const sampleFacts = validateClaims(localFacts(sample, sampleCaption), sampleCaption, sample.length);

test('the public example has a real alternate, and the added fact resolves that question', () => {
  const before = checkCaption(sample, 'lowest', sampleFacts);
  assert.equal(before.status, 'ambiguous');
  assert.equal(before.origin, 'browser');
  assert.deepEqual(before.expected, [3]);
  assert.notDeepEqual(before.alternateAnswer, before.expected);
  assert.ok(fits(before.alternate, sampleFacts));
  const revised = `${sampleCaption} ${supportedDetail(sample, 'lowest', before.expected)}`;
  const after = checkCaption(sample, 'lowest', validateClaims(localFacts(sample, revised), revised, sample.length));
  assert.equal(after.status, 'explicit');
  assert.deepEqual(after.expected, before.expected);
  assert.equal(after.alternate, undefined);
});

test('cloud candidates must satisfy the approved range, change the answer and stay within precision bounds', () => {
  const candidates = [[99, 80, 65.1], [71.5, 69.2, 65.1], [65.1, 69.234, 71.5], [65.1, 69.2, 71.5]];
  const result = checkCaption(sample, 'lowest', sampleFacts, candidates);
  assert.equal(result.origin, 'cloud');
  assert.deepEqual(result.alternate, [65.1, 69.2, 71.5]);
  assert.deepEqual(result.alternateAnswer, [1]);
});

test('a false claim is a contradiction even when the cloud can generate a candidate', () => {
  const falseCaption = 'Rates ranged from 55% to 71.5%.';
  const result = checkCaption(sample, 'lowest', localFacts(sample, falseCaption), [[55, 66, 71.5]]);
  assert.equal(result.status, 'conflict');
  assert.equal(result.alternate, undefined);
});

test('ties are answers and the checked revision names all tied categories on a fresh chart', () => {
  const rows = readChart('service,percent\nReading Room,19.3\n"Children, East",19.3\nCheckout,31');
  assert.deepEqual(answer(rows.map(row => row.value), 'lowest'), [1, 2]);
  const sentence = supportedDetail(rows, 'lowest', [1, 2]);
  assert.equal(sentence, 'Reading Room and Children, East shared the lowest rate, at 19.3%.');
  assert.throws(() => supportedDetail(rows, 'lowest', [1]), /disagrees/);
  assert.equal(checkCaption(rows, 'lowest', localFacts(rows, sentence)).status, 'explicit');
  assert.equal(checkCaption(rows, 'highest', localFacts(rows, 'Rates ranged from 19.3% to 31%.')).status, 'ambiguous');
});

test('unsupported text, invisible evidence, duplicate names, and invalid data fail visibly', () => {
  assert.throws(() => localFacts(sample, sampleCaption + ' A policy caused it.'), /cloud fact draft/);
  assert.throws(() => validateClaims([{...sampleFacts[0], evidence: 'invented quote'}], sampleCaption, 3), /excerpt/);
  assert.throws(() => readChart('service,percent\nFoo,92\nfoo,30'), /unique/);
  assert.throws(() => readChart('service,percent\nFoo,101\nBar,30'), /0 to 100/);
});

test('cloud draft receives only the approved caption and category names, with private values confined to the local route', () => {
  const cloud = cloudPrompt(sample, 'lowest', sampleCaption);
  const local = localPrompt(sample, {type: 'atLeast', cutoff: 70});
  assert.ok(cloud.includes('Select Bus Service'));
  assert.ok(cloud.includes('65.1%'));
  assert.ok(!cloud.includes('70.5'));
  assert.match(local, /greater than or equal to 70/);
  assert.match(local, /^2 \| 70\.5$/m);
  assert.ok(!local.includes(sampleCaption));
  assert.ok(!cloud.includes('"value":'));
});

test('a flat stated range mathematically forces an all-category tie', () => {
  const rows = readChart('service,percent\nA,25\nB,25');
  const result = checkCaption(rows, 'lowest', localFacts(rows, 'Rates ranged from 25% to 25%.'));
  assert.equal(result.status, 'implied');
  assert.deepEqual(result.expected, [1, 2]);
});

test('the solver finds a new value when rearranging the source numbers would miss the gap', () => {
  const rows = readChart('service,percent\nA,10\nB,90');
  const claims = [{type: 'value', id: 1, value: 10}];
  const result = checkCaption(rows, 'lowest', claims);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.alternate[0], 10);
  assert.notDeepEqual(result.alternateAnswer, [1]);
});

test('range and a pinned lowest figure still permit a new tie', () => {
  const rows = readChart('service,percent\nA,10\nB,20\nC,30');
  const claims = [{type: 'range', min: 10, max: 30}, {type: 'value', id: 1, value: 10}];
  const result = checkCaption(rows, 'lowest', claims);
  assert.equal(result.status, 'ambiguous');
  assert.ok(fits(result.alternate, claims));
  assert.notDeepEqual(result.alternateAnswer, result.expected);
});

test('checking bounded percentage domains agrees with exhaustive enumeration across varied constraints', () => {
  const domain = [0, 0.01, 0.02, 0.03];
  const all = domain.flatMap(a => domain.flatMap(b => domain.map(c => [a, b, c])));
  for (const actual of all) {
    const rows = actual.map((value, i) => ({label: String(i + 1), value}));
    const range = {type: 'range', min: Math.min(...actual), max: Math.max(...actual)};
    const high = {type: 'highest', ids: answer(actual, 'highest')};
    const low = {type: 'lowest', ids: answer(actual, 'lowest')};
    for (const scenario of [[range], [range, high], [range, low], [range, {type: 'value', id: 2, value: actual[1]}]]) {
      for (const question of ['lowest', 'highest']) {
        const expected = answer(actual, question);
        const differs = values => String(answer(values, question)) !== String(expected);
        const witness = all.some(values => fits(values, scenario) && differs(values));
        const result = checkCaption(rows, question, scenario);
        assert.equal(result.status === 'ambiguous', witness);
        if (witness) {
          assert.ok(fits(result.alternate, scenario));
          assert.ok(differs(result.alternate));
        }
      }
    }
  }
});

test('a reader link contains exactly the approved text, names, and question', () => {
  const url = new URL(createReaderLink('http://localhost:5173/#other', sample, 'lowest', sampleCaption));
  const decoded = decodeURIComponent(url.hash);
  assert.ok(decoded.includes('65.1%'));
  assert.ok(!decoded.includes('70.5'));
  assert.ok(!decoded.includes('"expected"'));
  assert.deepEqual(readReaderLink(url.hash), {
    caption: sampleCaption, question: 'lowest', labels: sample.map(row => row.label),
  });
  assert.equal(url.search, '');
  assert.throws(() => readReaderLink('#reader=%7B%7D'));
});

test('before and after links are independent, and their response codes round-trip without source values', () => {
  const after = sampleCaption + ' ' + supportedDetail(sample, 'lowest', [3]);
  let check = createReaderTest(sample, 'lowest', [3], sampleCaption, after);
  const url = new URL(createReaderLink('https://example.test/?draft=private', sample, 'lowest', sampleCaption, check.before.invitation));
  assert.equal(url.search, '');
  assert.deepEqual(readReaderLink(url.hash), {
    caption: sampleCaption, question: 'lowest', labels: sample.map(({label}) => label), invitation: check.before.invitation,
  });
  assert.notEqual(check.before.invitation, check.after.invitation);
  assert.ok(!decodeURIComponent(url.hash).includes('70.5'));
  const beforeId = crypto.randomUUID();
  const afterId = crypto.randomUUID();
  const unsure = encodeResponse(check.before.invitation, beforeId, null);
  const correct = encodeResponse(check.after.invitation, afterId, [3]);
  check = addReaderResponse(check, unsure).test;
  check = addReaderResponse(check, correct).test;
  assert.deepEqual(readerCounts(check, 'before'), {correct: 0, uncertain: 1, different: 0});
  assert.deepEqual(readerCounts(check, 'after'), {correct: 1, uncertain: 0, different: 0});
  assert.throws(() => addReaderResponse(check, encodeResponse(crypto.randomUUID(), beforeId, [3])), /different reader test/);
  assert.throws(() => addReaderResponse(check, encodeResponse(check.before.invitation, beforeId, [4])), /invalid/);
  assert.throws(() => addReaderResponse(check, 'No response yet.'), /Paste/);
  const duplicate = addReaderResponse(check, unsure);
  assert.equal(duplicate.action, 'Updated');
  assert.deepEqual(readerCounts(duplicate.test, 'before'), readerCounts(check, 'before'));
});

test('a reader can revise a tied answer without adding another response, and the test survives reload', () => {
  const rows = readChart('service,percent\nA,20\nB,20\nC,40');
  const before = 'Rates ranged from 20% to 40%.';
  const after = before + ' ' + supportedDetail(rows, 'lowest', [1, 2]);
  const values = new Map();
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  let check = createReaderTest(rows, 'lowest', [1, 2], before, after);
  const id = readerResponseId(storage, check.after.invitation);
  check = addReaderResponse(check, encodeResponse(check.after.invitation, id, [1])).test;
  assert.equal(readerCounts(check, 'after').different, 1);
  assert.equal(readerResponseId(storage, check.after.invitation), id);
  check = addReaderResponse(check, encodeResponse(check.after.invitation, id, [1, 2])).test;
  assert.deepEqual(readerCounts(check, 'after'), {correct: 1, uncertain: 0, different: 0});
  assert.ok(saveReaderTest(storage, check));
  assert.deepEqual(restoreReaderTest(storage), check);
  assert.equal(saveReaderTest(undefined, check), false);
  assert.equal(restoreReaderTest(undefined), null);
});

test('cutoff changes the eligible categories while both charts retain the stated range and endpoints', () => {
  const question = {type: 'atLeast', cutoff: 70.5};
  const claims = [...sampleFacts,
    {type: 'highest', ids: [1]},
    {type: 'lowest', ids: [3]}];
  const result = checkCaption(sample, question, claims, [[71.5, 70.5, 65.1], [71.5, 70.49, 60]]);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.origin, 'browser');
  assert.deepEqual(result.expected, [1, 2]);
  assert.deepEqual(result.alternate, [71.5, 70.49, 65.1]);
  assert.deepEqual(result.alternateAnswer, [1]);
  assert.ok(fits(result.alternate, claims));
  const evidence = supportedDetail(sample, question, result.expected);
  const revised = sampleCaption + ' ' + evidence;
  const checked = validateClaims(localFacts(sample, revised), revised, sample.length);
  assert.equal(checkCaption(sample, question, checked).status, 'explicit');
});

test('empty cutoff answers differ from uncertainty, and reader links preserve the inclusive cutoff', () => {
  const question = {type: 'atLeast', cutoff: 80};
  const evidence = supportedDetail(sample, question, []);
  assert.equal(evidence, 'No categories reached 80%.');
  assert.equal(checkCaption(sample, question, localFacts(sample, evidence)).status, 'explicit');
  assert.equal(checkCaption(sample, question, sampleFacts).status, 'implied');
  assert.throws(() => supportedDetail(sample, question, [1]), /disagrees/);
  let reader = createReaderTest(sample, question, [], sampleCaption, sampleCaption + ' ' + evidence);
  const url = new URL(createReaderLink('https://example.test/', sample, question, sampleCaption, reader.before.invitation));
  assert.deepEqual(readReaderLink(url.hash).question, question);
  assert.ok(!decodeURIComponent(url.hash).includes('70.5'));
  reader = addReaderResponse(reader, encodeResponse(reader.after.invitation, crypto.randomUUID(), [])).test;
  reader = addReaderResponse(reader, encodeResponse(reader.after.invitation, crypto.randomUUID(), null)).test;
  assert.deepEqual(readerCounts(reader, 'after'), {correct: 1, uncertain: 1, different: 0});
  assert.throws(() => createReaderLink('https://example.test/', sample, {...question, cutoff: 80.555}, sampleCaption), /two decimal/);
});

test('interval checks agree with exhaustive search for coupled cutoff and ranking claims', () => {
  const domain = [0, 0.01, 0.02, 0.03];
  const vectors = domain.flatMap(a => domain.flatMap(b => domain.map(c => [a, b, c])));
  for (const source of vectors) {
    const rows = source.map((value, i) => ({label: String(i + 1), value}));
    const range = {type: 'range', min: Math.min(...source), max: Math.max(...source)};
    const question = {type: 'atLeast', cutoff: 0.02};
    const otherCutoff = {type: 'atLeast', cutoff: 0.01};
    const high = {type: 'highest', ids: answer(source, 'highest')};
    const low = {type: 'lowest', ids: answer(source, 'lowest')};
    const atLeast = {...otherCutoff, ids: answer(source, otherCutoff)};
    const pin = {type: 'value', id: 2, value: source[1]};
    for (const testedQuestion of [question, 'lowest', 'highest']) {
      const expected = answer(source, testedQuestion);
      for (const claims of [[range, atLeast], [range, atLeast, high], [range, atLeast, low, pin]]) {
        const differs = values => String(answer(values, testedQuestion)) !== String(expected);
        const found = vectors.some(values => fits(values, claims) && differs(values));
        const result = checkCaption(rows, testedQuestion, claims);
        assert.equal(result.status === 'ambiguous', found);
        if (found) {
          assert.ok(fits(result.alternate, claims));
          assert.ok(differs(result.alternate));
        }
      }
    }
  }
});

test('an editor can confirm a quoted cutoff without publishing the private brief', () => {
  const evidence = 'which services reached at least 70 percent';
  const brief = 'Hold until the desk reviews the private budget. Check ' + evidence + '.';
  const draft = readQuestionDraft({kind: 'atLeast', cutoff: 70, evidence}, brief);
  assert.deepEqual(draft, {question: {type: 'atLeast', cutoff: 70}, evidence});
  assert.match(questionPrompt(brief), /private budget/);
  const publicDraft = cloudPrompt(sample, draft.question, sampleCaption);
  assert.match(publicDraft, /"cutoff":70/);
  assert.doesNotMatch(publicDraft, /private budget|70\.5/);
  assert.throws(() => readQuestionDraft({kind: 'atLeast', cutoff: 75, evidence}, brief), /absent/);
  assert.throws(() => readQuestionDraft({kind: 'lowest', evidence: 'fictional quote'}, brief), /did not quote/);
  assert.throws(() => readQuestionDraft({kind: 'unsupported'}, brief), /supported question/);
});

test('an explicit strict or opposite threshold cannot be approved as an inclusive minimum', () => {
  for (const condition of ['more than 70%', 'below 70 percent', 'at most 70%', '>70%']) {
    const evidence = `Which categories have a rate ${condition}?`;
    assert.throws(() => readQuestionDraft({kind: 'atLeast', cutoff: 70, evidence}, evidence), /inclusive minimum/);
  }
  const evidence = 'Show rates at or above 70%.';
  assert.deepEqual(readQuestionDraft({kind: 'atLeast', cutoff: 70, evidence}, evidence).question,
    {type: 'atLeast', cutoff: 70});
});

test('cloud cutoff claims cannot use the question in place of evidence from the caption', () => {
  const caption = sampleCaption + ' Local had the highest rate, at 71.5%. Express had the lowest rate, at 65.1%.';
  const local = localFacts(sample, caption);
  const wrongQuote = {type: 'atLeast', cutoff: 70, ids: [1, 2], evidence: 'Local had the highest rate, at 71.5%.'};
  const reviewed = reviewCloudClaims(sample, caption, [...local, wrongQuote]);
  assert.equal(reviewed.excluded, 1);
  assert.equal(checkCaption(sample, {type: 'atLeast', cutoff: 70}, reviewed.claims).status, 'ambiguous');
  const evidence = 'Only Local and Select Bus Service reached at least 70%.';
  const repaired = reviewCloudClaims(sample, `${caption} ${evidence}`, [...local, {...wrongQuote, evidence}]);
  assert.equal(repaired.excluded, 0);
  assert.equal(checkCaption(sample, {type: 'atLeast', cutoff: 70}, repaired.claims).status, 'explicit');
});
