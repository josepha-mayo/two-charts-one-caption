import assert from 'node:assert/strict';
import test from 'node:test';
import {answer, answerSupport, captionCoverage, checkCaption, fits, readChart, smallestAnswerShift, supportedDetail, validateClaims} from '../src/check.mjs';
import {questionPrompt, readQuestionDraft} from '../src/brief.mjs';
import {localFacts, localPrompt, reviewCloudClaims} from '../src/draft.mjs';
import {createPublishCheck, runPublishCheck, suggestPublishRepair} from '../src/publish-check.mjs';
import {addReaderResponse, createReaderLink, createReaderTest, encodeResponse, readReaderLink, readerCounts} from '../src/reader.mjs';
import {foodPairExample} from '../src/sample.mjs';

const {csv, caption, question} = foodPairExample;
const rows = readChart(csv);
const rankSentence = 'Midwest had a higher rate than West.';

test('a private note can propose the two fully named categories without giving Chrome the source values', () => {
  const evidence = 'which of Midwest and WEST had the higher rate';
  const note = 'Check ' + evidence + '. Keep staffing details private.';
  const draft = readQuestionDraft({kind:'pair', ids:[1,2], evidence}, note, rows);
  assert.deepEqual(draft, {question,evidence});
  const recovered = readQuestionDraft({kind:'pair',evidence:'Did the Midwest lead the West?'},note,rows);
  assert.deepEqual(recovered,{question,evidence:'Check which of Midwest and WEST had the higher rate.'});
  assert.throws(() => readQuestionDraft({kind:'pair',evidence:'Invented quote'},
    note + ' Also compare West and Midwest for the next edition.',rows),/one comparison/);
  const inputs = JSON.parse(questionPrompt(note, rows).split('\n').at(-1));
  assert.equal(inputs.brief,note);
  assert.deepEqual(inputs.categories,['Northeast','Midwest','South','West']);
  assert.doesNotMatch(questionPrompt(note, rows),/13\.3|12\.9|15\.0|12\.2/);
});

test('private-note comparisons reject ambiguous category mentions and questions about the size of the gap', () => {
  const chart = readChart('category,percent\nNorth,10\nNorth East,20\nSouth (A+),30\nHigher Region,40');
  const read = evidence => readQuestionDraft({kind:'pair',evidence},evidence,chart);
  assert.deepEqual(read('Did North East have a lower rate than South (A+)?').question,{type:'pair',ids:[2,3]});
  assert.throws(() => read('Did North East have a higher rate than West?'),/one comparison/);
  assert.throws(() => read('How much higher was South (A+) than North East?'),/one comparison/);
  assert.throws(() => read('Compare North, North East and South (A+).'),/one comparison/);
  assert.throws(() => read('North and Higher Region are in the file.'),/one comparison/);
});

test('a comparison can resolve the USDA question without stating either of the rates', () => {
  const facts = localFacts(rows, caption);
  const witness = checkCaption(rows, question, facts);
  assert.equal(witness.status, 'ambiguous');
  assert.deepEqual(witness.expected, [2]);
  assert.deepEqual(witness.alternateAnswer, [2, 4]);
  assert.equal(witness.changedCategories, 1);
  assert.equal(supportedDetail(rows, question, witness.expected), rankSentence);
  assert.doesNotMatch(localPrompt(rows, question), /12\.2|3 \| 15|Midwest|West/);
  assert.equal(checkCaption(rows, question, localFacts(rows, caption + ' ' + rankSentence)).status, 'explicit');
});

test('pair facts retain their exact meaning and the cloud review rejects a reversed winner', () => {
  const text = 'West had a lower rate than Midwest. The editorial desk will revisit this question.';
  const {claims, discarded, restored} = reviewCloudClaims(rows, text, [
    {type: 'pair', ids: [2, 4], higher: 4, evidence: 'West had a lower rate than Midwest.'},
  ]);
  assert.equal(discarded[0].reason, 'mismatch');
  assert.equal(restored, 1);
  assert.equal(claims[0].higher, 2);
  assert.throws(() => validateClaims([{...claims[0], ids: [2,2]}], text, rows.length), /two different/);
  const colliding = readChart('category,percent\nNorth. Central,34\n"Said ""Hello""",12');
  const comparison = {type:'pair', ids:[1,2]};
  const quote = supportedDetail(colliding, comparison, [1]);
  assert.deepEqual(localFacts(colliding, quote), [{...comparison, higher:1, evidence:quote}]);
});

