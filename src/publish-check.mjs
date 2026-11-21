import {
  answer, answerText, checkCaption, defaultDecimalPlaces, decimalPlaceIssue, fitsClaim, isCutoffClaim, questionText,
  readDecimalPlaces, readQuestion, sameAnswer, statesAnswer, supportedDetail, validateClaims,
} from './check.mjs';
import {checkText, localFacts, readQuotedCutoff, readQuotedFact, unverifiedCaptionExcerpts, withQuotedRankValue} from './draft.mjs';
import {maxChartRows, readColumnNames, rowScope} from './csv.mjs';

function normalizeCaption(text) {
  if (typeof text !== 'string') throw Error('The check needs the reviewed caption text.');
  return checkText(text.replace(/\r\n/g, '\n'));
}

export function createPublishCheck(rows, question, caption, claims, columns, decimalPlaces) {
  const issue = decimalPlaceIssue(rows, decimalPlaces);
  if (issue) throw Error(issue);
  return readPublishCheck({version: 1, labels: rows.map(row => row.label), question, caption, claims, columns, decimalPlaces});
}

export function readPublishCheck(check) {
  if (check?.version !== 1) throw Error('Use a Two Charts recheck file with version 1.');
  const {labels} = check;
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > maxChartRows ||
      !labels.every(label => typeof label === 'string' && label.trim() === label && label && label.length <= 64) ||
      new Set(labels.map(label => label.normalize('NFKC').toLowerCase())).size !== labels.length) {
    throw Error(`The recheck file needs 2 to ${maxChartRows} unique chart categories.`);
  }
  const caption = normalizeCaption(check.caption);
  const question = readQuestion(check.question, labels.length);
  if (!Array.isArray(check.claims) || !check.claims.length) throw Error('A saved check needs at least one reviewed fact.');
  const categories = labels.map(label => ({label}));
  const claims = validateClaims(check.claims.map(claim => ({
    ...claim, evidence: typeof claim?.evidence === 'string' ? claim.evidence.replace(/\r\n/g, '\n') : claim?.evidence,
  })), caption, labels.length)
    .map(claim => isCutoffClaim(claim)
      ? readQuotedCutoff(categories, caption, claim) ?? claim
      : withQuotedRankValue(categories, claim))
    .sort((a, b) => caption.indexOf(a.evidence) - caption.indexOf(b.evidence));
  const columns = readColumnNames(check.columns);
  const decimalPlaces = readDecimalPlaces(check.decimalPlaces);
  return {version: 1, labels, question, caption, claims, ...(columns && {columns}),
    ...(decimalPlaces !== defaultDecimalPlaces && {decimalPlaces})};
}

export function reviewPublishInputs(rows, caption, check, columns) {
  const draft = normalizeCaption(caption);
  if (draft !== check.caption) {
    return {status: 'review_required', message: 'The caption text changed. Review the new wording before publishing.'};
  }
  const required = check.columns;
  const savedGroup = required?.filter;
  const currentGroup = columns?.filter;
  if (savedGroup?.column !== currentGroup?.column || savedGroup?.value !== currentGroup?.value) {
    return {status: 'review_required', message: savedGroup
      ? `This check uses the row group ${rowScope(savedGroup)}. Load that group to rerun the check.`
      : 'This check uses the full chart. Review the caption for the selected row group.'};
  }
  if (required && (columns?.category !== required.category || columns?.rate !== required.rate)) {
    return {status: 'review_required',
      message: 'This check was saved for “' + required.rate + '” grouped by “' + required.category + '”. Load those columns or review the caption for the new chart.'};
  }
  const byLabel = new Map(rows.map(row => [row.label, row]));
  const ordered = check.labels.map(label => byLabel.get(label));
  if (ordered.length !== rows.length || ordered.some(row => row === undefined)) {
    return {status: 'review_required', message: 'The category list changed. Review the chart and caption again.'};
  }
  const precisionIssue = decimalPlaceIssue(ordered, check.decimalPlaces);
  if (precisionIssue) return {status: 'review_required', message: precisionIssue};
  const unsupported = check.claims.find(claim => isCutoffClaim(claim) && !readQuotedCutoff(ordered, draft, claim));
  if (unsupported) {
    return {status: 'review_required', message: `Review what this cutoff sentence establishes before publishing. “${unsupported.evidence}”`};
  }
  for (const claim of check.claims.filter(fact => fact.type === 'pair')) {
    const quote = readQuotedFact(ordered, draft, claim.evidence.trim());
    if (quote?.type !== 'pair' || !sameAnswer(quote.ids, claim.ids) || quote.higher !== claim.higher) {
      return {status: 'review_required', message: `Review what this comparison establishes before publishing. “${claim.evidence}”`};
    }
  }
  return {status: 'ready', rows: ordered};
}

