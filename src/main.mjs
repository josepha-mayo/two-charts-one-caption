import './style.css';
import {
  readChart, checkCaption, validateClaims, answerText, supportedDetail, fitsClaim, questionText, readQuestion,
} from './check.mjs';
import {localFacts, cloudPrompt, localPrompt, checkText, answerConstraint, reviewCloudClaims} from './draft.mjs';
import {checkBrief, questionPrompt, questionConstraint, readQuestionDraft} from './brief.mjs';
import {createPublishCheck, readPublishCheck, reviewPublishInputs} from './publish-check.mjs';
import {deviceAvailability} from './device.mjs';
import {sampleCsv, sampleCaption, cutoffCaption, sampleSource} from './sample.mjs';
import {
  addReaderResponse, createReaderLink, createReaderTest, encodeResponse, readReaderLink,
  readerCounts, readerResponseId, restoreReaderTest, saveReaderTest,
} from './reader.mjs';

const el = id => document.getElementById(id);
const caption = el('caption');
const question = el('question');
const cutoff = el('cutoff');
const csv = el('csv');
const dialog = el('dialog');
const status = el('status');
let rows, result, reviewed, candidate, snapshot;
let firebaseConnection;
let revision = 0;
let busy = false;
let readerAnswer;
let pendingReaderTest, readerTest, tabStorage;

try { tabStorage = window.sessionStorage; } catch { /* Session storage can be disabled. */ }

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
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

function invalidate() {
  revision += 1;
  candidate = null;
  reviewed = null;
  result = null;
  el('claim-review').hidden = true;
  el('revision').hidden = true;
  el('proof').hidden = true;
  el('comparison').hidden = true;
  if (pendingReaderTest) {
    pendingReaderTest = null;
    renderReaderTest();
  }
  readerAnswer = undefined;
  status.textContent = '';
  status.removeAttribute('data-state');
  el('recheck-status').textContent = '';
  const showCutoff = question.value === 'atLeast';
  el('cutoff-label').hidden = !showCutoff;
  try {
    el('studio-question').textContent = questionText(selectedQuestion());
  } catch (error) {
    el('studio-question').textContent = error.message;
  }
  const unknown = choiceButton('The caption doesn’t say', () => browserCheck(null), true);
  if (!showCutoff) {
    el('reader-choices').replaceChildren(
      ...rows.map(({label}, i) => choiceButton(label, () => browserCheck([i + 1]))), unknown,
    );
    return;
  }
  const checks = rows.map(({label}) => {
    const input = make('input');
    input.type = 'checkbox';
    input.disabled = busy;
    const option = make('label', undefined, 'challenge-option');
    option.append(input, make('span', label));
    return {input, option};
  });
  const reveal = choiceButton('Check selected categories', () => {
    const ids = checks.flatMap(({input}, i) => input.checked ? [i + 1] : []);
    if (ids.length) browserCheck(ids);
    else status.textContent = 'Select at least one category, or choose an answer below.';
  });
  el('reader-choices').replaceChildren(
    ...checks.map(({option}) => option), reveal, choiceButton('None reach the cutoff', () => browserCheck([])), unknown,
  );
}

function syncActions() {
  for (const id of ['check', 'cloud-preview', 'load', 'csv-file', 'example', 'nano', 'apply', 'confirm-facts',
    'brief-example', 'brief-submit', 'brief-apply', 'recheck-file', 'save-recheck']) el(id).disabled = busy;
  for (const control of el('reader-choices').querySelectorAll('button, input')) control.disabled = busy;
}

function loadSample(cutoffExample = false) {
  csv.value = sampleCsv;
  caption.value = cutoffExample ? cutoffCaption : sampleCaption;
  question.value = cutoffExample ? 'atLeast' : 'lowest';
  cutoff.value = '70';
  rows = readChart(sampleCsv);
  el('csv-status').textContent = '';
  el('source').href = sampleSource;
  el('source').hidden = false;
  invalidate();
}

function describeClaim(claim) {
  if (claim.type === 'range') return `Range ${claim.min}%–${claim.max}%`;
  if (claim.type === 'value') return `${rows[claim.id - 1].label} is ${claim.value}%`;
  if (claim.type === 'atLeast') return `At or above ${claim.cutoff}%: ${answerText(rows, claim.ids)}`;
  return `${claim.type === 'lowest' ? 'Lowest' : 'Highest'}: ${answerText(rows, claim.ids)}`;
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
  el('proof-summary').textContent = alternate
    ? 'Each checked fact is true in both charts. The answer changes anyway.'
    : result.status === 'implied'
      ? 'Across all permitted percentage charts, the checked facts force the same answer.'
      : result.status === 'conflict'
        ? `${verifiedCount} of ${claims.length} reviewed facts still match the current chart.`
        : 'These facts were checked against the source chart.';
  el('proof').hidden = false;
}

