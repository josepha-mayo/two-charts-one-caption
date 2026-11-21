import {answerText, fitsClaim, questionText, supportedDetail} from './check.mjs';

const reportStyle = `
  :root { color-scheme: light; color: #17253a; background: #f7f3e9; font: 16px/1.5 system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  main { max-width: 52rem; margin: auto; padding: clamp(1rem, 4vw, 3rem); }
  header { padding-bottom: 1rem; border-bottom: 2px solid #9a5829; }
  h1 { margin: .4rem 0 0; font: 500 clamp(2rem, 6vw, 3.35rem)/1.1 Georgia, serif; }
  h2 { font-size: 1.15rem; margin: 1.5rem 0 .5rem; }
  header p, caption, .source { color: #445065; }
  p, blockquote { margin: .5rem 0; }
  figure { margin: 1rem 0; }
  figcaption { overflow-wrap: anywhere; white-space: pre-wrap; }
  blockquote { padding-inline-start: .8rem; border-inline-start: 3px solid #9a5829; white-space: pre-wrap; overflow-wrap: anywhere; }
  .answers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; margin: .8rem 0; }
  .answers div { padding: .65rem; border: 1px solid #b5b6b2; background: #fffdf7; }
  .answers dt { color: #445065; font-size: .9rem; }
  .answers dd { font-weight: 750; margin: .2rem 0 0; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  caption { text-align: start; margin-block-end: .4rem; }
  th, td { border-bottom: 1px solid #b5b6b2; padding: .45rem .35rem; text-align: start; overflow-wrap: anywhere; }
  td { font-variant-numeric: tabular-nums; }
  meter { display: block; width: 100%; height: .65rem; }
  tr.changed { background: #f8e4ce; }
  small { display: block; }
  ul { padding-inline-start: 1.25rem; }
  li { margin: .6rem 0; break-inside: avoid; }
  li q { display: block; overflow-wrap: anywhere; }
  .source { font-size: .85rem; }
  @media print {
    :root { background: white; }
    main { padding: 0; }
    header, p, table, blockquote, .answers { break-inside: avoid; }
  }
`;

function element(doc, tag, text) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function reportDocument(document, title) {
  const doc = document.implementation.createHTMLDocument(title);
  doc.documentElement.lang = 'en';
  const encoding = element(doc, 'meta');
  encoding.setAttribute('charset', 'utf-8');
  const viewport = element(doc, 'meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  doc.head.prepend(encoding, viewport);
  const policy = element(doc, 'meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  doc.head.append(policy, element(doc, 'style', reportStyle));
  const main = element(doc, 'main');
  doc.body.append(main);
  return {doc, main};
}

function dataTable(doc, title, columns) {
  const table = element(doc, 'table');
  table.createCaption().textContent = title;
  const header = table.createTHead().insertRow();
  for (const name of columns) {
    const th = element(doc, 'th', name);
    th.scope = 'col';
    header.append(th);
  }
  const body = table.createTBody();
  return {table, body};
}

function labelRow(doc, body, label) {
  const row = body.insertRow();
  const category = element(doc, 'th', label);
  category.scope = 'row';
  row.append(category);
  return row;
}

function html(doc) {
  return '<!doctype html>' + doc.documentElement.outerHTML;
}

function reviewedFigure(doc, caption, rows, sourceNote) {
  const figure = element(doc, 'figure');
  const description = element(doc, 'figcaption');
  description.append(element(doc, 'p', caption));
  const {table, body} = dataTable(doc, 'Chart data', ['Category', 'Rate']);
  for (const {label, value} of rows) labelRow(doc, body, label).insertCell().textContent = `${value}%`;
  figure.append(description, table);
  if (sourceNote) figure.append(element(doc, 'p', sourceNote));
  return figure;
}

export function reviewedFragment(document, caption, rows, sourceNote) {
  return reviewedFigure(document, caption, rows, sourceNote).outerHTML;
}

export function reviewedDescription(document, caption, rows, sourceNote) {
  const {doc, main} = reportDocument(document, 'Reviewed chart description');
  main.append(element(doc, 'h1', 'Chart description'), reviewedFigure(doc, caption, rows, sourceNote));
  return html(doc);
}

export function comparisonReport(document, {caption, rows, question, result, claims, describeClaim, sourceNote}) {
  const {doc, main} = reportDocument(document, 'Chart caption comparison');
  const header = element(doc, 'header');
  header.append(element(doc, 'p', 'Two Charts, One Caption'), element(doc, 'h1', 'Same caption, different answers'));
  const answers = element(doc, 'dl');
  answers.className = 'answers';
  for (const [label, ids] of [['Source chart answer', result.expected], ['Hypothetical chart answer', result.alternateAnswer]]) {
    const answer = element(doc, 'div');
    answer.append(element(doc, 'dt', label), element(doc, 'dd', answerText(rows, ids)));
    answers.append(answer);
  }
  const {table, body} = dataTable(doc, 'Rates in both charts', ['Category', 'Source rate', 'Hypothetical rate']);
  for (const [index, {label, value}] of rows.entries()) {
    const alternate = result.alternate[index];
    const row = labelRow(doc, body, label);
    const changed = value !== alternate;
    if (changed) row.className = 'changed';
    for (const rate of [value, alternate]) {
      const cell = row.insertCell();
      const meter = element(doc, 'meter');
      meter.min = 0;
      meter.max = 100;
      meter.value = rate;
      meter.setAttribute('aria-hidden', 'true');
      cell.append(element(doc, 'span', `${rate}%`), meter);
    }
    if (changed) row.lastElementChild.append(element(doc, 'small', 'Changed'));
  }
  const sourceValues = rows.map(row => row.value);
  const facts = element(doc, 'ul');
  for (const claim of claims) {
    const item = element(doc, 'li');
    const matches = fitsClaim(sourceValues, claim) && fitsClaim(result.alternate, claim);
    item.append(element(doc, 'strong', describeClaim(claim)), element(doc, 'q', claim.evidence),
      element(doc, 'small', matches ? 'Verified on both charts' : 'Review this fact'));
    facts.append(item);
  }
  const changed = result.changedCategories === 1 ? '1 category' : `${result.changedCategories} categories`;
  main.append(header, element(doc, 'h2', 'Question checked'), element(doc, 'p', questionText(question)), answers,
    element(doc, 'p', `Changing ${changed} is enough to change the answer. The second chart is hypothetical.`), table,
    element(doc, 'h2', 'Caption under review'), element(doc, 'blockquote', caption),
    element(doc, 'h2', 'Checked caption facts'), claims.length ? facts : element(doc, 'p', '0 quantitative facts were approved.'),
    element(doc, 'h2', 'Suggested sentence'), element(doc, 'blockquote', supportedDetail(rows, question, result.expected)));
  if (sourceNote) {
    const source = element(doc, 'p', sourceNote);
    source.className = 'source';
    main.append(source);
  }
  return html(doc);
}
