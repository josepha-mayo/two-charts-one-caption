import {open} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {ratePrecisionText, readChart} from '../src/check.mjs';
import {maxCsvBytes} from '../src/csv.mjs';
import {readPublishCheck, runPublishCheck} from '../src/publish-check.mjs';
import {maxHtmlBytes, readFigures, runPublishedFigureCheck} from '../src/published-html.mjs';

const usage = [
  'Usage: node scripts/verify-caption.mjs check.json chart.csv caption.txt [--category-column HEADER --percent-column HEADER] [--require-checked-wording] [--json]',
  '       node scripts/verify-caption.mjs check.json chart.csv page.html --html [--caption-id ID] [--check-table] [--json]',
  '       node scripts/verify-caption.mjs --batch release.json [--require-checked-wording] [--json]',
].join('\n');

async function readText(path, limit) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw Error(`Expected a regular file under ${limit} bytes: ${path}`);
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw Error(`Expected a file under ${limit} bytes: ${path}`);
    return new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function readBatch(text) {
  const batch = JSON.parse(text);
  if (batch?.version !== 1 || !Array.isArray(batch.charts) || !batch.charts.length || batch.charts.length > 100) {
    throw Error('Use a version 1 batch with one to 100 chart entries.');
  }
  const ids = new Set();
  return batch.charts.map(entry => {
    const {id, check, csv, caption, html, captionId, checkTable} = entry ?? {};
    const hasHtml = html !== undefined;
    if (typeof id !== 'string' || !id.trim() || id.length > 100 || /[\u0000-\u001f]/.test(id) ||
        ids.has(id) || (caption !== undefined) === hasHtml ||
        [check, csv, hasHtml ? html : caption].some(path => typeof path !== 'string' || !path.trim())) {
      throw Error('Each chart needs a unique ID, paths for its check and CSV, and either a caption or HTML path.');
    }
    if ((!hasHtml && (captionId !== undefined || checkTable !== undefined)) ||
        (captionId !== undefined && !validHtmlId(captionId)) ||
        (checkTable !== undefined && typeof checkTable !== 'boolean')) {
      throw Error('Use captionId and checkTable only with HTML. Supply a figure or caption ID and a boolean table setting.');
    }
    ids.add(id);
    return {id, check, csv, caption: hasHtml ? html : caption, figure: hasHtml ? {captionId, checkTable} : undefined};
  });
}

function validHtmlId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\t\n\f\r ]/.test(id);
}

async function loadFigures(path) {
  return readFigures(await readText(path, maxHtmlBytes));
}

async function checkFiles(paths, {mapping, strict, figure, read = readText, readPage = loadFigures}) {
  const [recipeText, csv, captionInput] = await Promise.all([
    read(paths[0], 40000), read(paths[1], maxCsvBytes),
    figure ? readPage(paths[2]).then(page => page.read(figure)) : read(paths[2], 8000),
  ]);
  const check = readPublishCheck(JSON.parse(recipeText));
  const columns = mapping ? {...mapping, ...(check.columns?.filter && {filter:check.columns.filter})} : check.columns;
  const rows = readChart(csv, columns);
  const report = figure
    ? runPublishedFigureCheck(captionInput, rows, check, columns)
    : runPublishCheck(rows, captionInput, check, columns);
  if (strict && report.uncheckedWordingCount && passed(report)) {
    report.status = 'review_required';
    report.message = 'Some caption wording needs editorial review.';
  }
  return report;
}

function passed(report) {
  return report.status === 'explicit' || report.status === 'implied';
}

