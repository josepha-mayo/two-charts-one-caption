import './style.css';
import {
  readChart, checkCaption, validateClaims, answerText, sameAnswer, supportedDetail, fitsClaim, questionText, readQuestion,
} from './check.mjs';
import {localFacts, cloudPrompt, localPrompt, checkText, answerConstraint, reviewCloudClaims} from './draft.mjs';
import {defaultChartColumns, readChartRows, readCsvTable} from './csv.mjs';
import {checkBrief, questionPrompt, questionConstraint, readQuestionDraft} from './brief.mjs';
import {createPublishCheck, readPublishCheck, reviewPublishInputs, suggestPublishRepair} from './publish-check.mjs';
import {deviceAvailability} from './device.mjs';
import {saveOfflineApp} from './offline.mjs';
import {sampleCsv, sampleCaption, cutoffCaption, sampleSource, foodExample} from './sample.mjs';
import {comparisonReport, reviewedDescription} from './report.mjs';
import refreshedSampleCsv from '../examples/bus-cutoff/refreshed.csv?raw';
import {
  addReaderResponse, createReaderLink, createReaderTest, encodeResponse, readReaderLink,
  maxReaderTestFileBytes, readReaderTestFile, readerCounts, readerResponseId, restoreReaderTest, saveReaderTest, writeReaderTestFile,
} from './reader.mjs';

const el = id => document.getElementById(id);
const caption = el('caption');
const question = el('question');
const cutoff = el('cutoff');
const csv = el('csv');
const dialog = el('dialog');
const status = el('status');
const requestedExample = new URLSearchParams(location.search).get('example');
const startingExample = ['cutoff', 'food'].includes(requestedExample) ? requestedExample : 'bus';
let rows, result, reviewed, candidate, snapshot;
let firebaseConnection;
let cloudOperation;
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
const aiOperations = {
  question: {label: 'Question from private note', route: 'on_device', inputs: ['Private note']},
  detail: {label: 'Caption detail from source chart', route: 'on_device', inputs: ['Source percentages', 'Category IDs', 'Selected question']},
  review: {label: 'Cloud fact draft', route: 'in_cloud', inputs: ['Caption approved for cloud review', 'Category names', 'Selected question']},
};
const aiActivity = new Map();

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
  return readQuestion(question.value === 'atLeast' ? {type: 'atLeast', cutoff: cutoff.valueAsNumber} : question.value);
}

function setQuestion(selected) {
  question.value = typeof selected === 'string' ? selected : selected.type;
  if (typeof selected !== 'string') cutoff.value = String(selected.cutoff);
}

const deltaFormat = new Intl.NumberFormat('en', {signDisplay: 'always', maximumFractionDigits: 2});

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
    if (typeof selected !== 'string') {
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
    : `At or above ${selected.cutoff}%`;
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
  el('recheck-source').textContent = `Data in use · ${chartSource.label}`;
  el('source-chart-title').textContent = chartSource === refreshedExample ? 'Simulated data refresh' : 'Source chart';
  updateExampleRefresh();
  const showCutoff = question.value === 'atLeast';
  el('cutoff-label').hidden = !showCutoff;
  try {
    el('studio-question').textContent = `${questionText(selectedQuestion())} Select all that apply.`;
  } catch (error) {
    el('studio-question').textContent = error.message;
  }
  const unknown = choiceButton('The caption doesn’t say', () => browserCheck(null), true);
  const checks = rows.map(({label}) => {
    const choice = categoryChoice(label, 'challenge-option');
    choice.input.disabled = busy;
    return choice;
  });
  const reveal = choiceButton('Check selected categories', () => {
    const ids = checks.flatMap(({input}, i) => input.checked ? [i + 1] : []);
    if (ids.length) browserCheck(ids);
    else status.textContent = 'Select at least one category, or choose an answer below.';
  });
  el('reader-choices').replaceChildren(
    ...checks.map(({option}) => option), reveal,
    ...(showCutoff ? [choiceButton('None reach the cutoff', () => browserCheck([]))] : []), unknown,
  );
}

