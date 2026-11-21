export const sampleCsv = 'service,percent\nLocal,71.5\nSelect Bus Service,70.5\nExpress,65.1';
export const sampleCaption = 'Median on-time rates ranged from 65.1% to 71.5% across three bus service types.';
export const cutoffCaption = sampleCaption + ' Local had the highest rate, at 71.5%. Express had the lowest rate, at 65.1%.';
export const sampleSource = 'https://comptroller.nyc.gov/reports/life-in-the-slow-lane/';

// The public bus example from the November 20 hosted Firebase replay.
export const recordedBusReview = {
  question: {type: 'atLeast', cutoff: 70},
  excerpts: [
    sampleCaption,
    'Local had the highest rate, at 71.5%.',
    'Express had the lowest rate, at 65.1%.',
  ],
  detail: 'Only Local and Select Bus Service reached at least 70%.',
};

export const foodExample = {
  label: 'Food insecurity by region',
  csv: 'category,percent\nNortheast,12.2\nMidwest,13.3\nSouth,15.0\nWest,12.9',
  caption: 'In 2024, household food insecurity rates ranged from 12.2% to 15.0%. Northeast had the lowest rate, at 12.2%.',
  question: 'highest',
  sourceUrl: 'https://ers.usda.gov/sites/default/files/_laserfiche/publications/113623/ERR-358.pdf?v=71497',
  sourceCitation: 'USDA Economic Research Service · Household Food Security in the United States in 2024, Table 2',
};

export const foodNationalExample = {
  ...foodExample,
  label: 'Food insecurity vs. national estimate',
  question: {type: 'below', cutoff: 13.7},
  sourceCitation: 'USDA Economic Research Service · Household Food Security in the United States in 2024, Table 2 and the national estimate',
};

export const foodPairExample = {
  ...foodExample,
  label: 'Food insecurity in the Midwest and West',
  question: {type: 'pair', ids: [2, 4]},
  brief: 'Make sure readers can tell whether Midwest or West had the higher household food insecurity rate. Keep the graphics desk’s staffing note internal.',
};
