const validPercent = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 &&
  value === Number(value.toFixed(2));

export function readChart(csv) {
  if (typeof csv !== 'string' || csv.length > 4000) throw Error('Use CSV under 4,000 characters.');
  const lines = csv.trim().split(/\r?\n/);
  if (!['category,percent', 'service,percent'].includes(lines.shift()?.trim().toLowerCase())) {
    throw Error('Use the header category,percent followed by one category per line.');
  }
  if (lines.length < 2 || lines.length > 7) throw Error('Enter two to seven categories.');
  const seen = new Set();
  return lines.map(line => {
    const match = /^\s*(?:"((?:[^"]|"")*)"|([^",]+)),\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*$/.exec(line);
    if (!match) throw Error('Each line needs a name and a percentage with up to two decimal places.');
    const label = (match[1]?.replaceAll('""', '"') ?? match[2]).trim();
    const value = Number(match[3]);
    const key = label.normalize('NFKC').toLowerCase();
    if (!label || label.length > 64 || seen.has(key) || !validPercent(value)) {
      throw Error('Use unique category names and percentages from 0 to 100.');
    }
    seen.add(key);
    return {label, value};
  });
}

export function readQuestion(question) {
  if (question === 'lowest' || question === 'highest') return question;
  if (question?.type === 'atLeast' && validPercent(question.cutoff)) return {type: 'atLeast', cutoff: question.cutoff};
  throw Error('Choose a ranking or enter a cutoff from 0% to 100%, with up to two decimal places.');
}

export function questionText(question) {
  return typeof question === 'string'
    ? `Which categories had the ${question} rate?`
    : `Which categories reached at least ${question.cutoff}%?`;
}

export function answer(values, question) {
  const selected = readQuestion(question);
  return answerValues(values, selected);
}

function answerValues(values, question) {
  if (typeof question !== 'string') {
    return values.flatMap((value, index) => value >= question.cutoff ? [index + 1] : []);
  }
  const extreme = question === 'lowest' ? Math.min(...values) : Math.max(...values);
  return values.flatMap((value, index) => value === extreme ? [index + 1] : []);
}

function sameAnswer(a, b) {
  return a.length === b.length && a.every((index, position) => index === b[position]);
}

export function validateClaims(claims, caption, size) {
  if (!Array.isArray(claims) || claims.length > 12) throw Error('Expected a list of up to twelve facts.');
  return claims.map(claim => {
    if (!claim || typeof claim.evidence !== 'string' || !claim.evidence.trim() ||
        !caption.includes(claim.evidence)) throw Error('Each fact needs an exact excerpt from the caption.');
    const {type, evidence} = claim;
    if (type === 'range' && validPercent(claim.min) && validPercent(claim.max) && claim.min <= claim.max) {
      return {type, min: claim.min, max: claim.max, evidence};
    }
    if (type === 'value' && Number.isInteger(claim.id) && claim.id >= 1 &&
        claim.id <= size && validPercent(claim.value)) {
      return {type, id: claim.id, value: claim.value, evidence};
    }
    const isCutoff = type === 'atLeast' && validPercent(claim.cutoff);
    if ((type === 'lowest' || type === 'highest' || isCutoff) && Array.isArray(claim.ids)) {
      const ids = [...new Set(claim.ids)].sort((a, b) => a - b);
      if ((ids.length || isCutoff) && ids.length === claim.ids.length &&
          ids.every(id => Number.isInteger(id) && id >= 1 && id <= size)) {
        return isCutoff ? {type, cutoff: claim.cutoff, ids, evidence} : {type, ids, evidence};
      }
    }
    throw Error('A fact falls outside the supported range, value, ranking, or cutoff checks.');
  });
}

export function fits(values, claims) {
  return claims.every(claim => fitsClaim(values, claim));
}

export function fitsClaim(values, claim) {
  if (claim.type === 'range') return Math.min(...values) === claim.min && Math.max(...values) === claim.max;
  if (claim.type === 'value') return values[claim.id - 1] === claim.value;
  const question = claim.type === 'atLeast' ? claim : claim.type;
  return sameAnswer(answer(values, question), claim.ids);
}

function alternatePermutation(actual, claims, expected, question) {
  const partial = [];
  const used = new Set();
  function visit() {
    if (partial.length === actual.length) {
      return fits(partial, claims) && !sameAnswer(answerValues(partial, question), expected)
        ? partial.slice() : null;
    }
    const tried = new Set();
    for (const [index, value] of actual.entries()) {
      if (used.has(index) || tried.has(value)) continue;
      tried.add(value);
      used.add(index);
      partial.push(value);
      const result = visit();
      if (result) return result;
      partial.pop();
      used.delete(index);
    }
    return null;
  }
  return visit();
}

function maskOf(ids) {
  return ids.reduce((mask, id) => mask | (1 << (id - 1)), 0);
}

const points = percent => Math.round(percent * 100);

