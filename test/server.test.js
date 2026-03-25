const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");

const { _internals } = require("../server.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("sanitizeConfigForUi masks secrets while preserve-on-save keeps existing values", () => {
  const existing = clone(_internals.defaultConfig);
  existing.slack.webhookUrl = "https://hooks.slack.test/abc";
  existing.twilio.accountSid = "AC123";
  existing.twilio.authToken = "secret-token";
  existing.vapi.apiKey = "vapi-secret";

  const ui = _internals.sanitizeConfigForUi(existing);
  assert.equal(ui.slack.webhookUrl, "");
  assert.equal(ui.twilio.authToken, "");
  assert.equal(ui.vapi.apiKey, "");
  assert.equal(ui.slack.hasWebhookUrl, true);
  assert.equal(ui.twilio.hasAuthToken, true);
  assert.equal(ui.vapi.hasApiKey, true);

  const saved = _internals.sanitizeConfigInput(ui, existing);
  assert.equal(saved.slack.webhookUrl, existing.slack.webhookUrl);
  assert.equal(saved.twilio.accountSid, existing.twilio.accountSid);
  assert.equal(saved.twilio.authToken, existing.twilio.authToken);
  assert.equal(saved.vapi.apiKey, existing.vapi.apiKey);
});

test("area-based rules do not match when the job has no location area", () => {
  const config = clone(_internals.defaultConfig);
  config.routingRules = [
    {
      id: "rule_area_only",
      name: "Area only",
      active: true,
      sortOrder: 1,
      conditions: {
        issueTypes: [],
        urgencies: ["emergency"],
        areas: ["NW Calgary"],
        scheduleMode: "any",
        contactTypes: ["tech"]
      },
      strategy: {
        initialTier: 1,
        batchSize: 1,
        escalateAfterMinutes: 3,
        leaveVoicemail: false,
        sendSms: true,
        notifySlackOnEscalation: true,
        escalationSequence: []
      },
      targetContactIds: []
    }
  ];

  const job = {
    issueType: "hvac",
    urgency: "emergency",
    locationArea: ""
  };

  assert.equal(_internals.matchesRule(job, config.routingRules[0], config), false);
});

test("computeNextTargets honors the stored matched rule before re-matching", () => {
  const config = clone(_internals.defaultConfig);
  config.contacts = [
    {
      id: "contact_a",
      name: "Alpha",
      company: "Internal",
      type: "tech",
      priorityTier: 1,
      phone: "+15550000001",
      smsPhone: "+15550000001",
      serviceAreas: [],
      availability: "24/7",
      notes: "",
      active: true
    },
    {
      id: "contact_b",
      name: "Bravo",
      company: "Internal",
      type: "tech",
      priorityTier: 1,
      phone: "+15550000002",
      smsPhone: "+15550000002",
      serviceAreas: [],
      availability: "24/7",
      notes: "",
      active: true
    }
  ];

  config.routingRules = [
    {
      id: "rule_first",
      name: "First",
      active: true,
      sortOrder: 1,
      conditions: {
        issueTypes: ["hvac"],
        urgencies: ["emergency"],
        areas: [],
        scheduleMode: "any",
        contactTypes: ["tech"]
      },
      strategy: {
        initialTier: 1,
        batchSize: 1,
        escalateAfterMinutes: 3,
        leaveVoicemail: false,
        sendSms: true,
        notifySlackOnEscalation: true,
        escalationSequence: [{ contactId: "contact_a", partner: false }]
      },
      targetContactIds: ["contact_a"]
    },
    {
      id: "rule_second",
      name: "Second",
      active: true,
      sortOrder: 2,
      conditions: {
        issueTypes: ["hvac"],
        urgencies: ["emergency"],
        areas: [],
        scheduleMode: "any",
        contactTypes: ["tech"]
      },
      strategy: {
        initialTier: 1,
        batchSize: 1,
        escalateAfterMinutes: 3,
        leaveVoicemail: false,
        sendSms: true,
        notifySlackOnEscalation: true,
        escalationSequence: [{ contactId: "contact_b", partner: false }]
      },
      targetContactIds: ["contact_b"]
    }
  ];

  const job = _internals.createJobFromPayload(
    {
      callerName: "Jane",
      callbackNumber: "+15551111111",
      serviceAddress: "123 Main St",
      locationArea: "NW Calgary",
      issueType: "hvac",
      urgency: "emergency",
      summary: "No heat"
    },
    config
  );

  job.matchedRuleId = "rule_second";
  const batch = _internals.buildDispatchBatch(job, config);
  assert.equal(batch.matchedRule.id, "rule_second");
  assert.deepEqual(batch.contacts.map((contact) => contact.id), ["contact_b"]);
});

