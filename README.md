# Two Charts, One Caption

Check whether a chart description answers the question a reader needs to ask. The browser finds an alternative that changes the answer while preserving the checked facts and changing as few categories as possible. The revised description and an HTML data table can be downloaded once the selected answer is explicit.

[Try the 70% bus cutoff](https://two-charts-caption-2026.web.app/?example=cutoff) · [Compare food insecurity with the national rate](https://two-charts-caption-2026.web.app/?example=food-national)

## Run locally

Use Node.js 24.

```sh
npm ci
npm test
npm run dev
```

The bus example uses the median on-time rates in [Table 3 of the NYC Comptroller’s bus report](https://comptroller.nyc.gov/reports/life-in-the-slow-lane/). Try answering from the description alone, then inspect both charts and the exact facts they satisfy. The local text parser can check wording such as “Rates ranged from 10% to 40%.”, exact values such as “North had a rate of 40%.”, and the ranking and cutoff sentences suggested by the app. A ranking sentence with an exact rate checks both parts. The alternate chart is hypothetical.

Open `/?example=cutoff` to ask which bus services reach a hypothetical 70% editorial cutoff. The caption gives the range and names the best and worst performers. Select Bus Service can still move below 70% while all three statements remain true. A sentence such as “Local reached at least 70%.” establishes a lower bound for Local. Adding “Only” makes the list complete and constrains every other category. Reader links keep the same cutoff and offer separate responses for “none” and “the caption doesn’t say.”

Open `/?example=food` to ask which regions had the highest reported household food insecurity rate in 2024. South leads in the published estimates. In the hypothetical chart, raising Midwest from 13.3% to 15% creates a tie while keeping the caption’s range and named lowest region true. [USDA Economic Research Service report, Table 2](https://ers.usda.gov/sites/default/files/_laserfiche/publications/113623/ERR-358.pdf?v=71497)

Open `/?example=food-national` to ask which regional estimates fell below the national estimate of 13.7%. Northeast, Midwest, and West do in the published data. In the hypothetical chart, Midwest moves from 13.3% to 13.7%, so it drops out of the answer while the caption’s range and lowest region still hold. **Below** excludes an exact match. **At or above** includes it. [USDA national and regional estimates](https://www.ers.usda.gov/media/9161/err-358.pdf?v=35619)

Open [the Midwest and West comparison](https://two-charts-caption-2026.web.app/?example=food-pair) to test two categories directly. Midwest’s reported estimate is 13.3%, compared with West’s 12.9%. A hypothetical tie keeps the stated range and lowest region intact. Adding “Midwest had a higher rate than West.” resolves this question without publishing either figure. In the reader view, select both categories for a tie. [USDA regional estimates, Table 2](https://www.ers.usda.gov/media/9161/err-358.pdf?v=35619)

## Share the comparison

After revealing a gap, choose **Download proof with chart data**. The HTML file opens offline with both answers, the exact percentages, the checked caption facts, and a suggested sentence. Share it with an editor who can see the source data, or use a reader link for a caption-only test.

## Try a reader test

1. Reveal an ambiguous caption, add the verified detail, and create before and after links.
2. Give each reader just one link. They can answer on any device and copy a response code back to the editor.
3. Paste the codes in the original editor tab. The browser compares each answer with the source result and keeps the two caption versions separate. Download the counts when finished.

To use your own revision, choose **Test my own rewrite** after a chart check. The dialog keeps the checked caption beside your draft. **Check rewrite** runs the same local sentence checks as the editor and shows whether an alternate answer is still possible. **Use checked rewrite** applies a verified revision and prepares the original and rewritten captions for a reader test.

For freer wording, choose **Review with Gemini** in the rewrite dialog. Review and approve the outgoing rewrite, question, and category names. After Gemini responds, confirm the extracted facts before the browser checks the rewrite. The original caption stays in the editor until you apply the checked rewrite.

Each link contains its own caption, category names, question, and random invitation ID. The reader view does not receive the chart, the source answer, or the other caption. The test and imported responses survive a reload in the editor tab. Each reader tab generates an anonymous response ID so re-importing a code or updating an answer from that tab does not add another response. Counts are descriptive, and the links do not authenticate readers.

Select **Save reader test** to continue later or on another browser. Under **Open a saved reader test**, choose the JSON file and review both captions before opening it. The original links and their collected responses carry over. Keep the JSON with the editor because it includes both captions, the answer, and individual selections. **Download results** gives a text summary for sharing.

To load another chart, choose or paste a UTF-8 CSV with a header and two to seven data rows. The two-column formats `category,percent` and `service,percent` load directly. For other layouts, choose a category column and a percentage column. Only the chosen columns enter the chart check. Use percentages such as `71.5` or `71.5%`, with up to two decimal places.

Open **Save or open an editorial draft** to keep the loaded chart, wording, question, and any currently reviewed facts in one file. Reopen it in another browser or in a saved offline copy of Two Charts. The editor shows a preview and runs any saved review against the restored chart. The draft contains the selected chart values. Unused spreadsheet columns, private editor notes, and reader responses stay out of the file.

## Recheck before publishing

After a successful check, choose **Copy for publishing**. Copy the caption into a CMS text field, select **Formatted caption and table** for an editor that accepts rich paste, or select **HTML with data table** for an HTML block. The table uses the selected CSV headings when available. The preview, HTML source, and standalone download use the same figure and carry its source attribution. [W3C guidance on descriptions for charts and other complex images](https://www.w3.org/WAI/tutorials/images/complex/)

In the 70% example, resolve the caption and choose **Try a simulated data refresh** to run the same saved check with the example’s updated CSV. If exactly one supported answer sentence goes stale, the browser shows that sentence and a verified replacement. **Replace sentence and recheck** changes the quoted sentence. **Save recheck file** exports the newly checked wording. **Restore original example data** switches back while keeping the caption in the editor so it can be checked again.

**Save recheck file** records the caption, question, category labels, and approved facts. To rerun it in the browser, load the newest CSV and open the file under **Rerun a saved check**. Paste the exact wording you plan to publish, or choose **Review saved caption** to inspect and restore the approved wording. You can run the loaded check again after editing or loading another CSV. Two Charts matches rows by category name, so reordering the CSV is safe. Changed caption text or category names need fresh review. The check file itself may include figures that were approved in the caption.

The same check can run offline in a publishing pipeline. The three inputs are the review file, the current chart data, and the caption from the publishing system.

```sh
npm run verify-caption -- examples/bus-cutoff/caption-recheck.json examples/bus-cutoff/current.csv examples/bus-cutoff/caption.txt
```

Try replacing `current.csv` with the simulated `refreshed.csv`. Select Bus Service drops below 70% while the range and named extrema stay the same. The command returns the exact stale excerpt. Exit code 0 means the approved facts still determine the answer, 1 requests editorial review, and 2 indicates invalid input. Call `node scripts/verify-caption.mjs … --json` for machine-readable output without an npm script banner.

When the selected facts resolve the question, the browser still shows wording it could not match to a complete checked fact. The proof and publishing dialog display those excerpts locally. The CLI reports their count. Add `--require-checked-wording` to request editorial review when any such wording remains.

New recheck files remember the selected CSV headers when both headings are unique and nonempty. The browser shows the columns in use and requires the saved pair for that recheck. Place the columns anywhere in the next export. The CLI selects them by exact name automatically. For older files and files saved without unique headings, pass the exact, case-sensitive names you selected in the browser.

```sh
npm run verify-caption -- check.json latest.csv caption.txt --category-column "Bus service" --percent-column "On-time rate"
```

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

**Test with cloud Gemini** shows the exact text sent to the cloud, including the approved caption, question, and category names. Sending the specific request connects Firebase on demand. The browser checks the meaning of quotes it can parse and restores omitted standalone facts, including in captions that mix prose with exact claims. Confirm the extracted facts before checking the alternate. **Ask Chrome Nano for the detail** uses Firebase in device-only mode. The browser independently verifies the returned category IDs against the source chart before using them in the revision.

The review shows each fact beside its quotation and whether it matches the source data. Open **Excluded facts** to inspect why a proposed fact was dropped. A malformed item is excluded individually so you can still review the rest of the draft and the facts the browser recovered.

**Cancel cloud review** returns control to the editor and local verifier immediately. Editing the caption or question also cancels the current review. A request that already reached Google may finish there. Review the current prompt before sending a new one.

If App Check rejects the session or the cloud request fails, the editor moves focus to the browser check for the current caption or rewrite. The draft stays in the editor for that check.

After Firebase returns an AI response, open **AI activity in this tab** to see its inference route and the kinds of inputs used. The downloadable JSON records the action, route, input categories, response count, and last response time. Chrome manages the installed model version separately.

The hosted test used Chrome 157.0.8103.79 with Prompt API v4 and the `gemma4-2b-it` asset (component version `2026.8.7.929`). Firebase reported on-device inference. The exact Gemini Nano 4 designation for the Web track is awaiting organizer confirmation. [Firebase Web setup](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started) · [Web track rules](https://firebasehybridaihackathon.devpost.com/rules)

Use **Suggest a question from a private note** to turn an editorial brief into a ranking, cutoff, or two-category comparison. Firebase reads the note and category names on-device. The app checks the quoted cutoff and resolves comparison names directly from the note. If Chrome paraphrases a cutoff or comparison, the app can recover the exact wording when one sentence supports the suggestion. On the Midwest–West example, **Load an example note** provides a comparison to try. Only **Use this question** applies it. The cloud route starts App Check separately and receives the selected question, caption and category names after approval. It does not get the note or the original CSV.

While Chrome is drafting a question or a caption detail, **Stop waiting for Chrome** returns control to the editor. The browser check and manual question controls are available immediately. Replies from an earlier request are ignored.

Open **Chrome AI setup** while online. If Chrome needs the model, select **Prepare Chrome’s model**. The first download may take several minutes, and you can close the dialog while it runs. The browser verifier and reader links work during setup. Once setup reports the tab is ready for offline use, close the dialog and keep the tab open to try a private note or source-chart repair offline. The setup check loads the Firebase client and public configuration without sending a caption, note, or chart to a model. [Chrome built-in AI requirements](https://developer.chrome.com/docs/ai/get-started) · [Web setup in the official workshop](https://www.youtube.com/watch?v=lEsZMYkftiU&t=840s)

In the hosted app, select **Save app for offline use** from the same setup dialog and wait for **Offline copy saved**. Then you can close the tab and reopen the app offline on that browser. If Chrome’s model is installed and available, the app can also load the Firebase on-device route in the reopened tab. The offline copy contains the public app files and Firebase web configuration. Export a recheck file to keep reviewed work between tabs. Cloud review needs a connection.

After an update, the save checks that the downloaded files match the release on screen. If setup asks you to close all Two Charts tabs, save your work and close those tabs so the new offline copy can take over. A failed download keeps the previously installed copy available.

Local development on `127.0.0.1` supports the official App Check debug provider with `VITE_CHARTS_APP_CHECK_DEBUG_TOKEN` in a private `.env.development.local` file. Use an app-specific test token and revoke it when done. The production bundle requires a reCAPTCHA Enterprise site key. Keep debug credentials out of public assets and deployment archives.

## Current scope

Two to seven categories with percentage values and one question about rank, a cutoff, or the order of two named categories. The verifier supports ranges, individual values, extrema, cutoff lists, and pair comparisons. It treats percentages as exact within the app’s two-decimal domain. Gemini’s interpretation of free-form text requires review. The browser checks the approved claims and selected question.

## License

The source code is released under [Apache 2.0](LICENSE). [NOTICE](NOTICE) identifies the sources of the example data.
