import {answerText, checkCaption, fitsClaim, isCutoffClaim, questionText, readQuestion, validateClaims} from './check.mjs';
import {checkText, readQuotedCutoff, withQuotedRankValue} from './draft.mjs';

function normalizeCaption(text) {
  if (typeof text !== 'string') throw Error('The check needs the reviewed caption text.');
  return checkText(text.replace(/\r\n/g, '\n'));
}

export function createPublishCheck(rows, question, caption, claims) {
  return readPublishCheck({version: 1, labels: rows.map(row => row.label), question, caption, claims});
}

export function readPublishCheck(check) {
  if (check?.version !== 1) throw Error('Use a Two Charts recheck file with version 1.');
  const {labels} = check;
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 7 ||
      !labels.every(label => typeof label === 'string' && label.trim() === label && label && label.length <= 64) ||
      new Set(labels.map(label => label.normalize('NFKC').toLowerCase())).size !== labels.length) {
    throw Error('The recheck file needs two to seven unique chart categories.');
  }
  const caption = normalizeCaption(check.caption);
  const question = readQuestion(check.question);
  if (!Array.isArray(check.claims) || !check.claims.length) throw Error('A saved check needs at least one reviewed fact.');
  const categories = labels.map(label => ({label}));
  const claims = validateClaims(check.claims.map(claim => ({
    ...claim, evidence: typeof claim?.evidence === 'string' ? claim.evidence.replace(/\r\n/g, '\n') : claim?.evidence,
  })), caption, labels.length)
    .map(claim => isCutoffClaim(claim)
      ? readQuotedCutoff(categories, caption, claim) ?? claim
      : withQuotedRankValue(categories, claim))
    .sort((a, b) => caption.indexOf(a.evidence) - caption.indexOf(b.evidence));
  return {version: 1, labels, question, caption, claims};
}

export function reviewPublishInputs(rows, caption, check) {
  const draft = normalizeCaption(caption);
  if (draft !== check.caption) {
    return {status: 'review_required', message: 'The caption text changed. Review the new wording before publishing.'};
  }
  const byLabel = new Map(rows.map(row => [row.label, row]));
  const ordered = check.labels.map(label => byLabel.get(label));
  if (ordered.length !== rows.length || ordered.some(row => row === undefined)) {
    return {status: 'review_required', message: 'The category list changed. Review the chart and caption again.'};
  }
  const unsupported = check.claims.find(claim => isCutoffClaim(claim) && !readQuotedCutoff(ordered, draft, claim));
  if (unsupported) {
    return {status: 'review_required', message: `Review what this cutoff sentence establishes before publishing. “${unsupported.evidence}”`};
  }
  return {status: 'ready', rows: ordered};
}

export function runPublishCheck(rows, caption, check) {
  const input = reviewPublishInputs(rows, caption, check);
  if (input.status === 'review_required') return input;
  const result = checkCaption(input.rows, check.question, check.claims);
  const report = {
    status: result.status,
    question: questionText(check.question),
    sourceAnswer: answerText(input.rows, result.expected),
  };
  if (result.status === 'conflict') {
    const values = input.rows.map(row => row.value);
    report.failedFacts = check.claims.filter(claim => !fitsClaim(values, claim)).map(claim => claim.evidence);
  } else if (result.status === 'ambiguous') {
    report.alternateAnswer = answerText(input.rows, result.alternateAnswer);
    report.changedCategories = result.changedCategories;
  }
  return report;
}
