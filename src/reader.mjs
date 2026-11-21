import {checkText} from './draft.mjs';
import {isCutoffClaim, readQuestion, sameAnswer} from './check.mjs';
import {maxChartRows} from './csv.mjs';

const PREFIX = '#reader=';
const RESPONSE_PREFIX = 'two-charts-v1.';
const STUDY_KEY = 'two-charts.reader-test.v1';
const STUDY_SCHEMA = 'two-charts/reader-test/v1';
export const maxReaderTestFileBytes = 64_000;
const VARIANTS = ['before', 'after'];
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function createReaderLink(url, rows, question, caption, invitation) {
  const packet = {caption: checkText(caption), question: readQuestion(question, rows.length), labels: rows.map(row => row.label)};
  if (invitation !== undefined) packet.invitation = readId(invitation);
  const link = new URL(url);
  link.search = '';
  link.hash = PREFIX.slice(1) + encodeURIComponent(JSON.stringify(packet));
  return link.href;
}

export function readReaderLink(hash) {
  if (!hash.startsWith(PREFIX)) return null;
  if (hash.length > 22_000) throw Error('This reader link is too long.');
  return readPacket(JSON.parse(decodeURIComponent(hash.slice(PREFIX.length))));
}

function readPacket(packet) {
  if (!packet || typeof packet.caption !== 'string' ||
      !Array.isArray(packet.labels) || packet.labels.length < 2 || packet.labels.length > maxChartRows ||
      !packet.labels.every(label => typeof label === 'string' && label.trim() && label.length <= 64) ||
      new Set(packet.labels.map(label => label.normalize('NFKC').toLowerCase())).size !== packet.labels.length) {
    throw Error('This reader link has an invalid question or category list.');
  }
  const clean = {caption: checkText(packet.caption), question: readQuestion(packet.question, packet.labels.length), labels: packet.labels};
  if (packet.invitation !== undefined) clean.invitation = readId(packet.invitation);
  return clean;
}

function readId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw Error('Invalid reader test identifier.');
  return id;
}

function selectionRules(question, size) {
  return {size, allowNone: isCutoffClaim(question), pair: question?.type === 'pair' ? question.ids : null};
}

function readSelection(ids, {size, allowNone, pair}, allowUnknown) {
  if (ids === null && allowUnknown) return null;
  if (!Array.isArray(ids) || (!ids.length && !allowNone) || ids.length > size ||
      !ids.every((id, i) => Number.isInteger(id) && id > (ids[i - 1] ?? 0) && id <= size && (!pair || pair.includes(id)))) {
    throw Error('The reader response has an invalid category selection.');
  }
  return ids;
}

function readResponse(response, rules = {size: maxChartRows, allowNone: true}) {
  if (!response || typeof response !== 'object') throw Error('Invalid reader response.');
  return {
    invitation: readId(response.invitation),
    responseId: readId(response.responseId),
    selected: readSelection(response.selected, rules, true),
  };
}

export function encodeResponse(invitation, responseId, selected) {
  const response = readResponse({invitation, responseId, selected});
  return RESPONSE_PREFIX + encodeURIComponent(JSON.stringify(response));
}

export function readerResponseId(storage, invitation) {
  const key = `two-charts.response.${readId(invitation)}`;
  const generated = crypto.randomUUID();
  try {
    const stored = storage.getItem(key);
    if (stored && idPattern.test(stored)) return stored;
    storage.setItem(key, generated);
  } catch { /* A reader can still answer when storage is unavailable. */ }
  return generated;
}

export function createReaderTest(rows, question, expected, before, after) {
  const periods = Object.fromEntries(VARIANTS.map(variant => [variant, {
    caption: variant === 'before' ? before : after,
    invitation: crypto.randomUUID(),
    responses: [],
  }]));
  return readTest({question, labels: rows.map(row => row.label), expected, ...periods});
}

