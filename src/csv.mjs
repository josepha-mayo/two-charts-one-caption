const percent = /^\d{1,3}(?:\.\d{1,2})?\s*%?$/;
export const maxCsvBytes = 64_000;
export const maxChartRows = 12;
const validFilterValue = value => typeof value === 'string' && value.trim() === value && value.length > 0 &&
  value.length <= 128 && !/[\r\n]/.test(value);

export function readCsvTable(csv) {
  if (typeof csv !== 'string' || csv.length > maxCsvBytes || new TextEncoder().encode(csv).byteLength > maxCsvBytes) {
    throw Error('Use CSV up to 64 KB.');
  }
  const text = csv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const field = /(?:[ \t]*"((?:[^"]|"")*)"[ \t]*|([^",\n]*))(,|\n|$)/y;
  const records = [];
  let cells = [];
  let line = 1;
  let rowLine = 1;
  let delimiter;
  do {
    const match = field.exec(text);
    if (!match) throw Error('Invalid CSV quoting in the row starting on line ' + rowLine + '.');
    const [, quoted, plain, separator] = match;
    cells.push((quoted?.replaceAll('""', '"') ?? plain).trim());
    delimiter = separator;
    line += match[0].split('\n').length - 1;
    if (delimiter !== ',') {
      if (cells.length > 1 || cells[0]) records.push({cells, line: rowLine});
      cells = [];
      rowLine = line;
    }
  } while (delimiter === ',' || field.lastIndex < text.length);

  const headers = records.shift()?.cells ?? [];
  if (headers.length < 2) throw Error('Use a CSV with a header and at least two columns.');
  if (records.length < 2 || records.length > 500) throw Error('Enter two to 500 rows before selecting a row group.');
  for (const record of records) {
    if (record.cells.length !== headers.length) {
      throw Error('Line ' + record.line + ' must have the same number of columns as the header.');
    }
  }
  return {headers, records};
}

export function defaultChartColumns(headers) {
  if (headers.length !== 2) return;
  const [category, rate] = headers.map(header => header.toLowerCase());
  if (['category', 'service'].includes(category) && rate === 'percent') return {category: 0, rate: 1};
}

function namedColumn(headers, name) {
  const matches = headers.flatMap((header, index) => header === name ? [index] : []);
  if (matches.length !== 1) throw Error('Use a unique CSV header for ' + JSON.stringify(name) + '.');
  return matches[0];
}

export function readColumnNames(columns) {
  if (columns === undefined) return;
  const {category, rate, filter} = columns ?? {};
  if (![category, rate].every(name => typeof name === 'string' && name && name.trim() === name) ||
      category === rate) throw Error('Use two distinct, nonempty CSV header names.');
  if (filter === undefined) return {category, rate};
  const {column, value} = filter ?? {};
  if (typeof column !== 'string' || !column || column.trim() !== column || [category, rate].includes(column) || !validFilterValue(value)) {
    throw Error('Choose a separate group column and a nonempty group value.');
  }
  return {category, rate, filter: {column, value}};
}

export function readChartRows(table, {category, rate, filter} = {}) {
  const {headers, records} = table;
  if (![category, rate].every(index => Number.isInteger(index) && index >= 0 && index < headers.length) ||
      category === rate) throw Error('Choose separate columns for the category and percentage.');
  let selected = records;
  if (filter) {
    const {column, value} = filter;
    if (!Number.isInteger(column) || column < 0 || column >= headers.length || [category, rate].includes(column) || !validFilterValue(value)) {
      throw Error('Choose a separate group column and a nonempty group value.');
    }
    selected = records.filter(({cells}) => cells[column] === value);
  }
  if (selected.length < 2 || selected.length > maxChartRows) {
    throw Error(filter ? `The selected group has ${selected.length} rows. Choose a group of 2 to ${maxChartRows} categories.`
      : `Choose 2 to ${maxChartRows} categories, or select a row group.`);
  }
  const seen = new Set();
  return selected.map(({cells, line}) => {
    const label = cells[category];
    const raw = cells[rate];
    const key = label.normalize('NFKC').toLowerCase();
    if (!label || label.length > 64 || /[\r\n]/.test(label)) {
      throw Error('Line ' + line + ' needs a category name of 1 to 64 characters on a single line.');
    }
    if (seen.has(key)) throw Error('Line ' + line + ' repeats a category. Use unique category names.');
    if (!percent.test(raw)) {
      throw Error('Line ' + line + ' needs a percentage with up to two decimal places.');
    }
    const value = Number(raw.replace(/%$/, ''));
    if (value > 100) throw Error('Line ' + line + ' needs a percentage from 0 to 100.');
    seen.add(key);
    return {label, value};
  });
}

export function readChart(csv, columnNames) {
  const table = readCsvTable(csv);
  const {headers} = table;
  const names = readColumnNames(columnNames);
  const columns = names
    ? {category: namedColumn(headers, names.category), rate: namedColumn(headers, names.rate)}
    : defaultChartColumns(headers);
  if (!columns) throw Error('Use the header category,percent or specify the two column names.');
  if (names?.filter) columns.filter = {column: namedColumn(headers, names.filter.column), value: names.filter.value};
  return readChartRows(table, columns);
}

export function rowScope({column, value}) {
  return `${column} = ${value}`;
}
