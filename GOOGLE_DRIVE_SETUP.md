# Connecting Google Drive

One Google account holds every patient document. This is a **one-time** setup:
the account is connected once by an admin, the tokens are stored in the
`drive_tokens` table, and every doctor's upload from either app goes through
that one account. Doctors never sign in to Google themselves.

---

## Why it is not just "click sign in"

Two Google rules shape all of this, and both bite here:

1. **Redirect URIs must be `https://…` or `http://localhost`.**
   A plain-HTTP IP address like `http://148.113.6.25:4000` **cannot** be
   registered. So the callback can never land on the server directly unless
   the server gets a domain and a certificate.

2. **`https://www.googleapis.com/auth/drive` is a *restricted* scope.**
   The app needs it to see the folders the clinic *already has* (see
   [Appendix B](#appendix-b--the-narrower-scope-option) if you would rather
   avoid it). Restricted scopes interact with the app's *publishing status*,
   and getting that wrong is what makes a connection silently die a week
   later.

Step 3 works around rule 1 without a domain. Step 2 avoids rule 2's trap.

---

## Step 1 — Create the OAuth credentials

Everything happens in the [Google Cloud Console](https://console.cloud.google.com/),
signed in as **the one Drive account you have finalised**. Sign in as that
account and no other — whichever account you use here is the Drive that ends
up holding every patient's documents.

> Google renamed these screens in 2025. What used to be *APIs & Services →
> OAuth consent screen* and *→ Credentials* is now **Google Auth Platform**,
> split into **Branding**, **Audience**, **Data access** and **Clients**. Both
> names are given below; the old URLs redirect to the new pages.

### 1.1  Create a project

Top-left project dropdown → **New project** → name it e.g. *Treatment Record*
→ **Create**. Wait for it to become the selected project (the name shows in
the top bar).

A project is just a container. One project for this app is right; do not reuse
an unrelated one.

### 1.2  Enable the Drive API

**APIs & Services → Library** → search **Google Drive API** → open it →
**Enable**.

Skip this and every call fails later with *"Google Drive API has not been used
in project … before or it is disabled"*.

### 1.3  Configure the consent screen

**APIs & Services → OAuth consent screen** (new UI: **Google Auth Platform →
Get started**). Fill in:

- **App name** — what you will see on the consent screen, e.g. *Treatment
  Record*.
- **User support email** — pick your own address from the dropdown.
- **Audience**:
  - **Internal** — available only if this is a **Google Workspace** account.
    Choose it if you can: no verification, no warning screen, and nothing
    expires. You can then skip Step 2 entirely.
  - **External** — the only choice for a personal `@gmail.com`. Continue, and
    do not skip Step 2.
- **Contact information** — your email again.
- Agree to the policy → **Create**.

### 1.4  Add the Drive scope

**Data access** (old UI: *OAuth consent screen → Scopes*) → **Add or remove
scopes**. Either filter the list for *Google Drive API* and tick the row whose
scope is exactly `.../auth/drive`, or use **Manually add scopes** and paste:

```
https://www.googleapis.com/auth/drive
```

Then **Update** → **Save**. It will be listed under *Restricted* — that is
expected, and Step 2 explains what it means for you.

### 1.5  Add yourself as a test user  *(External only)*

**Audience** → **Test users** → **Add users** → your own Google address →
**Save**. Without this, sign-in is refused outright with *"App has not
completed the Google verification process"*.

### 1.6  Create the OAuth client

**Clients** (old UI: *APIs & Services → Credentials*) → **Create client**
(old: *Create credentials → OAuth client ID*):

- **Application type: Web application** — not Desktop, not Android. Desktop
  clients cannot use the paste-the-URL flow in Step 4.
- **Name** — anything, e.g. *Treatment Record backend*.
- **Authorised redirect URIs → Add URI**, exactly this, with no trailing
  slash:
  ```
  http://148.113.6.25:4000/api/drive/callback
  ```
  Leave *Authorised JavaScript origins* empty — the browser never calls
  Google directly, the backend does.
- **Create**.

### 1.7  Copy the two values

A dialog shows them once:

- **Client ID** — looks like `1234567890-a1b2c3….apps.googleusercontent.com`
- **Client secret** — looks like `GOCSPX-…`

Copy both now. If you lose the secret, open the client again under **Clients**
and either reveal it or press **Add secret**; you do not have to start over.

Treat the secret like a password: it belongs in `backend/.env` on the server
and nowhere else — not in the Flutter apps, not in git.

---

## Step 2 — Publish the app (External / personal Gmail only)

**Skip this if you chose *Internal*.**

On the **OAuth consent screen** page, press **PUBLISH APP** and confirm.

This matters more than it looks. While the app sits in **Testing** status,
Google expires the refresh token after **7 days** — Drive would disconnect
itself every week and every upload would start failing until someone
reconnected. Publishing stops that.

You will *not* pass verification (that needs a public domain, a privacy
policy and a review), and you do not need to. An unverified published app
still works; it simply shows a warning screen the first time you sign in:

> **Google hasn't verified this app**
> → click **Advanced** → **Go to *App name* (unsafe)**

That is your own app, signing in to your own Drive, once.

---

## Step 3 — Put the credentials in `backend/.env`

Edit `backend/.env` — these three keys already exist and are currently blank:

```env
GOOGLE_CLIENT_ID=<the client ID from step 1>
GOOGLE_CLIENT_SECRET=<the client secret from step 1>
GOOGLE_REDIRECT_URI=http://148.113.6.25:4000/api/drive/callback
```

`GOOGLE_REDIRECT_URI` must match the URI you registered **character for
character**. Leave `DRIVE_ROOT_FOLDER_ID` blank — the base folder is chosen
in the app now (Admin → Google Drive → **Choose…**).

Then restart the backend so it picks up the new values:

```bash
# whichever you use
npm start
# or
npm run pm2:stop && npm run pm2:start
```

Until this restart the app will keep saying *"Setup needed: run the backend
with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET"* — that message is only ever
about these env vars.

---

## Step 4 — Connect, using the paste fallback

Open **Admin → Google Drive** in either app.

1. Press **Sign in with Google**. A browser tab opens.
2. Choose your account, click through the unverified-app warning if it
   appears (Advanced → Go to … (unsafe)), and **Allow**.
3. The browser now tries to reach `http://148.113.6.25:4000/…` and shows
   **"This site can't be reached"**. **This is expected** — that address is
   your own computer, and the server is elsewhere. Do not close the tab.
4. **Copy the entire address** from the browser's address bar. It looks like:
   ```
   http://148.113.6.25:4000/api/drive/callback?code=4/0AVMBsJ...&scope=https://www.googleapis.com/auth/drive
   ```
5. Back in the app, click **"Sign-in page didn't come back? Finish it
   manually"**, paste that address, press **Connect**.

The panel switches to **connected** and shows the account's email.

> The code is single-use and expires in a few minutes. If you get *"That code
> was already used or has expired"*, just press **Sign in with Google** again
> and paste the fresh URL.

If your backend does happen to run on `localhost:4000` on the same machine as
the browser, step 3 completes by itself and you can ignore steps 4–5.

---

## Step 5 — Choose the folder

Still in **Admin → Google Drive**, under **Document folder layout**:

- **Base folder → Choose…** — browse your real Drive and pick the folder your
  clinic already uses. Search by name, or create a new one from the picker.
- **Patient folder name** — default `{code} - {name}`; the chips insert
  `{code} {name} {year} {month} {date}`.
- **Create the folder when a patient is added** — on by default, so a new
  patient's folder exists in Drive immediately.
- **Group by type** — a sub-folder per X-Ray / Scan / Report, or all together.
- **Group by date** — a folder per month, or one common folder.

The grey box shows exactly where a sample X-ray would land. It is a dry run —
nothing is created in Drive until you press **Save layout**.

---

## Verifying it works

1. Admin → Google Drive shows **connected** with the right email.
2. Create a test patient → the folder appears in Drive within a few seconds.
3. Open that patient → **Documents** → upload a file. The tile should show a
   green **Drive** badge, and hovering it names the folder the file went to.
4. If the tile says **Local only**, the file is safe on the server and the
   badge's tooltip carries Google's exact reason. Fix it, then press the
   retry icon on the tile — nothing is lost.

---

## Appendix A — Doing it properly later

The paste step exists only because the server has no HTTPS. Once it has a
domain and a certificate (Caddy or nginx + Let's Encrypt):

1. Add `https://your-domain/api/drive/callback` to the authorised redirect
   URIs in the Cloud Console.
2. Set `GOOGLE_REDIRECT_URI` to it in `.env`, restart.

Sign-in then completes by itself and the paste box is never needed. The
existing connection keeps working; nothing has to be redone.

---

## Appendix B — The narrower scope option

`auth/drive` is what lets the folder picker see folders the app did not
create. If you would rather not deal with the restricted-scope rules at all,
the app can run on `https://www.googleapis.com/auth/drive.file` instead —
change `SCOPES` in `backend/utils/drive.js`.

| | `auth/drive` (current) | `auth/drive.file` |
|---|---|---|
| Pick an **existing** clinic folder | yes | **no** — only folders the app made |
| Auto-created patient folders | yes | yes |
| Uploads, links, WhatsApp sharing | yes | yes |
| Unverified-app warning | yes, once | no |
| 7-day token expiry in Testing status | yes | yes |

Everything except picking a pre-existing folder works identically. If your
Drive has no structure you need to slot into, the narrow scope is the quieter
choice — tell me and I will switch it and re-issue both builds.
