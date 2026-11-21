import './style.css';
import {
  readChart, checkCaption, validateClaims, answerText, isCutoffClaim, sameAnswer, supportedDetail, fitsClaim, questionText, readQuestion,
} from './check.mjs';
import {localFacts, cloudPrompt, localPrompt, checkText, answerConstraint, reviewCloudClaims} from './draft.mjs';
import {defaultChartColumns, readChartRows, readCsvTable} from './csv.mjs';
import {checkBrief, questionPrompt, questionConstraint, readQuestionDraft} from './brief.mjs';
import {createPublishCheck, readPublishCheck, reviewPublishInputs, suggestPublishRepair} from './publish-check.mjs';
import {maxEditorialDraftBytes, readEditorialDraft, writeEditorialDraft} from './editorial-draft.mjs';
import {deviceAvailability} from './device.mjs';
import {saveOfflineApp} from './offline.mjs';
import {sampleCsv, sampleCaption, cutoffCaption, sampleSource, foodExample, foodNationalExample, foodPairExample} from './sample.mjs';
import {comparisonReport, reviewedDescription, reviewedFragment} from './report.mjs';
import refreshedSampleCsv from '../examples/bus-cutoff/refreshed.csv?raw';
import {
  addReaderResponse, createReaderLink, createReaderTest, encodeResponse, readReaderLink,
  maxReaderTestFileBytes, readReaderTestFile, readerCounts, readerResponseId, restoreReaderTest, saveReaderTest, writeReaderTestFile,
} from './reader.mjs';

const el = id => document.getElementById(id);
const caption = el('caption');
const question = el('question');
const cutoff = el('cutoff');
const pairInputs = [el('pair-first'), el('pair-second')];
const csv = el('csv');
const dialog = el('dialog');
const status = el('status');
const requestedExample = new URLSearchParams(location.search).get('example');
const startingExample = ['cutoff', 'food', 'food-national', 'food-pair'].includes(requestedExample) ? requestedExample : 'bus';
let rows, result, reviewed, candidate, snapshot;
let firebaseConnection;
let cloudOperation;
let deviceOperation;
let revision = 0;
let busy = false;
let readerAnswer;
let pendingReaderTest, readerTest, tabStorage;
let savedCheck, staleRepair;
const originalExample = {
  label: 'Bus report example',
  csv: sampleCsv,
  caption: sampleCaption,
  question: 'lowest',
  sourceUrl: sampleSource,
  sourceCitation: 'Example data from the NYC Comptroller’s bus report, Table 3',
};
const refreshedExample = {
  label: 'Simulated bus report refresh',
  sourceUrl: sampleSource,
  sourceCitation: 'Simulated data refresh based on the NYC Comptroller’s bus report, Table 3.',
};
const pastedCsv = {label: 'Pasted CSV'};
let chartSource = originalExample;
let exampleReview;
let pendingImport;
let pairSource;
const aiOperations = {
  question: {label: 'Question from private note', route: 'on_device', inputs: ['Private note', 'Category names']},
  detail: {label: 'Caption detail from source chart', route: 'on_device', inputs: ['Source percentages', 'Category IDs', 'Selected question']},
  review: {label: 'Cloud fact draft', route: 'in_cloud', inputs: ['Caption approved for cloud review', 'Category names', 'Selected question']},
  rewrite: {label: 'Cloud fact draft for rewrite', route: 'in_cloud', inputs: ['Rewrite approved for cloud review', 'Category names', 'Selected question']},
};
const aiActivity = new Map();
const cloudReviewControls = {
  editor: {feedback: 'status', panel: 'claim-review', list: 'claims', notes: 'claim-rejections',
    exclusions: 'claim-exclusions', excludedList: 'claim-exclusion-list',
    cancel: 'cloud-cancel', heading: 'facts-title', local: 'check',
    fallback: 'Choose Reveal without answering to check the caption in this browser.'},
  rewrite: {feedback: 'rewrite-status', panel: 'rewrite-claim-review', list: 'rewrite-claims', notes: 'rewrite-claim-notes',
    exclusions: 'rewrite-exclusions', excludedList: 'rewrite-exclusion-list',
    cancel: 'rewrite-cloud-cancel', heading: 'rewrite-facts-title', local: 'check-rewrite',
    fallback: 'Choose Check rewrite to check the draft in this browser.'},
};
const deviceControls = {
  question: {feedback: 'brief-status', cancel: 'brief-cancel', start: 'brief-submit',
    fallback: 'Set the question with the controls above.'},
  detail: {feedback: 'detail-status', cancel: 'nano-cancel', start: 'nano',
    fallback: 'You can still add the checked detail above.'},
};

try { tabStorage = window.sessionStorage; } catch { /* Session storage can be disabled. */ }

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function recordAIResponse(operation) {
  const count = (aiActivity.get(operation)?.completed ?? 0) + 1;
  aiActivity.set(operation, {operation, ...aiOperations[operation], completed: count, lastCompletedAt: new Date().toISOString()});
  const entries = [...aiActivity.values()].map(entry => {
    const item = make('li');
    const route = entry.route === 'on_device' ? 'on-device inference' : 'in-cloud inference';
    item.append(make('strong', entry.label), make('span', `Firebase reported ${route} · ${entry.completed} completed`),
      make('p', entry.inputs.join(' · ')));
    return item;
  });
  el('ai-activity-list').replaceChildren(...entries);
  el('ai-activity').hidden = false;
}

function selectedQuestion() {
  const type = question.value;
  if (type === 'pair') return readQuestion({type, ids: pairInputs.map(input => Number(input.value))}, rows.length);
  return readQuestion(isCutoffClaim({type}) ? {type, cutoff: cutoff.valueAsNumber} : type);
}

function refreshPairOptions(chartRows, ids) {
  if (chartRows !== pairSource) {
    const previous = pairInputs.map(input => pairSource?.[Number(input.value) - 1]?.label);
    const matching = previous.map(label => chartRows.findIndex(row => row.label === label) + 1);
    if (!ids) ids = matching.every(Boolean) ? matching : [1, 2];
    for (const input of pairInputs) {
      input.replaceChildren(...chartRows.map(({label}, index) => new Option(label, index + 1)));
    }
    pairSource = chartRows;
  }
  if (ids) pairInputs.forEach((input, i) => { input.value = String(ids[i]); });
}

function setQuestion(selected, chartRows = rows) {
  question.value = typeof selected === 'string' ? selected : selected.type;
  if (selected?.type === 'pair') refreshPairOptions(chartRows, selected.ids);
  if (isCutoffClaim(selected)) cutoff.value = String(selected.cutoff);
}

function questionPromptText(selected, chartRows) {
  const instruction = selected?.type === 'pair' ? 'Select both for a tie.' : 'Select all that apply.';
  return `${questionText(selected, chartRows)} ${instruction}`;
}

const deltaFormat = new Intl.NumberFormat('en', {signDisplay: 'always', maximumFractionDigits: 2});

function cutoffText({type, cutoff}) {
  return type === 'below' ? `Below ${cutoff}%` : `At or above ${cutoff}%`;
}

function noCutoffMatches(type) {
  return type === 'below' ? 'None fall below the cutoff' : 'None reach the cutoff';
}

function chart(target, values, ids, selected, compareToSource = false) {
  const axis = make('div', undefined, 'axis');
  for (const label of ['0%', '25%', '50%', '75%', '100%']) axis.append(make('span', label));
  axis.setAttribute('aria-hidden', 'true');
  const list = make('ul', undefined, 'bars');
  rows.forEach(({label}, i) => {
    const item = make('li', undefined, ids.includes(i + 1) ? 'selected' : '');
    const name = make('span', label, 'label');
    if (compareToSource && values[i] !== rows[i].value) {
      item.classList.add('changed');
      const delta = (Math.round(values[i] * 100) - Math.round(rows[i].value * 100)) / 100;
      const change = make('small', `${deltaFormat.format(delta)} percentage points from source`, 'value-change');
      name.append(change);
    }
    const track = make('span', undefined, 'track');
    track.setAttribute('aria-hidden', 'true');
    const bar = make('span', undefined, 'bar');
    bar.style.inlineSize = `${values[i]}%`;
    track.append(bar);
    if (isCutoffClaim(selected)) {
      const rule = make('span', undefined, 'cutoff-line');
      rule.style.insetInlineStart = `${selected.cutoff}%`;
      track.append(rule);
    }
    const value = make('strong', `${values[i]}%`, 'value');
    item.append(name, track, value);
    list.append(item);
  });
  target.replaceChildren(axis, list);
  const summary = typeof selected === 'string'
    ? (selected === 'lowest' ? 'Lowest' : 'Highest')
    : selected.type === 'pair' ? (ids.length === 2 ? 'Tie' : 'Higher of the pair') : cutoffText(selected);
  target.append(make('p', `${summary}: ${answerText(rows, ids)}`, 'answer'));
}

