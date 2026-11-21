import {open} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {readChart} from '../src/check.mjs';
import {readPublishCheck, runPublishCheck} from '../src/publish-check.mjs';

const usage = 'Usage: node scripts/verify-caption.mjs check.json chart.csv caption.txt [--category-column HEADER --percent-column HEADER] [--require-checked-wording] [--json]';

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

let json = false;
try {
  const {values, positionals} = parseArgs({
    options: {
      json: {type: 'boolean'},
      help: {type: 'boolean'},
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
    if (positionals.length !== 3) throw Error(usage);
    const category = values['category-column'];
    const rate = values['percent-column'];
    const hasMapping = category !== undefined || rate !== undefined;
    if (hasMapping && (!category?.trim() || !rate?.trim())) {
      throw Error('Specify both --category-column and --percent-column with nonempty header names.');
    }
    const [recipeText, csv, caption] = await Promise.all([
      readText(positionals[0], 40000), readText(positionals[1], 12000), readText(positionals[2], 8000),
    ]);
    const check = readPublishCheck(JSON.parse(recipeText));
    const columns = hasMapping ? {category, rate} : check.columns;
    const report = runPublishCheck(readChart(csv, columns), caption, check, columns);
    if (values['require-checked-wording'] && report.uncheckedWordingCount) {
      report.status = 'review_required';
      report.message = 'Some caption wording needs editorial review.';
    }
    const passed = report.status === 'explicit' || report.status === 'implied';
    process.exitCode = passed ? 0 : 1;
    if (json) console.log(JSON.stringify(report, null, 2));
    else if (report.status === 'review_required') console.log(`REVIEW REQUIRED. ${report.message}`);
    else {
      console.log(passed ? 'PASS. The reviewed facts still resolve the question.'
        : report.status === 'conflict' ? 'FAIL. The reviewed caption conflicts with the current chart.'
          : 'FAIL. The reviewed facts leave a different answer possible.');
      console.log(report.question);
      console.log('Current source answer:', JSON.stringify(report.sourceAnswer));
      if (report.alternateAnswer) console.log('Alternate answer:', JSON.stringify(report.alternateAnswer));
      for (const evidence of report.failedFacts ?? []) console.log('Stale excerpt:', JSON.stringify(evidence));
    }
    if (!json && report.uncheckedWordingCount) console.log('Unchecked excerpts:', report.uncheckedWordingCount);
  }
} catch (error) {
  process.exitCode = 2;
  if (json) console.log(JSON.stringify({status: 'invalid_input', message: error.message}));
  else console.error(error.message);
}
