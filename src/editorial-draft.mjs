import {readChart} from './csv.mjs';
import {readQuestion} from './check.mjs';
import {readPublishCheck, reviewPublishInputs} from './publish-check.mjs';

const schema = 'two-charts/editorial-draft/v1';
export const maxEditorialDraftBytes = 160_000;

function chartCsv(rows) {
  return ['category,percent', ...rows.map(({label, value}) => {
    const quoted = '"' + label.replaceAll('"', '""') + '"';
    return `${quoted},${value}`;
  })].join('\n');
}

function validate(file) {
  if (file?.schema !== schema) throw Error('Choose a Two Charts editorial draft.');
  const {caption, csv, sourceNote, review} = file;
  if (typeof caption !== 'string' || caption.length > 1800) throw Error('A draft caption can have up to 1,800 characters.');
  if (typeof sourceNote !== 'string' || sourceNote.length > 400) throw Error('The draft source note is invalid.');
  const rows = readChart(csv);
  const question = readQuestion(file.question);
  const check = review === null ? null : readPublishCheck(review);
  if (check && (JSON.stringify(question) !== JSON.stringify(check.question) ||
      reviewPublishInputs(rows, caption, check).status !== 'ready')) {
    throw Error('The saved review does not match this draft’s caption, categories, and question.');
  }
  return {schema, caption, csv: chartCsv(rows), sourceNote, question, review: check};
}

export function writeEditorialDraft({rows, caption, question, sourceNote = '', review = null}) {
  const csv = chartCsv(rows);
  const draft = validate({schema, caption, csv, question, sourceNote, review});
  return JSON.stringify(draft, null, 2) + '\n';
}

export function readEditorialDraft(text) {
  if (new TextEncoder().encode(text).byteLength > maxEditorialDraftBytes) {
    throw Error('Choose an editorial draft under 160 KB.');
  }
  return validate(JSON.parse(text));
}
