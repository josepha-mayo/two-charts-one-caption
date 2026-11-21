import {parse} from 'parse5';
import {readChartRows} from './csv.mjs';
import {runPublishCheck, suggestPublishRepair} from './publish-check.mjs';

export const maxHtmlBytes = 1_000_000;
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const excluded = new Set(['script', 'style', 'template', 'noscript']);
const block = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'ul']);

const element = (node, tag) => node?.namespaceURI === htmlNamespace && node.tagName === tag;
const attribute = (node, name) => node.attrs?.find(attr => attr.name === name)?.value;
const skip = node => excluded.has(node.tagName) || attribute(node, 'hidden') !== undefined ||
  attribute(node, 'inert') !== undefined || attribute(node, 'aria-hidden')?.toLowerCase() === 'true';

export const normalizeCaptionSpacing = text => text.replace(/[\t\n\f\r \u00a0\u202f]+/g, ' ').trim();

function* walk(root) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    yield node;
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
}

function visible(node) {
  for (let current = node; current; current = current.parentNode) {
    if (skip(current)) return false;
  }
  return true;
}

function staticText(root) {
  const pieces = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (node === null) pieces.push(' ');
    else if (node.nodeName === '#text') pieces.push(node.value);
    else if (node.namespaceURI === htmlNamespace && !skip(node)) {
      if (block.has(node.tagName)) {
        pieces.push(' ');
        pending.push(null);
      }
      const children = node.childNodes ?? [];
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
  }
  return normalizeCaptionSpacing(pieces.join(''));
}

function directChildren(parent, tag) {
  return (parent.childNodes ?? []).filter(node => element(node, tag));
}

function cellsOf(row) {
  const cells = (row.childNodes ?? []).filter(node => (element(node, 'th') || element(node, 'td')) && !skip(node));
  if (cells.length !== 2 || cells.some(cell => ['rowspan', 'colspan'].some(key => ![undefined, '1'].includes(attribute(cell, key))))) {
    throw Error('Use a two-column data table with one category and percentage per row.');
  }
  return cells;
}

function tableRows(figure) {
  const tables = directChildren(figure, 'table').filter(node => !skip(node));
  if (tables.length !== 1) throw Error('The selected figure needs exactly one data table.');
  const [table] = tables;
  const header = directChildren(table, 'thead').filter(node => !skip(node))
    .flatMap(head => directChildren(head, 'tr').filter(node => !skip(node)));
  if (header.length !== 1) throw Error('Use one header row in the figure’s data table.');
  const headings = cellsOf(header[0]);
  const headers = headings.map(staticText);
  if (headings.some(cell => !element(cell, 'th')) || headers.some(name => !name) || headers[0] === headers[1]) {
    throw Error('Use distinct category and percentage headers in the figure’s data table.');
  }
  const records = directChildren(table, 'tbody').filter(node => !skip(node))
    .flatMap(body => directChildren(body, 'tr').filter(node => !skip(node)))
    .map((row, index) => ({cells: cellsOf(row).map(staticText), line: index + 1}));
  return readChartRows({headers, records}, {category: 0, rate: 1});
}

export function readFigures(html) {
  const document = parse(html);
  const captions = [];
  const byId = new Map();
  for (const node of walk(document)) {
    const id = attribute(node, 'id');
    if (id) byId.set(id, byId.has(id) ? null : node);
    if (element(node, 'figcaption') && element(node.parentNode, 'figure') && visible(node)) captions.push(node);
  }
  function read({captionId, captionIndex, checkTable} = {}) {
    let caption;
    if (captionId !== undefined) {
      const target = byId.get(captionId);
      if (!target) throw Error('The requested HTML ID must exist and be unique.');
      caption = element(target, 'figure') ? directChildren(target, 'figcaption')[0] : target;
    } else if (captionIndex !== undefined) {
      caption = captions[captionIndex];
    } else {
      if (captions.length > 1) throw Error('This HTML has several figure captions. Select a figure or caption by ID.');
      [caption] = captions;
    }
    if (!element(caption, 'figcaption') || !element(caption.parentNode, 'figure') || !visible(caption)) {
      throw Error('Choose a visible figcaption inside its figure in the generated HTML.');
    }
    const figure = caption.parentNode;
    if (directChildren(figure, 'figcaption').length !== 1) {
      throw Error('The selected figure needs exactly one figcaption.');
    }
    const text = staticText(caption);
    if (!text) throw Error('The selected figcaption needs text.');
    return {text, ...(checkTable && {rows: tableRows(figure)})};
  }
  return {
    read,
    count: captions.length,
    label(index) {
      const caption = captions[index];
      const id = attribute(caption, 'id') || attribute(caption.parentNode, 'id');
      const prefix = id ? id.slice(0, 60) : `Figure ${index + 1}`;
      const preview = staticText(caption);
      return `${prefix} · ${preview.slice(0, 100)}${preview.length > 100 ? '…' : ''}`;
    },
  };
}

export function compareFigureRows(source, published) {
  const current = new Map(source.map(({label, value}) => [label, value]));
  const actual = new Map(published.map(({label, value}) => [label, value]));
  const categories = new Set([...current.keys(), ...actual.keys()]);
  return [...categories].flatMap(label => {
    const sourceRate = current.get(label) ?? null;
    const tableRate = actual.get(label) ?? null;
    return sourceRate === tableRate ? [] : [{label, sourceRate, tableRate}];
  });
}

export function runPublishedFigureCheck(figure, rows, check, columns, {suggestRepair = false} = {}) {
  const caption = normalizeCaptionSpacing(check.caption);
  const report = figure.text === caption
    ? runPublishCheck(rows, check.caption, check, columns)
    : {
        status: 'review_required',
        message: 'The HTML figcaption differs from the reviewed caption. Review the wording in the generated page.',
        missingReviewedExcerpts: [...new Set(check.claims.map(({evidence}) => evidence)
          .filter(evidence => !figure.text.includes(normalizeCaptionSpacing(evidence))))],
      };
  report.captionSource = 'html_figcaption';
  if (figure.rows) {
    const mismatches = compareFigureRows(rows, figure.rows);
    report.table = {matches: mismatches.length === 0, mismatches};
    if (mismatches.length && ['explicit', 'implied'].includes(report.status)) {
      report.status = 'review_required';
      report.message = 'The figure’s HTML data table differs from the current CSV.';
    }
  }
  if (suggestRepair && report.status === 'conflict') {
    const repair = suggestPublishRepair(rows, check.caption, check, columns);
    if (repair) report.captionRepair = {sentence: repair.after, check: repair.check};
  }
  return report;
}
