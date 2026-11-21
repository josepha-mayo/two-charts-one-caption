export {readChart} from './csv.mjs';

const validPercent = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 &&
  value === Number(value.toFixed(2));

const listFormat = new Intl.ListFormat('en', {style: 'long', type: 'conjunction'});
const categoryLists = new WeakMap();
const cutoffDirections = new Map([
  ['atLeast', 'atLeast'], ['atLeastSome', 'atLeast'], ['below', 'below'], ['belowSome', 'below'],
]);

export function cutoffDirection(claim) {
  return cutoffDirections.get(claim?.type);
}

export function isCutoffClaim(claim) {
  return cutoffDirections.has(claim?.type);
}

function readPairIds(ids, size) {
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1] ||
      ![ids[0], ids[1]].every(id => Number.isInteger(id) && id >= 1 && id <= size)) {
    throw Error('Choose two different chart categories.');
  }
  return [...ids].sort((a, b) => a - b);
}

export function readQuestion(question, size = 7) {
  if (question === 'lowest' || question === 'highest') return question;
  if (question?.type === 'pair') return {type: 'pair', ids: readPairIds(question.ids, size)};
  if ((question?.type === 'atLeast' || question?.type === 'below') && validPercent(question.cutoff)) {
    return {type: question.type, cutoff: question.cutoff};
  }
  throw Error('Choose a ranking or enter a cutoff from 0% to 100%, with up to two decimal places.');
}

export function questionText(question, rows) {
  if (typeof question === 'string') return `Which categories had the ${question} rate?`;
  if (question.type === 'pair') {
    const [first, second] = question.ids.map(id => rows[id - 1].label);
    return `Which had the higher rate, ${first} or ${second}?`;
  }
  return question.type === 'below'
    ? `Which categories fell below ${question.cutoff}%?`
    : `Which categories reached at least ${question.cutoff}%?`;
}

export function answer(values, question) {
  const selected = readQuestion(question, values.length);
  return answerValues(values, selected);
}

function meetsCutoff(value, {type, cutoff}) {
  return type === 'below' ? value < cutoff : value >= cutoff;
}

function answerValues(values, question) {
  if (question?.type === 'pair') {
    const [first, second] = question.ids;
    const difference = values[first - 1] - values[second - 1];
    return difference === 0 ? question.ids : [difference > 0 ? first : second];
  }
  if (typeof question !== 'string') {
    return values.flatMap((value, index) => meetsCutoff(value, question) ? [index + 1] : []);
  }
  const extreme = question === 'lowest' ? Math.min(...values) : Math.max(...values);
  return values.flatMap((value, index) => value === extreme ? [index + 1] : []);
}

export function sameAnswer(a, b) {
  return a.length === b.length && a.every((index, position) => index === b[position]);
}