function syncActions() {
  for (const id of ['check', 'cloud-preview', 'load', 'csv-file', 'example', 'example-select', 'nano', 'apply', 'confirm-facts',
    'brief-example', 'brief-submit', 'brief-apply', 'recheck-file', 'save-recheck', 'run-recheck',
    'review-saved-caption', 'apply-stale-repair', 'example-refresh', 'csv-category', 'csv-percent',
    'use-csv-columns']) el(id).disabled = busy;
  for (const control of el('reader-choices').querySelectorAll('button, input')) control.disabled = busy;
  el('cloud-cancel').hidden = !cloudOperation;
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
  operation.abort();
  finishCloudReview(operation);
}

function renderSource() {
  const link = el('source');
  link.hidden = !chartSource.sourceUrl;
  if (link.hidden) return;
  link.href = chartSource.sourceUrl;
  link.textContent = chartSource.sourceCitation;
}

function loadSample(key) {
  clearCsvMapping();
  chartSource = key === 'food' ? foodExample : originalExample;
  exampleReview = null;
  el('example-select').value = key;
  csv.value = chartSource.csv;
  caption.value = key === 'cutoff' ? cutoffCaption : chartSource.caption;
  question.value = key === 'cutoff' ? 'atLeast' : chartSource.question;
  cutoff.value = '70';
  rows = readChart(chartSource.csv);
  el('csv-status').textContent = '';
  renderSource();
  invalidate();
}

function describeClaim(claim) {
  if (claim.type === 'range') return `Range ${claim.min}%–${claim.max}%`;
  if (claim.type === 'value') return `${rows[claim.id - 1].label} is ${claim.value}%`;
  if (claim.type === 'atLeast') return `At or above ${claim.cutoff}%: ${answerText(rows, claim.ids)}`;
  if (claim.type === 'atLeastSome') return `${answerText(rows, claim.ids)} reached at least ${claim.cutoff}%`;
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
  el('witness-question').textContent = questionText(selected);
  el('witness-source').textContent = answerText(rows, expected);
  el('witness-alternate').textContent = answerText(rows, alternateAnswer);
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
  status.dataset.state = state;
  el('comparison').hidden = false;
  el('revision').hidden = state === 'conflict';
  el('export').hidden = state !== 'explicit' && state !== 'implied';
  el('apply').hidden = state !== 'ambiguous' && state !== 'implied';
  el('nano').hidden = state !== 'ambiguous';
  const guess = readerAnswer === undefined || state !== 'ambiguous' ? ''
    : readerAnswer === null ? 'You spotted the gap. '
      : `You picked ${answerText(rows, readerAnswer)}. The caption leaves more than one answer possible. `;
  const text = {
    ambiguous: `${guess}Both charts fit the checked facts. Their answers differ. ${note}${result.origin === 'browser' && note !== 'Browser check' ? ' · witness found by browser' : ''}.`,
    explicit: expected.length
      ? `The reviewed description now names ${names}. The alternate answer cannot satisfy that fact.`
      : 'The reviewed description now establishes that no category reaches the cutoff.',
    conflict: 'A checked fact contradicts the source chart. Revise the caption or its interpretation.',
    implied: `The checked facts force the same answer: ${names}. You can still state it directly for readers.`,
  };
  const resolved = state === 'explicit' || state === 'implied';
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
    for (const [index, input] of el('reader-choices').querySelectorAll('input').entries()) {
      input.checked = guess.includes(index + 1);
    }
  }
  try {
    const text = checkText(caption.value);
    render(validateClaims(localFacts(rows, text), text, rows.length));
  } catch (error) {
    status.textContent = error.message;
    status.dataset.state = 'conflict';
  }
  focusCheckResult();
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

