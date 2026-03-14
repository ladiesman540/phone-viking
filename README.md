# Phone Viking Dispatch Dashboard

This folder now contains a self-contained dashboard and local API server for:

- configuring intake fields
- managing tech and partner contact tiers
- defining routing combinations and escalation rules
- previewing dispatch batches
- exposing Millis-compatible function endpoints

## Run it

```bash
npm run dev
```

Open [http://localhost:3007](http://localhost:3007).

## Main files

- `server.js`: static server, JSON APIs, and Millis function endpoints
- `public/index.html`: dashboard shell
- `public/app.js`: dashboard interactions
- `public/styles.css`: dashboard styles
- `data/config.json`: saved configuration
- `data/jobs.json`: created jobs and attempt history

## Millis function endpoints

The dashboard exposes these endpoints:

- `POST /api/millis/create-job`
- `POST /api/millis/get-next-targets`
- `POST /api/millis/log-attempt`
- `POST /api/millis/accept-job`
- `POST /api/millis/decline-job`
- `GET /api/millis/function-definitions`

Use `GET /api/millis/function-definitions` to see the current URLs and parameter schemas.

## Notes

- Slack posting is live if you enable it and provide an incoming webhook URL.
- SMS sending and Millis outbound-call triggering are not wired to Twilio/Millis yet; this app currently stores the rules, renders the messages, and returns the next contacts for your orchestration layer or the next build step.
- Data is stored locally in JSON files so you can edit and test combinations immediately.