test('reader links and response codes limit the question to the requested pair', () => {
  const link = createReaderLink('https://example.test/', rows, question, caption);
  assert.deepEqual(readReaderLink(new URL(link).hash).question, question);
  assert.doesNotMatch(decodeURIComponent(new URL(link).hash), /13\.3|12\.9/);
  const study = createReaderTest(rows, question, [2], caption, caption + ' ' + rankSentence);
  const reply = ids => encodeResponse(study.after.invitation, crypto.randomUUID(), ids);
  assert.throws(() => addReaderResponse(study, reply([1])), /invalid/);
  assert.throws(() => addReaderResponse(study, reply([])), /invalid/);
  assert.deepEqual(readerCounts(addReaderResponse(study, reply([2,4])).test, 'after'), {correct:0, uncertain:0, different:1});
});

test('a saved pair comparison survives reordered rows and repairs an outdated comparison to a tie', () => {
  const text = caption + ' ' + rankSentence;
  const check = createPublishCheck(rows, question, text, localFacts(rows, text));
  assert.equal(runPublishCheck(rows.slice().reverse(), text, check).status, 'explicit');
  const refreshed = rows.map(row => row.label === 'Midwest' ? {...row, value: 12.9} : row).reverse();
  const conflict = runPublishCheck(refreshed, text, check);
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.failedFacts, [rankSentence]);
  const repair = suggestPublishRepair(refreshed, text, check);
  assert.equal(repair.after, 'Midwest and West had the same rate.');
  assert.equal(runPublishCheck(refreshed, repair.caption, repair.check).status, 'explicit');
});

test('fewest changed categories and smallest rate shifts agree with exhaustive small charts', () => {
  const domain = [0, 0.01, 0.02, 0.03];
  const vectors = domain.flatMap(a => domain.flatMap(b => domain.flatMap(c => domain.map(d => [a,b,c,d]))));
  const questions = [
    {type:'pair',ids:[1,4]}, {type:'pair',ids:[2,3]}, 'highest', 'lowest',
    {type:'atLeast', cutoff:0.02}, {type:'below', cutoff:0.02},
  ];
  for (const source of vectors) {
    const chart = source.map((value, i) => ({label:String(i + 1), value}));
    const range = {type:'range', min:Math.min(...source), max:Math.max(...source)};
    const group = (first, second) => ({
      type:'pair', ids:[first,second],
      higher:source[first - 1] === source[second - 1] ? 0 : source[first - 1] > source[second - 1] ? first : second,
    });
    const constraints = [
      [range, group(1,2), group(2,4)],
      [range, group(1,3), {type:'lowest', ids:answer(source, 'lowest')}],
      [range, group(2,4), {type:'atLeast',cutoff:0.01,ids:answer(source,{type:'atLeast',cutoff:0.01})}],
    ];
    for (const claims of constraints) {
      const eligible = vectors.filter(values => fits(values, claims));
      for (const selected of questions) {
        const expected = answer(source, selected);
        const alternatives = eligible.filter(values => String(answer(values, selected)) !== String(expected));
        const result = checkCaption(chart, selected, claims);
        assert.equal(result.status === 'ambiguous', alternatives.length > 0);
        const shift = smallestAnswerShift(chart, selected, claims, result.alternate);
        const maxDistance = values => Math.max(...values.map((value, i) => Math.abs(Math.round((value - source[i]) * 100))));
        assert.equal(shift?.maximumShift ?? null, alternatives.length ? Math.min(...alternatives.map(maxDistance)) / 100 : null);
        if (!alternatives.length) continue;
        assert.ok(fits(shift.alternate, claims));
        assert.equal(maxDistance(shift.alternate) / 100, shift.maximumShift);
        assert.deepEqual(shift.alternateAnswer, answer(shift.alternate, selected));
        assert.notDeepEqual(shift.alternateAnswer, expected);
        const moved = values => values.filter((value, i) => value !== source[i]).length;
        assert.equal(result.changedCategories, Math.min(...alternatives.map(moved)));
        assert.ok(fits(result.alternate, claims));
      }
    }
  }
});

