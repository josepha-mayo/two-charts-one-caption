import test from 'node:test';
import assert from 'node:assert/strict';
import {readChart, checkCaption, validateClaims, answer, answerText, readCategoryList, supportedDetail, fits} from '../src/check.mjs';
import {localFacts, cloudPrompt, localPrompt, reviewCloudClaims} from '../src/draft.mjs';
import {questionPrompt, readQuestionDraft} from '../src/brief.mjs';
import {sampleCsv, sampleCaption, cutoffCaption, foodExample} from '../src/sample.mjs';
import {
  addReaderResponse, createReaderLink, createReaderTest, encodeResponse, readReaderLink,
  readReaderTestFile, readerCounts, readerResponseId, restoreReaderTest, saveReaderTest, writeReaderTestFile,
} from '../src/reader.mjs';

const sample = readChart(sampleCsv);
const sampleFacts = validateClaims(localFacts(sample, sampleCaption), sampleCaption, sample.length);

test('category lists reflect edits and callers own the matched IDs', () => {
  const rows = readChart('category,percent\nNorth,20\nSouth,30\nEast,40');
  const matched = readCategoryList(rows, 'North and South');
  assert.deepEqual(matched, [1, 2]);
  matched.pop();
  assert.deepEqual(readCategoryList(rows, 'North and South'), [1, 2]);
  rows[2].label = 'North and South';
  assert.throws(() => readCategoryList(rows, 'North and South'), /different category lists/);
  assert.deepEqual(readCategoryList(rows, '"North" and "South"'), [1, 2]);
  rows.reverse();
  assert.deepEqual(readCategoryList(rows, '"South" and "North"'), [2, 3]);
});

test('a seven-category chart can require six coupled changes to alter a cutoff answer', () => {
  const rows = [20, 20, 20, 20, 20, 20, 10].map((value, index) => ({label: String(index + 1), value}));
  const claims = [{type:'highest', ids:[1, 2, 3, 4, 5, 6]}];
  const result = checkCaption(rows, {type:'atLeast', cutoff:30}, claims);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.changedCategories, 6);
  assert.equal(result.alternate[6], 10);
  assert.deepEqual(result.alternateAnswer, [1, 2, 3, 4, 5, 6]);
  assert.ok(fits(result.alternate, claims));
});

test('the USDA example preserves both caption facts while changing the highest-rate answer', () => {
  const {csv, caption, question} = foodExample;
  const rows = readChart(csv);
  const claims = validateClaims(localFacts(rows, caption), caption, rows.length);
  assert.deepEqual(claims.map(claim => claim.type), ['range', 'lowest']);

  const before = checkCaption(rows, question, claims);
  assert.equal(before.status, 'ambiguous');
  assert.equal(answerText(rows, before.expected), 'South');
  assert.equal(answerText(rows, before.alternateAnswer), 'Midwest and South');
  assert.equal(before.changedCategories, 1);
  assert.deepEqual(before.alternate, [12.2, 15, 15, 12.9]);
  assert.ok(fits(before.alternate, claims));

  const revised = `${caption} ${supportedDetail(rows, question, before.expected)}`;
  const after = checkCaption(rows, question, validateClaims(localFacts(rows, revised), revised, rows.length));
  assert.equal(after.status, 'explicit');
  assert.deepEqual(after.expected, before.expected);
});

test('caption repairs keep colliding category names distinct and round-trip all selections', () => {
  const labels = ['North', 'South', 'North and South', '"North"', 'None', 'All categories', 'Had a rate, at 5%. A'];
  const question = {type: 'atLeast', cutoff: 70};
  const rows = labels.map(label => ({label, value: 10}));
  assert.equal(answerText(rows, [1, 2]), 'the 2 categories "North" and "South"');
  assert.equal(answerText(rows, [3]), 'the category "North and South"');
  assert.equal(answerText(rows, [5]), 'the category "None"');
  assert.throws(() => localFacts(rows, 'Only North and South reached at least 70%.'), /Put each name in double quotes/);
  assert.deepEqual(localFacts(rows, 'Only "North" and "South" reached at least 70%.')[0].ids, [1, 2]);
  const legacy = [{label: 'North "Campus', value: 80}, {label: 'South', value: 10}];
  assert.deepEqual(localFacts(legacy, 'North "Campus had the highest rate, at 80%.')[0].ids, [1]);

  const answers = new Set();
  for (let mask = 0; mask < (1 << labels.length); mask++) {
    const chart = rows.map((row, i) => ({...row, value: mask & (1 << i) ? 80 : 10}));
    const ids = answer(chart.map(row => row.value), question);
    const text = answerText(chart, ids);
    assert.equal(answers.has(text), false, text);
    answers.add(text);
    const cutoff = supportedDetail(chart, question, ids);
    assert.deepEqual(localFacts(chart, cutoff), [{...question, ids, evidence: cutoff}]);

    const ranked = answer(chart.map(row => row.value), 'highest');
    const rank = supportedDetail(chart, 'highest', ranked);
    assert.deepEqual(localFacts(chart, rank), [{
      type: 'highest', ids: ranked, value: chart[ranked[0] - 1].value, evidence: rank,
    }]);
  }
});

