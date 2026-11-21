import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {unzipSync, strFromU8} from 'fflate';
import {createReleaseBundle} from '../src/ci-bundle.mjs';
import {readChart} from '../src/check.mjs';
import {localFacts} from '../src/draft.mjs';
import {createPublishCheck, readPublishCheck} from '../src/publish-check.mjs';
import {compareFigureRows, readFigures, runPublishedFigureCheck} from '../src/published-html.mjs';

const example = name => fileURLToPath(new URL('../examples/bls-unemployment/' + name, import.meta.url));
const script = fileURLToPath(new URL('../scripts/verify-caption.mjs', import.meta.url));
const checkedPage = readFileSync(example('published-page.html'), 'utf8');
const reviewedCaption = readFileSync(example('caption.txt'), 'utf8').trim();
const julySentence = 'July had a rate of 4.3%.';

test('publication holds when saved facts disagree with or omit checkable caption wording', t => {
  const directory = mkdtempSync(join(tmpdir(), 'two-charts-wording-'));
  const checkPath = join(directory, 'check.json'), pagePath = join(directory, 'page.html');
  t.after(() => {
    unlinkSync(checkPath);
    unlinkSync(pagePath);
    rmdirSync(directory);
  });
  const original = JSON.parse(readFileSync(example('caption-recheck.json'), 'utf8'));
  const altered = (before, after) => ({
    ...original,
    caption: original.caption.replace(before, after),
    claims: original.claims.map(claim => ({...claim, evidence: claim.evidence.replace(before, after)})),
  });
  const omitted = {
    ...altered('July had a rate of 4.3%.', 'July had a rate of 4.2%.'),
    claims: original.claims.slice(0, 2),
  };
  for (const [candidate, expected] of [
    [altered(julySentence, 'July had a rate of 4.2%.'), /saved fact disagrees.*4\.2%/],
    [altered('lowest', 'highest'), /saved fact disagrees.*highest rate/],
    [omitted, /missing from the saved check.*July/],
  ]) {
    writeFileSync(checkPath, JSON.stringify(candidate));
    writeFileSync(pagePath, checkedPage.replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/, '<figcaption>' + candidate.caption + '</figcaption>'));
    const result = spawnSync(process.execPath, [script, checkPath, example('first-published.csv'), pagePath,
      '--html', '--check-table', '--json'], {encoding:'utf8'});
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'review_required');
    assert.match(report.message, expected);
    assert.equal(report.table.matches, true);
  }
});

test('a rendered figure with two stale statements offers a checked full caption and both edits', () => {
  const original = readChart(readFileSync(example('first-published.csv'), 'utf8'));
  const current = readChart(readFileSync(example('revised.csv'), 'utf8'));
  const caption = reviewedCaption;
  const page = checkedPage;
  const saved = createPublishCheck(original, {type:'below', cutoff:3.9}, caption, localFacts(original, caption), undefined, 1);
  const options = {suggestRepair:true};
  const report = runPublishedFigureCheck(readFigures(page).read({checkTable:true}), current, saved, undefined, options);
  assert.equal(report.status, 'conflict');
  assert.deepEqual(report.captionRepair.changes, [
    {before:'Only January and March fell below 3.9%.', after:'Only January fell below 3.9%.'},
    {before:'July had a rate of 4.3%.', after:'July had a rate of 4.2%.'},
  ]);
  const changedPage = page.replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/, '<figcaption>' + report.captionRepair.caption + '</figcaption>');
  const figure = readFigures(changedPage).read({checkTable:true});
  assert.equal(runPublishedFigureCheck(figure, current, report.captionRepair.check).status, 'review_required');
  const newTable = changedPage.replace('<td>3.8%</td>', '<td>3.9%</td>').replace('<td>4.3%</td>', '<td>4.2%</td>');
  const updated = readFigures(newTable).read({checkTable:true});
  assert.equal(runPublishedFigureCheck(updated, current, report.captionRepair.check).status, 'explicit');
});