function choiceButton(label, onClick, primary = false) {
  const button = make('button', label, primary ? 'primary' : '');
  button.type = 'button';
  button.disabled = busy;
  button.addEventListener('click', onClick);
  return button;
}

function categoryChoice(label, className) {
  const input = make('input');
  input.type = 'checkbox';
  const option = make('label', undefined, className);
  option.append(input, make('span', label));
  return {input, option};
}

function updateExampleRefresh() {
  const restoring = chartSource === refreshedExample;
  const eligible = chartSource === originalExample && result?.status === 'explicit' &&
    question.value === 'atLeast' && cutoff.valueAsNumber === 70;
  el('example-refresh-panel').hidden = !restoring && !eligible;
  el('example-refresh').textContent = restoring ? 'Restore original example data' : 'Try a simulated data refresh';
}

function invalidate() {
  cancelCloudReview();
  stopDeviceInference('detail');
  if (questionDraft?.chartRows && questionDraft.chartRows !== rows) {
    clearQuestionDraft();
    briefStatus.textContent = 'The chart changed. Ask Chrome for a question using the current categories.';
  }
  if (publicationDialog.open) publicationDialog.close();
  revision += 1;
  candidate = null;
  reviewed = null;
  result = null;
  staleRepair = null;
  el('stale-repair').hidden = true;
  el('claim-review').hidden = true;
  el('revision').hidden = true;
  el('proof').hidden = true;
  el('comparison').hidden = true;
  el('witness').hidden = true;
  if (pendingReaderTest) {
    pendingReaderTest = null;
    renderReaderTest();
  }
  readerAnswer = undefined;
  status.textContent = '';
  status.removeAttribute('data-state');
  el('recheck-status').textContent = '';
  const columns = chartSource.columns;
  el('recheck-source').textContent = 'Data in use · ' + chartSource.label +
    (columns ? ' · ' + columns.rate + ' by ' + columns.category : '');
  el('source-chart-title').textContent = chartSource === refreshedExample ? 'Simulated data refresh' : 'Source chart';
  updateExampleRefresh();
  const showCutoff = isCutoffClaim({type: question.value});
  el('cutoff-label').hidden = !showCutoff;
  const showPair = question.value === 'pair';
  for (const input of pairInputs) el(input.id + '-label').hidden = !showPair;
  refreshPairOptions(rows);
  let selected;
  try {
    selected = selectedQuestion();
    el('studio-question').textContent = questionPromptText(selected, rows);
  } catch (error) {
    el('studio-question').textContent = error.message;
  }
  const unknown = choiceButton('The caption doesn’t say', () => browserCheck(null), true);
  const checks = rows.flatMap(({label}, index) => {
    const id = index + 1;
    if (showPair && !selected?.ids.includes(id)) return [];
    const choice = categoryChoice(label, 'challenge-option');
    choice.input.disabled = busy;
    choice.input.dataset.categoryId = String(id);
    return [{...choice, id}];
  });
  const reveal = choiceButton('Check selected categories', () => {
    const ids = checks.flatMap(({input, id}) => input.checked ? [id] : []);
    if (ids.length) browserCheck(ids);
    else status.textContent = 'Select at least one category, or choose an answer below.';
  });
  el('reader-choices').replaceChildren(
    ...checks.map(({option}) => option), reveal,
    ...(showCutoff ? [choiceButton(noCutoffMatches(question.value), () => browserCheck([]))] : []), unknown,
  );
}

function syncActions() {
  for (const id of ['check', 'cloud-preview', 'load', 'csv-file', 'example', 'example-select', 'nano', 'apply', 'open-rewrite',
    'brief-example', 'brief-submit', 'brief-apply', 'recheck-file', 'save-recheck', 'run-recheck',
    'save-editor-draft', 'editor-draft-file',
    'review-saved-caption', 'apply-stale-repair', 'example-refresh', 'csv-category', 'csv-percent',
    'use-csv-columns', 'check-rewrite', 'rewrite-cloud-preview', 'publication', 'export']) el(id).disabled = busy;
  el('confirm-facts').disabled = busy || !candidate?.claims.length;
  el('confirm-rewrite-facts').disabled = busy || !rewriteCandidate?.claims.length;
  for (const control of el('reader-choices').querySelectorAll('button, input')) control.disabled = busy;
  for (const [target, controls] of Object.entries(cloudReviewControls)) {
    el(controls.cancel).hidden = cloudOperation?.target !== target;
  }
  for (const [target, controls] of Object.entries(deviceControls)) {
    el(controls.cancel).hidden = deviceOperation?.target !== target;
  }
}

function finishDeviceInference(operation) {
  if (deviceOperation !== operation) return false;
  deviceOperation = null;
  clearTimeout(operation.timer);
  busy = false;
  syncActions();
  return true;
}

function stopDeviceInference(target, message) {
  const operation = deviceOperation;
  if (operation?.target !== target) return;
  const controls = deviceControls[target];
  const focused = document.activeElement === el(controls.cancel);
  operation.controller.abort();
  finishDeviceInference(operation);
  if (message) {
    el(controls.feedback).textContent = `${message} ${controls.fallback}`;
    if (focused) el(controls.start).focus();
  }
}

async function runDeviceInference(target, prompt, constraint, waiting, useReply) {
  if (busy) return;
  const controls = deviceControls[target];
  const feedback = el(controls.feedback);
  const operation = {target, controller: new AbortController()};
  deviceOperation = operation;
  operation.timer = setTimeout(() => stopDeviceInference(target, 'Chrome did not respond in time.'), 60000);
  busy = true;
  syncActions();
  feedback.textContent = waiting;
  el(controls.cancel).focus();
  try {
    const firebase = await connectFirebase();
    if (deviceOperation !== operation) return;
    const reply = await firebase.generateOnDevice(prompt, constraint, {signal: operation.controller.signal});
    if (deviceOperation !== operation) return;
    recordAIResponse(target);
    useReply(reply);
  } catch (error) {
    if (deviceOperation === operation) feedback.textContent = `${error.message} ${controls.fallback}`;
  } finally {
    const focused = document.activeElement === el(controls.cancel);
    if (finishDeviceInference(operation) && focused) el(controls.start).focus();
  }
}

for (const [target, controls] of Object.entries(deviceControls)) {
  el(controls.cancel).addEventListener('click', () => stopDeviceInference(target, 'Stopped waiting for Chrome.'));
}

function finishCloudReview(operation) {
  if (cloudOperation !== operation) return false;
  cloudOperation = null;
  busy = false;
  syncActions();
  return true;
}

function cancelCloudReview() {
  const operation = cloudOperation;
  if (!operation) return;
  operation.controller.abort();
  finishCloudReview(operation);
}

function renderSource() {
  const link = el('source');
  const note = el('draft-source-note');
  note.hidden = Boolean(chartSource.sourceUrl) || !chartSource.sourceCitation;
  note.textContent = note.hidden ? '' : chartSource.sourceCitation;
  link.hidden = !chartSource.sourceUrl;
  if (link.hidden) return;
  link.href = chartSource.sourceUrl;
  link.textContent = chartSource.sourceCitation;
}

function loadSample(key) {
  clearCsvMapping();
  chartSource = {food: foodExample, 'food-national': foodNationalExample, 'food-pair': foodPairExample}[key] ?? originalExample;
  exampleReview = null;
  el('example-select').value = key;
  csv.value = chartSource.csv;
  caption.value = key === 'cutoff' ? cutoffCaption : chartSource.caption;
  cutoff.value = '70';
  rows = readChart(chartSource.csv);
  setQuestion(key === 'cutoff' ? {type: 'atLeast', cutoff: 70} : chartSource.question);
  el('csv-status').textContent = '';
  renderSource();
  invalidate();
}

