import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {answerText, captionCoverage, checkCaption, readChart, smallestAnswerShift, supportedDetail} from '../src/check.mjs';
import {localFacts} from '../src/draft.mjs';
import {readEditorialDraft, writeEditorialDraft} from '../src/editorial-draft.mjs';
import {createPublishCheck, readPublishCheck, runPublishCheck, suggestPublishRepair} from '../src/publish-check.mjs';
import {addReaderResponse, createReaderLink, createReaderTest, encodeResponse, readReaderLink, readReaderTestFile, writeReaderTestFile} from '../src/reader.mjs';

const fixture = name => readFileSync(new URL('../examples/bls-unemployment/' + name, import.meta.url), 'utf8');

test('the published BLS revision invalidates just the previously checked cutoff sentence', () => {
  const first = readChart(fixture('first-published.csv'));
  const revised = readChart(fixture('revised.csv'));
  assert.equal(first.length, 12);
  assert.deepEqual(first.flatMap(({label, value}, i) => value === revised[i].value ? [] : [label]), ['March', 'July']);
  const saved = JSON.parse(fixture('caption-recheck.json'));
  const caption = saved.caption.replace(' July had a rate of 4.3%.', '');
  const check = readPublishCheck({...saved, caption, claims: saved.claims.slice(0, 2)});
  const original = runPublishCheck(first, caption, check);
  assert.equal(original.status, 'explicit');
  assert.equal(original.decimalPlaces, 1);
  assert.equal(original.sourceAnswer, 'January and March');
  const after = runPublishCheck(revised, caption, check);
  assert.equal(after.status, 'conflict');
  assert.equal(after.sourceAnswer, 'January');
  const repair = suggestPublishRepair(revised, caption, check);
  assert.equal(repair.before, 'Only January and March fell below 3.9%.');
  assert.equal(repair.after, 'Only January fell below 3.9%.');
  assert.equal(repair.check.claims[0].evidence, check.claims[0].evidence);
  assert.equal(repair.check.decimalPlaces, 1);
  assert.equal(runPublishCheck(revised, repair.caption, repair.check).status, 'explicit');
  const draft = readEditorialDraft(writeEditorialDraft({
    rows: revised, caption: repair.caption, question: check.question, review: repair.check, decimalPlaces: 1,
  }));
  assert.deepEqual(readChart(draft.csv), revised);
  assert.deepEqual(draft.review, repair.check);
  assert.equal(draft.decimalPlaces, 1);
});

test('the live BLS rates can update the cutoff answer and a separate July figure together', () => {
  const original = readChart(fixture('first-published.csv'));
  const current = readChart(fixture('revised.csv')).reverse();
  const text = fixture('caption.txt').trim().replace(' July', '\n\nJuly');
  const question = {type:'below', cutoff:3.9};
  const check = createPublishCheck(original, question, text, localFacts(original, text), undefined, 1);
  const expected = [
    {before:'Only January and March fell below 3.9%.', after:'Only January fell below 3.9%.'},
    {before:'July had a rate of 4.3%.', after:'July had a rate of 4.2%.'},
  ];
  assert.deepEqual(runPublishCheck(current, text, check).failedFacts, expected.map(({before}) => before));
  const repair = suggestPublishRepair(current, text, check);
  assert.deepEqual(repair.changes, expected);
  assert.equal(repair.caption, 'January had the lowest rate, at 3.7%. Only January fell below 3.9%.\n\nJuly had a rate of 4.2%.');
  assert.equal(runPublishCheck(current, repair.caption, repair.check).status, 'explicit');
  assert.deepEqual(repair.check.claims[0], check.claims[0]);
  assert.equal(repair.check.decimalPlaces, 1);
  const duplicate = text + ' July had a rate of 4.3%.';
  const ambiguous = readPublishCheck({...check, caption: duplicate});
  assert.equal(suggestPublishRepair(current, duplicate, ambiguous), undefined);
  const padded = text.replace('4.3%.', '4.30%.');
  const paddedCheck = createPublishCheck(original, question, padded, localFacts(original, padded), undefined, 1);
  assert.match(suggestPublishRepair(current, padded, paddedCheck).caption, /July had a rate of 4\.20%\.$/);
});

test('a complete year maintains exact proof when eleven categories must change together', () => {
  const rows = readChart(fixture('first-published.csv')).map((row, i) => ({...row, value: i === 11 ? 10 : 20}));
  const ids = Array.from({length: 11}, (_, index) => index + 1);
  const claims = [{type: 'highest', ids}];
  const question = {type: 'atLeast', cutoff: 30};
  const result = checkCaption(rows, question, claims);
  assert.equal(result.changedCategories, 11);
  assert.deepEqual(result.alternateAnswer, ids);
  const shift = smallestAnswerShift(rows, question, claims, result.alternate);
  assert.equal(shift.maximumShift, 10);
  assert.equal(shift.alternate[11], 10);
  assert.equal(captionCoverage(rows, claims).length, 68);
});

test('a full set of month selections survives file and reader link round trips', () => {
  const chart = readChart(fixture('first-published.csv'));
  const question = {type: 'atLeast', cutoff: 3.7};
  const before = 'January had the lowest rate.';
  const ids = chart.map((_, i) => i + 1);
  const after = before + ' ' + supportedDetail(chart, question, ids);
  const check = createPublishCheck(chart, question, after, localFacts(chart, after));
  assert.equal(runPublishCheck(chart, after, check).status, 'explicit');
  const session = createReaderTest(chart, question, ids, before, after);
  const link = createReaderLink('https://example.test/', chart, question, after, session.after.invitation);
  const packet = readReaderLink(new URL(link).hash);
  assert.equal(packet.labels[11], 'December');
  const responseId = '00000000-0000-4000-8000-000000000001';
  const received = addReaderResponse(session, encodeResponse(packet.invitation, responseId, ids));
  assert.equal(received.action, 'Added');
  const restored = readReaderTestFile(writeReaderTestFile(received.test));
  assert.deepEqual(restored.after.responses[0].selected, ids);
  assert.match(answerText(chart, ids), /November, and December$/);
  const tied = chart.map((row, i) => ({label: i ? row.label : 'None', value: 10}));
  const detail = supportedDetail(tied, 'highest', ids, {includeRate: false});
  assert.match(detail, /^The 12 categories "None"/);
  assert.deepEqual(localFacts(tied, detail)[0].ids, ids);
});
