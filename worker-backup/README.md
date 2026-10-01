# dscm-backup - nightly SharePoint backup

A separate Cloudflare Worker that copies DSCM production data to a SharePoint
site every day at 10:00 UTC:

- **Database** (D1 `dscm-db`): a full dump of every table, schema + rows.
- **Files** (R2 `dscm-files`): incremental - each file version is uploaded
  once; changed files are saved as new copies, never over the old one.

It reads the same D1 database and R2 bucket as the `roberto` app worker but
never writes to them, and it holds the SharePoint credentials so `roberto`
doesn't have to. It is **not** deployed by `deploy-backend.yml` (that only
watches `worker/`); deploy it with `npx wrangler deploy` from this folder.

## What lands in SharePoint

Inside the backup site's default document library, under `BACKUP_FOLDER`
(`DSCM-Backups`):

```
DSCM-Backups/
  d1/dscm-db-YYYY-MM-DD.json            full database dump, one per day
  r2/manifests/r2-manifest-YYYY-MM-DD.json
                                        every file that existed that day:
                                        original R2 key, size, etag, and
                                        backupPath (relative to r2/objects/)
  r2/objects/...                        the backed-up files, mirroring R2 keys
                                        (characters SharePoint rejects become
                                        "_"; a changed file's newer copy gets
                                        "~YYYY-MM-DD-<etag>" before its extension)
  state/r2-index.json                   what's already uploaded (lets each run
                                        upload only what's new)
  state/run-log.json                    last 120 runs: status, sizes, errors
  state/run.lock                        exists only while a run is in progress
```

A day's file set = that day's manifest. Each entry's `backupPath` is where
its content is, and `key` is where it belongs in R2. The manifest is
authoritative - never rely on the `objects/` folder names alone.

## Retention

After each **complete** run: keep the newest 14 dumps/manifests, plus the
newest one from each of the last 8 ISO weeks and each of the last 12 months.
A backed-up file is deleted only when no kept manifest references it and it
is no longer in R2 - so a file deleted from R2 by mistake stays recoverable
for up to a year. Nothing is pruned after a failed or incomplete run.

If a Microsoft Purview retention **policy** covers the site, pruned files are
kept in its Preservation Hold library for the policy period. Don't use a
retention **label** that declares items as records - those can't be deleted,
and pruning would fail every night.

## Alerts

Emails go through Resend to `ALERT_EMAIL`:
- **FAILED** - any error; says which step and why. The next scheduled run retries.
- **incomplete** - a run hit its per-run limit (subrequests/time) before
  uploading every file; the next run continues where it stopped.
- **Weekly summary** every Monday - if these stop arriving, the scheduled job
  itself has stopped.

The most likely cause of a failure email over time is the **Graph client
secret expiring** (the error will say so). Create a new secret in Entra and
run `npx wrangler secret put GRAPH_CLIENT_SECRET` here.

## Setup

1. Entra app registration with the Microsoft Graph **application** permission
   `Sites.Selected` (admin-consented), and a `write` grant on the one backup
   site (`POST /sites/{site-id}/permissions`).
2. From this folder, set the secrets (each command prompts for the value):
   ```
   npx wrangler secret put GRAPH_TENANT_ID
   npx wrangler secret put GRAPH_CLIENT_ID
   npx wrangler secret put GRAPH_CLIENT_SECRET
   npx wrangler secret put GRAPH_SITE_ID
   npx wrangler secret put ALERT_EMAIL
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put BACKUP_TRIGGER_TOKEN
   ```
   The worker must exist before secrets can be set - deploy once first
   (`npx wrangler deploy`); until the secrets are in, a scheduled run just
   fails with a "Missing Worker secret" alert (or no email, if the Resend
   secrets are the missing ones).
3. First full upload (~368 MB): trigger manual runs until one reports
   `"status": "ok"`:
   ```
   curl -X POST https://dscm-backup.dessimate.workers.dev/run -H "Authorization: Bearer <BACKUP_TRIGGER_TOKEN>"
   ```
   Add `?summary=1` to also send the summary email (handy for testing Resend).
   The response streams a "running... Ns" line every 10 seconds, then the
   run's result as JSON. A run keeps going on Cloudflare even if the caller
   disconnects.

Check recent runs without SharePoint access (same token):
```
curl https://dscm-backup.dessimate.workers.dev/status?n=5 -H "Authorization: Bearer <BACKUP_TRIGGER_TOKEN>"
```

Only one run can be active at a time: each run creates `state/run.lock`
(create-only, so a second run sees it and stops with status `skipped`) and
deletes it when done. A lock older than 20 minutes is treated as left over
from a run that died, and the next run takes it over. A skipped scheduled
run sends a "skipped" email.

## Limits

Each run stops starting new uploads at 900 outbound calls or 12 minutes,
keeping a reserve to save progress and send email. Normal nightly runs use a
few dozen calls; only the first full upload needs more than one run.

## Tests

`npm test` (Node 20+) runs unit tests plus a simulation of the whole job
against in-memory fakes of D1, R2, SharePoint and Resend, including a 400-day
retention run.