test('three tied rates must move together when the remaining categories are pinned below a cutoff', () => {
  const rows = [70.01, 70.01, 70.01, 69.99, 69.99, 69.99, 69.99]
    .map((value, index) => ({label: `Region ${index + 1}`, value}));
  const claims = [
    {type: 'highest', ids: [1, 2, 3]},
    {type: 'lowest', ids: [4, 5, 6, 7], value: 69.99},
  ];
  const result = checkCaption(rows, {type: 'atLeast', cutoff: 70.01}, claims);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.changedCategories, 3);
  assert.deepEqual(result.alternate, [70, 70, 70, 69.99, 69.99, 69.99, 69.99]);
  assert.deepEqual(result.alternateAnswer, []);
});

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
  const candidates = [[99, 80, 65.1], [71.5, 69.2, 65.1], [65.1, 69.234, 71.5], [71.5, 65.1, 65.1]];
  const result = checkCaption(sample, 'lowest', sampleFacts, candidates);
  assert.equal(result.origin, 'cloud');
  assert.deepEqual(result.alternate, [71.5, 65.1, 65.1]);
  assert.deepEqual(result.alternateAnswer, [2, 3]);
});

test('one bar reaching a cutoff beats swapping or redrawing the chart', () => {
  const rows = readChart('category,percent\nA,15\nB,40\nC,80');
  const claims = localFacts(rows, 'Rates ranged from 15% to 80%.');
  const result = checkCaption(rows, {type: 'atLeast', cutoff: 50}, claims, [[80, 55, 15]]);
  assert.deepEqual(result.alternate, [15, 50, 80]);
  assert.deepEqual(result.alternateAnswer, [2, 3]);
  assert.equal(result.changedCategories, 1);
  assert.equal(result.origin, 'browser');
});

test('the smallest edit can require a whole tied group to move', () => {
  const rows = readChart('category,percent\nA,25\nB,25\nC,25\nD,70');
  const claims = [{type: 'lowest', ids: [1, 2, 3]}, {type: 'value', id: 4, value: 70}];
  const result = checkCaption(rows, {type: 'atLeast', cutoff: 30}, claims);
  assert.equal(result.changedCategories, 3);
  assert.deepEqual(result.alternateAnswer, [1, 2, 3, 4]);
  assert.ok(fits(result.alternate, claims));
});

test('a ranked category’s quoted rate stays fixed in either kind of alternate', () => {
  const rows = readChart('category,percent\nNorth,78\nCentral,64\nSouth,48');
  const caption = 'North had the highest rate, at 78%.';
  const question = {type: 'atLeast', cutoff: 75};
  const claim = {type: 'highest', ids: [1], evidence: caption};
  assert.deepEqual(localFacts(rows, caption), [{...claim, value: 78}]);
  const reviewed = reviewCloudClaims(rows, caption, [claim]).claims;
  const before = checkCaption(rows, question, reviewed, [[80, 76, 48]]);
  assert.equal(before.status, 'ambiguous');
  assert.equal(before.origin, 'browser');
  assert.equal(before.alternate[0], 78);
  assert.equal(checkCaption(rows, question, reviewed, [[78, 75, 48]]).origin, 'cloud');
});