export function statesAnswer(claim, question) {
  if (typeof question === 'string') return claim.type === question;
  if (claim.type !== question.type) return false;
  return question.type === 'pair' ? sameAnswer(claim.ids, question.ids) : claim.cutoff === question.cutoff;
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
    if (type === 'pair') {
      const ids = readPairIds(claim.ids, size);
      if (claim.higher === 0 || ids.includes(claim.higher)) return {type, ids, higher: claim.higher, evidence};
      throw Error('A comparison must name the higher category or record a tie.');
    }
    const isCutoff = isCutoffClaim(claim) && validPercent(claim.cutoff);
    const isRank = (type === 'lowest' || type === 'highest') &&
      (claim.value === undefined || validPercent(claim.value));
    if ((isRank || isCutoff) && Array.isArray(claim.ids)) {
      const ids = [...new Set(claim.ids)].sort((a, b) => a - b);
      if ((ids.length || (isCutoff && type === cutoffDirection(claim))) && ids.length === claim.ids.length &&
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
  if (claim.type === 'pair') {
    const ids = answerValues(values, claim);
    return (ids.length === 2 ? 0 : ids[0]) === claim.higher;
  }
  const direction = cutoffDirection(claim);
  if (direction) {
    const question = {type: direction, cutoff: claim.cutoff};
    return claim.type === direction
      ? sameAnswer(answerValues(values, question), claim.ids)
      : claim.ids.every(id => meetsCutoff(values[id - 1], question));
  }
  return sameAnswer(answer(values, claim.type), claim.ids) &&
    (claim.value === undefined || values[claim.ids[0] - 1] === claim.value);
}

function maskOf(ids) {
  return ids.reduce((mask, id) => mask | (1 << (id - 1)), 0);
}

const points = percent => Math.round(percent * 100);

// Each edge means that "to" is at least "from" plus this many hundredths.
function pairEdges({ids: [first, second], higher}) {
  if (higher === 0) return [[first - 1, second - 1, 0], [second - 1, first - 1, 0]];
  const lower = higher === first ? second : first;
  return [[lower - 1, higher - 1, 1]];
}

function fitPairs(candidate, intervals, edges) {
  if (edges.every(([from, to, delta]) => candidate[to] >= candidate[from] + delta)) return candidate;
  const minimum = intervals.map(([lower]) => lower);
  // Propagate lower bounds. An update after n-1 passes would require a positive cycle.
  for (let pass = 0; pass < minimum.length; pass += 1) {
    let changed = false;
    for (const [from, to, delta] of edges) {
      const next = minimum[from] + delta;
      if (minimum[to] >= next) continue;
      if (next > intervals[to][1]) return null;
      minimum[to] = next;
      changed = true;
    }
    if (!changed) return minimum;
  }
  return null;
}

// Each named value or cutoff narrows a category's integer interval. For a
// pair of extremum groups, the smallest permitted minimum and the largest
// permitted maximum give every interior category the most room.
function intervalWitness(actual, claims, movable, acceptGroups = () => true, {index, bound, extraEdges = [], radius = 10000} = {}) {
  const full = (1 << actual.length) - 1;
  const requiredLow = maskOf(claims.find(claim => claim.type === 'lowest')?.ids ?? []);
  const requiredHigh = maskOf(claims.find(claim => claim.type === 'highest')?.ids ?? []);
  const range = claims.find(claim => claim.type === 'range');
  const minBound = range ? points(range.min) : 0;
  const maxBound = range ? points(range.max) : 10000;
  const sourcePoints = actual.map(points);
  const bounds = actual.map(() => [minBound, maxBound]);
  const edges = [...claims.filter(claim => claim.type === 'pair').flatMap(pairEdges), ...extraEdges];
  for (const claim of claims) {
    if (claim.value === undefined) continue;
    const pinned = points(claim.value);
    for (const id of claim.type === 'value' ? [claim.id] : claim.ids) bounds[id - 1] = [pinned, pinned];
  }
  for (const claim of claims.filter(isCutoffClaim)) {
    const cutoff = points(claim.cutoff);
    const direction = cutoffDirection(claim);
    bounds.forEach(([lower, upper], i) => {
      const named = claim.ids.includes(i + 1);
      if (!named && claim.type !== direction) return;
      // Hundredths of a point keep an exact match out of the below group.
      bounds[i] = named === (direction === 'atLeast')
        ? [Math.max(lower, cutoff), upper]
        : [lower, Math.min(upper, cutoff - 1)];
    });
  }
  for (const [i, value] of sourcePoints.entries()) {
    const variation = movable & (1 << i) ? radius : 0;
    const [lower, upper] = bounds[i];
    bounds[i] = [Math.max(lower, value - variation), Math.min(upper, value + variation)];
  }
  if (bound) {
    const [lower, upper] = bounds[index];
    bounds[index] = [Math.max(lower, bound[0]), Math.min(upper, bound[1])];
  }
  if (bounds.some(([lower, upper]) => lower > upper)) return null;
  // A contradiction among pair comparisons also rules out every choice of extrema.
  if (edges.length && !fitPairs(bounds.map(([lower]) => lower), bounds, edges)) return null;

  for (let low = requiredLow || 1; low <= (requiredLow || full); low += 1) {
    // A non-flat chart needs disjoint extrema. Visit only subsets of the
    // available categories, in ascending order to keep witness selection stable.
    const available = full ^ low;
    const firstHigh = requiredHigh || (available & -available) || full;
    for (let high = firstHigh; high; high = requiredHigh || !available ? 0 : (high - available) & available) {
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
        if (min <= max && (!range || min === max) && edges.every(([, , delta]) => delta === 0)) {
          return actual.map(() => min / 100);
        }
        continue;
      }
      if (min >= max) continue;
      const candidate = [];
      const intervals = [];
      for (const [i, [lower, upper]] of bounds.entries()) {
        const bit = 1 << i;
        const floor = low & bit ? min : high & bit ? max : min + 1;
        const ceiling = low & bit ? min : high & bit ? max : max - 1;
        const from = Math.max(floor, lower);
        const to = Math.min(ceiling, upper);
        if (from > to) break;
        candidate.push(Math.max(from, Math.min(to, sourcePoints[i])));
        if (edges.length) intervals.push([from, to]);
      }
      if (candidate.length !== actual.length) continue;
      const checked = edges.length ? fitPairs(candidate, intervals, edges) : candidate;
      if (checked) return checked.map(value => value / 100);
    }
  }
  return null;
}

function alternateIntervals(actual, claims, expected, question, movable, radius) {
  if (typeof question === 'string') {
    const expectedMask = maskOf(expected);
    return intervalWitness(actual, claims, movable, (low, high) => (question === 'lowest' ? low : high) !== expectedMask, {radius});
  }
  if (question.type === 'pair') {
    const [first, second] = question.ids;
    if (expected.length === 2) {
      return intervalWitness(actual, claims, movable, undefined, {radius, extraEdges: [[first - 1, second - 1, 1]]}) ??
        intervalWitness(actual, claims, movable, undefined, {radius, extraEdges: [[second - 1, first - 1, 1]]});
    }
    const winner = expected[0];
    const other = winner === first ? second : first;
    return intervalWitness(actual, claims, movable, undefined, {radius, extraEdges: [[winner - 1, other - 1, 0]]});
  }
  const cutoff = points(question.cutoff);
  // A different answer must change the membership of at least one category.
  for (const [i, value] of actual.entries()) {
    if (!(movable & (1 << i))) continue;
    const opposite = value >= question.cutoff ? [0, cutoff - 1] : [cutoff, 10000];
    const candidate = intervalWitness(actual, claims, movable, undefined, {index: i, bound: opposite, radius});
    if (candidate) return candidate;
  }
  return null;
}

export function smallestAnswerShift(rows, question, claims, witness) {
  const actual = rows.map(row => row.value);
  const selected = readQuestion(question, rows.length);
  const expected = answerValues(actual, selected);
  if (!fits(actual, claims)) return null;
  const possible = radius => alternateIntervals(actual, claims, expected, selected, (1 << actual.length) - 1, radius);
  const qualifies = candidate => fits(candidate, claims) && !sameAnswer(answerValues(candidate, selected), expected);
  let alternate = Array.isArray(witness) && witness.length === actual.length && witness.every(validPercent) && qualifies(witness)
    ? witness : possible(10000);
  if (!alternate) return null;
  let lower = 1;
  const distance = candidate => Math.max(...candidate.map((value, i) => Math.abs(points(value) - points(actual[i]))));
  let upper = distance(alternate);
  // Permitting a larger movement can only add possible charts. Verify the
  // smallest feasible radius in integer hundredths of a percentage point.
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = possible(middle);
    if (candidate) {
      alternate = candidate;
      upper = middle;
    } else lower = middle + 1;
  }
  if (!qualifies(alternate) || distance(alternate) !== upper) throw Error('The smallest shift could not be verified.');
  return {maximumShift: upper / 100, alternate, alternateAnswer: answerValues(alternate, selected)};
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
  if (isCutoffClaim(question)) boundaries.push(points(question.cutoff));
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
  const selected = readQuestion(question, rows.length);
  const expected = answerValues(actual, selected);
  if (!fits(actual, claims)) return {status: 'conflict', expected};
  if (claims.some(claim => statesAnswer(claim, selected))) return {status: 'explicit', expected};
  // An exact, flat range fixes every category at the same value.
  if (claims.some(claim => claim.type === 'range' && claim.min === claim.max)) return {status: 'implied', expected};
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

export function captionCoverage(rows, claims) {
  const actual = rows.map(row => row.value);
  if (!fits(actual, claims)) return [];
  const questions = ['highest', 'lowest'];
  for (let first = 1; first < rows.length; first++) {
    for (let second = first + 1; second <= rows.length; second++) {
      questions.push({type: 'pair', ids: [first, second]});
    }
  }
  const full = (1 << rows.length) - 1;
  return questions.map(question => {
    const expected = answerValues(actual, question);
    if (claims.some(claim => statesAnswer(claim, question))) return {question, expected, status: 'explicit'};
    // Find the smallest witness only when the editor opens an individual proof.
    const alternate = alternateIntervals(actual, claims, expected, question, full);
    if (alternate && (!fits(alternate, claims) || sameAnswer(answerValues(alternate, question), expected))) {
      throw Error('A question in the coverage check could not be verified.');
    }
    return {question, expected, status: alternate ? 'ambiguous' : 'implied'};
  });
}

export function answerSupport(rows, question, claims) {
  const actual = rows.map(row => row.value);
  const selected = readQuestion(question, rows.length);
  const expected = answerValues(actual, selected);
  if (!fits(actual, claims)) return null;
  const full = (1 << rows.length) - 1;
  function findAlternate(facts) {
    if (facts.some(fact => statesAnswer(fact, selected))) return null;
    const witness = alternateIntervals(actual, facts, expected, selected, full);
    if (!witness) return null;
    const qualifies = values => fits(values, facts) && !sameAnswer(answerValues(values, selected), expected);
    if (!qualifies(witness)) {
      throw Error('The answer support could not be verified.');
    }
    const alternate = oneCategoryWitness(actual, facts, selected, qualifies)?.alternate ?? witness;
    return {alternate, alternateAnswer: answerValues(alternate, selected)};
  }
  if (findAlternate(claims)) return null;
  const excerpts = new Set(claims.map(claim => claim.evidence));
  const direct = claims.find(claim => statesAnswer(claim, selected));
  const retained = new Set(direct ? [direct.evidence] : excerpts);
  const essential = [];
  for (const excerpt of excerpts) {
    if (!retained.delete(excerpt)) continue;
    const witness = findAlternate(claims.filter(claim => retained.has(claim.evidence)));
    if (witness) {
      // This counterexample also satisfies any smaller set of remaining facts.
      retained.add(excerpt);
      essential.push({excerpt, ...witness});
    }
  }
  return {essential, omitted: [...excerpts].filter(excerpt => !retained.has(excerpt))};
}

function formatLabels(rows, ids, quoted = false) {
  return listFormat.format(ids.map(id => {
    const label = rows[id - 1].label;
    return quoted ? JSON.stringify(label) : label;
  }));
}

function matchingLists(rows, subjects, single, quoted) {
  if (single === true) {
    return rows.flatMap(({label}, index) => (quoted ? JSON.stringify(label) : label) === subjects ? [[index + 1]] : []);
  }
  let saved = categoryLists.get(rows);
  if (!saved || saved.labels.length !== rows.length || rows.some(({label}, index) => label !== saved.labels[index])) {
    saved = {labels: rows.map(({label}) => label)};
    categoryLists.set(rows, saved);
  }
  const mode = quoted ? 'quoted' : 'plain';
  if (!saved[mode]) {
    const lists = new Map();
    for (let mask = 1; mask < (1 << rows.length); mask++) {
      const ids = rows.flatMap((_, index) => mask & (1 << index) ? [index + 1] : []);
      const text = formatLabels(rows, ids, quoted);
      if (!lists.has(text)) lists.set(text, []);
      lists.get(text).push(ids);
    }
    saved[mode] = lists;
  }
  const matches = saved[mode].get(subjects) ?? [];
  return single === false ? matches.filter(ids => ids.length > 1) : matches;
}

export function readCategoryList(rows, subjects, single) {
  const named = /^(?:[Tt]he category |[Tt]he ([2-7]) categories )(?=")/.exec(subjects);
  const names = named ? subjects.slice(named[0].length) : subjects;
  if (names.startsWith('"')) {
    const [quoted] = matchingLists(rows, names, single, true);
    if (quoted && (!named || quoted.length === Number(named[1] ?? 1))) return quoted.slice();
  }
  const matches = matchingLists(rows, subjects, single, false);
  if (matches.length > 1) throw Error('The caption’s names could refer to different category lists. Put each name in double quotes.');
  return matches[0]?.slice();
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
  if (question?.type === 'pair') {
    if (ids.length === 2) return `${subjects} had the same rate.`;
    const [winner] = ids;
    const other = question.ids.find(id => id !== winner);
    const name = id => {
      const label = rows[id - 1].label;
      return /["%]|[.!?]\s| had a (?:higher|lower) rate than /.test(label) ? JSON.stringify(label) : label;
    };
    return `${name(winner)} had a higher rate than ${name(other)}.`;
  }
  if (typeof question !== 'string') {
    const cutoff = `${question.cutoff}%`;
    if (question.type === 'below') {
      return ids.length ? `Only ${subjects} fell below ${cutoff}.` : `No categories fell below ${cutoff}.`;
    }
    return ids.length ? `Only ${subjects} reached at least ${cutoff}.` : `No categories reached ${cutoff}.`;
  }
  const value = rows[ids[0] - 1].value;
  const subject = subjects === formatLabels(rows, ids) ? subjects : subjects[0].toUpperCase() + subjects.slice(1);
  return ids.length === 1
    ? `${subject} had the ${question} rate, at ${value}%.`
    : `${subject} shared the ${question} rate, at ${value}%.`;
}