test('two rates moving 10 points each can tie when a one-category edit takes at least 20 points', () => {
  const chart = readChart('category,percent\nNorth,40\nSouth,60');
  const question = {type: 'pair', ids: [1, 2]};
  const witness = checkCaption(chart, question, []);
  assert.equal(witness.changedCategories, 1);
  assert.ok(Math.max(...witness.alternate.map((value, i) => Math.abs(value - chart[i].value))) >= 20);
  assert.deepEqual(smallestAnswerShift(chart, question, [], witness.alternate), {
    maximumShift: 10,
    alternate: [50, 50],
    alternateAnswer: [1, 2],
  });
});

test('caption coverage agrees with the individual proof across all seven-category questions', () => {
  const chart = Array.from({length: 7}, (_, i) => ({label: `Category ${i + 1}`, value: 50 + i}));
  const range = {type: 'range', min: 50, max: 56};
  const ascending = chart.slice(1).map((_, i) => ({type: 'pair', ids: [i + 1, i + 2], higher: i + 2}));
  for (const claims of [
    [range],
    [range, {type: 'lowest', ids: [1]}],
    [range, ...ascending],
  ]) {
    const coverage = captionCoverage(chart, claims);
    assert.equal(coverage.length, 23);
    assert.equal(new Set(coverage.map(entry => JSON.stringify(entry.question))).size, 23);
    for (const {question, expected, status} of coverage) {
      const checked = checkCaption(chart, question, claims);
      assert.equal(status, checked.status);
      assert.deepEqual(expected, checked.expected);
    }
  }
  assert.deepEqual(captionCoverage(chart, [{...range, max: 57}]), []);
});

test('an inferred comparison retains both links in its proof and verifies both omission witnesses', () => {
  const background = 'Rates ranged from 12.2% to 15%.';
  const southMidwest = 'South had a higher rate than Midwest.';
  const midwestWest = 'Midwest had a higher rate than West.';
  const selected = {type: 'pair', ids: [3, 4]};
  const facts = localFacts(rows, [background, southMidwest, midwestWest].join(' '));
  const proof = answerSupport(rows, selected, facts);
  assert.deepEqual(proof.essential.map(item => item.excerpt), [southMidwest, midwestWest]);
  assert.deepEqual(proof.omitted, [background]);
  const retained = facts.filter(fact => !proof.omitted.includes(fact.evidence));
  assert.equal(checkCaption(rows, selected, retained).status, 'implied');
  for (const {excerpt, alternate, alternateAnswer} of proof.essential) {
    const remaining = retained.filter(fact => fact.evidence !== excerpt);
    assert.ok(fits(alternate, remaining));
    assert.deepEqual(alternateAnswer, answer(alternate, selected));
    assert.notDeepEqual(alternateAnswer, [3]);
    assert.equal(checkCaption(rows, selected, remaining).status, 'ambiguous');
  }
});

test('support groups multiple facts from one quote and handles a cutoff resolved by the domain', () => {
  const chart = readChart('category,percent\nNorth,40\nSouth,60');
  const quote = 'North and South reported 40% and 60%, respectively.';
  const facts = [
    {type:'value', id:1, value:40, evidence:quote},
    {type:'value', id:2, value:60, evidence:quote},
  ];
  const pair = {type:'pair', ids:[1, 2]};
  assert.deepEqual(answerSupport(chart, pair, facts).essential.map(item => item.excerpt), [quote]);
  assert.deepEqual(answerSupport(chart, {type:'atLeast', cutoff:0}, facts), {essential:[], omitted:[quote]});
  assert.equal(answerSupport(chart, pair, []), null);
  assert.equal(answerSupport(chart, pair, [{...facts[0], value:39}, facts[1]]), null);
});