function describeClaim(claim) {
  if (claim.type === 'range') return `Range ${claim.min}%–${claim.max}%`;
  if (claim.type === 'value') return `${rows[claim.id - 1].label} is ${claim.value}%`;
  if (claim.type === 'pair') {
    return claim.higher ? `Higher in this pair: ${answerText(rows, [claim.higher])}` : `Same rate: ${answerText(rows, claim.ids)}`;
  }
  if (claim.type === 'atLeast') return `At or above ${claim.cutoff}%: ${answerText(rows, claim.ids)}`;
  if (claim.type === 'below') return `${cutoffText(claim)}: ${answerText(rows, claim.ids)}`;
  if (claim.type === 'atLeastSome') return `${answerText(rows, claim.ids)} reached at least ${claim.cutoff}%`;
  if (claim.type === 'belowSome') return `${answerText(rows, claim.ids)} fell below ${claim.cutoff}%`;
  const rate = claim.value === undefined ? '' : ` (${claim.value}%)`;
  return `${claim.type === 'lowest' ? 'Lowest' : 'Highest'}: ${answerText(rows, claim.ids)}${rate}`;
}

function renderProof(claims, alternate) {
  const source = rows.map(row => row.value);
  let verifiedCount = 0;
  const entries = claims.map(claim => {
    const item = make('li');
    item.append(make('strong', describeClaim(claim)), make('q', claim.evidence));
    const verified = [source, ...(alternate ? [alternate] : [])].every(values => fitsClaim(values, claim));
    if (verified) verifiedCount += 1;
    const verification = make('span', verified ? (alternate ? 'Verified on both charts' : 'Verified on source chart') : 'Conflicts with the source chart');
    verification.dataset.verified = String(verified);
    item.append(verification);
    return item;
  });
  el('proof-facts').replaceChildren(...entries);
  el('save-recheck').hidden = !claims.length;
  const count = result.changedCategories;
  el('proof-summary').textContent = alternate
    ? `Every checked fact holds in both charts. Changing ${count === 1 ? 'one category' : `${count} categories`} is the smallest edit that changes the answer.`
    : result.status === 'implied'
      ? 'Across all permitted percentage charts, the checked facts force the same answer.'
      : result.status === 'conflict'
        ? `${verifiedCount} of ${claims.length} reviewed facts still match the current chart.`
        : 'These facts were checked against the source chart.';
  el('proof').hidden = false;
}

function renderWitness(selected, expected, alternate, alternateAnswer) {
  el('witness').hidden = !alternate;
  if (!alternate) return;
  el('witness-question').textContent = questionText(selected, rows);
  el('witness-source').textContent = answerText(rows, expected) + (selected?.type === 'pair' && expected.length === 2 ? ' (tie)' : '');
  el('witness-alternate').textContent = answerText(rows, alternateAnswer) + (selected?.type === 'pair' && alternateAnswer.length === 2 ? ' (tie)' : '');
  const changes = rows.flatMap(({label, value}, i) => {
    if (value === alternate[i]) return [];
    const item = make('li');
    item.append(make('strong', label), make('span', `${value}% to ${alternate[i]}%`));
    return [item];
  });
  el('witness-rates').replaceChildren(...changes);
}

function focusCheckResult() {
  if (result?.status === 'ambiguous') {
    el('witness-title').focus({preventScroll: true});
    status.scrollIntoView({block: 'start'});
    return;
  }
  status.setAttribute('tabindex', '-1');
  status.focus();
}

function render(claims, alternatives = [], note = 'Browser check') {
  el('detail-status').textContent = '';
  reviewed = claims;
  const selected = selectedQuestion();
  result = checkCaption(rows, selected, claims, alternatives);
  const {expected, alternate, alternateAnswer} = result;
  renderWitness(selected, expected, alternate, alternateAnswer);
  chart(el('actual'), rows.map(row => row.value), expected, selected);
  const names = answerText(rows, expected);
  const state = result.status;
  const resolved = canPublish();
  status.dataset.state = state;
  el('comparison').hidden = false;
  el('revision').hidden = state === 'conflict';
  el('export').hidden = !resolved;
  el('publication').hidden = !resolved;
  el('apply').hidden = state !== 'ambiguous' && state !== 'implied';
  el('nano').hidden = state !== 'ambiguous';
  const guess = readerAnswer === undefined || state !== 'ambiguous' ? ''
    : readerAnswer === null ? 'You spotted the gap. '
      : `You picked ${answerText(rows, readerAnswer)}. The caption leaves more than one answer possible. `;
  const text = {
    ambiguous: `${guess}Both charts fit the checked facts. Their answers differ. ${note}${result.origin === 'browser' && note !== 'Browser check' ? ' · witness found by browser' : ''}.`,
    explicit: expected.length
      ? `The reviewed description now names ${names}. The alternate answer cannot satisfy that fact.`
      : `The reviewed description now establishes that no category ${selected.type === 'below' ? 'falls below' : 'reaches'} the cutoff.`,
    conflict: 'A checked fact contradicts the source chart. Revise the caption or its interpretation.',
    implied: `The checked facts force the same answer: ${names}. You can still state it directly for readers.`,
  };
  let feedback = '';
  if (resolved && Array.isArray(readerAnswer)) {
    feedback = sameAnswer(readerAnswer, expected)
      ? 'Your selection matches the checked answer. '
      : 'Your selection differs from the checked answer. ';
  }
  status.textContent = feedback + text[state];
  if (alternate) chart(el('alternate'), alternate, alternateAnswer, selected, true);
  else el('alternate').replaceChildren(make('p', state === 'explicit' || state === 'implied'
    ? 'The caption decides this question.' : 'No alternate is shown for this check.', 'empty'));
  if (state !== 'conflict') {
    el('detail').textContent = supportedDetail(rows, selected, expected);
  }
  renderProof(claims, alternate);
  updateExampleRefresh();
}

function browserCheck(guess) {
  invalidate();
  readerAnswer = guess;
  if (Array.isArray(guess)) {
    for (const input of el('reader-choices').querySelectorAll('input')) {
      input.checked = guess.includes(Number(input.dataset.categoryId));
    }
  }
  try {
    const text = checkText(caption.value);
    render(localCaptionClaims(text));
  } catch (error) {
    status.textContent = error.message;
    status.dataset.state = 'conflict';
  }
  focusCheckResult();
}

function localCaptionClaims(text) {
  return validateClaims(localFacts(rows, text), text, rows.length);
}

el('example').addEventListener('click', () => loadSample(el('example-select').value));
el('check').addEventListener('click', () => browserCheck());
el('show-fix').addEventListener('click', () => {
  const heading = el('revision-title');
  heading.focus({preventScroll: true});
  heading.scrollIntoView({block: 'start'});
});
const csvStatus = el('csv-status');
function csvError(message) {
  csvStatus.textContent = message + ' The current chart is still in use.';
}

function clearCsvMapping() {
  pendingImport = null;
  el('csv-columns').hidden = true;
  el('csv-category').replaceChildren();
  el('csv-percent').replaceChildren();
}

function applyChart(chart, input, source, columns) {
  clearCsvMapping();
  rows = chart;
  chartSource = columns ? {...source, columns} : source;
  csv.value = input;
  if (!source.sourceUrl) {
    exampleReview = null;
    if ([sampleCaption, cutoffCaption, foodExample.caption].includes(caption.value)) caption.value = '';
  }
  invalidate();
  renderSource();
  csvStatus.textContent = `Loaded ${rows.length} categories${source === pastedCsv ? '' : ` from ${source.label}`}.`;
  caption.focus();
}

function applyImportedChart(table, columns, input, source) {
  const chart = readChartRows(table, columns);
  const names = {category: table.headers[columns.category], rate: table.headers[columns.rate]};
  const unique = Object.values(names).every(name => name && table.headers.indexOf(name) === table.headers.lastIndexOf(name));
  applyChart(chart, input, source, unique ? names : undefined);
}

