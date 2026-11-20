# Two Charts, One Caption

Check whether a chart description answers the question a reader needs to ask. The browser finds an alternative that changes the answer while preserving the checked facts and changing as few categories as possible. The revised description and an HTML data table can be downloaded once the selected answer is explicit.

[Try the 70% cutoff demo](https://two-charts-caption-2026--judge-preview-nh1ldqbu.web.app/?example=cutoff)

## Run locally

Use Node.js 24.

```sh
npm ci
npm test
npm run dev
```

The built-in example uses the median on-time rates in [Table 3 of the NYC Comptroller’s bus report](https://comptroller.nyc.gov/reports/life-in-the-slow-lane/). Try answering from the description alone, then inspect both charts and the exact facts they satisfy. The local text parser can check wording such as “Rates ranged from 10% to 40%.”, exact values such as “North had a rate of 40%.”, and the ranking and cutoff sentences suggested by the app. A ranking sentence with an exact rate checks both parts. The alternate chart is hypothetical.

Open `/?example=cutoff` to ask which bus services reach a hypothetical 70% editorial cutoff. The caption gives the range and names the best and worst performers. Select Bus Service can still move below 70% while all three statements remain true. A sentence such as “Local reached at least 70%.” establishes a lower bound for Local. Adding “Only” makes the list complete and constrains every other category. Reader links keep the same cutoff and offer separate responses for “none” and “the caption doesn’t say.”

## Try a reader test

1. Reveal an ambiguous caption, add the verified detail, and create before and after links.
2. Give each reader just one link. They can answer on any device and copy a response code back to the editor.
3. Paste the codes in the original editor tab. The browser compares each answer with the source result and keeps the two caption versions separate. Download the counts when finished.

Each link contains its own caption, category names, question, and random invitation ID. The reader view does not receive the chart, the source answer, or the other caption. The test and imported responses survive a reload in the editor tab. Each reader tab generates an anonymous response ID so re-importing a code or updating an answer from that tab does not add another response. Counts are descriptive, and the links do not authenticate readers.

To load another chart, choose or paste a UTF-8 CSV with the header `category,percent` and two to seven data rows. The existing `service,percent` header also works.

## Recheck before publishing

In the 70% example, resolve the caption and choose **Try a simulated data refresh** to run the same saved check with the example’s updated CSV. If exactly one supported answer sentence goes stale, the browser shows that sentence and a verified replacement. **Replace sentence and recheck** changes the quoted sentence. **Save recheck file** exports the newly checked wording. **Restore original example data** switches back while keeping the caption in the editor so it can be checked again.

**Save recheck file** records the caption, question, category labels, and approved facts. To rerun it in the browser, load the newest CSV and open the file under **Rerun a saved check**. Paste the exact wording you plan to publish, or choose **Review saved caption** to inspect and restore the approved wording. You can run the loaded check again after editing or loading another CSV. Two Charts matches rows by category name, so reordering the CSV is safe. Changed caption text or category names need fresh review. The check file itself may include figures that were approved in the caption.

The same check can run offline in a publishing pipeline. The three inputs are the review file, the current chart data, and the caption from the publishing system.

```sh
npm run verify-caption -- examples/bus-cutoff/caption-recheck.json examples/bus-cutoff/current.csv examples/bus-cutoff/caption.txt
```

Try replacing `current.csv` with the simulated `refreshed.csv`. Select Bus Service drops below 70% while the range and named extrema stay the same. The command returns the exact stale excerpt. Exit code 0 means the approved facts still determine the answer, 1 requests editorial review, and 2 indicates invalid input. Call `node scripts/verify-caption.mjs … --json` for machine-readable output without an npm script banner.

## Firebase

The Firebase client is loaded on demand. Configure a Firebase web app with the Gemini Developer API and Firebase App Check. Put the web app’s public configuration and the reCAPTCHA Enterprise site key into `public/firebase.local.json` using the following keys.

```json
{
  "firebase": {
    "apiKey": "FIREBASE_WEB_API_KEY",
    "projectId": "FIREBASE_PROJECT_ID",
    "appId": "FIREBASE_WEB_APP_ID"
  },
  "appCheckSiteKey": "ENTERPRISE_SITE_KEY"
}
```

**Test with cloud Gemini** shows the exact text sent to the cloud, including the approved caption, question, and category names. Sending the specific request connects Firebase on demand. The browser checks the meaning of quotes it can parse and restores omitted facts when it can read the whole caption. Confirm the extracted facts before checking the alternate. **Ask Chrome Nano for the detail** uses Firebase in device-only mode. The browser independently verifies the returned category IDs against the source chart before using them in the revision.

**Cancel cloud review** returns control to the editor and local verifier immediately. Editing the caption or question also cancels the current review. A request that already reached Google may finish there. Review the current prompt before sending a new one.

Use **Suggest a question from a private note** to turn an editorial brief into a ranking or cutoff question. Firebase requests device-only inference. The app checks that the suggestion quotes the note and that any proposed cutoff appears in that quote. Only **Use this question** applies it. The cloud route starts App Check separately and receives the selected question, caption and category names after approval. It does not get the note or the original CSV.

Open **Chrome AI setup** while online. If Chrome needs the model, select **Prepare Chrome’s model**. The first download may take several minutes, and you can close the dialog while it runs. The browser verifier and reader links work during setup. Once setup reports the tab is ready for offline use, close the dialog and keep the tab open to try a private note or source-chart repair offline. The setup check loads the Firebase client and public configuration without sending a caption, note, or chart to a model. [Chrome built-in AI requirements](https://developer.chrome.com/docs/ai/get-started) · [Web setup in the official workshop](https://www.youtube.com/watch?v=lEsZMYkftiU&t=840s)

Local development on `127.0.0.1` supports the official App Check debug provider with `VITE_CHARTS_APP_CHECK_DEBUG_TOKEN` in a private `.env.development.local` file. Use an app-specific test token and revoke it when done. The production bundle requires a reCAPTCHA Enterprise site key. Keep debug credentials out of public assets and deployment archives.

## Current scope

Two to seven categories with percentage values and one question about a rank or a cutoff. The verifier supports ranges, individual values, extrema, and complete cutoff lists. It treats percentages as exact within the app’s two-decimal domain. Gemini’s interpretation of free-form text requires review. The browser checks the approved claims and selected question.

## License

The source code is released under [Apache 2.0](LICENSE). [NOTICE](NOTICE) identifies the source of the transit figures.