test("sanitizeConfigInput keeps advanced routing and contact properties instead of dropping them", () => {
  const config = clone(_internals.defaultConfig);
  config.contacts = [
    {
      id: "contact_test",
      name: "Test Tech",
      company: "Internal",
      type: "tech",
      priorityTier: 1,
      phone: "+15550000001",
      smsPhone: "+15550000001",
      serviceAreas: ["NW Calgary"],
      availability: "24/7",
      notes: "",
      active: true,
      doNotUse: true,
      mayReplaceSubcontractor: false
    }
  ];
  config.routingRules = [
    {
      id: "rule_test",
      name: "Test Rule",
      active: true,
      sortOrder: 1,
      conditions: {
        issueTypes: ["hvac"],
        urgencies: ["emergency"],
        areas: ["NW Calgary"],
        scheduleMode: "any",
        contactTypes: ["tech"]
      },
      strategy: {
        initialTier: 1,
        batchSize: 1,
        escalateAfterMinutes: 3,
        subReplacementWindowMinutes: 12,
        leaveVoicemail: false,
        sendSms: true,
        notifySlackOnEscalation: true,
        escalationSequence: [{ contactId: "contact_test", partner: false }]
      },
      targetContactIds: ["contact_test"]
    }
  ];

  const sanitized = _internals.sanitizeConfigInput(config, config);
  assert.equal(sanitized.contacts[0].doNotUse, true);
  assert.equal(sanitized.contacts[0].mayReplaceSubcontractor, false);
  assert.equal(sanitized.routingRules[0].strategy.subReplacementWindowMinutes, 12);
  assert.deepEqual(sanitized.routingRules[0].strategy.escalationSequence, [{ contactId: "contact_test", partner: false }]);
});

test("resolveSmsJobForContact requires an explicit job id when a contact has multiple active jobs", () => {
  const jobs = [
    {
      id: "job_alpha",
      state: _internals.STATES.AWAITING_TECH1_RESPONSE,
      status: "open",
      issueType: "hvac",
      locationArea: "NW Calgary",
      attempts: [{ contactId: "contact_1", channel: "sms", status: "queued" }]
    },
    {
      id: "job_bravo",
      state: _internals.STATES.AWAITING_TECH2_RESPONSE,
      status: "open",
      issueType: "plumbing",
      locationArea: "Downtown",
      attempts: [{ contactId: "contact_1", channel: "sms", status: "queued" }]
    }
  ];

  const ambiguous = _internals.resolveSmsJobForContact(jobs, "contact_1", "YES");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);

  const matched = _internals.resolveSmsJobForContact(jobs, "contact_1", "YES job_bravo");
  assert.equal(matched.status, "matched");
  assert.equal(matched.job.id, "job_bravo");

  const unknown = _internals.resolveSmsJobForContact(jobs, "contact_1", "NO job_missing");
  assert.equal(unknown.status, "unknown-job");
});

test("parseSmsResponse extracts decisions and normalized job ids", () => {
  const parsed = _internals.parseSmsResponse("Accept JOB_AbC-123");
  assert.equal(parsed.decision, "accepted");
  assert.equal(parsed.jobId, "job_abc-123");

  const declined = _internals.parseSmsResponse("No job_xyz");
  assert.equal(declined.decision, "declined");
  assert.equal(declined.jobId, "job_xyz");
});

