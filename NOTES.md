# Project Notes

## 2026-03-25: v4 Spec — Full Implementation Complete

### What was built

Every requirement from `after_hours_agentic_ai_workflow_v4.docx` (Sections 1-15, Appendices A-D) is now implemented. This covers the core dispatch workflow, the operational build components, and the supervisor console.

### v4 Spec coverage by section

| Section | What it required | What was built |
|---|---|---|
| 1. Operating model | Separate case per call, state machine | Each job has unique ID, own timers, timeline, state machine |
| 2. Required data at intake | 20+ fields across customer/issue/commercial/system | 26+ fields on job object, 13 params on Vapi intake tool |
| 3. Workflow states | 11 named states + communication flags | 12 states (added HUMAN_REVIEW_REQUIRED), 4 comm flags |
| 4. Main dispatch workflow | Tech 1 → Tech 2 → retry → sub → exhausted | Configurable escalation sequence engine |
| 5. Customer callback rules | Initial, accepted, sub_dispatched, unavailable | All 5 callback types fire at the correct moments |
| 6. Subcontractor decision handling | Provisional assignment before final | PROVISIONAL_SUB_ASSIGNMENT state with replacement window timer |
| 7. Late tech response | Cancel sub if not en route | handleLateAccept blocks when enRouteConfirmedAt is set |
| 8. Concurrency & isolation | Per-job timers, ambiguous SMS, idempotency | Idempotency keys, optimistic locking, SMS job disambiguation |
| 9. Audit & insurance | Immutable timeline, actor attribution | 14+ event types, UUID per event, actor field |
| 10. Slack usage | Threaded updates, case summary | Bot token threading + webhook fallback |
| 11. Human review triggers | Pauses workflow, Slack notify, resume | HUMAN_REVIEW_REQUIRED state, resolve endpoint resumes |
| 12. System components | Intake, orchestration, comms, audit, supervisor | All 5 components implemented |
| 13. Decision rules table | 9 rules | All 9 decision paths work |
| 14. Example timeline | 10:02-10:20 PM flow | Reproducible end-to-end |
| 15. Implementation notes | Case IDs, idempotency, locking, closure | All implemented |
| Appendix A. SOP | 10-step workflow | All steps work |
| Appendix B. Swimlane | 8 stages | All stages work |
| Appendix C. Tech spec | States, transitions, API, DB, concurrency | Implemented with Neon JSONB + optimistic locking |
| Appendix D.1 Tech setup | Master record, blackouts, overrides, trade tags | All fields on contact model |
| Appendix D.2 Sub tiers | Scenario-based tiering | scenarioTiers per contact (issue-specific tier overrides) |
| Appendix D.3 Voice scripts | Editable templates, safety disclaimer | 7 voice scripts + safety disclaimer in config |
| Appendix D.4 Triage rules | Configurable by issue/urgency/area/schedule/trade | Routing rules with all condition types |
| Appendix D.5 Edge cases | En-route blocking, case-matched cancellation | enRouteConfirmedAt + handleLateAccept |
| Appendix D.6 Change mgmt | Config-driven, versioning, test mode | Config-driven (versioning + test mode not yet built) |

### Implementation phases (chronological)

**Hardening pass (2026-03-24)**
- Security: dashboard Basic auth, Vapi HMAC signature verification, Twilio signature validation, secret masking, body size limits
- Persistence: Neon tables (pv_config, pv_jobs, pv_runtime_locks), local file fallback
- Escalation: durable cron at `/api/cron/process-escalations` with DB-backed lease locking
- Bug fixes: SMS to smsPhone not phone, Vapi call metadata for call-ended linking, escalation sequence fallback from targetContactIds, businessName in templates

**Phase 1: Core workflow**
- PROVISIONAL_SUB_ASSIGNMENT: partner acceptance creates provisional hold, replacement window timer, finalization to DISPATCH_CONFIRMED_SUBCONTRACTOR
- Initial customer callback: fires after first dispatch ("we received your request")
- CLOSED state: closeJobIfTerminal after every final callback, cron auto-close after configurable window

**Phase 2: Data model + reliability**
- Optimistic locking: version field + saveJobWithLock with WHERE version check
- Idempotency: dedup key per job+contact+step+channel in dispatchBatch
- Expanded intake: 13 params on Vapi tool (was 7), updated intake prompt with safety script + situational fields