function importChart(input, source = pastedCsv) {
  clearCsvMapping();
  csv.value = input;
  try {
    const table = readCsvTable(input);
    const columns = defaultChartColumns(table.headers);
    if (columns) {
      applyImportedChart(table, columns, input, source);
      return;
    }
    pendingImport = {table, source};
    for (const [id, key] of [['csv-category', 'category'], ['csv-percent', 'rate']]) {
      const select = el(id);
      select.add(new Option('Choose a column', ''));
      table.headers.forEach((header, index) => {
        select.add(new Option(header ? `${index + 1}. ${header}` : `Column ${index + 1} (no header)`, index));
      });
      const required = savedCheck?.columns?.[key];
      const match = table.headers.indexOf(required);
      if (match !== -1 && match === table.headers.lastIndexOf(required)) select.value = String(match);
    }
    el('csv-columns').hidden = false;
    csvStatus.textContent = 'Choose two columns to replace the current chart.';
    el('csv-category').focus();
  } catch (error) {
    csvError(error.message);
  }
}

el('load').addEventListener('click', () => importChart(csv.value));
csv.addEventListener('input', () => {
  clearCsvMapping();
  csvStatus.textContent = '';
});
el('use-csv-columns').addEventListener('click', () => {
  if (!pendingImport) return;
  const {table, source} = pendingImport;
  const category = el('csv-category').value;
  const rate = el('csv-percent').value;
  try {
    if (!category || !rate) throw Error('Choose a category column and a percentage column.');
    applyImportedChart(table, {category: Number(category), rate: Number(rate)}, csv.value, source);
  } catch (error) {
    csvError(error.message);
  }
});
el('csv-file').addEventListener('change', async event => {
  const picker = event.currentTarget;
  const file = picker.files[0];
  picker.value = '';
  if (!file) return;
  clearCsvMapping();
  if (file.size > 12_000) {
    csvError('Choose a CSV under 12 KB.');
    return;
  }
  const previousDraft = csv.value;
  busy = true;
  syncActions();
  let input;
  try {
    input = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer());
  } catch {
    csvError('This CSV could not be read as UTF-8. Save it as UTF-8 or paste its contents.');
  } finally {
    busy = false;
    syncActions();
  }
  if (input !== undefined && csv.value === previousDraft) importChart(input, {label: file.name});
});
caption.addEventListener('input', invalidate);
question.addEventListener('change', invalidate);
cutoff.addEventListener('input', invalidate);
for (const input of pairInputs) input.addEventListener('change', invalidate);

function connectFirebase() {
  if (firebaseConnection) return firebaseConnection;
  if (navigator.onLine === false && !navigator.serviceWorker?.controller) {
    return Promise.reject(Error('Reconnect to load the Firebase client for this tab.'));
  }
  firebaseConnection = import('./firebase.mjs').catch(() => {
    throw Error('The Firebase tools could not load. Keep a copy of your edits before reloading, or continue with the browser check.');
  }).then(async module => {
    await module.configure();
    return module;
  }).catch(error => {
    firebaseConnection = null;
    throw error;
  });
  return firebaseConnection;
}

const setupDialog = el('ai-setup-dialog');
const setupStatus = el('ai-setup-status');
const setupProgress = el('ai-setup-progress');
const prepareDevice = el('prepare-device');
const refreshDevice = el('refresh-device');
let deviceSetupPending = false;

const availabilityText = {
  available: 'Chrome’s on-device model is ready for offline use in this tab. Private notes and source values stay on this device.',
  downloadable: 'Chrome can download its on-device model. The first download can take several minutes.',
  downloading: 'Chrome reports that its model is downloading. Prepare it here to follow progress.',
  unavailable: 'This browser does not offer the on-device model. The browser check and reader links are still available.',
};

async function refreshDeviceSetup() {
  if (deviceSetupPending) return;
  refreshDevice.disabled = true;
  prepareDevice.hidden = true;
  setupStatus.textContent = 'Checking Chrome’s on-device model…';
  try {
    const state = await deviceAvailability();
    if (state !== 'unavailable') {
      setupStatus.textContent = state === 'available' ? 'Chrome’s model is installed. Loading the Firebase client for this tab…' : availabilityText[state];
      await connectFirebase();
      prepareDevice.hidden = state === 'available';
    }
    setupStatus.textContent = availabilityText[state];
  } catch {
    setupStatus.textContent = 'Chrome AI setup could not finish. Reconnect and check again, or use the browser check.';
  } finally {
    refreshDevice.disabled = false;
  }
}

el('ai-setup').addEventListener('click', () => {
  setupDialog.showModal();
  refreshDeviceSetup();
});
refreshDevice.addEventListener('click', refreshDeviceSetup);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  el('offline-copy').hidden = false;
  el('save-offline').addEventListener('click', async event => {
    const button = event.currentTarget;
    const feedback = el('offline-copy-status');
    button.disabled = true;
    feedback.textContent = 'Saving the app for offline use…';
    try {
      const version = document.querySelector('meta[name="two-charts-offline-build"]')?.content;
      const {waiting} = await saveOfflineApp(import.meta.env.BASE_URL + 'offline-worker.js', version);
      feedback.textContent = waiting
        ? 'Offline copy saved. Close all Two Charts tabs before reopening offline to use this version.'
        : 'Offline copy saved. You can reopen this app without a connection.';
    } catch (error) {
      feedback.textContent = error.message || 'The offline copy could not be saved. Try again when connected.';
    } finally {
      button.disabled = false;
    }
  });
}

prepareDevice.addEventListener('click', async () => {
  deviceSetupPending = true;
  prepareDevice.disabled = true;
  refreshDevice.disabled = true;
  setupProgress.hidden = false;
  setupProgress.removeAttribute('value');
  setupStatus.textContent = 'Chrome is preparing the model. You can close setup and keep editing.';
  try {
    const firebase = await connectFirebase();
    await firebase.prepareOnDevice(answerConstraint, progress => {
      if (Number.isFinite(progress)) setupProgress.value = Math.max(0, Math.min(100, Math.round(progress * 100)));
    });
    deviceSetupPending = false;
    await refreshDeviceSetup();
  } catch {
    setupStatus.textContent = 'Chrome could not prepare the model. Check its requirements and retry.';
  } finally {
    deviceSetupPending = false;
    setupProgress.hidden = true;
    prepareDevice.disabled = false;
    refreshDevice.disabled = false;
  }
});

const brief = el('brief');
const briefStatus = el('brief-status');
let questionDraft;

function clearQuestionDraft() {
  stopDeviceInference('question');
  questionDraft = null;
  el('brief-review').hidden = true;
  briefStatus.textContent = '';
}

brief.addEventListener('input', clearQuestionDraft);
el('brief-example').addEventListener('click', () => {
  brief.value = chartSource.brief ?? 'Before the report goes to the desk, make sure readers can tell which bus services reached at least 70% on time. Save the internal follow-up for our planning meeting.';
  clearQuestionDraft();
  brief.focus();
});

el('brief-submit').addEventListener('click', () => {
  let note;
  try {
    note = checkBrief(brief.value);
  } catch (error) {
    briefStatus.textContent = error.message;
    return;
  }
  clearQuestionDraft();
  const chartRows = rows;
  void runDeviceInference('question', questionPrompt(note, chartRows), questionConstraint, 'Chrome is reading the note on this device…',
    proposal => {
      const draft = readQuestionDraft(proposal, note, chartRows);
      if (draft.question.type === 'pair' && rows !== chartRows) throw Error('The chart changed while Chrome was reading the note.');
      questionDraft = draft.question.type === 'pair' ? {...draft, chartRows} : draft;
      el('brief-question').textContent = questionText(draft.question, chartRows);
      el('brief-evidence').textContent = questionDraft.evidence;
      el('brief-review').hidden = false;
      briefStatus.textContent = 'Firebase reported on-device inference. Review the question before using it.';
    });
});

el('brief-apply').addEventListener('click', () => {
  if (!questionDraft) return;
  setQuestion(questionDraft.question);
  invalidate();
  clearQuestionDraft();
  el('brief-panel').open = false;
  status.textContent = 'Question set. Answer it using the caption alone.';
  question.focus();
});

