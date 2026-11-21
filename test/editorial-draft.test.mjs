import assert from 'node:assert/strict';
import test from 'node:test';
import {readChart} from '../src/csv.mjs';
import {localFacts} from '../src/draft.mjs';
import {maxEditorialDraftBytes, readEditorialDraft, writeEditorialDraft} from '../src/editorial-draft.mjs';
import {createPublishCheck, runPublishCheck} from '../src/publish-check.mjs';

const rows = [{label: 'North, East', value: 79.5}, {label: 'West "B"', value: 71.22}, {label: 'South', value: 20.5}];
const question = {type: 'below', cutoff: 71.22};
const caption = 'Rates ranged from 20.5% to 79.5%. Only South fell below 71.22%.';
const review = createPublishCheck(rows, question, caption, localFacts(rows, caption));

test('an unfinished editorial draft round-trips quoted category labels, precision, and an empty caption', () => {
  const text = writeEditorialDraft({rows, caption: '', question, privateNote: 'Private editor note'});
  const draft = readEditorialDraft(text);
  assert.deepEqual(readChart(draft.csv), rows);
  assert.deepEqual(draft.question, question);
  assert.equal(draft.caption, '');
  assert.equal(draft.review, null);
  assert.doesNotMatch(text, /Private editor note/);
});

test('a saved editorial review is rerun on the data carried by the draft', () => {
  const text = writeEditorialDraft({rows, caption, question, review, sourceNote: 'City report, Table 1'});
  const draft = readEditorialDraft(text);
  assert.equal(draft.sourceNote, 'City report, Table 1');
  assert.equal(runPublishCheck(readChart(draft.csv), draft.caption, draft.review).status, 'explicit');

  const edited = readEditorialDraft(text.replace('71.22\\n', '71.21\\n'));
  const result = runPublishCheck(readChart(edited.csv), edited.caption, edited.review);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.failedFacts, ['Only South fell below 71.22%.']);
});

test('draft import rejects mixed reviews and oversized files', () => {
  const file = JSON.parse(writeEditorialDraft({rows, caption, question, review}));
  for (const changes of [
    {caption: caption + ' Edited.'},
    {question: {...question, type: 'atLeast'}},
    {csv: file.csv.replace('South', 'Central')},
  ]) {
    assert.throws(() => readEditorialDraft(JSON.stringify({...file, ...changes})), /saved review does not match/);
  }
  assert.throws(() => readEditorialDraft(' '.repeat(maxEditorialDraftBytes + 1)), /under 160 KB/);
  assert.throws(() => readEditorialDraft(JSON.stringify(review)), /Choose a Two Charts editorial draft/);
});

test('an editorial draft keeps the selected headers alongside the standard chart CSV', () => {
  const columns = {category:'Region', rate:'Share saying "yes"', filter:{column:'Period',value:'2024'}};
  const selectedReview = createPublishCheck(rows, question, caption, review.claims, columns);
  const draft = readEditorialDraft(writeEditorialDraft({rows, caption, question, review: selectedReview, columns}));
  assert.deepEqual(draft.columns, columns);
  assert.deepEqual(draft.review.columns, columns);
  assert.deepEqual(readChart(draft.csv), rows);
  assert.equal(runPublishCheck(rows, caption, draft.review, draft.columns).status, 'explicit');
  assert.equal(runPublishCheck(rows, caption, draft.review, {...columns, rate: 'Last week'}).status, 'review_required');
});
