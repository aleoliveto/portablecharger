# BIG BOARD FY27

Monthly Focus Initiatives tracker, hosted on Netlify with a password sign-in and its data in Netlify Blobs.

## How it fits together

| Path | What it is |
| --- | --- |
| `public/index.html` | The board page itself: network dashboard, base trackers, barriers, initiatives admin and exports. It started as the artifact export and loads `store.js` first. |
| `public/store.js` | Supplies the `claude.use("db")` / `claude.use("user")` interface the page expects (see the build guide, section 5). It talks to `/api/*`, shows the sign-in screen, and polls every 10 s for changes. |
| `public/admin.html` | Imports a `big-board-data-export-*.json` file into the store and lists the nightly backups. |
| `netlify/functions/api.mjs` | Handles sign-in and serves documents from Netlify Blobs, with version history and edit-conflict checks. |
| `netlify/functions/backup.mjs` | Scheduled nightly. Saves a full copy of the board to the `bigboard-backups` store and keeps 90 days. |
| `netlify/lib/data.mjs` | Storage helpers shared by both functions. |
| `public/vendor/xlsx-0.18.5.full.min.js` | SheetJS (Apache-2.0), loaded only when someone exports to Excel. |

Storage: each document is its own blob in the `bigboard` store, keyed `<collection>/<id>`. Updates are keyed `updates/<YYYY-MM>/<id>`, so opening a month reads only that month however much history builds up. Each write also changes a small revision blob, which lets open pages check one cheap endpoint and reload only the collections that changed.

## Deploy

1. In Netlify, choose **Add new site → Import an existing project** and pick this repository. The build settings come from `netlify.toml`, so there is nothing to fill in.
2. Under **Site configuration → Environment variables**, add:
   - `BOARD_PASSWORD`: the password that can read **and edit** (required).
   - `BOARD_VIEW_PASSWORD`: a password that can only read (optional).
   - `SESSION_SECRET`: a long random string used to sign sessions (recommended; generate one with `openssl rand -hex 32`). If it is not set, a key derived from the passwords is used, so changing a password signs everyone out.
3. Deploy, or redeploy if the site was built before the variables were set.
4. Open the site and sign in with your name and the edit password. Then open the menu with your name (top right), choose **Import and backups**, pick the data export JSON and click **Import**. Importing again later only overwrites documents with the same id.

Netlify Blobs is enabled automatically for sites that use it, so there is nothing to set up for it.

## Access

- Sign-in asks for a name and a password. The name is what the page shows as "saved by".
- With the edit password you can do everything. With the view password you can read everything, and the page disables every control.
- Sessions last 30 days and use an HttpOnly, Secure, SameSite=Strict cookie. After 10 failed attempts from one IP address, sign-in is locked for 15 minutes.
- The HTML contains no data. Every document is served by `/api/*`, which requires a session.

## Safety nets

- **History.** Before a document is overwritten or removed, the old version is kept under `_hist/`. Saves by the same person within 10 minutes count as one version, so autosaved notes don't pile up. On a base page, open an initiative and click **History** to see earlier versions of that month's update and restore one.
- **Edit conflicts.** The update window remembers which version it opened. If someone else saves in the meantime, saving shows their version and asks whether to save over it or keep theirs. Either way, the replaced version stays in History.
- **Autosave.** Board feedback and meeting notes save about a second after typing stops, and straight away when you change month or tab.
- **Nightly backups.** Kept for 90 days and listed under **Import and backups** in the account menu. To roll back, download one and import it.
- **Export data** in the account menu, or `/api/export`, downloads everything in the same JSON shape as the original export.

## Reporting

- **Month-on-month.** The headline strip and the base table compare against the previous month. "Slipped since…" lists initiatives whose status got worse. An arrow next to a status shows the direction of change.
- **KPI actuals.** The update window has an optional "KPI actual this month" field. Opening an initiative shows the values by month with a small trend line.
- **Status is required** when saving an update.
- **Barrier age.** Days open are shown for each barrier, oldest first, and turn red after 30 days.
- **Export** on the Network view offers an Excel workbook of the month (summary, updates, barriers, board feedback), a print-ready board pack (choose "Save as PDF" in the print dialog), or the summary as plain text.

## Local development

```sh
npm install
npx netlify-cli dev   # serves the site and the function, with a local Blobs sandbox
```

Set `BOARD_PASSWORD` in a `.env` file or in your shell first.