function previewCloudReview(target, text, selected) {
  snapshot = {target, text, prompt: cloudPrompt(rows, selected, text), revision,
    context: target === 'rewrite' ? rewriteContext : null};
  el('cloud-question').textContent = questionText(selected, rows);
  el('cloud-categories').textContent = answerText(rows, rows.map((_, index) => index + 1));
  el('cloud-caption').textContent = text;
  el('preview-data').textContent = target === 'rewrite'
    ? 'The rewrite shown below goes to Google. The separate original caption, private note, and source chart stay in this tab.'
    : 'Your private note and unpublished chart values stay in this tab.';
  el('cloud-exact').open = false;
  el('prompt').textContent = snapshot.prompt;
  dialog.returnValue = 'cancel';
  dialog.showModal();
}

function currentCloudRequest(request) {
  return request?.revision === revision && (request.target === 'editor' ||
    (rewriteDialog.open && request.context === rewriteContext && rewriteCaption.value.trim() === request.text));
}

const cloudFactOrigins = {
  matched: 'The browser read the same fact in the quote.',
  narrowed: 'The quote names qualifying categories and leaves the others open.',
  'rate-restored': 'The browser restored the exact rate stated in this quote.',
  interpreted: 'Gemini interpreted this quote. Check its meaning before approving.',
  restored: 'The browser read this fact directly from the caption.',
};

const cloudFactExclusions = {
  invalid: 'The draft fact lacked an exact excerpt or usable values.',
  mismatch: 'The browser read a different fact in this quote.',
  duplicate: 'The same quote already appears in the review.',
  cutoff: 'A cutoff needs a full sentence that states who qualifies.',
  excerpt: 'The excerpt does not establish a separate fact.',
};

function renderExcludedFacts(discarded, controls) {
  const details = el(controls.exclusions);
  details.hidden = !discarded.length;
  details.open = false;
  details.querySelector('summary').textContent = `${discarded.length} excluded ${discarded.length === 1 ? 'fact' : 'facts'}`;
  el(controls.excludedList).replaceChildren(...discarded.map(({index, claim, reason, parsed}) => {
    const item = make('li');
    item.append(make('strong', claim ? describeClaim(claim) : `Draft fact ${index}`));
    if (claim) item.append(make('q', claim.evidence));
    item.append(make('p', cloudFactExclusions[reason]));
    if (parsed) item.append(make('p', describeClaim(parsed)));
    return item;
  }));
}

function showCloudClaims(draft, request, controls) {
  const {claims, factReviews, discarded, restored} = reviewCloudClaims(rows, request.text, draft.claims);
  const reviewedDraft = {claims, alternatives: draft.alternatives};
  if (request.target === 'editor') candidate = reviewedDraft;
  else rewriteCandidate = {...reviewedDraft, request};
  const values = rows.map(row => row.value);
  const entries = factReviews.map(({claim, origin}) => {
    const item = make('li');
    const matches = fitsClaim(values, claim);
    const result = make('span', matches ? 'Matches the source data' : 'Conflicts with the source data', 'claim-result');
    result.dataset.matches = String(matches);
    item.append(make('strong', describeClaim(claim)), make('q', claim.evidence),
      make('p', cloudFactOrigins[origin]), result);
    return item;
  });
  el(controls.list).replaceChildren(...(entries.length ? entries : [make('li', 'Gemini found no supported quantitative claims.')]));
  el(controls.notes).textContent = restored
    ? `Recovered ${restored} ${restored === 1 ? 'fact' : 'facts'} directly from the caption.`
    : '';
  renderExcludedFacts(discarded, controls);
  el(controls.panel).hidden = false;
}

el('cloud-preview').addEventListener('click', () => {
  try {
    previewCloudReview('editor', checkText(caption.value), selectedQuestion());
  } catch (error) {
    status.textContent = error.message;
  }
});

dialog.addEventListener('close', async () => {
  const request = snapshot;
  snapshot = null;
  if (busy || dialog.returnValue !== 'send' || !currentCloudRequest(request)) return;
  const controls = cloudReviewControls[request.target];
  const feedback = el(controls.feedback);
  if (navigator.onLine === false) {
    feedback.textContent = `Reconnect to send the cloud request. ${controls.fallback}`;
    el(controls.local).focus();
    return;
  }
  if (request.target === 'editor') candidate = null;
  else clearRewriteCheck();
  el(controls.panel).hidden = true;
  const operation = {controller: new AbortController(), target: request.target};
  cloudOperation = operation;
  const ownsReview = () => cloudOperation === operation && currentCloudRequest(request);
  busy = true;
  syncActions();
  feedback.textContent = 'Verifying this browser for cloud review…';
  el(controls.cancel).focus();
  let draftReady = false;
  try {
    const firebase = await connectFirebase();
    if (!ownsReview()) return;
    const draft = await firebase.generateInCloud(request.prompt, {
      signal: operation.controller.signal,
      onSend: () => {
        if (ownsReview()) feedback.textContent = 'Waiting for Gemini’s draft…';
      },
    });
    if (!ownsReview()) return;
    recordAIResponse(request.target === 'editor' ? 'review' : 'rewrite');
    if (draft?.supported !== true || !Array.isArray(draft.alternatives)) throw Error('Gemini could not interpret the caption using the supported checks.');
    showCloudClaims(draft, request, controls);
    draftReady = true;
    feedback.textContent = 'Firebase reported in-cloud inference. Check the extracted facts.';
  } catch (error) {
    if (ownsReview()) feedback.textContent = `${error.message} ${controls.fallback}`;
  } finally {
    if (finishCloudReview(operation)) {
      if (draftReady) {
        const heading = el(controls.heading);
        heading.scrollIntoView({block: 'start'});
        heading.focus({preventScroll: true});
      } else {
        el(controls.local).focus();
      }
    }
  }
});

for (const [target, controls] of Object.entries(cloudReviewControls)) {
  el(controls.cancel).addEventListener('click', () => {
    if (cloudOperation?.target !== target) return;
    cancelCloudReview();
    el(controls.feedback).textContent = 'Cloud review canceled. A request already sent may still finish at Google.';
    el(controls.local).focus();
  });
}

el('confirm-facts').addEventListener('click', () => {
  if (!candidate?.claims.length) return;
  render(candidate.claims, candidate.alternatives, 'Firebase cloud draft, verified in your browser');
  el('claim-review').hidden = true;
  focusCheckResult();
});

el('nano').addEventListener('click', () => {
  if (!result) return;
  const detailStatus = el('detail-status');
  const selected = selectedQuestion();
  void runDeviceInference('detail', localPrompt(rows, selected), answerConstraint,
    'Chrome Nano is reading the source chart on this device…', reply => {
      try {
        if (!Array.isArray(reply?.ids)) throw Error('Chrome’s suggestion did not contain category IDs.');
        const ids = [...reply.ids].sort((a, b) => a - b);
        el('detail').textContent = supportedDetail(rows, selected, ids);
        detailStatus.textContent = 'Firebase ran on-device. The browser verified Chrome’s suggestion against the source chart.';
      } catch (error) {
        detailStatus.textContent = `Firebase ran on-device. ${error.message} You can still add the checked detail above.`;
      }
    });
});

function applyCaptionRevision(text, claims, comparison) {
  if (comparison) {
    pendingReaderTest = comparison;
    renderReaderTest();
  }
  caption.value = text;
  revision += 1;
  readerAnswer = undefined;
  render(claims);
  if (pendingReaderTest) el('start-reader-test').focus();
  else focusCheckResult();
}

el('apply').addEventListener('click', () => {
  if (!result || !reviewed) return;
  const selected = selectedQuestion();
  const evidence = supportedDetail(rows, selected, result.expected);
  const before = checkText(caption.value);
  const text = `${before} ${evidence}`;
  if (text.length > 1800) {
    status.textContent = 'Shorten the caption before adding the detail.';
    return;
  }
  const comparison = result.status === 'ambiguous'
    ? {rows, question: selected, expected: result.expected, before, after: text}
    : null;
  try {
    const newFacts = localCaptionClaims(evidence);
    applyCaptionRevision(text, [...reviewed, ...newFacts], comparison);
  } catch (error) {
    status.textContent = error.message;
  }
});