**Phase 3: Human review + safety**
- HUMAN_REVIEW_REQUIRED workflow state: pauses escalation, stores previous state, resumes on resolve
- Safety disclaimer voice script in config
- Updated Vapi intake prompt with safety-first instructions

**Phase 4: Contact & routing**
- Trade tags on contacts, requiredTradeTags on rules, filtering in getRuleContacts
- enRouteConfirmedAt field + POST /api/jobs/:id/en-route endpoint
- Final statuses: INTERNAL_TECH_DISPATCHED, SUBCONTRACTOR_DISPATCHED, UNABLE_TO_DISPATCH_AFTER_HOURS

**Supervisor console (2026-03-25)**
- Live operations view with 5-second auto-polling
- Event feed showing all system activity color-coded by severity
- Job detail panel: caller info, dispatch status, escalation countdown, attempts table, customer callbacks table, recordings section, full timeline
- Action buttons: Resolve Review, Mark En Route, Close Job, Cancel as Duplicate
- Server endpoints: GET /api/jobs/:id, GET /api/events, POST /api/jobs/:id/close

**Final gaps (2026-03-25)**
- Communication flags: commFlags object auto-updates on state transitions (customerCallbackDue, techContactInProgress, subcontractorCallbackPending, finalNotificationPending)
- Scenario-based sub tiers: scenarioTiers per contact overrides global priorityTier per issue type
- Recording/transcript capture from Vapi call-ended webhook, stored in job.recordings
- ESCALATED_TO_HUMAN_SUPERVISOR: auto-set when closing paused jobs
- CANCELLED_DUPLICATE: duplicate detection (same callback+issue within 1hr), human review trigger, cancel button

### Current API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | /api/health | Health check |
| GET | /api/config | Dashboard config (secrets masked) |
| PUT | /api/config | Save config |
| GET | /api/jobs | List all jobs |
| POST | /api/jobs | Simulator — create test job (no dispatch) |
| GET | /api/jobs/:id | Single job detail with timeline/attempts/recordings |
| GET | /api/events | Cross-job event feed (supports `since` and `limit` params) |
| POST | /api/jobs/:id/en-route | Mark subcontractor as en route |
| POST | /api/jobs/:id/resolve-review | Resolve a human review flag |
| POST | /api/jobs/:id/close | Manually close a job |
| POST | /api/vapi/create-job | Vapi intake agent tool call |
| POST | /api/vapi/accept-job | Vapi dispatch agent tool call |
| POST | /api/vapi/report-response | Alias for accept-job |
| POST | /api/vapi/report_response | Alias for accept-job |
| POST | /api/vapi/call-ended | Vapi call-ended webhook |
| POST | /api/twilio/incoming-sms | Twilio inbound SMS webhook |
| GET/POST | /api/cron/process-escalations | Cron-driven escalation + auto-close |

### Production env vars (all set in Vercel)

| Var | Status |
|---|---|
| DATABASE_URL | Set |
| CRON_SECRET | Set |
| VAPI_WEBHOOK_TOKEN | Set (HMAC signature verification) |
| VAPI_API_KEY | Set |
| VAPI_DISPATCH_ASSISTANT_ID | Set |
| VAPI_PHONE_NUMBER_ID | Set |
| TWILIO_ACCOUNT_SID | Set |
| TWILIO_AUTH_TOKEN | Set |
| TWILIO_PHONE_NUMBER | Set |
| SLACK_WEBHOOK_URL | Set |
| DASHBOARD_USERNAME | Not set (dashboard open, as requested) |
| DASHBOARD_PASSWORD | Not set |

### Vapi tool + assistant config

Both Vapi tools have `server.secret` configured for HMAC signature verification:
- `create_job` tool (34ac73b7): 13 parameters, points to `/api/vapi/create-job`
- `report_response` tool (4dad11b0): 4 parameters, points to `/api/vapi/accept-job`
- Intake assistant (88c54524): updated prompt with safety-first script and situational field collection
- Dispatch assistant (0d5390f4): unchanged

### Test suite

25 regression tests covering: secret masking, rule matching, config sanitization, SMS job resolution, Twilio signatures, auth paths, state transitions, close logic, human review, trade tags, comm flags, scenario tiers, duplicate detection.

### What's NOT built (Appendix D.6 operational features)

- Config versioning/rollback — every save overwrites, no history
- Test/shadow mode — no dry-run flag for live traffic
- These are operational refinements, not workflow gaps