test('read the selected semantic caption with HTML entities, line breaks and inline formatting', () => {
  const {read} = readFigures([
    '<figure id="selected"><figcaption id="caption"><p>Fabric <strong>&amp;</strong> Paper.</p>',
    '<p>Rate was&nbsp;<strong>4</strong>.2%.<br>Second line.</p><span aria-hidden="true">Decorative</span>',
    '<script>throw Error("The publisher has scripts");</script></figcaption></figure>',
    '<figure hidden><figcaption>Unpublished draft.</figcaption></figure>',
    '<template><figure><figcaption>Unused template.</figcaption></figure></template>',
  ].join(''));
  const expected = {text:'Fabric & Paper. Rate was 4.2%. Second line.'};
  assert.deepEqual(read(), expected);
  assert.deepEqual(read({captionId:'selected'}), expected);
  assert.deepEqual(read({captionId:'caption'}), expected);
});

test('ambiguous, hidden, and duplicate targets fail closed', () => {
  const figure = '<figure id="chart"><figcaption>Actual caption</figcaption></figure>';
  const multi = readFigures(figure + '<figure><figcaption>Separate caption.</figcaption></figure>');
  assert.throws(() => multi.read(), /several figure captions/);
  assert.equal(multi.read({captionId:'chart'}).text,'Actual caption');
  assert.equal(multi.count, 2);
  assert.equal(multi.label(1), 'Figure 2 · Separate caption.');
  assert.equal(multi.read({captionIndex:1}).text, 'Separate caption.');
  assert.throws(() => multi.read({captionIndex:2}), /visible figcaption/);
  assert.throws(() => readFigures('<section inert>' + figure + '</section>').read({captionId:'chart'}), /visible figcaption/);
  assert.throws(() => readFigures(figure + '<span hidden id="chart"></span>').read({captionId:'chart'}), /must exist and be unique/);
  assert.throws(() => readFigures('<figcaption>Orphaned</figcaption>').read(), /inside its figure/);
  assert.throws(() => readFigures('<figure><figcaption>One</figcaption><figcaption>Two</figcaption></figure>').read(), /several figure captions/);
});

test('read the exported table shape and report changed or missing rows by label', () => {
  const {read} = readFigures(checkedPage);
  const selected = read({captionId:'unemployment-rates', checkTable:true});
  assert.equal(selected.text, reviewedCaption);
  assert.equal(selected.rows.length,12);
  assert.deepEqual(compareFigureRows(selected.rows, [...selected.rows].reverse()), []);
  const changes = [{label:'Unknown',value:99}, ...selected.rows.slice(1)
    .map(row => row.label === 'March' ? {...row,value:3.9} : row)];
  assert.deepEqual(compareFigureRows(selected.rows, changes), [
    {label:'January',sourceRate:3.7,tableRate:null}, {label:'March',sourceRate:3.8,tableRate:3.9},
    {label:'Unknown',sourceRate:null,tableRate:99},
  ]);
  const span = checkedPage.replace('<td>3.8%</td>','<td colspan="2">3.8%</td>');
  assert.throws(() => readFigures(span).read({checkTable:true}), /two-column data table/);
  const hidden = checkedPage.replace('<table>','<table aria-hidden="true">');
  assert.throws(() => readFigures(hidden).read({checkTable:true}), /exactly one data table/);
  assert.deepEqual(read({captionId:'unemployment-rates',forAudit:true}), {...selected,decimalPlaces:1});
  const normalized = readFigures('<figure><figcaption>Two groups.</figcaption><table>' +
    '<thead><tr><th>Group</th><th>Rate</th></tr></thead>' +
    '<tbody><tr><th>A</th><td>40.00%</td></tr><tr><th>B</th><td>50%</td></tr></tbody></table></figure>');
  assert.deepEqual(normalized.read({forAudit:true}), {
    text:'Two groups.', rows:[{label:'A',value:40},{label:'B',value:50}], decimalPlaces:2,
  });
});

test('a checked replacement closes the publication check after the caption and table are updated', () => {
  const full = JSON.parse(readFileSync(example('caption-recheck.json'), 'utf8'));
  const saved = readPublishCheck({...full, caption:full.caption.replace(' ' + julySentence, ''), claims:full.claims.slice(0, 2)});
  const rows = readChart(readFileSync(example('revised.csv'), 'utf8'));
  const page = checkedPage.replace(' ' + julySentence, '');
  const figure = readFigures(page).read({checkTable: true});
  const options = {suggestRepair: true};
  const stale = runPublishedFigureCheck(figure, rows, saved, undefined, options);
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.captionRepair.sentence, 'Only January fell below 3.9%.');
  const revisedCheck = readPublishCheck(stale.captionRepair.check);
  const rebuilt = page.replace('Only January and March fell below&nbsp;3.9%.', stale.captionRepair.sentence)
    .replace('<td>3.8%</td>', '<td>3.9%</td>').replace('<td>4.3%</td>', '<td>4.2%</td>');
  const result = runPublishedFigureCheck(readFigures(rebuilt).read({checkTable: true}), rows, revisedCheck, undefined, options);
  assert.equal(result.status, 'explicit');
  assert.equal(result.table.matches, true);
  assert.equal(result.captionRepair, undefined);
  assert.equal(runPublishedFigureCheck({...figure,text:'Changed independently.'}, rows, saved, undefined, options).captionRepair, undefined);
});

