const percent = /^\d{1,3}(?:\.\d{1,2})?\s*%?$/;

export function readCsvTable(csv) {
  if (typeof csv !== 'string' || csv.length > 4000) throw Error('Use CSV under 4,000 characters.');
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
  if (records.length < 2 || records.length > 7) throw Error('Enter two to seven categories.');
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

export function readChartRows(table, {category, rate} = {}) {
  const {headers, records} = table;
  if (![category, rate].every(index => Number.isInteger(index) && index >= 0 && index < headers.length) ||
      category === rate) throw Error('Choose separate columns for the category and percentage.');
  const seen = new Set();
  return records.map(({cells, line}) => {
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
  const columns = columnNames
    ? {category: namedColumn(headers, columnNames.category), rate: namedColumn(headers, columnNames.rate)}
    : defaultChartColumns(headers);
  if (!columns) throw Error('Use the header category,percent or specify the two column names.');
  return readChartRows(table, columns);
}
