import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {compareFigureRows, readFigures} from '../src/published-html.mjs';

const example = name => fileURLToPath(new URL('../examples/bls-unemployment/' + name, import.meta.url));
const script = fileURLToPath(new URL('../scripts/verify-caption.mjs', import.meta.url));
const checkedPage = readFileSync(example('published-page.html'), 'utf8');
const reviewedCaption = 'January had the lowest rate, at 3.7%. Only January and March fell below 3.9%.';

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
  assert.deepEqual(revised.report.failedFacts,['Only January and March fell below 3.9%.']);
  assert.deepEqual(revised.report.table.mismatches.map(row => row.label), ['March','July']);

  writeFileSync(page,checkedPage.replace('Only January and March fell','Only January fell'));
  const changedCaption = run('first-published.csv',...flags);
  assert.equal(changedCaption.code,1);
  assert.match(changedCaption.report.message,/HTML figcaption differs/);
  assert.deepEqual(changedCaption.report.missingReviewedExcerpts,['Only January and March fell below 3.9%.']);
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