function readTest(test) {
  const {caption, question, labels} = readPacket({
    caption: test.before?.caption, question: test.question, labels: test.labels,
  });
  const rules = selectionRules(question, labels.length);
  const expected = readSelection(test.expected, rules, false);
  const before = readVariant(test.before, caption, rules);
  const after = readVariant(test.after, checkText(test.after.caption), rules);
  if (before.invitation === after.invitation || before.caption === after.caption) {
    throw Error('The reader test needs two different caption versions.');
  }
  return {question, labels, expected, before, after};
}

function readVariant(variant, caption, rules) {
  const invitation = readId(variant.invitation);
  if (!Array.isArray(variant.responses) || variant.responses.length > 100) throw Error('Invalid response history.');
  const responses = variant.responses.map(response => readResponse(response, rules));
  if (responses.some(response => response.invitation !== invitation) ||
      new Set(responses.map(response => response.responseId)).size !== responses.length) {
    throw Error('Invalid response history.');
  }
  return {caption, invitation, responses};
}

export function writeReaderTestFile(test) {
  return JSON.stringify({schema: STUDY_SCHEMA, test: readTest(test)}) + '\n';
}

export function readReaderTestFile(text) {
  if (typeof text !== 'string' || text.length > maxReaderTestFileBytes ||
      new TextEncoder().encode(text).byteLength > maxReaderTestFileBytes) {
    throw Error('Choose a reader test file under 64 KB.');
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw Error('This reader test file is not valid JSON.');
  }
  if (file?.schema !== STUDY_SCHEMA) throw Error('Choose a file saved with Save reader test.');
  try {
    return readTest(file.test);
  } catch {
    throw Error('This reader test file has invalid captions, invitations, or responses.');
  }
}

export function restoreReaderTest(storage) {
  try {
    const raw = storage.getItem(STUDY_KEY);
    return raw && raw.length < 50_000 ? readTest(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveReaderTest(storage, test) {
  try {
    storage.setItem(STUDY_KEY, JSON.stringify(test));
    return true;
  } catch {
    return false;
  }
}

export function addReaderResponse(test, code) {
  const value = code.trim();
  if (!value.startsWith(RESPONSE_PREFIX) || value.length > 700) throw Error('Paste the response code from a reader test.');
  let response;
  try {
    response = readResponse(
      JSON.parse(decodeURIComponent(value.slice(RESPONSE_PREFIX.length))),
      selectionRules(test.question, test.labels.length),
    );
  } catch {
    throw Error('That response code is invalid. Ask the reader to copy it again.');
  }
  const variant = VARIANTS.find(version => test[version].invitation === response.invitation);
  if (!variant) throw Error('This response belongs to a different reader test.');
  const group = test[variant];
  const index = group.responses.findIndex(previous => previous.responseId === response.responseId);
  const action = index === -1 ? 'Added' : 'Updated';
  if (index === -1 && group.responses.length >= 100) throw Error('This caption already has 100 responses.');
  const responses = group.responses.slice();
  if (index === -1) responses.push(response);
  else responses[index] = response;
  return {test: {...test, [variant]: {...group, responses}}, action, variant};
}

export function readerCounts(test, variant) {
  const result = {correct: 0, uncertain: 0, different: 0};
  for (const {selected} of test[variant].responses) {
    if (selected === null) result.uncertain++;
    else if (sameAnswer(selected, test.expected)) result.correct++;
    else result.different++;
  }
  return result;
}

export function readerDifferences(test) {
  const groups = new Map();
  for (const variant of VARIANTS) {
    for (const {selected} of test[variant].responses) {
      if (selected === null || sameAnswer(selected, test.expected)) continue;
      const key = selected.join(',');
      if (!groups.has(key)) {
        groups.set(key, {
          selected: [...selected],
          missing: test.expected.filter(id => !selected.includes(id)),
          extra: selected.filter(id => !test.expected.includes(id)),
          before: 0, after: 0,
        });
      }
      groups.get(key)[variant]++;
    }
  }
  return [...groups.values()].sort((a, b) =>
    b.before + b.after - a.before - a.after || a.selected.join(',').localeCompare(b.selected.join(','), 'en', {numeric: true}));
}
