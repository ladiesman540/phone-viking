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
