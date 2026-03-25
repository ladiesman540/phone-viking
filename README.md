# Phone Viking Dispatch Dashboard

This app is a dispatch dashboard plus Vapi/Twilio webhook server for the after-hours flow:

- intake creates a job
- Slack gets the summary
- techs get SMS + outbound voice calls
- escalation advances until someone accepts or the list is exhausted

## Run it

```bash
npm run dev
```

Open [http://localhost:3007](http://localhost:3007).

## Change History

- Ongoing implementation notes, audit fixes, and remaining work are tracked in [NOTES.md](/Users/Uzi/Appz/phone-viking/NOTES.md).

## Current stack

- `server.js`: dashboard API, webhook handlers, escalation engine, and local/Neon persistence
- `public/index.html`: dashboard layout
- `public/app.js`: dashboard behavior
- `public/styles.css`: dashboard styling
- `prompts/`: intake and dispatch voice-agent prompts

## Persistence

- If `DATABASE_URL` is set, config and jobs are stored in Neon.
- If `DATABASE_URL` is not set, config and jobs are stored locally in `data/config.json` and `data/jobs.json`.
- On startup, the app bootstraps the required Neon tables automatically.

## Required Production Env Vars

- `DATABASE_URL`
- `DASHBOARD_USERNAME`
- `DASHBOARD_PASSWORD`
- `CRON_SECRET`
- `VAPI_WEBHOOK_TOKEN`
- `TWILIO_AUTH_TOKEN`

Optional but typically needed:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_PHONE_NUMBER`
- `VAPI_API_KEY`
- `VAPI_DISPATCH_ASSISTANT_ID`
- `VAPI_PHONE_NUMBER_ID`
- `SLACK_WEBHOOK_URL` or `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID`

## Main endpoints

- `GET /api/config`
- `PUT /api/config`
- `GET /api/jobs`
- `POST /api/jobs`
- `POST /api/vapi/create-job`
- `POST /api/vapi/accept-job`
- `POST /api/vapi/report-response`
- `POST /api/vapi/report_response`
- `POST /api/vapi/call-ended`
- `POST /api/twilio/incoming-sms`
- `GET|POST /api/cron/process-escalations`

## Notes

- The current voice provider wiring is Vapi, not Millis.
- Sensitive config fields are masked in the dashboard response; blank saves preserve the stored values.
- The dashboard and dashboard APIs are protected with HTTP Basic auth when `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` are set.
- Vapi webhooks can be protected with `Authorization: Bearer <VAPI_WEBHOOK_TOKEN>`.
- Twilio inbound SMS requests are validated against the configured Twilio auth token.
- Vercel cron should call `GET /api/cron/process-escalations` with `Authorization: Bearer <CRON_SECRET>`.
- Local in-memory timers are used in dev. On Vercel, `vercel.json` schedules `GET /api/cron/process-escalations` every minute as the durable escalation trigger.
- If a tech has multiple open jobs, SMS replies must include the job id, for example: `YES job_alpha`.
