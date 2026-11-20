const validPercent = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 &&
  value === Number(value.toFixed(2));

const listFormat = new Intl.ListFormat('en', {style: 'long', type: 'conjunction'});

export function isCutoffClaim(claim) {
  return claim.type === 'atLeast' || claim.type === 'atLeastSome';
}

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

export function sameAnswer(a, b) {
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
    const isCutoff = isCutoffClaim(claim) && validPercent(claim.cutoff);
    const isRank = (type === 'lowest' || type === 'highest') &&
      (claim.value === undefined || validPercent(claim.value));
    if ((isRank || isCutoff) && Array.isArray(claim.ids)) {
      const ids = [...new Set(claim.ids)].sort((a, b) => a - b);
      if ((ids.length || type === 'atLeast') && ids.length === claim.ids.length &&
          ids.every(id => Number.isInteger(id) && id >= 1 && id <= size)) {
        if (isCutoff) return {type, cutoff: claim.cutoff, ids, evidence};
        return claim.value === undefined ? {type, ids, evidence} : {type, ids, value: claim.value, evidence};
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
  if (claim.type === 'atLeastSome') return claim.ids.every(id => values[id - 1] >= claim.cutoff);
  const question = claim.type === 'atLeast' ? claim : claim.type;
  return sameAnswer(answer(values, question), claim.ids) &&
    (claim.value === undefined || values[claim.ids[0] - 1] === claim.value);
}

function maskOf(ids) {
  return ids.reduce((mask, id) => mask | (1 << (id - 1)), 0);
}

const points = percent => Math.round(percent * 100);

// Each named value or cutoff narrows a category's integer interval. For a
// pair of extremum groups, the smallest permitted minimum and the largest
// permitted maximum give every interior category the most room.
function intervalWitness(actual, claims, movable, acceptGroups, changedIndex, changedBound) {
  const full = (1 << actual.length) - 1;
  const requiredLow = maskOf(claims.find(claim => claim.type === 'lowest')?.ids ?? []);
  const requiredHigh = maskOf(claims.find(claim => claim.type === 'highest')?.ids ?? []);
  const range = claims.find(claim => claim.type === 'range');
  const minBound = range ? points(range.min) : 0;
  const maxBound = range ? points(range.max) : 10000;
  const bounds = actual.map(() => [minBound, maxBound]);
  for (const claim of claims) {
    if (claim.value === undefined) continue;
    const pinned = points(claim.value);
    for (const id of claim.type === 'value' ? [claim.id] : claim.ids) bounds[id - 1] = [pinned, pinned];
  }
  for (const claim of claims.filter(isCutoffClaim)) {
    const cutoff = points(claim.cutoff);
    bounds.forEach(([lower, upper], i) => {
      if (claim.ids.includes(i + 1)) bounds[i] = [Math.max(lower, cutoff), upper];
      else if (claim.type === 'atLeast') bounds[i] = [lower, Math.min(upper, cutoff - 1)];
    });
  }
  for (const [i, value] of actual.entries()) {
    if (!(movable & (1 << i))) bounds[i] = [points(value), points(value)];
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

function alternateIntervals(actual, claims, expected, question, movable) {
  if (typeof question === 'string') {
    const expectedMask = maskOf(expected);
    return intervalWitness(actual, claims, movable, (low, high) => (question === 'lowest' ? low : high) !== expectedMask);
  }
  const cutoff = points(question.cutoff);
  // A different answer must change the membership of at least one category.
  for (const [i, value] of actual.entries()) {
    if (!(movable & (1 << i))) continue;
    const opposite = value >= question.cutoff ? [0, cutoff - 1] : [cutoff, 10000];
    const candidate = intervalWitness(actual, claims, movable, () => true, i, opposite);
    if (candidate) return candidate;
  }
  return null;
}

function preferWitness(best, alternate, origin, actual) {
  if (!alternate) return best;
  let changedCategories = 0;
  let displacement = 0;
  for (const [i, value] of alternate.entries()) {
    const change = Math.abs(points(value) - points(actual[i]));
    if (change) changedCategories += 1;
    displacement += change;
  }
  if (best && (best.changedCategories < changedCategories ||
      (best.changedCategories === changedCategories && best.displacement <= displacement))) return best;
  return {alternate, origin, changedCategories, displacement};
}

function oneCategoryWitness(actual, claims, question, qualifies, best) {
  // With the other values fixed, facts and answers can only change at a
  // source value or a cutoff. Try those points and their immediate neighbors.
  const boundaries = [0, 10000, ...actual.map(points)];
  for (const claim of claims) if (isCutoffClaim(claim)) boundaries.push(points(claim.cutoff));
  if (typeof question !== 'string') boundaries.push(points(question.cutoff));
  const nearby = new Set(boundaries.flatMap(point => [point - 1, point, point + 1]));
  for (const [i, value] of actual.entries()) {
    for (const point of nearby) {
      const distance = Math.abs(point - points(value));
      if (point < 0 || point > 10000 || !distance ||
          (best?.changedCategories === 1 && distance >= best.displacement)) continue;
      const alternate = actual.slice();
      alternate[i] = point / 100;
      if (qualifies(alternate)) best = preferWitness(best, alternate, 'browser', actual);
    }
  }
  return best;
}

function fewestChanges(actual, claims, expected, question, best) {
  const full = (1 << actual.length) - 1;
  best = preferWitness(best, alternateIntervals(actual, claims, expected, question, full), 'browser', actual);
  if (!best || best.changedCategories <= 2) return best;
  const masksBySize = Array.from({length: actual.length}, () => []);
  for (let mask = 1; mask < full; mask += 1) {
    const size = actual.filter((_, index) => mask & (1 << index)).length;
    masksBySize[size].push(mask);
  }
  // Pin all bars outside each subset. Once a size works, every smaller
  // subset has already been ruled out.
  for (let size = 2; size < best.changedCategories; size += 1) {
    for (const movable of masksBySize[size]) {
      const alternate = alternateIntervals(actual, claims, expected, question, movable);
      if (alternate) return preferWitness(best, alternate, 'browser', actual);
    }
  }
  return best;
}

export function checkCaption(rows, question, claims, proposed = []) {
  const actual = rows.map(row => row.value);
  const selected = readQuestion(question);
  const expected = answerValues(actual, selected);
  if (!fits(actual, claims)) return {status: 'conflict', expected};
  if (claims.some(claim => typeof selected === 'string' ? claim.type === selected :
      claim.type === selected.type && claim.cutoff === selected.cutoff)) return {status: 'explicit', expected};
  const qualifies = values => fits(values, claims) && !sameAnswer(answerValues(values, selected), expected);
  let best;
  for (const values of proposed.slice(0, 12)) {
    if (Array.isArray(values) && values.length === actual.length && values.every(validPercent) && qualifies(values)) {
      best = preferWitness(best, values, 'cloud', actual);
    }
  }
  best = oneCategoryWitness(actual, claims, selected, qualifies, best);
  if (best?.changedCategories !== 1) best = fewestChanges(actual, claims, expected, selected, best);
  if (!best) return {status: 'implied', expected};
  const {alternate, origin, changedCategories} = best;
  if (!qualifies(alternate)) throw Error('The proposed alternate could not be verified.');
  return {status: 'ambiguous', expected, alternate, alternateAnswer: answerValues(alternate, selected), origin, changedCategories};
}

function formatLabels(rows, ids, quoted = false) {
  return listFormat.format(ids.map(id => {
    const label = rows[id - 1].label;
    return quoted ? JSON.stringify(label) : label;
  }));
}

function matchingLists(rows, subjects, single, quoted) {
  const matches = [];
  for (let mask = 1; mask < (1 << rows.length); mask++) {
    const ids = rows.flatMap((_, index) => mask & (1 << index) ? [index + 1] : []);
    if ((single === undefined || (ids.length === 1) === single) &&
        formatLabels(rows, ids, quoted) === subjects) matches.push(ids);
  }
  return matches;
}

export function readCategoryList(rows, subjects, single) {
  const named = /^(?:[Tt]he category |[Tt]he ([2-7]) categories )(?=")/.exec(subjects);
  const names = named ? subjects.slice(named[0].length) : subjects;
  if (names.startsWith('"')) {
    const [quoted] = matchingLists(rows, names, single, true);
    if (quoted && (!named || quoted.length === Number(named[1] ?? 1))) return quoted;
  }
  const matches = matchingLists(rows, subjects, single, false);
  if (matches.length > 1) throw Error('The caption’s names could refer to different category lists. Put each name in double quotes.');
  return matches[0];
}

export function answerText(rows, ids) {
  if (!ids.length) return 'None';
  const text = formatLabels(rows, ids);
  const needsQuotes = ids.some(id => {
    const {label} = rows[id - 1];
    return /["%\u0000-\u001f]/.test(label) || /^(?:Only |All categories$|No categories$|None$)/.test(label);
  }) || matchingLists(rows, text, undefined, false).length > 1;
  if (!needsQuotes) return text;
  const noun = ids.length === 1 ? 'the category' : `the ${ids.length} categories`;
  return `${noun} ${formatLabels(rows, ids, true)}`;
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
  const subject = subjects === formatLabels(rows, ids) ? subjects : subjects[0].toUpperCase() + subjects.slice(1);
  return ids.length === 1
    ? `${subject} had the ${question} rate, at ${value}%.`
    : `${subject} shared the ${question} rate, at ${value}%.`;
}