function render(claims, alternatives = [], note = 'Browser check') {
  el('detail-status').textContent = '';
  reviewed = claims;
  const selected = selectedQuestion();
  result = checkCaption(rows, selected, claims, alternatives);
  const {expected, alternate, alternateAnswer} = result;
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
  status.textContent = text[state];
  if (alternate) chart(el('alternate'), alternate, alternateAnswer, selected, true);
  else el('alternate').replaceChildren(make('p', state === 'explicit' || state === 'implied'
    ? 'The caption decides this question.' : 'No alternate is shown for this check.', 'empty'));
  if (state !== 'conflict') {
    el('detail').textContent = supportedDetail(rows, selected, expected);
  }
  renderProof(claims, alternate);
}

function browserCheck(guess) {
  invalidate();
  readerAnswer = guess;
  try {
    const text = checkText(caption.value);
    render(validateClaims(localFacts(rows, text), text, rows.length));
  } catch (error) {
    status.textContent = error.message;
    status.dataset.state = 'conflict';
  }
  status.setAttribute('tabindex', '-1');
  status.focus();
}

el('example').addEventListener('click', () => loadSample());
el('check').addEventListener('click', () => browserCheck());
const csvStatus = el('csv-status');
function loadChart(input, fileName = '') {
  try {
    rows = readChart(input);
    csv.value = input;
    invalidate();
    el('source').hidden = true;
    if ([sampleCaption, cutoffCaption].includes(caption.value)) caption.value = '';
    csvStatus.textContent = `Loaded ${rows.length} categories${fileName ? ` from ${fileName}` : ''}.`;
    caption.focus();
  } catch (error) {
    csvStatus.textContent = error.message;
  }
}
el('load').addEventListener('click', () => loadChart(csv.value));
el('csv-file').addEventListener('change', async event => {
  const picker = event.currentTarget;
  const file = picker.files[0];
  picker.value = '';
  if (!file) return;
  if (file.size > 12_000) {
    csvStatus.textContent = 'Choose a CSV under 12 KB.';
    return;
  }
  busy = true;
  syncActions();
  try {
    loadChart(await file.text(), file.name);
  } catch {
    csvStatus.textContent = 'This CSV could not be opened. Paste its contents to try again.';
  } finally {
    busy = false;
    syncActions();
  }
});
caption.addEventListener('input', invalidate);
question.addEventListener('change', invalidate);
cutoff.addEventListener('input', invalidate);

function connectFirebase() {
  if (firebaseConnection) return firebaseConnection;
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
  available: 'Chrome’s on-device model is ready. Private notes and source values can be processed in this browser.',
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
    setupStatus.textContent = availabilityText[state];
    if (state === 'downloadable' || state === 'downloading') {
      await connectFirebase();
      prepareDevice.hidden = false;
    }
  } catch {
    setupStatus.textContent = 'Chrome AI setup could not finish. Check again or use the browser check.';
  } finally {
    refreshDevice.disabled = false;
  }
}

el('ai-setup').addEventListener('click', () => {
  setupDialog.showModal();
  refreshDeviceSetup();
});
refreshDevice.addEventListener('click', refreshDeviceSetup);

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
    snapshot = {prompt: cloudPrompt(rows, selectedQuestion(), caption.value), revision};
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
  if (dialog.returnValue !== 'send' || request?.revision !== revision) return;
  candidate = null;
  el('claim-review').hidden = true;
  const current = revision;
  busy = true;
  syncActions();
  status.textContent = 'Gemini is looking for a second chart…';
  try {
    const firebase = await connectFirebase();
    if (current !== revision) return;
    const draft = await firebase.generateInCloud(request.prompt);
    if (current !== revision) return;
    if (draft?.supported !== true || !Array.isArray(draft.alternatives)) throw Error('Gemini could not interpret the caption using the supported checks.');
    const {claims, excluded} = reviewCloudClaims(rows, caption.value, draft.claims);
    candidate = {claims, alternatives: draft.alternatives};
    const entries = claims.map(claim => {
      return make('li', `${describeClaim(claim)} · “${claim.evidence}”`);
    });
    el('claims').replaceChildren(...(entries.length ? entries : [make('li', 'Gemini found no supported quantitative claims.')]));
    el('claim-rejections').textContent = excluded
      ? `Excluded ${excluded} cutoff ${excluded === 1 ? 'claim' : 'claims'} without a supporting quote. Confirm the remaining facts cover the caption.`
      : '';
    el('claim-review').hidden = false;
    el('confirm-facts').focus();
    status.textContent = 'Firebase reported in-cloud inference. Check the extracted facts.';
  } catch (error) {
    if (current === revision) status.textContent = error.message;
  } finally {
    busy = false;
    syncActions();
  }
});