export function reviewedAnswerChange(rows, check, current) {
  const stated = check.claims.filter(claim => statesAnswer(claim, check.question))
    .map(claim => claim.type === 'pair' && claim.higher ? [claim.higher] : claim.ids);
  const [previous, ...others] = stated;
  // An implied answer has no saved selection. Conflicting exact claims also
  // cannot establish a single previously reviewed answer.
  if (!previous || !others.every(ids => sameAnswer(ids, previous)) || sameAnswer(previous, current)) return;
  return {
    reviewed: answerText(rows, previous),
    current: answerText(rows, current),
    added: current.filter(id => !previous.includes(id)).map(id => rows[id - 1].label),
    removed: previous.filter(id => !current.includes(id)).map(id => rows[id - 1].label),
  };
}

export function runPublishCheck(rows, caption, check, columns) {
  const input = reviewPublishInputs(rows, caption, check, columns);
  if (input.status === 'review_required') return input;
  const result = checkCaption(input.rows, check.question, check.claims, [], check.decimalPlaces);
  const report = {
    status: result.status,
    question: questionText(check.question, input.rows),
    sourceAnswer: answerText(input.rows, result.expected),
    ...(check.decimalPlaces !== undefined && {decimalPlaces: check.decimalPlaces}),
  };
  if (result.status === 'conflict') {
    const values = input.rows.map(row => row.value);
    report.failedFacts = check.claims.filter(claim => !fitsClaim(values, claim)).map(claim => claim.evidence);
    const change = reviewedAnswerChange(input.rows, check, result.expected);
    if (change) report.answerChange = change;
  } else if (result.status === 'ambiguous') {
    report.alternateAnswer = answerText(input.rows, result.alternateAnswer);
    report.changedCategories = result.changedCategories;
  } else {
    const unchecked = unverifiedCaptionExcerpts(input.rows, caption, check.claims).length;
    if (unchecked) report.uncheckedWordingCount = unchecked;
  }
  return report;
}

export function suggestPublishRepair(rows, caption, check, columns) {
  const input = reviewPublishInputs(rows, caption, check, columns);
  if (input.status !== 'ready') return;

  const values = input.rows.map(row => row.value);
  const stale = check.claims.filter(claim => !fitsClaim(values, claim));
  if (stale.length !== 1) return;

  const [claim] = stale;
  const currentQuestion = check.question;
  if (!statesAnswer(claim, currentQuestion)) return;

  const text = caption.replace(/\r\n/g, '\n');
  try {
    const parsed = readQuotedFact(input.rows, check.caption, claim.evidence.trim());
    if (!parsed || parsed.type !== claim.type || !sameAnswer(parsed.ids, claim.ids) ||
        parsed.value !== claim.value || parsed.cutoff !== claim.cutoff || parsed.higher !== claim.higher) return;
    const before = parsed.evidence;
    const start = text.indexOf(before);
    if (text.indexOf(before, start + 1) !== -1) return;

    const after = supportedDetail(input.rows, currentQuestion, answer(values, currentQuestion), {includeRate: claim.value !== undefined});
    const [updatedFact] = localFacts(input.rows, after);
    const nextCaption = text.slice(0, start) + after + text.slice(start + before.length);
    const nextClaims = check.claims.map(fact => fact === claim ? updatedFact : fact);
    const revised = createPublishCheck(input.rows, currentQuestion, nextCaption, nextClaims, check.columns, check.decimalPlaces);
    if (runPublishCheck(input.rows, nextCaption, revised, columns).status !== 'explicit') return;
    return {before, after, caption: nextCaption, check: revised};
  } catch {
    // An ambiguous category name or quote cannot safely be replaced here.
  }
}