// Each named value or cutoff narrows a category's integer interval. For a
// pair of extremum groups, the smallest permitted minimum and the largest
// permitted maximum give every interior category the most room.
function intervalWitness(actual, claims, acceptGroups, changedIndex, changedBound) {
  const full = (1 << actual.length) - 1;
  const requiredLow = maskOf(claims.find(claim => claim.type === 'lowest')?.ids ?? []);
  const requiredHigh = maskOf(claims.find(claim => claim.type === 'highest')?.ids ?? []);
  const range = claims.find(claim => claim.type === 'range');
  const minBound = range ? points(range.min) : 0;
  const maxBound = range ? points(range.max) : 10000;
  const bounds = actual.map(() => [minBound, maxBound]);
  for (const claim of claims) {
    if (claim.type === 'value') bounds[claim.id - 1] = [points(claim.value), points(claim.value)];
  }
  for (const claim of claims.filter(claim => claim.type === 'atLeast')) {
    const cutoff = points(claim.cutoff);
    bounds.forEach(([lower, upper], i) => {
      bounds[i] = claim.ids.includes(i + 1) ? [Math.max(lower, cutoff), upper] : [lower, Math.min(upper, cutoff - 1)];
    });
  }
  if (changedBound) {
    const [lower, upper] = bounds[changedIndex];
    bounds[changedIndex] = [Math.max(lower, changedBound[0]), Math.min(upper, changedBound[1])];
  }
  if (bounds.some(([lower, upper]) => lower > upper)) return null;

  for (let low = requiredLow || 1; low <= (requiredLow || full); low += 1) {
    for (let high = requiredHigh || 1; high <= (requiredHigh || full); high += 1) {
      const flat = low === full && high === full;
      if (((low & high) && !flat) || !acceptGroups(low, high)) continue;
      let min = minBound;
      let max = maxBound;
      for (const [i, [lower, upper]] of bounds.entries()) {
        const bit = 1 << i;
        if (low & bit) min = Math.max(min, lower);
        if (high & bit) max = Math.min(max, upper);
      }
      if (range && (min !== minBound || max !== maxBound)) continue;
      if (flat) {
        if (min <= max && (!range || min === max)) return actual.map(() => min / 100);
        continue;
      }
      if (min >= max) continue;
      const candidate = [];
      for (const [i, [lower, upper]] of bounds.entries()) {
        const bit = 1 << i;
        const floor = low & bit ? min : high & bit ? max : min + 1;
        const ceiling = low & bit ? min : high & bit ? max : max - 1;
        const from = Math.max(floor, lower);
        const to = Math.min(ceiling, upper);
        if (from > to) break;
        candidate.push(Math.max(from, Math.min(to, points(actual[i]))) / 100);
      }
      if (candidate.length === actual.length) return candidate;
    }
  }
  return null;
}

function alternateIntervals(actual, claims, expected, question) {
  if (typeof question === 'string') {
    const expectedMask = maskOf(expected);
    return intervalWitness(actual, claims, (low, high) => (question === 'lowest' ? low : high) !== expectedMask);
  }
  const cutoff = points(question.cutoff);
  // A different answer must change the membership of at least one category.
  for (const [i, value] of actual.entries()) {
    const opposite = value >= question.cutoff ? [0, cutoff - 1] : [cutoff, 10000];
    const candidate = intervalWitness(actual, claims, () => true, i, opposite);
    if (candidate) return candidate;
  }
  return null;
}

export function checkCaption(rows, question, claims, proposed = []) {
  const actual = rows.map(row => row.value);
  const selected = readQuestion(question);
  const expected = answerValues(actual, selected);
  if (!fits(actual, claims)) return {status: 'conflict', expected};
  if (claims.some(claim => typeof selected === 'string' ? claim.type === selected :
      claim.type === selected.type && claim.cutoff === selected.cutoff)) return {status: 'explicit', expected};
  for (const values of proposed.slice(0, 12)) {
    if (Array.isArray(values) && values.length === actual.length && values.every(validPercent) &&
        fits(values, claims) && !sameAnswer(answerValues(values, selected), expected)) {
      return {status: 'ambiguous', expected, alternate: values, alternateAnswer: answerValues(values, selected), origin: 'cloud'};
    }
  }
  const alternate = alternatePermutation(actual, claims, expected, selected) ??
    alternateIntervals(actual, claims, expected, selected);
  if (!alternate) return {status: 'implied', expected};
  const alternateAnswer = answerValues(alternate, selected);
  if (sameAnswer(alternateAnswer, expected) || !fits(alternate, claims)) {
    throw Error('The proposed alternate could not be verified.');
  }
  return {status: 'ambiguous', expected, alternate, alternateAnswer, origin: 'browser'};
}

export function answerText(rows, ids) {
  if (!ids.length) return 'None';
  return new Intl.ListFormat('en', {style: 'long', type: 'conjunction'})
    .format(ids.map(id => rows[id - 1].label));
}

export function supportedDetail(rows, question, ids) {
  if (!sameAnswer(answer(rows.map(row => row.value), question), ids)) {
    throw Error('The proposed detail disagrees with the source chart.');
  }
  const subjects = answerText(rows, ids);
  if (typeof question !== 'string') {
    const cutoff = `${question.cutoff}%`;
    return ids.length ? `Only ${subjects} reached at least ${cutoff}.` : `No categories reached ${cutoff}.`;
  }
  const value = rows[ids[0] - 1].value;
  return ids.length === 1
    ? `${subjects} had the ${question} rate, at ${value}%.`
    : `${subjects} shared the ${question} rate, at ${value}%.`;
}