test('the GitHub gate summarizes each figure and rejects inputs outside the checkout', t => {
  const directory = mkdtempSync(join(tmpdir(), 'two-charts-gate-'));
  const names = ['check.json','first.csv','revised.csv','page.html','release.json','summary.md'];
  t.after(() => {
    for (const name of names) unlinkSync(join(directory,name));
    rmdirSync(directory);
  });
  writeFileSync(join(directory,'check.json'),readFileSync(example('caption-recheck.json')));
  writeFileSync(join(directory,'first.csv'),readFileSync(example('first-published.csv')));
  writeFileSync(join(directory,'revised.csv'),readFileSync(example('revised.csv')));
  writeFileSync(join(directory,'page.html'),checkedPage);
  writeFileSync(join(directory,'summary.md'),'');
  const figure = {check:'check.json',html:'page.html',captionId:'unemployment-rates',checkTable:true};
  const charts = [
    {...figure,id:'First publication',csv:'first.csv'},
    {...figure,id:'Edited <img>|row',csv:'revised.csv'},
    {...figure,id:'Outside file',csv:'first.csv',html:example('published-page.html')},
  ];
  writeFileSync(join(directory,'release.json'),JSON.stringify({version:1,charts}));
  const result = spawnSync(process.execPath,
    [script,'--batch','release.json','--json','--github-actions'], {
      encoding:'utf8',env:{...process.env,GITHUB_WORKSPACE:directory,GITHUB_STEP_SUMMARY:join(directory,'summary.md')},
    });
  assert.equal(result.status,2,result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.totals,{passed:1,reviewRequired:1,invalid:1});
  assert.equal(report.checks[1].answerChange.removed[0],'March');
  assert.match(report.checks[2].message,/inside the checked-out GitHub workspace/);
  const summary = readFileSync(join(directory,'summary.md'),'utf8');
  assert.match(summary,/1 passed · 1 need review · 1 invalid/);
  assert.match(summary,/<code>Edited &lt;img&gt;&#124;row<\/code> \| Review required/);
  assert.doesNotMatch(summary,/<img>|January and March/);
});

test('the downloaded release setup checks a generated page and detects a stale refresh', t => {
  const directory = mkdtempSync(join(tmpdir(), 'two-charts-bundle-'));
  const files = ['latest source.csv','generated report.html','release.json','caption-recheck.json'];
  const checks = join(directory,'caption-checks');
  mkdirSync(checks);
  t.after(() => {
    for (const name of files.slice(0,2)) unlinkSync(join(directory,name));
    for (const name of files.slice(2)) unlinkSync(join(checks,name));
    rmdirSync(checks);
    rmdirSync(directory);
  });
  const check = JSON.parse(readFileSync(example('caption-recheck.json'), 'utf8'));
  const options = {csv:'latest source.csv', page:'generated report.html', format:'html', captionId:'unemployment-rates'};
  const bundle = unzipSync(createReleaseBundle(check,options));
  assert.deepEqual(Object.keys(bundle).sort(), [
    '.github/workflows/check-chart-captions.yml', 'caption-checks/caption-recheck.json', 'caption-checks/release.json',
  ]);
  const workflow = strFromU8(bundle['.github/workflows/check-chart-captions.yml']);
  assert.match(workflow,/two-charts-one-caption@[a-f0-9]{40}/);
  assert.match(workflow,/manifest: caption-checks\/release\.json/);
  assert.doesNotMatch(workflow,/January|BLS|latest source\.csv/);
  for (const name of files.slice(2)) writeFileSync(join(checks,name),bundle['caption-checks/'+name]);
  writeFileSync(join(directory,'generated report.html'),checkedPage);
  const run = csv => {
    writeFileSync(join(directory,'latest source.csv'),readFileSync(example(csv)));
    return spawnSync(process.execPath,[script,'--batch',join(checks,'release.json'),'--json'],{encoding:'utf8'});
  };
  assert.equal(run('first-published.csv').status,0);
  const stale = run('revised.csv');
  assert.equal(stale.status,1);
  assert.deepEqual(JSON.parse(stale.stdout).checks[0].answerChange.removed,['March']);
  const txt = unzipSync(createReleaseBundle(check,{...options,format:'text',page:'copy.txt'}));
  const manifest = JSON.parse(strFromU8(txt['caption-checks/release.json']));
  assert.equal(manifest.charts[0].caption,'../copy.txt');
  assert.equal(manifest.charts[0].captionId,undefined);
  assert.throws(() => createReleaseBundle(check,{...options,csv:'../outside.csv'}), /repository root/);
  assert.throws(() => createReleaseBundle(check,{...options,captionId:'bad id'}), /without spaces/);
});

test('a generated page can fail for changed wording, stale numbers, or an invalid target', t => {
  const temporary = mkdtempSync(join(tmpdir(),'two-charts-html-'));
  const page = join(temporary,'built.html'), batch = join(temporary,'release.json');
  t.after(() => {
    unlinkSync(batch);
    unlinkSync(page);
    rmdirSync(temporary);
  });
  const common = [example('caption-recheck.json')];
  const run = (csv, ...options) => {
    const result = spawnSync(process.execPath,[script,...common,example(csv),page,'--json',...options], {encoding:'utf8'});
    return {code:result.status, report:JSON.parse(result.stdout)};
  };
  const flags = ['--html','--caption-id','unemployment-rates','--check-table'];
  writeFileSync(page,checkedPage);
  const initial = run('first-published.csv',...flags);
  assert.equal(initial.code,0);
  assert.equal(initial.report.captionSource,'html_figcaption');
  assert.deepEqual(initial.report.table,{matches:true,mismatches:[]});
  const revised = run('revised.csv',...flags);
  assert.equal(revised.code,1);
  assert.equal(revised.report.status,'conflict');
  assert.deepEqual(revised.report.failedFacts,['Only January and March fell below 3.9%.', julySentence]);
  assert.deepEqual(revised.report.table.mismatches.map(row => row.label), ['March','July']);
  assert.deepEqual(revised.report.answerChange, {reviewed:'January and March', current:'January', added:[], removed:['March']});

  writeFileSync(page,checkedPage.replace('Only January and March fell','Only January fell'));
  const changedCaption = run('first-published.csv',...flags);
  assert.equal(changedCaption.code,1);
  assert.match(changedCaption.report.message,/HTML figcaption differs/);
  assert.deepEqual(changedCaption.report.missingReviewedExcerpts,['Only January and March fell below 3.9%.']);
  assert.equal(changedCaption.report.answerChange,undefined);
  assert.equal(changedCaption.report.table.matches,true);
  writeFileSync(page,checkedPage.replace('<td>3.8%</td>','<td>3.9%</td>'));
  assert.equal(run('first-published.csv','--html').code,0);
  const changedTable = run('first-published.csv',...flags);
  assert.equal(changedTable.code,1);
  assert.match(changedTable.report.message,/HTML data table differs/);
  assert.equal(run('first-published.csv','--caption-id','unemployment-rates').code,2);

  const restored = checkedPage + '<figure id="unrelated"><figcaption>Another chart on this page.</figcaption></figure>';
  writeFileSync(page,restored);
  assert.equal(run('first-published.csv','--html').code,2);
  const chart = {id:'labor',check:common[0],csv:example('first-published.csv'),html:'built.html',
    captionId:'unemployment-rates',checkTable:true};
  const entries = [
    chart,
    {...chart,id:'different-figure',captionId:'unrelated',checkTable:false},
    {id:'plain-caption',check:chart.check,csv:chart.csv,caption:example('caption.txt')},
  ];
  writeFileSync(batch,JSON.stringify({version:1,charts:entries}));
  const report = spawnSync(process.execPath,[script,'--batch',batch,'--json'],{encoding:'utf8'});
  assert.equal(report.status,1,report.stderr);
  assert.deepEqual(JSON.parse(report.stdout).totals,{passed:2,reviewRequired:1,invalid:0});
  assert.deepEqual(JSON.parse(report.stdout).checks.map(row => row.status),['explicit','review_required','explicit']);
});