const rewriteDialog = el('rewrite-dialog');
const rewriteCaption = el('rewrite-caption');
const rewriteStatus = el('rewrite-status');
let rewriteContext;
let checkedRewrite;
let rewriteCandidate;

function clearRewriteCheck() {
  checkedRewrite = null;
  rewriteCandidate = null;
  if (cloudOperation?.target === 'rewrite') cancelCloudReview();
  el('rewrite-claim-review').hidden = true;
  el('confirm-rewrite-facts').disabled = true;
  rewriteStatus.textContent = '';
  rewriteStatus.removeAttribute('data-state');
  el('use-rewrite').disabled = true;
}

el('open-rewrite').addEventListener('click', () => {
  if (!result || result.status === 'conflict') return;
  const before = checkText(caption.value);
  rewriteContext = {revision, before, question: selectedQuestion()};
  el('rewrite-original').textContent = before;
  rewriteCaption.value = before;
  el('rewrite-question').textContent = questionText(rewriteContext.question, rows);
  clearRewriteCheck();
  rewriteDialog.returnValue = 'cancel';
  rewriteDialog.showModal();
  rewriteCaption.focus();
});
rewriteCaption.addEventListener('input', clearRewriteCheck);

function readChangedRewrite() {
  if (rewriteContext?.revision !== revision) {
    throw Error('The chart or question changed. Reopen the rewrite to check it again.');
  }
  const text = checkText(rewriteCaption.value);
  if (text === rewriteContext.before) throw Error('Change the wording before checking the rewrite.');
  return text;
}

function checkRewrite(text, claims, alternatives = []) {
  const result = checkCaption(rows, rewriteContext.question, claims, alternatives);
  if (result.status === 'conflict') {
    const values = rows.map(row => row.value);
    const conflict = claims.find(claim => !fitsClaim(values, claim));
    rewriteStatus.textContent = `This sentence conflicts with the source chart. “${conflict.evidence}”`;
    return;
  }
  const sourceAnswer = answerText(rows, result.expected);
  if (result.status === 'ambiguous') {
    const alternate = answerText(rows, result.alternateAnswer);
    rewriteStatus.textContent = `The source chart answers “${sourceAnswer}.” The same rewrite also fits a chart that answers “${alternate}.”`;
    return;
  }
  checkedRewrite = {text, claims, expected: result.expected};
  rewriteStatus.textContent = result.status === 'explicit'
    ? `The rewrite directly establishes the answer “${sourceAnswer}.”`
    : `The checked facts force the answer “${sourceAnswer}.” Readers still need to work it out.`;
  rewriteStatus.dataset.state = 'resolved';
  el('use-rewrite').disabled = false;
}

el('check-rewrite').addEventListener('click', () => {
  clearRewriteCheck();
  try {
    const text = readChangedRewrite();
    checkRewrite(text, localCaptionClaims(text));
  } catch (error) {
    rewriteStatus.textContent = error.message;
  }
});

el('rewrite-cloud-preview').addEventListener('click', () => {
  try {
    previewCloudReview('rewrite', readChangedRewrite(), rewriteContext.question);
  } catch (error) {
    rewriteStatus.textContent = error.message;
  }
});

el('confirm-rewrite-facts').addEventListener('click', () => {
  if (!rewriteCandidate?.claims.length || !currentCloudRequest(rewriteCandidate.request)) return;
  const {request, claims, alternatives} = rewriteCandidate;
  clearRewriteCheck();
  try {
    checkRewrite(request.text, claims, alternatives);
    (checkedRewrite ? el('use-rewrite') : el('rewrite-cloud-preview')).focus();
  } catch (error) {
    rewriteStatus.textContent = error.message;
  }
});
rewriteDialog.addEventListener('close', () => {
  const context = rewriteContext;
  const checked = checkedRewrite;
  rewriteContext = null;
  clearRewriteCheck();
  if (rewriteDialog.returnValue !== 'use' || context?.revision !== revision || !checked) return;
  applyCaptionRevision(checked.text, checked.claims, {
    rows, question: context.question, expected: checked.expected, before: context.before, after: checked.text,
  });
});