test("validateTwilioSignature matches Twilio form webhook signing", () => {
  const url = "https://dispatch.example.com/api/twilio/incoming-sms";
  const params = {
    Body: "YES job_alpha",
    From: "+15550000001",
    To: "+15550000002"
  };
  const payload = `${url}Body${params.Body}From${params.From}To${params.To}`;
  const signature = createHmac("sha1", "twilio-secret").update(payload, "utf8").digest("base64");

  assert.equal(_internals.validateTwilioSignature("twilio-secret", signature, url, params), true);
  assert.equal(_internals.validateTwilioSignature("wrong-secret", signature, url, params), false);
});

test("dashboard auth classification skips webhooks and cron but protects dashboard paths when enabled", () => {
  const originalUser = process.env.DASHBOARD_USERNAME;
  const originalPassword = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_USERNAME = "admin";
  process.env.DASHBOARD_PASSWORD = "secret";

  try {
    assert.equal(_internals.requiresDashboardAuth("/"), true);
    assert.equal(_internals.requiresDashboardAuth("/api/config"), true);
    assert.equal(_internals.requiresDashboardAuth("/api/health"), false);
    assert.equal(_internals.requiresDashboardAuth("/api/twilio/incoming-sms"), false);
    assert.equal(_internals.requiresDashboardAuth("/api/vapi/create-job"), false);
    assert.equal(_internals.requiresDashboardAuth("/api/cron/process-escalations"), false);
    assert.equal(_internals.isVapiResponsePath("/api/vapi/report_response"), true);
    assert.equal(_internals.isVapiResponsePath("/api/vapi/report-response"), true);
  } finally {
    if (originalUser == null) delete process.env.DASHBOARD_USERNAME;
    else process.env.DASHBOARD_USERNAME = originalUser;
    if (originalPassword == null) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = originalPassword;
  }
});

// --- Phase 1 tests ---

test("closeJobIfTerminal transitions confirmed jobs to CLOSED", () => {
  const job = { state: _internals.STATES.DISPATCH_CONFIRMED_INTERNAL, timeline: [] };
  const closed = _internals.closeJobIfTerminal(job);
  assert.equal(closed, true);
  assert.equal(job.state, _internals.STATES.CLOSED);
});

test("closeJobIfTerminal does not close open or awaiting jobs", () => {
  const job1 = { state: _internals.STATES.AWAITING_TECH1_RESPONSE, timeline: [] };
  assert.equal(_internals.closeJobIfTerminal(job1), false);
  assert.equal(job1.state, _internals.STATES.AWAITING_TECH1_RESPONSE);

  const job2 = { state: _internals.STATES.OPEN_PENDING_DISPATCH, timeline: [] };
  assert.equal(_internals.closeJobIfTerminal(job2), false);
});

test("closeJobIfTerminal closes DISPATCH_CONFIRMED_SUBCONTRACTOR and UNABLE_TO_DISPATCH", () => {
  const job1 = { state: _internals.STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR, timeline: [] };
  assert.equal(_internals.closeJobIfTerminal(job1), true);
  assert.equal(job1.state, _internals.STATES.CLOSED);

  const job2 = { state: _internals.STATES.UNABLE_TO_DISPATCH, timeline: [] };
  assert.equal(_internals.closeJobIfTerminal(job2), true);
  assert.equal(job2.state, _internals.STATES.CLOSED);
});

test("transitionState from PROVISIONAL_SUB_ASSIGNMENT to DISPATCH_CONFIRMED_SUBCONTRACTOR is allowed", () => {
  const job = { state: _internals.STATES.PROVISIONAL_SUB_ASSIGNMENT, timeline: [] };
  _internals.transitionState(job, _internals.STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR, { contactId: "sub_1" });
  assert.equal(job.state, _internals.STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR);
  assert.equal(_internals.getJobStatus(job), "accepted");
});

test("transitionState from PROVISIONAL_SUB_ASSIGNMENT to CANCEL_SUBCONTRACTOR_PENDING is allowed", () => {
  const job = { state: _internals.STATES.PROVISIONAL_SUB_ASSIGNMENT, timeline: [] };
  _internals.transitionState(job, _internals.STATES.CANCEL_SUBCONTRACTOR_PENDING, { reason: "tech-override" });
  assert.equal(job.state, _internals.STATES.CANCEL_SUBCONTRACTOR_PENDING);
});