function printReport(report) {
  if (report.status === 'invalid_input') console.log(`INVALID INPUT. ${report.message}`);
  else if (report.status === 'review_required') console.log(`REVIEW REQUIRED. ${report.message}`);
  else {
    console.log(passed(report) ? 'PASS. The reviewed facts still resolve the question.'
      : report.status === 'conflict' ? 'FAIL. The reviewed caption conflicts with the current chart.'
        : 'FAIL. The reviewed facts leave a different answer possible.');
    console.log(report.question);
    if (report.decimalPlaces !== undefined) console.log(ratePrecisionText(report.decimalPlaces));
    console.log('Current source answer:', JSON.stringify(report.sourceAnswer));
    if (report.alternateAnswer) console.log('Alternate answer:', JSON.stringify(report.alternateAnswer));
    for (const evidence of report.failedFacts ?? []) console.log('Stale excerpt:', JSON.stringify(evidence));
  }
  if (report.uncheckedWordingCount) console.log('Unchecked excerpts:', report.uncheckedWordingCount);
  for (const text of report.missingReviewedExcerpts ?? []) console.log('Reviewed excerpt missing from the HTML caption:', JSON.stringify(text));
  if (report.table?.matches) console.log('The HTML data table matches the current CSV.');
  for (const {label, sourceRate, tableRate} of report.table?.mismatches ?? []) {
    const rate = value => value === null ? 'missing' : `${value}%`;
    console.log(`Table difference for ${JSON.stringify(label)}. CSV ${rate(sourceRate)}, HTML ${rate(tableRate)}.`);
  }
}

async function checkBatch(path, strict) {
  const root = dirname(resolve(path));
  const entries = readBatch(await readText(path, 64000));
  const files = new Map();
  function read(path, limit) {
    const key = JSON.stringify([path, limit]);
    if (!files.has(key)) files.set(key, readText(path, limit));
    return files.get(key);
  }
  let lastPage;
  function readPage(file) {
    if (lastPage?.file !== file) lastPage = {file, figures: loadFigures(file)};
    return lastPage.figures;
  }
  const checks = [];
  const totals = {passed:0, reviewRequired:0, invalid:0};
  for (const {id, check, csv, caption, figure} of entries) {
    try {
      const report = await checkFiles([check, csv, caption].map(file => resolve(root, file)), {strict, figure, read, readPage});
      checks.push({id, ...report});
      totals[passed(report) ? 'passed' : 'reviewRequired'] += 1;
    } catch (error) {
      checks.push({id, status:'invalid_input', message:error.message});
      totals.invalid += 1;
    }
  }
  const status = totals.invalid ? 'invalid_input' : totals.reviewRequired ? 'review_required' : 'passed';
  return {version:1, status, totals, checks};
}

let json = false;
try {
  const {values, positionals} = parseArgs({
    options: {
      json: {type: 'boolean'},
      help: {type: 'boolean'},
      batch: {type: 'string'},
      html: {type: 'boolean'},
      'caption-id': {type: 'string'},
      'check-table': {type: 'boolean'},
      'category-column': {type: 'string'},
      'percent-column': {type: 'string'},
      'require-checked-wording': {type: 'boolean'},
    },
    allowPositionals: true,
  });
  json = values.json;
  if (values.help) {
    console.log(usage);
  } else {
    const category = values['category-column'];
    const rate = values['percent-column'];
    const hasMapping = category !== undefined || rate !== undefined;
    const strict = values['require-checked-wording'];
    const captionId = values['caption-id'];
    const checkTable = values['check-table'];
    if (values.batch !== undefined) {
      if (!values.batch.trim() || positionals.length || hasMapping || values.html || captionId !== undefined || checkTable) throw Error(usage);
      const batch = await checkBatch(values.batch, strict);
      process.exitCode = batch.totals.invalid ? 2 : batch.totals.reviewRequired ? 1 : 0;
      if (json) console.log(JSON.stringify(batch, null, 2));
      else {
        for (const check of batch.checks) {
          console.log(`\n${check.id}`);
          printReport(check);
        }
        console.log(`\n${batch.totals.passed} passed · ${batch.totals.reviewRequired} need review · ${batch.totals.invalid} invalid`);
      }
    } else {
      if (positionals.length !== 3) throw Error(usage);
      if (hasMapping && (!category?.trim() || !rate?.trim())) {
        throw Error('Specify both --category-column and --percent-column with nonempty header names.');
      }
      if ((!values.html && (captionId !== undefined || checkTable)) ||
          (captionId !== undefined && !validHtmlId(captionId))) {
        throw Error('Use --caption-id and --check-table with --html, and supply an exact HTML ID without spaces.');
      }
      const report = await checkFiles(positionals, {strict, mapping: hasMapping ? {category, rate} : undefined,
        figure: values.html ? {captionId, checkTable} : undefined});
      process.exitCode = passed(report) ? 0 : 1;
      if (json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
    }
  }
} catch (error) {
  process.exitCode = 2;
  if (json) console.log(JSON.stringify({status: 'invalid_input', message: error.message}));
  else console.error(error.message);
}