el('confirm-facts').addEventListener('click', () => {
  if (!candidate) return;
  render(candidate.claims, candidate.alternatives, 'Firebase cloud draft, verified in your browser');
  el('claim-review').hidden = true;
  status.setAttribute('tabindex', '-1');
  status.focus();
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
  const fact = typeof selected === 'string' ? {type: selected} : selected;
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

el('save-recheck').addEventListener('click', () => {
  try {
    const saved = createPublishCheck(rows, selectedQuestion(), caption.value, reviewed);
    downloadFile(JSON.stringify(saved, null, 2) + '\n', 'application/json', 'caption-recheck.json');
  } catch (error) {
    status.textContent = error.message;
  }
});

el('recheck-file').addEventListener('change', async event => {
  const picker = event.currentTarget;
  const file = picker.files[0];
  picker.value = '';
  if (!file) return;
  const recheckStatus = el('recheck-status');
  const current = revision;
  busy = true;
  syncActions();
  try {
    if (file.size > 40000) throw Error('Choose a recheck file under 40 KB.');
    const contents = await file.text();
    if (current !== revision) return;
    const saved = readPublishCheck(JSON.parse(contents));
    const input = reviewPublishInputs(rows, caption.value, saved);
    if (input.status === 'review_required') {
      recheckStatus.textContent = input.message;
      return;
    }
    rows = input.rows;
    setQuestion(saved.question);
    invalidate();
    render(saved.claims, [], 'Saved check');
    if (result.status === 'conflict') status.textContent = 'Saved check failed. Review the marked excerpt before publishing.';
    if (result.status === 'explicit' || result.status === 'implied') {
      status.textContent = 'Saved check passed. The reviewed facts still resolve this question.';
    }
    status.setAttribute('tabindex', '-1');
    status.focus();
  } catch (error) {
    if (current === revision) recheckStatus.textContent = error instanceof SyntaxError
      ? 'This file is not a valid recheck JSON file.'
      : error.message;
  } finally {
    busy = false;
    syncActions();
  }
});

el('export').addEventListener('click', () => {
  if (result?.status !== 'explicit' && result?.status !== 'implied') return;
  const doc = document.implementation.createHTMLDocument('Reviewed chart description');
  const encoding = doc.createElement('meta');
  encoding.setAttribute('charset', 'utf-8');
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  doc.head.prepend(encoding, viewport);
  const heading = doc.createElement('h1');
  heading.textContent = 'Chart description';
  const text = doc.createElement('p');
  text.textContent = caption.value;
  const table = doc.createElement('table');
  const title = table.createCaption();
  title.textContent = 'Chart data';
  const header = table.createTHead().insertRow();
  for (const name of ['Category', 'Rate']) {
    const th = doc.createElement('th');
    th.scope = 'col';
    th.textContent = name;
    header.append(th);
  }
  const body = table.createTBody();
  for (const {label, value} of rows) {
    const row = body.insertRow();
    const category = doc.createElement('th');
    category.scope = 'row';
    category.textContent = label;
    row.append(category);
    row.insertCell().textContent = `${value}%`;
  }
  doc.documentElement.lang = 'en';
  const main = doc.createElement('main');
  main.append(heading, text, table);
  doc.body.append(main);
  downloadFile('<!doctype html>' + doc.documentElement.outerHTML, 'text/html;charset=utf-8', 'chart-description.html');
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
    const counts = readerCounts(readerTest, key);
    const card = make('article', undefined, 'test-version');
    card.setAttribute('aria-label', title);
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
    const captionText = make('p', caption, 'test-caption');
    if (key === 'after' && caption.startsWith(readerTest.before.caption + ' ')) {
      captionText.textContent = readerTest.before.caption + ' ';
      captionText.append(make('mark', caption.slice(readerTest.before.caption.length + 1)));
    }
    card.append(make('h3', title), captionText, make('p', countText(counts), 'test-count'), actions);
    return card;
  }));
  el('download-reader-results').hidden = testVersions.every(([key]) => !readerTest[key].responses.length);
}

function persistReaderTest() {
  const saved = saveReaderTest(tabStorage, readerTest);
  el('reader-test-storage').textContent = saved
    ? 'Saved in this tab. Each link shows one caption and the question.'
    : 'Browser storage is unavailable. Keep this page open while collecting responses.';
}

function startReaderTest() {
  if (!pendingReaderTest) return;
  const {rows, question, expected, before, after} = pendingReaderTest;
  try {
    readerTest = createReaderTest(rows, question, expected, before, after);
    pendingReaderTest = null;
    el('reader-response').value = '';
    renderReaderTest();
    persistReaderTest();
    testStatus.textContent = 'Reader links are ready.';
    el('reader-test-versions').querySelector('button').focus();
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
    const input = make('input');
    input.type = 'checkbox';
    const option = make('label', undefined, 'reader-option');
    option.append(input, make('span', label));
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
    loadSample(new URLSearchParams(location.search).get('example') === 'cutoff');
    renderReaderTest();
  }
} catch {
  loadSample();
  status.textContent = 'That reader link could not be opened. The example is ready to try.';
}