function downloadFile(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = make('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

el('download-ai-activity').addEventListener('click', () => {
  if (!aiActivity.size) return;
  const record = {version: 1, source: 'Firebase AI Logic responses reported by this browser', entries: [...aiActivity.values()]};
  downloadFile(JSON.stringify(record, null, 2) + '\n', 'application/json', 'two-charts-ai-activity.json');
});

el('save-recheck').addEventListener('click', () => {
  try {
    const saved = createPublishCheck(rows, selectedQuestion(), caption.value, reviewed, chartSource.columns);
    downloadFile(JSON.stringify(saved, null, 2) + '\n', 'application/json', 'caption-recheck.json');
  } catch (error) {
    status.textContent = error.message;
  }
});

const recheckStatus = el('recheck-status');
const savedCaptionDialog = el('saved-caption-dialog');
let previewedCheck;
const editorialFileDialog = el('editor-draft-dialog');
const editorialFileStatus = el('editor-draft-status');
let editorialFileRevision = 0;
let previewedEditorialFile;

el('save-editor-draft').addEventListener('click', () => {
  try {
    const selected = selectedQuestion();
    const columns = chartSource.columns;
    const review = reviewed?.length ? createPublishCheck(rows, selected, caption.value, reviewed, columns) : null;
    const draft = writeEditorialDraft({
      rows, caption: caption.value, question: selected, sourceNote: chartSource.sourceCitation, review, columns,
    });
    downloadFile(draft, 'application/json', 'two-charts-editorial-draft.json');
    editorialFileStatus.textContent = 'Draft downloaded. It contains the selected chart values.';
  } catch (error) {
    editorialFileStatus.textContent = error.message;
  }
});
el('editor-draft-file').addEventListener('change', async event => {
  const picker = event.currentTarget;
  const file = picker.files[0];
  picker.value = '';
  if (!file) return;
  const intent = ++editorialFileRevision;
  editorialFileStatus.textContent = '';
  try {
    if (file.size > maxEditorialDraftBytes) throw Error('Choose an editorial draft under 160 KB.');
    const text = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer());
    if (intent !== editorialFileRevision) return;
    const draft = readEditorialDraft(text);
    const chart = readChart(draft.csv);
    if (busy || document.querySelector('dialog[open]')) throw Error('Finish the current action, then choose the draft again.');
    previewedEditorialFile = {draft, chart, name: file.name};
    el('editor-draft-question').textContent = `${questionText(draft.question, chart)} · ${chart.length} categories`;
    el('editor-draft-caption').textContent = draft.caption || 'Empty caption';
    el('editor-draft-data').open = false;
    el('editor-draft-categories').replaceChildren(...chart.map(({label, value}) => make('li', `${label} · ${value}%`)));
    el('editor-draft-note').textContent = 'Opening the draft replaces the chart, caption, question, and saved review in this editor.' +
      (draft.review ? ' The browser will rerun the saved review.' : '');
    editorialFileDialog.returnValue = 'cancel';
    editorialFileDialog.showModal();
  } catch (error) {
    if (intent !== editorialFileRevision) return;
    editorialFileStatus.textContent = error instanceof SyntaxError || error instanceof TypeError
      ? 'Choose an editorial draft in UTF-8 JSON format.' : error.message;
  }
});
editorialFileDialog.addEventListener('close', () => {
  const preview = previewedEditorialFile;
  previewedEditorialFile = null;
  el('editor-draft-caption').textContent = '';
  el('editor-draft-categories').replaceChildren();
  if (!preview || editorialFileDialog.returnValue !== 'open') return;
  const {draft, chart, name} = preview;
  setQuestion(draft.question, chart);
  applyChart(chart, draft.csv, {label: 'Editorial draft', sourceCitation: draft.sourceNote}, draft.columns);
  caption.value = draft.caption;
  savedCheck = draft.review;
  el('recheck-file-name').textContent = savedCheck ? name : '';
  el('recheck-actions').hidden = !savedCheck;
  editorialFileStatus.textContent = 'Editorial draft opened.';
  if (savedCheck) runSavedCheck(savedCheck);
});

function runSavedCheck(check = savedCheck, feedback = recheckStatus) {
  if (!check) return;
  if (!caption.value.trim()) {
    invalidate();
    feedback.textContent = 'Paste the caption you plan to publish or choose Review saved caption.';
    return;
  }
  try {
    const input = reviewPublishInputs(rows, caption.value, check, chartSource.columns);
    if (input.status === 'review_required') {
      invalidate();
      feedback.textContent = input.message;
      return;
    }
    rows = input.rows;
    setQuestion(check.question);
    invalidate();
    render(check.claims, [], 'Saved check');
    if (result.status === 'conflict') {
      status.textContent = 'Saved check failed. Review the marked excerpt before publishing.';
      const repair = suggestPublishRepair(rows, caption.value, check, chartSource.columns);
      if (repair) {
        staleRepair = {repair, original: check};
        el('stale-before').textContent = repair.before;
        el('stale-after').textContent = repair.after;
        el('stale-repair').hidden = false;
        status.textContent = 'One answer sentence no longer matches the data. Review the proposed replacement below.';
      }
    }
    if (result.status === 'explicit' || result.status === 'implied') {
      status.textContent = 'Saved check passed. The reviewed facts still resolve this question.';
    }
    focusCheckResult();
  } catch (error) {
    invalidate();
    feedback.textContent = error.message;
  }
}

el('recheck-file').addEventListener('change', async event => {
  const picker = event.currentTarget;
  const file = picker.files[0];
  picker.value = '';
  if (!file) return;
  invalidate();
  const current = revision;
  savedCheck = null;
  el('recheck-actions').hidden = true;
  busy = true;
  syncActions();
  try {
    if (file.size > 40000) throw Error('Choose a recheck file under 40 KB.');
    savedCheck = readPublishCheck(JSON.parse(await file.text()));
    el('recheck-file-name').textContent = file.name;
    el('recheck-actions').hidden = false;
    if (current === revision) runSavedCheck();
    else recheckStatus.textContent = 'Saved check loaded. Run it when your caption and data are ready.';
  } catch (error) {
    recheckStatus.textContent = error instanceof SyntaxError
      ? 'This file is not a valid recheck JSON file.'
      : error.message;
  } finally {
    busy = false;
    syncActions();
  }
});

el('run-recheck').addEventListener('click', () => runSavedCheck());
el('apply-stale-repair').addEventListener('click', () => {
  if (!staleRepair || busy) return;
  const {repair, original} = staleRepair;
  caption.value = repair.caption;
  if (savedCheck === original) savedCheck = repair.check;
  if (exampleReview?.check === original) exampleReview = {check: repair.check};
  runSavedCheck(repair.check, status);
  if (result?.status === 'explicit') {
    status.textContent = 'Sentence updated. All reviewed facts match the current data. Save the recheck file to keep this wording.';
  }
});
el('example-refresh').addEventListener('click', () => {
  const restoring = chartSource === refreshedExample;
  try {
    const demo = restoring ? exampleReview : {
      check: createPublishCheck(rows, selectedQuestion(), caption.value, reviewed),
      readerTest: pendingReaderTest,
    };
    const data = restoring ? sampleCsv : refreshedSampleCsv;
    const source = restoring ? originalExample : refreshedExample;
    applyChart(readChart(data), data, source);
    exampleReview = restoring ? null : demo;
    runSavedCheck(demo.check, status);
    if (restoring && result?.status === 'explicit' && demo.readerTest) {
      pendingReaderTest = demo.readerTest;
      renderReaderTest();
    }
  } catch (error) {
    status.textContent = error.message;
  }
});
el('review-saved-caption').addEventListener('click', () => {
  if (!savedCheck) return;
  previewedCheck = savedCheck;
  el('saved-caption-text').textContent = savedCheck.caption;
  savedCaptionDialog.returnValue = 'cancel';
  savedCaptionDialog.showModal();
});
savedCaptionDialog.addEventListener('close', () => {
  const preview = previewedCheck;
  previewedCheck = null;
  if (!preview || preview !== savedCheck || savedCaptionDialog.returnValue !== 'restore') return;
  caption.value = savedCheck.caption;
  invalidate();
  runSavedCheck();
});

el('download-comparison').addEventListener('click', () => {
  if (result?.status !== 'ambiguous') return;
  const report = comparisonReport(document, {
    caption: checkText(caption.value), question: selectedQuestion(), rows, result,
    claims: reviewed, describeClaim, sourceNote: chartSource.sourceCitation,
  });
  downloadFile(report, 'text/html;charset=utf-8', 'caption-comparison.html');
});

function canPublish() {
  return result?.status === 'explicit' || result?.status === 'implied';
}

el('export').addEventListener('click', () => {
  if (!canPublish()) return;
  downloadFile(reviewedDescription(document, caption.value, rows, chartSource.sourceCitation),
    'text/html;charset=utf-8', 'chart-description.html');
});

const publicationDialog = el('publication-dialog');
const publicationFormat = el('publication-format');
const publicationContent = el('publication-content');
const publicationCopy = el('publication-copy');
const publicationStatus = el('publication-status');
let publicationVersion = 0;

function showPublicationFormat() {
  publicationVersion += 1;
  publicationStatus.textContent = '';
  const withTable = publicationFormat.value === 'html';
  publicationContent.value = withTable
    ? reviewedFragment(document, caption.value, rows, chartSource.sourceCitation)
    : caption.value;
  el('publication-note').textContent = withTable
    ? 'Paste into an HTML block. This includes the source chart values.'
    : 'Paste into your publishing system’s caption or description field.';
  publicationCopy.textContent = withTable ? 'Copy HTML source' : 'Copy caption';
}
el('publication').addEventListener('click', () => {
  if (!canPublish()) return;
  publicationFormat.value = 'caption';
  showPublicationFormat();
  publicationDialog.showModal();
});
publicationFormat.addEventListener('change', showPublicationFormat);
publicationDialog.addEventListener('close', () => {
  publicationVersion += 1;
  publicationContent.value = '';
  publicationStatus.textContent = '';
});
publicationCopy.addEventListener('click', async () => {
  if (!publicationDialog.open || !canPublish()) return;
  const version = publicationVersion;
  const withTable = publicationFormat.value === 'html';
  try {
    await navigator.clipboard.writeText(publicationContent.value);
    if (publicationDialog.open && version === publicationVersion) {
      publicationStatus.textContent = withTable ? 'HTML source copied.' : 'Caption copied.';
    }
  } catch {
    if (publicationDialog.open && version === publicationVersion) {
      publicationContent.focus();
      publicationContent.select();
      publicationStatus.textContent = 'Content selected. Use your browser’s copy command.';
    }
  }
});

el('reader-preview').addEventListener('click', () => {
  try {
    const url = createReaderLink(location.href, rows, selectedQuestion(), caption.value);
    el('reader-link-caption').textContent = checkText(caption.value);
    el('reader-url').value = url;
    el('reader-open').href = url;
    el('reader-link-status').textContent = '';
    el('reader-dialog').showModal();
  } catch (error) {
    status.textContent = error.message;
  }
});

el('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el('reader-url').value);
    el('reader-link-status').textContent = 'Reader link copied.';
  } catch {
    el('reader-url').select();
    el('reader-link-status').textContent = 'The link is selected. Copy it with your browser controls.';
  }
});

const testVersions = [['before', 'Original caption'], ['after', 'Revised caption']];
const testStatus = el('reader-test-status');

function countText(counts) {
  const total = counts.correct + counts.uncertain + counts.different;
  return total
    ? `${counts.correct} of ${total} matched · ${counts.uncertain} unsure · ${counts.different} different`
    : 'Waiting for reader responses';
}

function readerVersionCard(test, key, title) {
  const caption = test[key].caption;
  const card = make('article', undefined, 'test-version');
  card.setAttribute('aria-label', title);
  const captionText = make('p', caption, 'test-caption');
  if (key === 'after' && caption.startsWith(test.before.caption + ' ')) {
    captionText.textContent = test.before.caption + ' ';
    captionText.append(make('mark', caption.slice(test.before.caption.length + 1)));
  }
  card.append(make('h3', title), captionText, make('p', countText(readerCounts(test, key)), 'test-count'));
  return card;
}