function applyChart(chart, input, source) {
  clearCsvMapping();
  rows = chart;
  chartSource = source;
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

function importChart(input, source = pastedCsv) {
  clearCsvMapping();
  csv.value = input;
  try {
    const table = readCsvTable(input);
    const columns = defaultChartColumns(table.headers);
    if (columns) {
      applyChart(readChartRows(table, columns), input, source);
      return;
    }
    pendingImport = {table, source};
    for (const id of ['csv-category', 'csv-percent']) {
      const select = el(id);
      select.add(new Option('Choose a column', ''));
      table.headers.forEach((header, index) => {
        select.add(new Option(header ? `${index + 1}. ${header}` : `Column ${index + 1} (no header)`, index));
      });
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
    applyChart(readChartRows(table, {category: Number(category), rate: Number(rate)}), csv.value, source);
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
let briefRevision = 0;
let questionDraft;

function clearQuestionDraft() {
  briefRevision += 1;
  questionDraft = null;
  el('brief-review').hidden = true;
  briefStatus.textContent = '';
}

brief.addEventListener('input', clearQuestionDraft);
el('brief-example').addEventListener('click', () => {
  brief.value = 'Before the report goes to the desk, make sure readers can tell which bus services reached at least 70% on time. Save the internal follow-up for our planning meeting.';
  clearQuestionDraft();
  brief.focus();
});

el('brief-submit').addEventListener('click', async () => {
  let note;
  try {
    note = checkBrief(brief.value);
  } catch (error) {
    briefStatus.textContent = error.message;
    return;
  }
  clearQuestionDraft();
  const current = briefRevision;
  busy = true;
  syncActions();
  briefStatus.textContent = 'Chrome is reading the note on this device…';
  try {
    const firebase = await connectFirebase();
    if (current !== briefRevision) return;
    const proposal = await firebase.generateOnDevice(questionPrompt(note), questionConstraint);
    if (current !== briefRevision) return;
    recordAIResponse('question');
    questionDraft = readQuestionDraft(proposal, note);
    el('brief-question').textContent = questionText(questionDraft.question);
    el('brief-evidence').textContent = questionDraft.evidence;
    el('brief-review').hidden = false;
    briefStatus.textContent = 'Firebase reported on-device inference. Review the question before using it.';
  } catch (error) {
    if (current === briefRevision) briefStatus.textContent = `${error.message} You can set the question with the controls above.`;
  } finally {
    busy = false;
    syncActions();
  }
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

el('cloud-preview').addEventListener('click', () => {
  try {
    const selected = selectedQuestion();
    const text = checkText(caption.value);
    snapshot = {prompt: cloudPrompt(rows, selected, text), revision};
    el('cloud-question').textContent = questionText(selected);
    el('cloud-categories').textContent = answerText(rows, rows.map((_, index) => index + 1));
    el('cloud-caption').textContent = text;
    el('cloud-exact').open = false;
    el('prompt').textContent = snapshot.prompt;
    dialog.returnValue = 'cancel';
    dialog.showModal();
  } catch (error) {
    status.textContent = error.message;
  }
});

dialog.addEventListener('close', async () => {
  const request = snapshot;
  snapshot = null;
  if (busy || dialog.returnValue !== 'send' || request?.revision !== revision) return;
  if (navigator.onLine === false) {
    status.textContent = 'Reconnect to send the cloud request. You can check the caption in this browser while offline.';
    return;
  }
  candidate = null;
  el('claim-review').hidden = true;
  const operation = new AbortController();
  cloudOperation = operation;
  const ownsReview = () => cloudOperation === operation && request.revision === revision;
  busy = true;
  syncActions();
  status.textContent = 'Verifying this browser for cloud review…';
  el('cloud-cancel').focus();
  try {
    const firebase = await connectFirebase();
    if (!ownsReview()) return;
    const draft = await firebase.generateInCloud(request.prompt, {
      signal: operation.signal,
      onSend: () => {
        if (ownsReview()) status.textContent = 'Waiting for Gemini’s draft…';
      },
    });
    if (!ownsReview()) return;
    recordAIResponse('review');
    if (draft?.supported !== true || !Array.isArray(draft.alternatives)) throw Error('Gemini could not interpret the caption using the supported checks.');
    const {claims, excluded, narrowed, restored} = reviewCloudClaims(rows, caption.value, draft.claims);
    candidate = {claims, alternatives: draft.alternatives};
    const entries = claims.map(claim => {
      return make('li', `${describeClaim(claim)} · “${claim.evidence}”`);
    });
    el('claims').replaceChildren(...(entries.length ? entries : [make('li', 'Gemini found no supported quantitative claims.')]));
    const notes = [];
    if (excluded) notes.push(`Omitted ${excluded} ${excluded === 1 ? 'draft fact' : 'draft facts'} without distinct supporting wording.`);
    if (narrowed) notes.push('The quoted wording confirms who qualifies and leaves other categories open.');
    if (restored) notes.push(`Recovered ${restored} ${restored === 1 ? 'fact' : 'facts'} directly from the caption.`);
    el('claim-rejections').textContent = notes.join(' ');
    el('claim-review').hidden = false;
    status.textContent = 'Firebase reported in-cloud inference. Check the extracted facts.';
  } catch (error) {
    if (ownsReview()) status.textContent = error.message;
  } finally {
    if (finishCloudReview(operation)) {
      el(candidate ? 'confirm-facts' : 'cloud-preview').focus();
    }
  }
});

el('cloud-cancel').addEventListener('click', () => {
  if (!cloudOperation) return;
  cancelCloudReview();
  status.textContent = 'Cloud review canceled. A request already sent may still finish at Google.';
  el('check').focus();
});

el('confirm-facts').addEventListener('click', () => {
  if (!candidate) return;
  render(candidate.claims, candidate.alternatives, 'Firebase cloud draft, verified in your browser');
  el('claim-review').hidden = true;
  focusCheckResult();
});

el('nano').addEventListener('click', async () => {
  if (!result) return;
  const current = revision;
  const detailStatus = el('detail-status');
  busy = true;
  syncActions();
  detailStatus.textContent = 'Chrome Nano is reading the source chart on this device…';
  try {
    const firebase = await connectFirebase();
    if (current !== revision) return;
    const selected = selectedQuestion();
    const reply = await firebase.generateOnDevice(localPrompt(rows, selected), answerConstraint);
    if (current !== revision) return;
    recordAIResponse('detail');
    try {
      if (!Array.isArray(reply?.ids)) throw Error('Chrome’s suggestion did not contain category IDs.');
      const ids = [...reply.ids].sort((a, b) => a - b);
      el('detail').textContent = supportedDetail(rows, selected, ids);
      detailStatus.textContent = 'Firebase ran on-device. The browser verified Chrome’s suggestion against the source chart.';
    } catch (error) {
      detailStatus.textContent = `Firebase ran on-device. ${error.message} You can still add the checked detail above.`;
    }
  } catch (error) {
    if (current === revision) detailStatus.textContent = `${error.message} You can still add the checked detail above.`;
  } finally {
    busy = false;
    syncActions();
  }
});

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
  if (result.status === 'ambiguous') {
    pendingReaderTest = {rows, question: selected, expected: result.expected, before, after: text};
    renderReaderTest();
  }
  caption.value = text;
  revision += 1;
  readerAnswer = undefined;
  const fact = typeof selected === 'string'
    ? {type: selected, value: rows[result.expected[0] - 1].value}
    : selected;
  render([...reviewed, {...fact, ids: result.expected, evidence}]);
  if (pendingReaderTest) el('start-reader-test').focus();
  else {
    status.setAttribute('tabindex', '-1');
    status.focus();
  }
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
    const saved = createPublishCheck(rows, selectedQuestion(), caption.value, reviewed);
    downloadFile(JSON.stringify(saved, null, 2) + '\n', 'application/json', 'caption-recheck.json');
  } catch (error) {
    status.textContent = error.message;
  }
});

const recheckStatus = el('recheck-status');
const savedCaptionDialog = el('saved-caption-dialog');
let previewedCheck;

function runSavedCheck(check = savedCheck, feedback = recheckStatus) {
  if (!check) return;
  if (!caption.value.trim()) {
    invalidate();
    feedback.textContent = 'Paste the caption you plan to publish or choose Review saved caption.';
    return;
  }
  try {
    const input = reviewPublishInputs(rows, caption.value, check);
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
      const repair = suggestPublishRepair(rows, caption.value, check);
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

el('export').addEventListener('click', () => {
  if (result?.status !== 'explicit' && result?.status !== 'implied') return;
  downloadFile(reviewedDescription(document, caption.value, rows), 'text/html;charset=utf-8', 'chart-description.html');
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
  el('reader-test-question').textContent = `Question: ${questionText(readerTest.question)}`;
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
    el('reader-file-question').textContent = questionText(test.question);
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
  const prompt = questionText(packet.question);
  el('reader-question').textContent = `${prompt} Select all that apply.`;
  const options = packet.labels.map((label, index) => {
    const {input, option} = categoryChoice(label, 'reader-option');
    el('reader-options').append(option);
    return {input, label, id: index + 1};
  });
  const responseId = packet.invitation ? readerResponseId(tabStorage, packet.invitation) : null;
  let recorded;
  function record(choices) {
    const answer = choices === null ? 'The caption doesn’t say'
      : answerText(packet.labels.map(label => ({label})), choices);
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
  none.hidden = typeof packet.question === 'string';
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
