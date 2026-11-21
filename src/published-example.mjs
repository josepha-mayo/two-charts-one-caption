import {readChart} from './check.mjs';
import {readPublishCheck} from './publish-check.mjs';
import {readFigures, runPublishedFigureCheck} from './published-html.mjs';
import savedReview from '../examples/bls-unemployment/caption-recheck.json';
import firstPublished from '../examples/bls-unemployment/first-published.csv?raw';
import revised from '../examples/bls-unemployment/revised.csv?raw';
import html from '../examples/bls-unemployment/published-page.html?raw';

const check = readPublishCheck(savedReview);
const figure = readFigures(html).read({captionId: 'unemployment-rates', checkTable: true});

export function checkBlsPage(useRevision) {
  const rows = readChart(useRevision ? revised : firstPublished);
  return {caption: figure.text, report: runPublishedFigureCheck(figure, rows, check)};
}
