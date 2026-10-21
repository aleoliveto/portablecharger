# BIG BOARD FY27

Monthly Focus Initiatives tracker, hosted on Netlify with a password sign-in and its data in Netlify Blobs.

## How it fits together

| Path | What it is |
| --- | --- |
| `public/index.html` | The board page itself. It is unchanged from the artifact export except that it loads `store.js` first. |
| `public/store.js` | Supplies the `claude.use("db")` / `claude.use("user")` interface the page expects (see the build guide, section 5). It talks to `/api/*`, shows the sign-in screen, and polls every 10 s for changes. |
| `public/admin.html` | Imports a `big-board-data-export-*.json` file into the store. |
| `netlify/functions/api.mjs` | Handles sign-in and serves documents from Netlify Blobs. |

Storage: each document is its own blob in the `bigboard` store, keyed `<collection>/<id>`. Updates are keyed `updates/<YYYY-MM>/<id>`, so opening a month reads only that month however much history builds up. Each write also changes a small revision blob, which lets open pages check one cheap endpoint and reload only the collections that changed.

## Deploy

1. In Netlify, choose **Add new site → Import an existing project** and pick this repository. The build settings come from `netlify.toml`, so there is nothing to fill in.
2. Under **Site configuration → Environment variables**, add:
   - `BOARD_PASSWORD`: the password that can read **and edit** (required).
   - `BOARD_VIEW_PASSWORD`: a password that can only read (optional).
   - `SESSION_SECRET`: a long random string used to sign sessions (recommended; generate one with `openssl rand -hex 32`). If it is not set, a key derived from the passwords is used, so changing a password signs everyone out.
3. Deploy, or redeploy if the site was built before the variables were set.
4. Open the site and sign in with your name and the edit password. Then use **Import** (bottom right), choose the data export JSON and click **Import**. Importing again later only overwrites documents with the same id.

Netlify Blobs is enabled automatically for sites that use it, so there is nothing to set up for it.

## Access

- Sign-in asks for a name and a password. The name is what the page shows as "saved by".
- With the edit password you can do everything. With the view password you can read everything, and the page disables every control.
- Sessions last 30 days and use an HttpOnly, Secure, SameSite=Strict cookie. After 10 failed attempts from one IP address, sign-in is locked for 15 minutes.
- The HTML contains no data. Every document is served by `/api/*`, which requires a session.

## Backups

**Export** (bottom right, or `/api/export`) downloads every document in the same JSON shape as the original export. Take one before each board meeting.

## Local development

```sh
npm install
npx netlify-cli dev   # serves the site and the function, with a local Blobs sandbox
```

Set `BOARD_PASSWORD` in a `.env` file or in your shell first.