test("getJobStatus returns correct status for all terminal and provisional states", () => {
  assert.equal(_internals.getJobStatus({ state: _internals.STATES.PROVISIONAL_SUB_ASSIGNMENT }), "open");
  assert.equal(_internals.getJobStatus({ state: _internals.STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR }), "accepted");
  assert.equal(_internals.getJobStatus({ state: _internals.STATES.CLOSED }), "closed");
  assert.equal(_internals.getJobStatus({ state: _internals.STATES.UNABLE_TO_DISPATCH }), "closed");
  assert.equal(_internals.getJobStatus({ state: _internals.STATES.HUMAN_REVIEW_REQUIRED }), "paused");
});

// --- Phase 3 tests ---

test("HUMAN_REVIEW_REQUIRED state exists and has valid transitions", () => {
  assert.equal(_internals.STATES.HUMAN_REVIEW_REQUIRED, "HUMAN_REVIEW_REQUIRED");

  // Can transition from awaiting to human review
  const job = { state: _internals.STATES.AWAITING_TECH1_RESPONSE, timeline: [] };
  _internals.transitionState(job, _internals.STATES.HUMAN_REVIEW_REQUIRED, { trigger: "safetyRisk" });
  assert.equal(job.state, _internals.STATES.HUMAN_REVIEW_REQUIRED);

  // Can transition back to awaiting
  _internals.transitionState(job, _internals.STATES.AWAITING_TECH1_RESPONSE, { reason: "resolved" });
  assert.equal(job.state, _internals.STATES.AWAITING_TECH1_RESPONSE);
});

test("cron skips paused (HUMAN_REVIEW_REQUIRED) jobs", () => {
  const pausedJob = { state: _internals.STATES.HUMAN_REVIEW_REQUIRED, escalationDueAt: new Date(Date.now() - 60000).toISOString() };
  // getJobStatus returns "paused", not "open", so cron filter would exclude it
  assert.equal(_internals.getJobStatus(pausedJob), "paused");
  assert.notEqual(_internals.getJobStatus(pausedJob), "open");
});

test("safetyDisclaimer exists in defaultConfig.voiceScripts", () => {
  assert.ok(_internals.defaultConfig.voiceScripts.safetyDisclaimer);
  assert.ok(_internals.defaultConfig.voiceScripts.safetyDisclaimer.includes("911"));
});

// --- Phase 4 tests ---

test("closeJobIfTerminal sets correct finalStatus per state", () => {
  const job1 = { state: _internals.STATES.DISPATCH_CONFIRMED_INTERNAL, timeline: [] };
  _internals.closeJobIfTerminal(job1);
  assert.equal(job1.finalStatus, "INTERNAL_TECH_DISPATCHED");
  assert.equal(job1.state, _internals.STATES.CLOSED);

  const job2 = { state: _internals.STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR, timeline: [] };
  _internals.closeJobIfTerminal(job2);
  assert.equal(job2.finalStatus, "SUBCONTRACTOR_DISPATCHED");

  const job3 = { state: _internals.STATES.UNABLE_TO_DISPATCH, timeline: [] };
  _internals.closeJobIfTerminal(job3);
  assert.equal(job3.finalStatus, "UNABLE_TO_DISPATCH_AFTER_HOURS");
});

test("closeJobIfTerminal accepts overrideFinalStatus", () => {
  const job = { state: _internals.STATES.DISPATCH_CONFIRMED_INTERNAL, timeline: [] };
  _internals.closeJobIfTerminal(job, "ESCALATED_TO_HUMAN_SUPERVISOR");
  assert.equal(job.finalStatus, "ESCALATED_TO_HUMAN_SUPERVISOR");
});

