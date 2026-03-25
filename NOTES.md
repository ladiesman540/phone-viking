# Project Notes

## 2026-03-24: Audit + hardening pass

### Current product shape

- This project is a Vapi/Twilio/Slack dispatch dashboard deployed on Vercel with Neon as the primary persistence layer.
- Millis is no longer the target provider in this codebase.

### Changes completed

- Fixed local persistence so config and jobs save to `data/config.json` and `data/jobs.json` when `DATABASE_URL` is not set.
- Added request body size limits and clean `400`/`413` errors for bad or oversized payloads.
- Fixed routing rule matching so blank `locationArea` does not accidentally match area-restricted rules.
- Fixed target selection so jobs keep using their originally matched rule instead of drifting on re-evaluation.
- Fixed config sanitization so advanced contact/routing fields are preserved instead of being dropped on dashboard saves.
- Masked secrets in `GET /api/config` and preserved existing secret values on blank saves.
- Removed dangerous fuzzy / fallback matching in Vapi accept flow so accepts do not attach to the wrong job.
- Fixed dashboard XSS risk by removing unsafe `innerHTML` rendering for job data.
- Corrected repo/docs/UI language to reflect Vapi instead of Millis.
- Added durable serverless escalation support via `/api/cron/process-escalations`.
- Added Neon schema bootstrap for `pv_config`, `pv_jobs`, and runtime lock state.
- Added dashboard HTTP Basic auth support using `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`.
- Changed Vercel routing so the dashboard and static assets go through `server.js`, which means auth actually applies in production.
- Added Vapi webhook bearer-token verification using `VAPI_WEBHOOK_TOKEN`.
- Added alias support for `/api/vapi/report-response` and `/api/vapi/report_response` so prompt/tool-name drift does not break dispatch.
- Added Twilio webhook signature verification for inbound SMS.
- Fixed SMS reply resolution so a tech with multiple active jobs must specify a job id.
- Removed duplicate confirmation messaging on inbound SMS accept flow.
- Added cron auth via `CRON_SECRET`.
- Added DB-backed cron lease locking so overlapping Vercel cron executions do not race each other.
- Wrapped Slack, Twilio, and Vapi outbound network calls so provider failures degrade into logged failures instead of breaking state transitions.
- Added regression tests for secret masking, rule matching, preserved advanced config, SMS job resolution, Twilio signature validation, and auth path classification.

### Files changed during the hardening work

- `server.js`
- `public/app.js`
- `public/index.html`
- `README.md`
- `vercel.json`
- `package.json`
- `test/server.test.js`

### What still needs to happen

1. Set the production env vars in Vercel:
   - `DATABASE_URL`
   - `DASHBOARD_USERNAME`
   - `DASHBOARD_PASSWORD`
   - `CRON_SECRET`
   - `VAPI_WEBHOOK_TOKEN`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER`
   - `VAPI_API_KEY`
   - `VAPI_DISPATCH_ASSISTANT_ID`
   - `VAPI_PHONE_NUMBER_ID`
   - Slack credentials if Slack notifications are required
2. Update the Vapi server/tool webhook config to send `Authorization: Bearer <VAPI_WEBHOOK_TOKEN>`.
3. Redeploy on Vercel so the new route and cron config take effect.
4. Run a live smoke test:
   - dashboard login
   - config save/load
   - Vapi create-job webhook
   - Vapi accept/decline webhook
   - Twilio inbound SMS reply handling
   - cron-driven escalation
5. Confirm the Vercel plan supports the configured 1-minute cron schedule. If not, lower the frequency or use an external scheduler.
6. Decide whether the dashboard should keep simple Basic auth or move to proper user/session auth later.

### Known remaining risks

- The app still relies on environment-variable discipline. If auth tokens are missing, those protections are effectively disabled.
- There is still no full user account system for the dashboard; current protection is HTTP Basic auth.
- Live provider behavior has not been fully exercised from this repo after the hardening pass because deployment/webhook smoke tests still need to be run against Vercel/Twilio/Vapi.