function renderReaderTest() {
  el('reader-test').hidden = !readerTest && !pendingReaderTest;
  const start = el('start-reader-test');
  start.hidden = !pendingReaderTest;
  start.textContent = readerTest ? 'Create a new test' : 'Create before and after links';
  el('reader-test-run').hidden = !readerTest;
  if (!readerTest) return;
  const labels = readerTest.labels.map(label => ({label}));
  el('reader-test-question').textContent = `Question: ${questionText(readerTest.question, readerTest.labels.map(label => ({label})))}`;
  el('reader-test-versions').replaceChildren(...testVersions.map(([key, title]) => {
    const {caption, invitation} = readerTest[key];
    const card = readerVersionCard(readerTest, key, title);
    const url = createReaderLink(location.href, labels, readerTest.question, caption, invitation);
    const open = make('a', 'Open');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.setAttribute('aria-label', `Open reader view for ${title.toLowerCase()}`);
    const copy = make('button', 'Copy link', 'small');
    copy.type = 'button';
    copy.setAttribute('aria-label', `Copy reader link for ${title.toLowerCase()}`);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        testStatus.textContent = `${title} link copied.`;
      } catch {
        testStatus.textContent = 'Open the reader view and copy the address from your browser.';
      }
    });
    const actions = make('div', undefined, 'controls');
    actions.append(copy, open);
    card.append(actions);
    return card;
  }));
  el('download-reader-results').hidden = testVersions.every(([key]) => !readerTest[key].responses.length);
}

function persistReaderTest() {
  const saved = saveReaderTest(tabStorage, readerTest);
  el('reader-test-storage').textContent = saved
    ? 'Saved in this tab. Save a test file to continue in another tab.'
    : 'Browser storage is unavailable. Save a test file to keep your responses.';
}

function openReaderTest(test, message) {
  readerTest = test;
  el('reader-response').value = '';
  renderReaderTest();
  persistReaderTest();
  testStatus.textContent = message;
  el('reader-test-versions').querySelector('button').focus();
}

function startReaderTest() {
  if (!pendingReaderTest) return;
  const {rows, question, expected, before, after} = pendingReaderTest;
  try {
    const test = createReaderTest(rows, question, expected, before, after);
    pendingReaderTest = null;
    openReaderTest(test, 'Reader links are ready.');
  } catch (error) {
    testStatus.textContent = error.message;
  }
}

const replaceDialog = el('replace-test-dialog');
el('start-reader-test').addEventListener('click', () => {
  if (!readerTest) startReaderTest();
  else {
    replaceDialog.returnValue = 'cancel';
    replaceDialog.showModal();
  }
});
replaceDialog.addEventListener('close', () => {
  if (replaceDialog.returnValue === 'replace') startReaderTest();
});

el('save-reader-test-file').addEventListener('click', () => {
  if (!readerTest) return;
  downloadFile(writeReaderTestFile(readerTest), 'application/json', 'caption-reader-test.json');
  testStatus.textContent = 'Reader test downloaded. Keep this file with the editor.';
});

const readerFileDialog = el('open-reader-file-dialog');
let readerFileRevision = 0;
let previewedReaderFile;
el('reader-test-file').addEventListener('change', async event => {
  const picker = event.currentTarget;
  const file = picker.files[0];
  picker.value = '';
  if (!file) return;
  const revision = ++readerFileRevision;
  const feedback = el('reader-file-status');
  feedback.textContent = '';
  try {
    if (file.size > maxReaderTestFileBytes) throw Error('Choose a reader test file under 64 KB.');
    const text = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer());
    if (revision !== readerFileRevision) return;
    const test = readReaderTestFile(text);
    previewedReaderFile = test;
    el('reader-file-question').textContent = questionText(test.question, test.labels.map(label => ({label})));
    el('reader-file-versions').replaceChildren(...testVersions.map(([key, title]) => readerVersionCard(test, key, title)));
    el('open-reader-file-note').textContent = readerTest
      ? 'Opening this file replaces the test in this tab. Save the current test first if you need to resume it later.'
      : 'Open this file to continue collecting replies to the original reader links.';
    readerFileDialog.returnValue = 'cancel';
    readerFileDialog.showModal();
  } catch (error) {
    if (revision === readerFileRevision) {
      feedback.textContent = error instanceof TypeError ? 'Choose a UTF-8 reader test file.' : error.message;
    }
  }
});
readerFileDialog.addEventListener('close', () => {
  const test = previewedReaderFile;
  previewedReaderFile = null;
  el('reader-file-versions').replaceChildren();
  if (test && readerFileDialog.returnValue === 'open') openReaderTest(test, 'Reader test opened. The original links still accept responses.');
});

el('reader-response-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = el('reader-response');
  try {
    const added = addReaderResponse(readerTest, input.value);
    readerTest = added.test;
    input.value = '';
    renderReaderTest();
    persistReaderTest();
    testStatus.textContent = `${added.action} a response to the ${added.variant === 'before' ? 'original' : 'revised'} caption.`;
  } catch (error) {
    testStatus.textContent = error.message;
  }
  input.focus();
});

el('download-reader-results').addEventListener('click', () => {
  if (!readerTest) return;
  const lines = ['# Two Charts, One Caption — reader test', '',
    el('reader-test-question').textContent,
    `Source answer: ${answerText(readerTest.labels.map(label => ({label})), readerTest.expected)}`, ''];
  for (const [key, title] of testVersions) {
    lines.push(title, readerTest[key].caption, countText(readerCounts(readerTest, key)), '');
  }
  lines.push('Counts reflect response codes returned by readers. Each code is counted once per caption version.', '');
  downloadFile(lines.join('\n'), 'text/plain;charset=utf-8', 'caption-reader-results.txt');
});

function mountReader(packet) {
  el('studio').hidden = true;
  el('reader').hidden = false;
  el('reader-caption').textContent = packet.caption;
  const readerRows = packet.labels.map(label => ({label}));
  const prompt = questionText(packet.question, readerRows);
  el('reader-question').textContent = questionPromptText(packet.question, readerRows);
  const options = packet.labels.flatMap((label, index) => {
    const id = index + 1;
    if (packet.question?.type === 'pair' && !packet.question.ids.includes(id)) return [];
    const {input, option} = categoryChoice(label, 'reader-option');
    el('reader-options').append(option);
    return [{input, id}];
  });
  const responseId = packet.invitation ? readerResponseId(tabStorage, packet.invitation) : null;
  let recorded;
  function record(choices) {
    const answer = choices === null ? 'The caption doesn’t say'
      : answerText(readerRows, choices);
    recorded = `${prompt} My answer: ${answer}.`;
    el('reader-status').textContent = recorded;
    if (packet.invitation) {
      el('reader-code').value = encodeResponse(packet.invitation, responseId, choices);
      el('reader-code-panel').hidden = false;
      el('reader-copy').textContent = 'Copy response code';
    }
    el('reader-copy').hidden = false;
  }
  el('reader-submit').addEventListener('click', () => {
    const ids = options.filter(({input}) => input.checked).map(({id}) => id);
    if (ids.length) record(ids);
    else {
      el('reader-copy').hidden = true;
      el('reader-code-panel').hidden = true;
      el('reader-status').textContent = 'Choose at least one category or select “The caption doesn’t say.”';
    }
  });
  const none = el('reader-none');
  none.hidden = !isCutoffClaim(packet.question);
  none.textContent = noCutoffMatches(packet.question.type);
  none.addEventListener('click', () => record([]));
  el('reader-unknown').addEventListener('click', () => record(null));
  el('reader-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(packet.invitation ? el('reader-code').value : recorded);
      el('reader-status').textContent = packet.invitation
        ? 'Response code copied. Send it to the editor.'
        : 'Response copied. You can share it with the author.';
    } catch {
      if (packet.invitation) el('reader-code').select();
      else el('reader-status').textContent = recorded;
    }
  });
}

// A second invitation pasted into the same tab changes only the URL fragment.
window.addEventListener('hashchange', () => location.reload());
try {
  const packet = readReaderLink(location.hash);
  if (packet) mountReader(packet);
  else {
    readerTest = restoreReaderTest(tabStorage);
    loadSample(startingExample);
    renderReaderTest();
  }
} catch {
  loadSample(startingExample);
  status.textContent = 'That reader link could not be opened. The example is ready to try.';
}
