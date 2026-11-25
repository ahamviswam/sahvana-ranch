# Sahvana Ranch

Booking tracker for Sahvana Ranch (752 JC Maples Rd, Gunter, TX): house stays, event hall days, tours, payments, refundable deposits, signed contracts and Airbnb calendar sync.

- **One shared password** protects the whole app.
- **Postgres** stores everything, including contract PDFs.
- **Airbnb sync:** paste the listing's Airbnb calendar link on the Properties page and Airbnb dates show up (in coral) and refresh every hour. Dates already covered by your own bookings are skipped.
- **Backups:** Properties → *Download backup* saves everything (records and PDFs) as one JSON file. *Restore from backup* loads one back in.
- Works on phones: add it to the home screen and it opens full screen like an app.

## Deploy on Railway

1. **Create the project.** In Railway, choose **New Project → Deploy from GitHub repo** and pick this repository.
2. **Add the database.** In the same project, click **+ New → Database → PostgreSQL**.
3. **Set the variables** on the app service (not the database), under **Variables**:
   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a reference to the database you just added) |
   | `APP_PASSWORD` | the password you both will use to sign in. Make it long. |
   | `SESSION_SECRET` | optional: any long random text. Changing it, or the password, signs everyone out. |
4. **Get a web address.** App service → **Settings → Networking → Generate Domain**. You can add your own domain (e.g. `app.sahvanaranch.com`) there later.
5. Railway builds and starts it with `npm start`. The health check is `/healthz`.

### Move your existing data in

1. Open the new web address and sign in with `APP_PASSWORD`.
2. Go to **Properties** (on a phone: **More → Properties & prices**), tap **Restore from backup**, and pick `sahvana-backup-2026-11-24.json`.
3. Check the calendar and a couple of bookings, then you're done. Restoring twice is safe; it just overwrites the same records.

The backup file contains guest names, phone numbers and contracts. It is **not** in this repository (see `.gitignore`); keep it somewhere private.

### Turn on Airbnb sync

In Airbnb: **Calendar → Availability → Connect calendars → Export calendar**, copy the link. In the app, open the property on the **Properties** page, paste it into **Airbnb calendar link**, and tap **Save** (or **Sync now**).

### Add it to your phone

Open the web address in Safari (iPhone) or Chrome (Android), sign in, then **Share → Add to Home Screen**. Sign-in lasts 180 days per device.

## Run locally

```bash
cp .env.example .env   # set APP_PASSWORD and DATABASE_URL
npm install
node --env-file=.env server.js
```

## How it's built

- `server.js`: Express server: login, `/api/data`, `/api/docs/:collection/:id`, `/api/files`, `/files/:id`, `/api/backup`, `/api/restore`, `/api/ical/sync`.
- `public/index.html`: the whole app (no build step).
- `public/login.html`, `manifest.webmanifest`, icons.
- Tables `docs (collection, id, data jsonb)` and `files (id, name, content_type, data bytea)` are created automatically on start.

## Changing things

Edit the code, commit and push to GitHub; Railway redeploys automatically in a minute or two.