test("sanitizeContacts preserves tradeTags", () => {
  const config = clone(_internals.defaultConfig);
  config.contacts = [{
    id: "c1", name: "Tech A", type: "tech", priorityTier: 1,
    phone: "+15550000001", tradeTags: ["hvac", "plumbing"]
  }];
  const sanitized = _internals.sanitizeConfigInput(config, config);
  assert.deepEqual(sanitized.contacts[0].tradeTags, ["hvac", "plumbing"]);
});

test("sanitizeRoutingRules preserves requiredTradeTags in conditions", () => {
  const config = clone(_internals.defaultConfig);
  config.contacts = [{ id: "c1", name: "A", type: "tech", phone: "+15550000001" }];
  config.routingRules = [{
    id: "r1", name: "HVAC only", active: true, sortOrder: 1,
    conditions: { issueTypes: [], urgencies: [], areas: [], scheduleMode: "any", contactTypes: [], requiredTradeTags: ["hvac"] },
    strategy: { initialTier: 1, batchSize: 1, escalateAfterMinutes: 3, escalationSequence: [] },
    targetContactIds: ["c1"]
  }];
  const sanitized = _internals.sanitizeConfigInput(config, config);
  assert.deepEqual(sanitized.routingRules[0].conditions.requiredTradeTags, ["hvac"]);
});

// --- Final gaps tests ---

test("closeJobIfTerminal maps HUMAN_REVIEW_REQUIRED to ESCALATED_TO_HUMAN_SUPERVISOR", () => {
  const job = { state: _internals.STATES.HUMAN_REVIEW_REQUIRED, timeline: [] };
  const closed = _internals.closeJobIfTerminal(job);
  assert.equal(closed, true);
  assert.equal(job.finalStatus, "ESCALATED_TO_HUMAN_SUPERVISOR");
  assert.equal(job.state, _internals.STATES.CLOSED);
});

test("createJobFromPayload includes commFlags, recordings, and possibleDuplicateOf fields", () => {
  const config = clone(_internals.defaultConfig);
  const job = _internals.createJobFromPayload({
    callerName: "Test", callbackNumber: "+15551234567", serviceAddress: "123 Test St",
    issueType: "hvac", urgency: "emergency", summary: "No heat"
  }, config);
  assert.deepEqual(job.commFlags, { customerCallbackDue: false, techContactInProgress: false, subcontractorCallbackPending: false, finalNotificationPending: false });
  assert.deepEqual(job.recordings, []);
  assert.equal(job.possibleDuplicateOf, null);
});

test("transitionState auto-sets commFlags based on target state", () => {
  const job = { state: _internals.STATES.OPEN_PENDING_DISPATCH, timeline: [], commFlags: {} };
  _internals.transitionState(job, _internals.STATES.AWAITING_TECH1_RESPONSE);
  assert.equal(job.commFlags.techContactInProgress, true);
  assert.equal(job.commFlags.subcontractorCallbackPending, false);

  _internals.transitionState(job, _internals.STATES.AWAITING_SUBCONTRACTOR_RESPONSE);
  assert.equal(job.commFlags.techContactInProgress, false);
  assert.equal(job.commFlags.subcontractorCallbackPending, true);

  _internals.transitionState(job, _internals.STATES.DISPATCH_CONFIRMED_INTERNAL);
  assert.equal(job.commFlags.finalNotificationPending, true);
  assert.equal(job.commFlags.techContactInProgress, false);

  _internals.transitionState(job, _internals.STATES.CLOSED);
  assert.equal(job.commFlags.finalNotificationPending, false);
});

test("sanitizeContacts preserves scenarioTiers", () => {
  const config = clone(_internals.defaultConfig);
  config.contacts = [{
    id: "c1", name: "Sub A", type: "partner", phone: "+15550000001",
    scenarioTiers: [{ issueType: "hvac", tier: 1 }, { issueType: "plumbing", tier: 3 }]
  }];
  const sanitized = _internals.sanitizeConfigInput(config, config);
  assert.equal(sanitized.contacts[0].scenarioTiers.length, 2);
  assert.equal(sanitized.contacts[0].scenarioTiers[0].issueType, "hvac");
  assert.equal(sanitized.contacts[0].scenarioTiers[0].tier, 1);
});