test('custom exact values and a tied rate are parsed independently of the current chart', () => {
  const rows = readChart('category,percent\nSt. Louis,45\nSouth,45\nCentral,60');
  const caption = 'Central had a rate of 58%. St. Louis and South shared the lowest rate, at 44%.';
  const claims = validateClaims(localFacts(rows, caption), caption, rows.length);
  assert.deepEqual(claims, [
    {type: 'value', id: 3, value: 58, evidence: 'Central had a rate of 58%.'},
    {type: 'lowest', ids: [1, 2], value: 44, evidence: 'St. Louis and South shared the lowest rate, at 44%.'},
  ]);
  assert.equal(checkCaption(rows, 'lowest', claims).status, 'conflict');
  const matching = rows.map((row, index) => ({...row, value: [44, 44, 58][index]}));
  assert.equal(checkCaption(matching, 'lowest', claims).status, 'explicit');
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
        const witnesses = all.filter(values => fits(values, scenario) && differs(values));
        const result = checkCaption(rows, question, scenario);
        assert.equal(result.status === 'ambiguous', Boolean(witnesses.length));
        if (witnesses.length) {
          assert.ok(fits(result.alternate, scenario));
          assert.ok(differs(result.alternate));
          const changes = values => values.filter((value, i) => value !== actual[i]).length;
          assert.equal(result.changedCategories, Math.min(...witnesses.map(changes)));
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

test('a saved test carries forward old invitations and deduplicates replies in a new editor', () => {
  const question = {type: 'atLeast', cutoff: 70};
  const after = cutoffCaption + ' Only Local and Select Bus Service reached at least 70%.';
  let test = createReaderTest(sample, question, [1, 2], cutoffCaption, after);
  const id = crypto.randomUUID();
  const oldReply = encodeResponse(test.before.invitation, id, null);
  const pendingReply = encodeResponse(test.after.invitation, crypto.randomUUID(), [1, 2]);
  test = addReaderResponse(test, oldReply).test;

  const restored = readReaderTestFile(writeReaderTestFile(test));
  assert.deepEqual(restored, test);
  assert.equal(addReaderResponse(restored, oldReply).action, 'Updated');
  const later = addReaderResponse(restored, pendingReply).test;
  assert.deepEqual(readerCounts(later, 'before'), {correct: 0, uncertain: 1, different: 0});
  assert.deepEqual(readerCounts(later, 'after'), {correct: 1, uncertain: 0, different: 0});

  const file = JSON.parse(writeReaderTestFile(test));
  file.test.before.responses[0].invitation = file.test.after.invitation;
  assert.throws(() => readReaderTestFile(JSON.stringify(file)), /invalid captions, invitations, or responses/);
  assert.throws(() => readReaderTestFile('{"version":1}'), /Save reader test/);
  assert.throws(() => readReaderTestFile('é'.repeat(32_001)), /64 KB/);
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

test('a cloud draft cannot pin the middle bar with a quote that only states the range', () => {
  const facts = localFacts(sample, cutoffCaption);
  const invented = {type: 'value', id: 2, value: 70.5, evidence: facts[0].evidence};
  const {claims, excluded, restored} = reviewCloudClaims(sample, cutoffCaption, [...facts.slice(1), invented]);
  assert.equal(excluded, 1);
  assert.equal(restored, 1);
  assert.deepEqual(claims, facts);
  const result = checkCaption(sample, {type: 'atLeast', cutoff: 70}, claims);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.alternate, [71.5, 69.99, 65.1]);
});

test('cloud review rejects altered facts when it recognizes their quotes inside mixed wording', () => {
  const caption = 'Buses were slow in the morning. Local had the highest rate, at 71.5%. ' +
    'Select Bus Service had a rate of 70.5%.';
  const drafted = [
    {type: 'highest', ids: [1], value: 75, evidence: 'Local had the highest rate, at 71.5%.'},
    {type: 'value', id: 1, value: 70.5, evidence: 'Select Bus Service had a rate of 70.5%'},
    {type: 'highest', ids: [1], evidence: 'Local had the highest rate, at 71.5%.'},
  ];
  const {claims, excluded, restored} = reviewCloudClaims(sample, caption, drafted);
  assert.deepEqual(claims, [{...drafted[2], value: 71.5},
    {type: 'value', id: 2, value: 70.5, evidence: 'Select Bus Service had a rate of 70.5%.'}]);
  assert.equal(excluded, 2);
  assert.equal(restored, 1);
  const paraphrased = 'Local led all services with an on-time rate of 71.5%.';
  const cloud = {type: 'highest', ids: [1], value: 71.5, evidence: paraphrased};
  assert.deepEqual(reviewCloudClaims(sample, paraphrased, [cloud]).claims, [cloud]);
});

test('cloud review restores an omitted exact answer or contradiction from mixed prose', () => {
  const question = {type: 'atLeast', cutoff: 70};
  const known = 'Only Local and Select Bus Service reached at least 70%.';
  const prefix = 'The committee reviewed these rates. ';
  const excerpt = 'Select Bus Service reached at least 70%.';
  const draft = {type: 'value', id: 3, value: 70, evidence: '70%'};
  const recovered = reviewCloudClaims(sample, prefix + known, [draft]);
  assert.deepEqual(recovered.claims, [{...question, ids: [1, 2], evidence: known}]);
  assert.equal(recovered.excluded, 1);
  assert.equal(recovered.restored, 1);
  assert.equal(checkCaption(sample, question, recovered.claims).status, 'explicit');
  const contradictory = reviewCloudClaims(sample, prefix + 'Only ' + excerpt, []);
  assert.equal(checkCaption(sample, question, contradictory.claims).status, 'conflict');
});

test('quoted examples, asides, abbreviations and qualifications do not establish standalone facts', () => {
  const question = {type: 'atLeast', cutoff: 70};
  const fake = 'Only Express reached at least 70%.';
  const actual = 'Only Local and Select Bus Service reached at least 70%.';
  const draft = {...question, ids: [3], evidence: fake};
  const prefixes = [
    'An earlier draft read “Old example. ' + fake + '” ',
    'The editor wrote (unverified example. ' + fake + ') ',
    'The editor wrote \'unverified example. ' + fake + '\' ',
    'An earlier draft read "Old example. ' + fake + '" ',
    'The report used illustrative phrases, e.g. ' + fake + ' ',
    'Only Express reached at least 70%, if the estimates are right. ',
  ];
  for (const prefix of prefixes) {
    const reviewed = reviewCloudClaims(sample, prefix + actual, prefix.includes(fake) ? [draft] : []);
    assert.deepEqual(reviewed.claims, [{...question, ids: [1, 2], evidence: actual}], prefix);
  }
  const rows = [{label: 'Route 9. East', value: 70}, {label: 'Route 9 West', value: 30}];
  const quotedName = 'Only the category "Route 9. East" reached at least 70%.';
  assert.deepEqual(reviewCloudClaims(rows, 'Service improved. ' + quotedName, []).claims,
    [{...question, ids: [1], evidence: quotedName}]);
});

test('positive cutoff evidence constrains named categories and leaves the other bars open', () => {
  const rows = readChart('category,percent\nNorth,78\nCentral,64\nSouth,48');
  const question = {type: 'atLeast', cutoff: 70};
  const evidence = 'North reached at least 70%.';
  const cloud = reviewCloudClaims(rows, evidence, [{...question, ids: [1], evidence}]);
  assert.deepEqual(cloud, {claims: [{type: 'atLeastSome', cutoff: 70, ids: [1], evidence}], excluded: 0, narrowed: 1, restored: 0});
  assert.deepEqual(localFacts(rows, evidence), cloud.claims);
  const result = checkCaption(rows, question, cloud.claims, [[69, 70, 48]]);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.alternate, [78, 70, 48]);
  assert.deepEqual(result.alternateAnswer, [1, 2]);
  const complete = 'Only North met or exceeded 70 percent.';
  const reviewed = reviewCloudClaims(rows, complete, [{...question, ids: [1], evidence: complete}]);
  assert.equal(checkCaption(rows, question, reviewed.claims).status, 'explicit');
});

test('cutoff evidence names the right categories and comes from a standalone sentence', () => {
  const rows = readChart('category,percent\nNorth,65\nNorth East,74\nSouth,72');
  const question = {type: 'atLeast', cutoff: 70};
  const evidence = 'North East reached at least 70%.';
  assert.equal(reviewCloudClaims(rows, evidence, [{...question, ids: [1], evidence}]).excluded, 1);
  assert.equal(reviewCloudClaims(rows, 'Only ' + evidence, [{...question, ids: [2], evidence}]).excluded, 1);
  const conditional = 'Only North East reached at least 70%, if the draft is correct.';
  assert.equal(reviewCloudClaims(rows, conditional, [{...question, ids: [2], evidence: conditional}]).excluded, 1);
  assert.equal(reviewCloudClaims(rows, evidence, [{...question, ids: [2], evidence: evidence.slice(0, -1)}]).narrowed, 1);
});
