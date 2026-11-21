import assert from 'node:assert/strict';
import test from 'node:test';
import {answer, answerSupport, captionCoverage, checkCaption, fits, readChart, sameAnswer, smallestAnswerShift} from '../src/check.mjs';
import {localFacts} from '../src/draft.mjs';
import {createPublishCheck, readPublishCheck, runPublishCheck} from '../src/publish-check.mjs';

test('published precision can determine an answer and exclude an off-grid cloud suggestion', () => {
  const rows = readChart('category,percent\nJanuary,3.7\nFebruary,3.8\nMarch,3.8');
  const caption = 'Rates ranged from 3.7% to 3.8%. January had the lowest rate.';
  const claims = localFacts(rows, caption);
  const offGrid = [3.7, 3.79, 3.8];
  assert.equal(checkCaption(rows, 'highest', claims, [offGrid]).status, 'ambiguous');
  assert.deepEqual(checkCaption(rows, 'highest', claims, [offGrid], 1), {status:'implied', expected:[2, 3]});
  assert.equal(smallestAnswerShift(rows, 'highest', claims, offGrid, 1), null);
  assert.equal(captionCoverage(rows, claims, 1).find(entry => entry.question === 'highest').status, 'implied');
  const support = answerSupport(rows, 'highest', claims, 1);
  assert.deepEqual(support.essential.map(({excerpt}) => excerpt), claims.map(({evidence}) => evidence));
  for (const witness of support.essential) {
    assert(witness.alternate.every(value => Number(value.toFixed(1)) === value));
  }
});

test('an editorial cutoff between two grid values keeps its strict boundary', () => {
  const rows = readChart('category,percent\nJanuary,3.7\nFebruary,3.8\nMarch,3.9');
  const caption = 'Rates ranged from 3.7% to 3.9%. January had the lowest rate.';
  const claims = localFacts(rows, caption);
  for (const question of [{type:'below', cutoff:3.85}, {type:'atLeast', cutoff:3.85}]) {
    const result = checkCaption(rows, question, claims, [[3.7, 3.85, 3.9]], 1);
    assert.equal(result.status, 'ambiguous');
    assert.deepEqual(result.alternate, [3.7, 3.9, 3.9]);
    assert.equal(smallestAnswerShift(rows, question, claims, result.alternate, 1).maximumShift, 0.1);
  }
});

test('whole and tenth-point proofs agree with exhaustive grid search', () => {
  for (const [places, step] of [[0, 1], [1, 0.1]]) {
    const grid = [0, step, step * 2];
    const vectors = grid.flatMap(a => grid.flatMap(b => grid.map(c => [a, b, c])));
    for (const source of vectors) {
      const rows = source.map((value, index) => ({label:'ABC'[index], value}));
      const range = {type:'range', min:Math.min(...source), max:Math.max(...source)};
      const highest = {type:'highest', ids:answer(source, 'highest')};
      for (const claims of [[range], [range, highest]]) {
        const eligible = vectors.filter(values => fits(values, claims));
        for (const question of ['highest', 'lowest', {type:'pair', ids:[1, 3]},
          {type:'below', cutoff:step}, {type:'atLeast', cutoff:step / 2}]) {
          const expected = answer(source, question);
          const alternatives = eligible.filter(values => !sameAnswer(answer(values, question), expected));
          const result = checkCaption(rows, question, claims, [], places);
          assert.equal(result.status === 'ambiguous', alternatives.length > 0);
          const distance = values => Math.max(...values.map((value, index) => Math.abs(Math.round((value - source[index]) * 100))));
          const shift = smallestAnswerShift(rows, question, claims, result.alternate, places);
          assert.equal(shift?.maximumShift ?? null,
            alternatives.length ? Math.min(...alternatives.map(distance)) / 100 : null);
          if (!alternatives.length) continue;
          assert(alternatives.some(values => sameAnswer(values, result.alternate)));
          assert.equal(result.changedCategories, Math.min(...alternatives.map(values => values.filter((value, index) => value !== source[index]).length)));
        }
      }
    }
  }
});

test('saved reviews reject a finer-grained refresh and keep legacy hundredth-point semantics', () => {
  const rows = readChart('category,percent\nJanuary,3.7\nFebruary,3.8\nMarch,3.8');
  const caption = 'Rates ranged from 3.7% to 3.8%. January had the lowest rate.';
  const claims = localFacts(rows, caption);
  const saved = createPublishCheck(rows, 'highest', caption, claims, undefined, 1);
  assert.deepEqual(readPublishCheck(JSON.parse(JSON.stringify(saved))), saved);
  assert.equal(runPublishCheck(rows, caption, saved).status, 'implied');
  const legacy = createPublishCheck(rows, 'highest', caption, claims);
  assert.equal(legacy.decimalPlaces, undefined);
  assert.equal(runPublishCheck(rows, caption, legacy).status, 'ambiguous');
  const refresh = rows.map(row => row.label === 'February' ? {...row, value:3.79} : row);
  assert.equal(runPublishCheck(refresh, caption, saved).status, 'review_required');
  assert.match(runPublishCheck(refresh, caption, saved).message, /February is 3\.79%/);
  assert.throws(() => readPublishCheck({...saved, decimalPlaces:3}), /Choose 0, 1, or 2/);
});
