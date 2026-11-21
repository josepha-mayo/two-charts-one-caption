import {strToU8, zipSync} from 'fflate';
import {readPublishCheck} from './publish-check.mjs';

const workflow = `name: Check chart captions
on: [pull_request, push]
permissions:
  contents: read
jobs:
  caption-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      # If CI generates the CSV or report, build it before this step.
      - uses: josepha-mayo/two-charts-one-caption@d8e5b99b0b5bb8f9f6cf3e54cedc5ac00e0918e9
        with:
          manifest: caption-checks/release.json
`;

function workspacePath(value, label) {
  const path = typeof value === 'string' ? value.trim().replace(/^\.\//, '') : '';
  if (!path || path.length > 240 || /[\\:\u0000-\u001f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error(`Enter the ${label} path from the repository root using forward slashes.`);
  }
  return '../' + path;
}

export function createReleaseBundle(checked, {csv, page, format, captionId = '', checkTable = true}) {
  const check = readPublishCheck(checked);
  const entry = {id:'reviewed-caption', check:'caption-recheck.json', csv:workspacePath(csv,'CSV')};
  if (format === 'html') {
    entry.html = workspacePath(page,'HTML');
    const id = captionId.trim();
    if (id && (id.length > 200 || /[\t\n\f\r ]/.test(id))) throw Error('Enter the exact figure ID without spaces.');
    if (id) entry.captionId = id;
    entry.checkTable = checkTable;
  } else if (format === 'text') {
    entry.caption = workspacePath(page,'caption');
  } else {
    throw Error('Choose HTML or caption text for the publication.');
  }
  const json = value => strToU8(JSON.stringify(value, null, 2) + '\n');
  return zipSync({
    '.github/workflows/check-chart-captions.yml': strToU8(workflow),
    'caption-checks/caption-recheck.json': json(check),
    'caption-checks/release.json': json({version:1, charts:[entry]}),
  }, {level:1});
}
