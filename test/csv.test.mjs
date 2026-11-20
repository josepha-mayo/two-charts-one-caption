import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultChartColumns, readChart, readChartRows, readCsvTable} from '../src/csv.mjs';

test('quoted spreadsheet headers and percentage cells load with legacy names', () => {
  const csv = '\uFEFF"Service", "Percent"\r\n"North, East","71.50%"\r\n\r\n"West ""B""","65"\r\n';
  assert.deepEqual(readChart(csv), [
    {label: 'North, East', value: 71.5},
    {label: 'West "B"', value: 65},
  ]);
});

test('the browser and CLI select only the requested columns', () => {
  const csv = '"Rate",Internal note,Region\n"15.0","line one,\nline two",South\n"12.2",confidential,Northeast';
  const table = readCsvTable(csv);
  assert.equal(defaultChartColumns(table.headers), undefined);
  const expected = [{label: 'South', value: 15}, {label: 'Northeast', value: 12.2}];
  assert.deepEqual(readChartRows(table, {category: 2, rate: 0}), expected);
  assert.deepEqual(readChart(csv, {category: 'Region', rate: 'Rate'}), expected);
  assert.throws(() => readChartRows(table, {category: 0, rate: 0}), /separate columns/);
  assert.throws(() => readChart(csv, {category: 'region', rate: 'Rate'}), /unique CSV header/);
  assert.throws(() => readChart(csv.replace('Internal note', 'Region'), {category: 'Region', rate: 'Rate'}), /unique CSV header/);
});

test('invalid sheet rows keep their source line numbers', () => {
  assert.throws(() => readChart('\ncategory,percent\nA,0\nB,51.234'), /Line 4.*two decimal/);
  assert.throws(() => readChart('category,percent\rA,0\r\rB,51.234'), /Line 4.*two decimal/);
  assert.throws(() => readChart('category,percent\nA,0\nB'), /Line 3.*same number/);
  assert.throws(() => readChart('category,percent\nA,0\n"B,12'), /quoting.*line 3/);
  assert.throws(() => readChart('category,percent\nA,0\n"Upper\nWest",12'), /Line 3.*single line/);
  assert.throws(() => readChart('category,percent\nA,0\nB,'), /Line 3.*percentage/);
});
