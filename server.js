const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { URL } = require("url");
const { neon } = require("@neondatabase/serverless");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3007);

function log(event, data = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  console.log(JSON.stringify(entry));
}

function getDb() {
  if (!process.env.DATABASE_URL) return null;
  return neon(process.env.DATABASE_URL);
}

// Active escalation timers keyed by jobId
const escalationTimers = new Map();

// Case states (v4 state machine)
const STATES = Object.freeze({
  OPEN_PENDING_DISPATCH: "OPEN_PENDING_DISPATCH",
  AWAITING_TECH1_RESPONSE: "AWAITING_TECH1_RESPONSE",
  AWAITING_TECH2_RESPONSE: "AWAITING_TECH2_RESPONSE",
  AWAITING_TECH1_FINAL_RETRY: "AWAITING_TECH1_FINAL_RETRY",
  AWAITING_SUBCONTRACTOR_RESPONSE: "AWAITING_SUBCONTRACTOR_RESPONSE",
  PROVISIONAL_SUB_ASSIGNMENT: "PROVISIONAL_SUB_ASSIGNMENT",
  DISPATCH_CONFIRMED_INTERNAL: "DISPATCH_CONFIRMED_INTERNAL",
  DISPATCH_CONFIRMED_SUBCONTRACTOR: "DISPATCH_CONFIRMED_SUBCONTRACTOR",
  UNABLE_TO_DISPATCH: "UNABLE_TO_DISPATCH",
  CANCEL_SUBCONTRACTOR_PENDING: "CANCEL_SUBCONTRACTOR_PENDING",
  CLOSED: "CLOSED"
});

const ALLOWED_TRANSITIONS = {
  [STATES.OPEN_PENDING_DISPATCH]: [STATES.AWAITING_TECH1_RESPONSE],
  [STATES.AWAITING_TECH1_RESPONSE]: [STATES.AWAITING_TECH2_RESPONSE, STATES.DISPATCH_CONFIRMED_INTERNAL],
  [STATES.AWAITING_TECH2_RESPONSE]: [STATES.AWAITING_TECH1_FINAL_RETRY, STATES.DISPATCH_CONFIRMED_INTERNAL],
  [STATES.AWAITING_TECH1_FINAL_RETRY]: [STATES.AWAITING_SUBCONTRACTOR_RESPONSE, STATES.DISPATCH_CONFIRMED_INTERNAL],
  [STATES.AWAITING_SUBCONTRACTOR_RESPONSE]: [STATES.PROVISIONAL_SUB_ASSIGNMENT, STATES.UNABLE_TO_DISPATCH],
  [STATES.PROVISIONAL_SUB_ASSIGNMENT]: [STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR, STATES.CANCEL_SUBCONTRACTOR_PENDING, STATES.DISPATCH_CONFIRMED_INTERNAL],
  [STATES.CANCEL_SUBCONTRACTOR_PENDING]: [STATES.DISPATCH_CONFIRMED_INTERNAL],
  [STATES.DISPATCH_CONFIRMED_INTERNAL]: [STATES.CLOSED],
  [STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR]: [STATES.CLOSED],
  [STATES.UNABLE_TO_DISPATCH]: [STATES.CLOSED, STATES.DISPATCH_CONFIRMED_INTERNAL]
};

function getJobStatus(job) {
  const s = job.state;
  if (!s) return job.status || "open";
  if (s === STATES.DISPATCH_CONFIRMED_INTERNAL || s === STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR) return "accepted";
  if (s === STATES.CLOSED || s === STATES.UNABLE_TO_DISPATCH) return "closed";
  return "open";
}

function transitionState(job, newState, payload = {}) {
  const from = job.state || STATES.OPEN_PENDING_DISPATCH;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed && !allowed.includes(newState)) {
    log("state-transition-blocked", { jobId: job.id, from, to: newState });
  }
  job.state = newState;
  job.status = getJobStatus(job);
  job.updatedAt = new Date().toISOString();
  appendTimeline(job, "state-change", { from, to: newState, ...payload });
}

const defaultConfig = {
  workspace: {
    businessName: "Phone Viking Dispatch",
    timezone: "America/Edmonton",
    businessHours: {
      days: ["mon", "tue", "wed", "thu", "fri"],
      startHour: 8,
      endHour: 18
    }
  },
  slack: {
    enabled: !!process.env.SLACK_WEBHOOK_URL,
    webhookUrl: process.env.SLACK_WEBHOOK_URL || "",
    channelLabel: "#dispatch"
  },
  twilio: {
    voiceNumber: process.env.TWILIO_PHONE_NUMBER || "",
    smsNumber: process.env.TWILIO_PHONE_NUMBER || "",
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || ""
  },
  vapi: {
    apiKey: process.env.VAPI_API_KEY || "",
    dispatchAssistantId: process.env.VAPI_DISPATCH_ASSISTANT_ID || "",
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || "",
    baseUrl: "https://api.vapi.ai"
  },
  voiceScripts: {
    customerInitial: "Hi {{callerName}}, this is {{businessName}}. We received your request about the {{issueType}} issue and we're reaching out to our on-call team right now. Someone should be calling you back shortly.",
    customerAccepted: "Hi {{callerName}}, this is {{businessName}} calling back about your {{issueType}} emergency. Good news — we've got a tech heading your way.{{etaText}} They'll call you when they're close. Is there anything else you need before they arrive?",
    customerSubDispatched: "Hi {{callerName}}, this is {{businessName}} calling back. We've arranged a service partner to assist you tonight with your {{issueType}} issue. They should be reaching out to you shortly.",
    customerUnavailable: "Hi {{callerName}}, this is {{businessName}} calling back about your {{issueType}} request. Unfortunately we weren't able to reach any of our on-call techs tonight. If this is still urgent, you can call our direct line at 587-809-6383. We really apologize for the inconvenience.",
    customerSubCancelledTechAssigned: "Hi {{callerName}}, this is {{businessName}} with an update. Good news — one of our own techs is now heading your way for your {{issueType}} issue.{{etaText}} They'll call you when they're close.",
    subCancellation: "Hi, this is {{businessName}} dispatch. We had a service request we'd reached out about, but one of our techs is now available to cover it. You're off the hook — sorry for the back and forth."
  },
  humanReview: {
    enabled: true,
    triggerOnAmbiguousResponse: true,
    triggerOnConflictingAcceptances: true,
    triggerOnSafetyRisk: true,
    triggerOnPricingIssue: true,
    slackNotify: true
  },
  escalation: {
    defaultTimerMinutes: 3,
    subReplacementWindowMinutes: 10
  },
  intakeFields: [
    {
      id: "caller_name",
      label: "Caller name",
      type: "text",
      required: true,
      helpText: "Who is calling?"
    },
    {
      id: "callback_number",
      label: "Callback number",
      type: "phone",
      required: true,
      helpText: "Best number for the crew to reach back."
    },
    {
      id: "service_address",
      label: "Service address",
      type: "text",
      required: true,
      helpText: "Where the work needs to happen."
    },
    {
      id: "issue_type",
      label: "Issue type",
      type: "text",
      required: true,
      helpText: "Plumbing, HVAC, locksmith, towing, or your own categories."
    },
    {
      id: "urgency",
      label: "Urgency",
      type: "select",
      required: true,
      helpText: "Emergency, same-day, routine."
    },
    {
      id: "notes",
      label: "Notes",
      type: "textarea",
      required: false,
      helpText: "Anything the tech should know before calling."
    }
  ],
  messageTemplates: {
    slackSummary:
      "*New dispatch request*\nCustomer: {{callerName}}\nCallback: {{callbackNumber}}\nLocation: {{locationArea}}\nIssue: {{issueType}}\nUrgency: {{urgency}}\nSummary: {{summary}}\nJob ID: {{jobId}}",
    techSms:
      "Dispatch request {{jobId}}: {{issueType}} at {{locationArea}}. {{summary}} Reply YES if you can take it, NO if not.",
    partnerSms:
      "Partner request {{jobId}}: {{issueType}} at {{locationArea}}. {{summary}} Reply YES if available.",
    acceptanceAck:
      "Confirmed. {{contactName}} has accepted job {{jobId}}.",
    subcontractorSms:
      "Service partner request {{jobId}}: {{issueType}} at {{locationArea}}. Please call back to confirm availability."
  },
  contacts: [
    {
      id: "contact_test_tech",
      name: "Test Tech",
      company: "Phone Viking QA",
      type: "tech",
      priorityTier: 1,
      phone: "+17807163624",
      smsPhone: "+17807163624",
      serviceAreas: [],
      availability: "24/7",
      notes: "Test contact for simulation",
      active: true
    }
  ],
  routingRules: [
    {
      id: "rule_afterhours_emergency",
      name: "After-hours emergency",
      active: true,
      sortOrder: 1,
      conditions: {
        issueTypes: ["hvac", "plumbing", "gas"],
        urgencies: ["emergency"],
        areas: [],
        scheduleMode: "after-hours",
        contactTypes: ["tech"]
      },
      strategy: {
        initialTier: 1,
        batchSize: 1,
        escalateAfterMinutes: 3,
        leaveVoicemail: false,
        sendSms: true,
        notifySlackOnEscalation: true,
        escalationSequence: [
          { contactId: "contact_test_tech" }
        ],
        subReplacementWindowMinutes: 10
      },
      targetContactIds: ["contact_test_tech"]
    },
    {
      id: "rule_anytime_emergency",
      name: "Emergency fallback (any time)",
      active: true,
      sortOrder: 2,
      conditions: {
        issueTypes: [],
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
        escalationSequence: [
          { contactId: "contact_test_tech" }
        ],
        subReplacementWindowMinutes: 10
      },
      targetContactIds: ["contact_test_tech"]
    }
  ]
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await fs.mkdir(PUBLIC_DIR, { recursive: true }).catch(() => {});
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    return JSON.parse(raw);
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }

  // Try parsing as JSON even without Content-Type header
  try {
    return JSON.parse(raw);
  } catch {}

  return { raw };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeArray(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : String(values || "").split(","))
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  );
}

function normalizeString(value) {
  return String(value || "").trim();
}

function toSlug(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "item";
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function getPartsForTimezone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit"
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    weekday: String(parts.weekday || "").toLowerCase().slice(0, 3),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0)
  };
}

function isBusinessHours(config, date = new Date()) {
  const workspace = config.workspace || defaultConfig.workspace;
  const businessHours = workspace.businessHours || defaultConfig.workspace.businessHours;
  const parts = getPartsForTimezone(date, workspace.timezone || defaultConfig.workspace.timezone);
  const isAllowedDay = normalizeArray(businessHours.days).includes(parts.weekday);
  const startHour = Number(businessHours.startHour ?? 8);
  const endHour = Number(businessHours.endHour ?? 18);
  return isAllowedDay && parts.hour >= startHour && parts.hour < endHour;
}

function matchesRule(job, rule, config) {
  if (!rule || rule.active === false) {
    return false;
  }

  const conditions = rule.conditions || {};
  const issueTypes = normalizeArray(conditions.issueTypes).map((value) => value.toLowerCase());
  const urgencies = normalizeArray(conditions.urgencies).map((value) => value.toLowerCase());
  const areas = normalizeArray(conditions.areas).map((value) => value.toLowerCase());
  const scheduleMode = normalizeString(conditions.scheduleMode || "any").toLowerCase();
  const jobIssueType = normalizeString(job.issueType).toLowerCase();
  const jobUrgency = normalizeString(job.urgency).toLowerCase();
  const jobArea = normalizeString(job.locationArea).toLowerCase();

  if (issueTypes.length && !issueTypes.includes(jobIssueType)) {
    return false;
  }

  if (urgencies.length && !urgencies.includes(jobUrgency)) {
    return false;
  }

  if (areas.length && !areas.some((area) => jobArea.includes(area) || area.includes(jobArea))) {
    return false;
  }

  const businessHours = isBusinessHours(config);
  if (scheduleMode === "business-hours" && !businessHours) {
    return false;
  }
  if (scheduleMode === "after-hours" && businessHours) {
    return false;
  }

  return true;
}

function sortRules(routingRules) {
  return clone(routingRules).sort((left, right) => {
    const leftOrder = Number(left.sortOrder ?? 9999);
    const rightOrder = Number(right.sortOrder ?? 9999);
    return leftOrder - rightOrder;
  });
}

function findMatchingRule(job, config) {
  const rules = sortRules(config.routingRules || []);
  return rules.find((rule) => matchesRule(job, rule, config)) || null;
}

function getContactMap(config) {
  return new Map((config.contacts || []).map((contact) => [contact.id, contact]));
}

function getRuleContacts(job, rule, config) {
  const contactMap = getContactMap(config);
  const conditions = rule?.conditions || {};
  const allowedTypes = normalizeArray(conditions.contactTypes).map((value) => value.toLowerCase());
  const targetContactIds = normalizeArray(rule?.targetContactIds);
  const contacts = targetContactIds.length
    ? targetContactIds.map((contactId) => contactMap.get(contactId)).filter(Boolean)
    : clone(config.contacts || []);

  return contacts
    .filter((contact) => contact.active !== false)
    .filter((contact) => {
      if (!allowedTypes.length) {
        return true;
      }
      return allowedTypes.includes(normalizeString(contact.type).toLowerCase());
    })
    .filter((contact) => {
      const serviceAreas = normalizeArray(contact.serviceAreas).map((value) => value.toLowerCase());
      if (!serviceAreas.length) {
        return true;
      }
      const area = normalizeString(job.locationArea).toLowerCase();
      return serviceAreas.some((item) => area.includes(item) || item.includes(area));
    })
    .sort((left, right) => {
      const tierDelta = Number(left.priorityTier ?? 999) - Number(right.priorityTier ?? 999);
      if (tierDelta !== 0) {
        return tierDelta;
      }
      return normalizeString(left.name).localeCompare(normalizeString(right.name));
    });
}

function buildJobSummary(job) {
  const parts = [
    `${job.issueType || "General request"} at ${job.locationArea || "unknown location"}`,
    `urgency ${job.urgency || "unspecified"}`,
    job.notes ? `notes: ${job.notes}` : "",
    job.callerName ? `caller: ${job.callerName}` : ""
  ].filter(Boolean);
  return job.summary || parts.join(", ");
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key) => {
    const trimmedKey = String(key).trim();
    return values[trimmedKey] == null ? "" : String(values[trimmedKey]);
  });
}

function getTemplateValues(job, contact) {
  return {
    jobId: job.id,
    callerName: job.callerName,
    callbackNumber: job.callbackNumber,
    locationArea: job.locationArea,
    serviceAddress: job.serviceAddress,
    issueType: job.issueType,
    urgency: job.urgency,
    summary: buildJobSummary(job),
    contactName: contact?.name || "",
    company: contact?.company || ""
  };
}

function computeNextTargets(job, config, options = {}) {
  const matchedRule =
    findMatchingRule(job, config) ||
    config.routingRules?.find((rule) => rule.id === job.matchedRuleId) ||
    null;
  const strategy = matchedRule?.strategy || {};
  const contacts = getRuleContacts(job, matchedRule, config);
  const attemptedContactIds = new Set((job.attempts || []).map((attempt) => attempt.contactId));
  const availableContacts = contacts.filter((contact) => !attemptedContactIds.has(contact.id));
  const initialTier = Number(strategy.initialTier ?? 1);
  const overrideTier = options.overrideTier != null ? Number(options.overrideTier) : null;
  const tiers = Array.from(
    new Set(
      availableContacts
        .map((contact) => Number(contact.priorityTier ?? 999))
        .filter((tier) => Number.isFinite(tier))
        .sort((left, right) => left - right)
    )
  ).filter((tier) => tier >= initialTier);

  const chosenTier = overrideTier ?? tiers[0] ?? null;
  const batchSize = Number(strategy.batchSize ?? 3);
  const selectedContacts =
    chosenTier == null
      ? []
      : availableContacts.filter((contact) => Number(contact.priorityTier ?? 999) === chosenTier).slice(0, batchSize);

  return {
    matchedRule,
    tier: chosenTier,
    strategy: {
      initialTier,
      batchSize,
      escalateAfterMinutes: Number(strategy.escalateAfterMinutes ?? 5),
      leaveVoicemail: Boolean(strategy.leaveVoicemail),
      sendSms: strategy.sendSms !== false,
      notifySlackOnEscalation: Boolean(strategy.notifySlackOnEscalation)
    },
    contacts: selectedContacts
  };
}

function buildDispatchBatch(job, config, options = {}) {
  const nextTargets = computeNextTargets(job, config, options);
  const techSmsTemplate = config.messageTemplates?.techSms || defaultConfig.messageTemplates.techSms;
  const partnerSmsTemplate = config.messageTemplates?.partnerSms || defaultConfig.messageTemplates.partnerSms;

  return {
    ...nextTargets,
    contacts: nextTargets.contacts.map((contact) => {
      const values = getTemplateValues(job, contact);
      const template = normalizeString(contact.type).toLowerCase() === "partner" ? partnerSmsTemplate : techSmsTemplate;
      return {
        ...contact,
        renderedSms: renderTemplate(template, values),
        renderedSummary: buildJobSummary(job)
      };
    })
  };
}

// --- v4 Escalation Sequence Engine ---

function isContactAvailable(contact) {
  if (!contact || contact.active === false || contact.doNotUse) return false;
  const now = new Date();
  const overrides = contact.tempOverrides || {};
  if (overrides.unavailableUntil && new Date(overrides.unavailableUntil) > now) return false;
  if (overrides.doNotCallBefore && new Date(overrides.doNotCallBefore) > now) return false;
  for (const bp of (contact.blackoutPeriods || [])) {
    if (bp.start && bp.end && now >= new Date(bp.start) && now <= new Date(bp.end)) return false;
  }
  return true;
}

function getEscalationTarget(job, config) {
  const rule = (config.routingRules || []).find((r) => r.id === job.matchedRuleId);
  const sequence = rule?.strategy?.escalationSequence;
  if (!sequence || !sequence.length) return null;

  const contactMap = getContactMap(config);
  let step = job.escalationStep;
  while (step < sequence.length) {
    const entry = sequence[step];
    const contact = contactMap.get(entry.contactId);
    if (contact && isContactAvailable(contact)) {
      return { contact, isPartner: !!entry.partner, step };
    }
    log("escalation-skip-unavailable", { jobId: job.id, step, contactId: entry.contactId });
    step++;
  }
  return null;
}

function stateForStep(step, sequence) {
  if (!sequence || step >= sequence.length) return null;
  if (sequence[step].partner) return STATES.AWAITING_SUBCONTRACTOR_RESPONSE;
  // Determine which AWAITING state based on tech contact identity
  const contactId = sequence[step].contactId;
  const firstTechId = sequence.find((e) => !e.partner)?.contactId;
  const secondTechId = sequence.find((e) => !e.partner && e.contactId !== firstTechId)?.contactId;
  // Count how many times this contact has appeared before this step
  const priorAppearances = sequence.slice(0, step).filter((e) => e.contactId === contactId).length;
  if (contactId === firstTechId && priorAppearances > 0) return STATES.AWAITING_TECH1_FINAL_RETRY;
  if (contactId === firstTechId) return STATES.AWAITING_TECH1_RESPONSE;
  if (contactId === secondTechId) return STATES.AWAITING_TECH2_RESPONSE;
  return STATES.AWAITING_TECH1_RESPONSE;
}

async function advanceEscalation(job, config, jobs) {
  job.escalationStep++;
  const target = getEscalationTarget(job, config);

  if (!target) {
    log("escalation-exhausted", { jobId: job.id, step: job.escalationStep });
    transitionState(job, STATES.UNABLE_TO_DISPATCH);
    const customerResult = await callCustomerUpdate(config, job, "unavailable");
    appendTimeline(job, "customer-callback", { type: "unavailable", callId: customerResult.callId, error: customerResult.error, skipped: customerResult.skipped });
    job.customerCallbacks.push({ type: "unavailable", at: new Date().toISOString(), outcome: customerResult.ok ? "completed" : "failed", callId: customerResult.callId, error: customerResult.error || null });
    await sendSlackMessage(config, `*Escalation exhausted* for job ${job.id} — no more contacts available.`);
    clearEscalation(job.id);
    await saveJobs(jobs);
    return;
  }

  job.escalationStep = target.step;
  const rule = (config.routingRules || []).find((r) => r.id === job.matchedRuleId);
  const sequence = rule?.strategy?.escalationSequence || [];
  const newState = stateForStep(target.step, sequence);
  if (newState) transitionState(job, newState, { contactId: target.contact.id });

  const smsTemplate = target.isPartner
    ? (config.messageTemplates?.subcontractorSms || defaultConfig.messageTemplates.subcontractorSms)
    : (normalizeString(target.contact.type).toLowerCase() === "partner"
      ? (config.messageTemplates?.partnerSms || defaultConfig.messageTemplates.partnerSms)
      : (config.messageTemplates?.techSms || defaultConfig.messageTemplates.techSms));

  const values = getTemplateValues(job, target.contact);
  const renderedSms = renderTemplate(smsTemplate, values);
  const batch = {
    contacts: [{ ...target.contact, renderedSms, renderedSummary: buildJobSummary(job) }],
    strategy: rule?.strategy || {},
    tier: target.contact.priorityTier || 1,
    matchedRule: rule
  };

  log("escalation-step", { jobId: job.id, step: target.step, contactId: target.contact.id, contactName: target.contact.name, isPartner: target.isPartner });
  await sendSlackMessage(config, `*Escalation step ${target.step + 1}*: contacting ${target.contact.name} for job ${job.id}`);
  await dispatchBatch(job, batch, config);
  await saveJobs(jobs);

  const timerMinutes = target.isPartner
    ? Number(rule?.strategy?.subReplacementWindowMinutes || config.escalation?.subReplacementWindowMinutes || 10)
    : Number(rule?.strategy?.escalateAfterMinutes || config.escalation?.defaultTimerMinutes || 3);
  scheduleEscalation(job.id, timerMinutes, config, job.escalationStep);
}

async function handleLateAccept(job, config, contact, jobs) {
  // Tech accepting while sub is provisional — cancel sub, assign tech
  if (job.state === STATES.PROVISIONAL_SUB_ASSIGNMENT) {
    if (contact.mayReplaceSubcontractor === false) {
      log("late-accept-blocked", { jobId: job.id, contactId: contact.id, reason: "contact may not replace subcontractor" });
      return false;
    }
    const subContact = (config.contacts || []).find((c) => c.id === job.provisionalSubId);
    log("partner-superseded", { jobId: job.id, techContactId: contact.id, partnerId: job.provisionalSubId });
    transitionState(job, STATES.CANCEL_SUBCONTRACTOR_PENDING, { techContactId: contact.id });

    // Courtesy SMS to subcontractor
    if (subContact) {
      const subPhone = normalizeString(subContact.smsPhone || subContact.phone);
      if (subPhone) {
        await sendTwilioSms(config, subPhone, "Disregard previous dispatch — a tech has accepted the job. Sorry for the back and forth.");
      }
    }
    appendTimeline(job, "sub-cancelled", { partnerId: job.provisionalSubId, reason: "tech-override", techContactId: contact.id });
    await sendSlackMessage(config, `*Tech override* — ${contact.name} accepted job ${job.id}, canceling subcontractor outreach.`);

    transitionState(job, STATES.DISPATCH_CONFIRMED_INTERNAL, { contactId: contact.id });
    const customerResult = await callCustomerUpdate(config, job, "sub_cancelled_tech_assigned", contact.name);
    appendTimeline(job, "customer-callback", { type: "sub_cancelled_tech_assigned", callId: customerResult.callId, error: customerResult.error, skipped: customerResult.skipped });
    job.customerCallbacks.push({ type: "sub_cancelled_tech_assigned", at: new Date().toISOString(), outcome: customerResult.ok ? "completed" : "failed", callId: customerResult.callId, error: customerResult.error || null });
    clearEscalation(job.id);
    await saveJobs(jobs);
    return true;
  }

  // Tech accepting after exhaustion — late but better than nothing
  if (job.state === STATES.UNABLE_TO_DISPATCH) {
    log("late-accept-from-exhausted", { jobId: job.id, contactId: contact.id });
    transitionState(job, STATES.DISPATCH_CONFIRMED_INTERNAL, { contactId: contact.id });
    const customerResult = await callCustomerUpdate(config, job, "accepted", contact.name);
    appendTimeline(job, "customer-callback", { type: "accepted", callId: customerResult.callId, error: customerResult.error, skipped: customerResult.skipped });
    job.customerCallbacks.push({ type: "accepted", at: new Date().toISOString(), outcome: customerResult.ok ? "completed" : "failed", callId: customerResult.callId, error: customerResult.error || null });
    await sendSlackMessage(config, `*Late tech accept* — ${contact.name} accepted job ${job.id} after exhaustion.`);
    await saveJobs(jobs);
    return true;
  }

  return false;
}

async function checkHumanReview(job, config, trigger, context) {
  const hr = config.humanReview || {};
  if (!hr.enabled) return;
  const triggerMap = {
    ambiguousResponse: hr.triggerOnAmbiguousResponse,
    conflictingAcceptances: hr.triggerOnConflictingAcceptances,
    safetyRisk: hr.triggerOnSafetyRisk,
    pricingIssue: hr.triggerOnPricingIssue
  };
  if (triggerMap[trigger] === false) return;

  const flag = { trigger, at: new Date().toISOString(), resolved: false, context };
  job.humanReviewFlags = job.humanReviewFlags || [];
  job.humanReviewFlags.push(flag);
  appendTimeline(job, "human-review-flagged", { trigger, context });
  log("human-review-flagged", { jobId: job.id, trigger, context });

  if (hr.slackNotify) {
    try {
      await sendSlackMessage(config, `*Human review needed* — ${trigger}: ${context}`, job.slackThreadTs);
    } catch {}
  }
}

function appendTimeline(job, type, payload = {}, actor = "system") {
  const event = {
    id: `evt_${randomUUID()}`,
    type,
    actor,
    at: new Date().toISOString(),
    ...payload
  };
  job.timeline = Array.isArray(job.timeline) ? job.timeline : [];
  job.timeline.push(event);
}

function createJobFromPayload(payload, config) {
  const job = {
    id: payload.jobId || `job_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: STATES.OPEN_PENDING_DISPATCH,
    status: "open",
    // Caller info
    callerName: normalizeString(payload.callerName),
    callbackNumber: normalizeString(payload.callbackNumber),
    alternateNumber: normalizeString(payload.alternateNumber),
    companySiteName: normalizeString(payload.companySiteName),
    email: normalizeString(payload.email),
    // Location
    serviceAddress: normalizeString(payload.serviceAddress),
    locationArea: normalizeString(payload.locationArea || payload.serviceAddress),
    // Issue details
    issueType: normalizeString(payload.issueType),
    urgency: normalizeString(payload.urgency || "routine"),
    summary: normalizeString(payload.summary),
    notes: normalizeString(payload.notes),
    equipmentInvolved: normalizeString(payload.equipmentInvolved),
    severity: normalizeString(payload.severity || "standard"),
    anyoneOnsite: !!payload.anyoneOnsite,
    accessInstructions: normalizeString(payload.accessInstructions),
    hazards: normalizeString(payload.hazards),
    photosVideoAvailable: !!payload.photosVideoAvailable,
    // Commercial
    poApprovalRequired: normalizeString(payload.poApprovalRequired),
    billingNotes: normalizeString(payload.billingNotes),
    authorizedContact: payload.authorizedContact !== false,
    // Routing + escalation
    metadata: payload.metadata || {},
    matchedRuleId: "",
    escalationStep: 0,
    // Subcontractor tracking
    provisionalSubId: null,
    provisionalSubAt: null,
    // Dispatch history
    attempts: [],
    acceptedBy: null,
    timeline: [],
    // Comms + audit
    humanReviewFlags: [],
    slackThreadTs: null,
    customerCallbacks: []
  };

  const matchedRule = findMatchingRule(job, config);
  job.matchedRuleId = matchedRule?.id || "";
  appendTimeline(job, "job-created", { matchedRuleId: job.matchedRuleId }, "ai-intake");
  return job;
}

async function sendSlackMessage(config, text, threadTs = null) {
  const botToken = normalizeString(config.slack?.botToken);
  const channelId = normalizeString(config.slack?.channelId);

  // Prefer Slack Web API (supports threading) over webhook
  if (botToken && channelId) {
    log("slack-send", { channel: channelId, threadTs: threadTs || "(new)", textPreview: text.slice(0, 120) });
    const payload = { channel: channelId, text };
    if (threadTs) payload.thread_ts = threadTs;
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${botToken}` },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    log("slack-result", { ok: data.ok, ts: data.ts, error: data.error });
    return { skipped: false, ok: data.ok, ts: data.ts, threadTs: threadTs || data.ts, error: data.error };
  }

  // Fallback to webhook (no threading)
  if (!config?.slack?.enabled || !normalizeString(config.slack.webhookUrl)) {
    log("slack-skip", { reason: "Slack disabled or webhook missing." });
    return { skipped: true, reason: "Slack disabled or webhook missing." };
  }

  log("slack-send", { channel: config.slack.channelLabel, textPreview: text.slice(0, 120) });
  const response = await fetch(config.slack.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  const body = await response.text();
  const result = { skipped: false, ok: response.ok, status: response.status, body };
  log("slack-result", { ok: response.ok, status: response.status });
  return result;
}

async function sendTwilioSms(config, to, body) {
  const { accountSid, authToken, smsNumber } = config.twilio || {};
  if (!accountSid || !authToken || !smsNumber) {
    log("sms-skip", { to, reason: "Twilio not configured." });
    return { skipped: true, reason: "Twilio not configured." };
  }

  log("sms-send", { from: smsNumber, to, bodyPreview: body.slice(0, 120) });
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ From: smsNumber, To: to, Body: body });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
    },
    body: params.toString()
  });

  const result = await response.json();
  log("sms-result", { to, ok: response.ok, status: response.status, sid: result.sid, error: result.message });
  return { skipped: false, ok: response.ok, status: response.status, sid: result.sid, error: result.message };
}

async function startVapiOutboundCall(config, toPhone, job, contactId, contactName) {
  const { apiKey, dispatchAssistantId, phoneNumberId, baseUrl } = config.vapi || {};
  if (!apiKey || !dispatchAssistantId) {
    log("vapi-call-skip", { contactId, contactName, reason: "Vapi dispatch agent not configured." });
    return { skipped: true, reason: "Vapi dispatch agent not configured." };
  }

  log("vapi-call-start", { jobId: job.id, contactId, contactName, toPhone, phoneNumberId });

  const response = await fetch(`${baseUrl || "https://api.vapi.ai"}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      assistantId: dispatchAssistantId,
      assistantOverrides: {
        variableValues: {
          jobId: job.id,
          contactId,
          techContactId: contactId,
          techName: contactName,
          issueType: job.issueType,
          jobAddress: job.serviceAddress,
          summary: job.summary,
          callerName: job.callerName,
          callbackNumber: job.callbackNumber,
          notes: job.notes || ""
        }
      },
      phoneNumberId: phoneNumberId || undefined,
      customer: {
        number: toPhone
      }
    })
  });

  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { raw: text }; }
  log("vapi-call-result", { jobId: job.id, contactId, ok: response.ok, status: response.status, callId: result.id, error: result.message || result.error || null });
  return { skipped: false, ok: response.ok, status: response.status, callId: result.id, error: result.message || result.error || null };
}

async function callCustomerUpdate(config, job, updateType, techName, etaMinutes) {
  const { apiKey, phoneNumberId, baseUrl } = config.vapi || {};
  if (!apiKey) {
    log("customer-callback-skip", { jobId: job.id, reason: "Vapi not configured." });
    return { skipped: true, reason: "Vapi not configured." };
  }

  const customerPhone = normalizeString(job.callbackNumber);
  if (!customerPhone) {
    log("customer-callback-skip", { jobId: job.id, reason: "No callback number." });
    return { skipped: true, reason: "No callback number." };
  }

  log("customer-callback-start", { jobId: job.id, updateType, customerPhone, techName: techName || null });

  const businessName = config.workspace?.businessName || "Viking Refrigeration";
  const etaText = etaMinutes ? ` They should be there in about ${etaMinutes} minutes.` : "";
  const templateValues = { ...getTemplateValues(job), businessName, techName: techName || "a technician", etaMinutes: etaMinutes || "30 to 45", etaText };

  let firstMessage, systemPrompt;
  if (updateType === "initial") {
    const scriptTemplate = config.voiceScripts?.customerInitial;
    firstMessage = scriptTemplate ? renderTemplate(scriptTemplate, templateValues) : `Hi ${job.callerName || "there"}, this is ${businessName}. We received your request about the ${job.issueType || "service"} issue and we're reaching out to our on-call team right now. Someone should be calling you back shortly to confirm the plan.`;
    systemPrompt = `You are a callback agent for ${businessName}. You just informed the customer that their request has been received and the on-call team is being contacted. Answer simple questions briefly. Don't promise an ETA or a specific tech. If they ask who is coming, say "We're reaching out to the team now and will call you back as soon as we have confirmation." Keep it short and friendly. Once they confirm, say "Great, sit tight and we'll be in touch shortly." and end the call.`;
  } else if (updateType === "accepted" || updateType === "sub_cancelled_tech_assigned") {
    const scriptKey = updateType === "sub_cancelled_tech_assigned" ? "customerSubCancelledTechAssigned" : "customerAccepted";
    const scriptTemplate = config.voiceScripts?.[scriptKey];
    firstMessage = scriptTemplate ? renderTemplate(scriptTemplate, templateValues) : `Hi ${job.callerName || "there"}, this is ${businessName} calling back about your ${job.issueType || "service"} emergency. Good news — we've got a tech heading your way.${etaText} They'll call you when they're close. Is there anything else you need before they arrive?`;
    systemPrompt = `You are a callback agent for ${businessName}. You just informed the customer that a tech has been dispatched. Answer any simple questions briefly. If they ask about pricing, say the tech can discuss that on site. If they ask for an ETA, say approximately ${etaMinutes || "30 to 45"} minutes. Keep it short and friendly. Once they confirm they're good, say "Great, sit tight and the tech will be there soon. Have a good night." and end the call.`;
  } else if (updateType === "sub_dispatched") {
    const scriptTemplate = config.voiceScripts?.customerSubDispatched;
    firstMessage = scriptTemplate ? renderTemplate(scriptTemplate, templateValues) : `Hi ${job.callerName || "there"}, this is ${businessName} calling back. We've arranged a service partner to assist you tonight with your ${job.issueType || "service"} issue. They should be reaching out to you shortly.`;
    systemPrompt = `You are a callback agent for ${businessName}. You just informed the customer that a service partner has been arranged. Answer simple questions briefly. If they ask who exactly is coming, say "One of our service partners — they'll be in touch with you directly." If they ask about cost, say "The partner can discuss that when they arrive." Keep it short. Once they confirm, end the call.`;
  } else {
    const scriptTemplate = config.voiceScripts?.customerUnavailable;
    firstMessage = scriptTemplate ? renderTemplate(scriptTemplate, templateValues) : `Hi ${job.callerName || "there"}, this is ${businessName} calling back about your ${job.issueType || "service"} request. Unfortunately we weren't able to reach any of our on-call techs tonight. If this is still urgent, you can call our direct line at 587-809-6383. We really apologize for the inconvenience.`;
    systemPrompt = `You are a callback agent for ${businessName}. You just informed the customer that no technician is available tonight. Be empathetic and apologetic. If they're upset, acknowledge it. Remind them they can call 587-809-6383 for the direct line, or call back when the office opens at 8 AM. Keep it brief. Once they acknowledge, say "Again, we're sorry about this. Stay safe tonight." and end the call.`;
  }

  const response = await fetch(`${baseUrl || "https://api.vapi.ai"}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      assistant: {
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: systemPrompt }]
        },
        voice: { provider: "11labs", voiceId: "cjVigY5qzO86Huf0OWal", stability: 0.6, similarityBoost: 0.85 },
        transcriber: { provider: "deepgram", model: "nova-2", language: "en" },
        backgroundDenoisingEnabled: true,
        silenceTimeoutSeconds: 20,
        firstMessage
      },
      phoneNumberId: phoneNumberId || undefined,
      customer: { number: customerPhone }
    })
  });

  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { raw: text }; }
  log("customer-callback-result", { jobId: job.id, updateType, ok: response.ok, status: response.status, callId: result.id, error: result.message || result.error || null });
  return { skipped: false, ok: response.ok, status: response.status, callId: result.id, error: result.message || result.error || null };
}

async function dispatchBatch(job, batch, config) {
  log("dispatch-batch", { jobId: job.id, tier: batch.tier, contactCount: batch.contacts.length, contactNames: batch.contacts.map((c) => c.name) });
  const results = [];
  for (const contact of batch.contacts) {
    const phone = normalizeString(contact.phone);
    if (!phone) {
      log("dispatch-skip-no-phone", { jobId: job.id, contactId: contact.id, contactName: contact.name });
      continue;
    }

    // Send SMS if enabled
    if (batch.strategy.sendSms && contact.renderedSms) {
      const smsResult = await sendTwilioSms(config, phone, contact.renderedSms);
      const attempt = {
        id: `attempt_${randomUUID()}`,
        at: new Date().toISOString(),
        contactId: contact.id,
        channel: "sms",
        status: smsResult.ok ? "queued" : "failed",
        notes: smsResult.error || ""
      };
      job.attempts.push(attempt);
      appendTimeline(job, "attempt-logged", { ...attempt, twilioSid: smsResult.sid });
      results.push({ contactId: contact.id, channel: "sms", result: smsResult });
    }

    // Start outbound call via Vapi
    const callResult = await startVapiOutboundCall(config, phone, job, contact.id, contact.name);
    if (!callResult.skipped) {
      const attempt = {
        id: `attempt_${randomUUID()}`,
        at: new Date().toISOString(),
        contactId: contact.id,
        channel: "call",
        status: callResult.ok ? "ringing" : "failed",
        notes: callResult.error || ""
      };
      job.attempts.push(attempt);
      appendTimeline(job, "attempt-logged", { ...attempt, vapiCallId: callResult.callId, vapiError: callResult.error });
      results.push({ contactId: contact.id, channel: "call", result: callResult });
    }
  }
  return results;
}

function scheduleEscalation(jobId, delayMinutes, config, scheduledForStep) {
  clearEscalation(jobId);
  log("escalation-scheduled", { jobId, delayMinutes, scheduledForStep });
  const timer = setTimeout(async () => {
    escalationTimers.delete(jobId);
    try {
      const jobs = await loadJobs();
      const job = jobs.find((j) => j.id === jobId);
      if (!job || getJobStatus(job) !== "open") {
        log("escalation-skip", { jobId, reason: !job ? "job not found" : `state: ${job?.state}` });
        return;
      }
      // Skip if a decline already advanced past this step
      if (scheduledForStep != null && job.escalationStep !== scheduledForStep) {
        log("escalation-skip", { jobId, reason: "step already advanced", scheduledForStep, currentStep: job.escalationStep });
        return;
      }
      log("escalation-firing", { jobId, step: job.escalationStep });
      const currentConfig = await loadConfig();
      await advanceEscalation(job, currentConfig, jobs);
    } catch (error) {
      log("escalation-error", { jobId, error: error.message });
    }
  }, delayMinutes * 60 * 1000);
  escalationTimers.set(jobId, timer);
}

function clearEscalation(jobId) {
  const existing = escalationTimers.get(jobId);
  if (existing) {
    clearTimeout(existing);
    escalationTimers.delete(jobId);
  }
}

function mergeConfig(config) {
  return {
    ...clone(defaultConfig),
    ...clone(config),
    workspace: {
      ...clone(defaultConfig.workspace),
      ...(config.workspace || {}),
      businessHours: {
        ...clone(defaultConfig.workspace.businessHours),
        ...((config.workspace || {}).businessHours || {})
      }
    },
    slack: { ...clone(defaultConfig.slack), ...(config.slack || {}) },
    twilio: { ...clone(defaultConfig.twilio), ...(config.twilio || {}) },
    vapi: { ...clone(defaultConfig.vapi), ...(config.vapi || {}) },
    intakeFields: Array.isArray(config.intakeFields) ? config.intakeFields : clone(defaultConfig.intakeFields),
    contacts: Array.isArray(config.contacts) ? config.contacts : clone(defaultConfig.contacts),
    routingRules: Array.isArray(config.routingRules) ? config.routingRules : clone(defaultConfig.routingRules),
    messageTemplates: { ...clone(defaultConfig.messageTemplates), ...(config.messageTemplates || {}) },
    voiceScripts: { ...clone(defaultConfig.voiceScripts), ...(config.voiceScripts || {}) },
    humanReview: { ...clone(defaultConfig.humanReview), ...(config.humanReview || {}) },
    escalation: { ...clone(defaultConfig.escalation), ...(config.escalation || {}) }
  };
}

function overlayEnvSecrets(config) {
  if (process.env.SLACK_WEBHOOK_URL) config.slack = { ...config.slack, webhookUrl: process.env.SLACK_WEBHOOK_URL };
  if (process.env.SLACK_BOT_TOKEN) config.slack = { ...config.slack, botToken: process.env.SLACK_BOT_TOKEN };
  if (process.env.SLACK_CHANNEL_ID) config.slack = { ...config.slack, channelId: process.env.SLACK_CHANNEL_ID };
  if (process.env.TWILIO_ACCOUNT_SID) config.twilio = { ...config.twilio, accountSid: process.env.TWILIO_ACCOUNT_SID };
  if (process.env.TWILIO_AUTH_TOKEN) config.twilio = { ...config.twilio, authToken: process.env.TWILIO_AUTH_TOKEN };
  if (process.env.VAPI_API_KEY) config.vapi = { ...config.vapi, apiKey: process.env.VAPI_API_KEY };
  if (process.env.VAPI_DISPATCH_ASSISTANT_ID) config.vapi = { ...config.vapi, dispatchAssistantId: process.env.VAPI_DISPATCH_ASSISTANT_ID };
  if (process.env.VAPI_PHONE_NUMBER_ID) config.vapi = { ...config.vapi, phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID };
  return config;
}

async function saveConfig(config) {
  const merged = mergeConfig(config);
  const sql = getDb();
  if (sql) {
    await sql`INSERT INTO pv_config (id, data, updated_at) VALUES ('default', ${JSON.stringify(merged)}, NOW())
              ON CONFLICT (id) DO UPDATE SET data = ${JSON.stringify(merged)}, updated_at = NOW()`;
  }
  return merged;
}

async function loadConfig() {
  const sql = getDb();
  let current = clone(defaultConfig);
  if (sql) {
    const rows = await sql`SELECT data FROM pv_config WHERE id = 'default'`;
    if (rows.length > 0) {
      current = rows[0].data;
    }
  }
  const merged = mergeConfig(current);
  overlayEnvSecrets(merged);
  return saveConfig(merged);
}

async function loadJobs() {
  const sql = getDb();
  if (!sql) return [];
  const rows = await sql`SELECT data FROM pv_jobs ORDER BY created_at DESC LIMIT 200`;
  return rows.map((r) => r.data);
}

async function saveJobs(jobs) {
  const sql = getDb();
  if (!sql) return;
  for (const job of jobs) {
    await sql`INSERT INTO pv_jobs (id, data, created_at, updated_at) VALUES (${job.id}, ${JSON.stringify(job)}, ${job.createdAt}, NOW())
              ON CONFLICT (id) DO UPDATE SET data = ${JSON.stringify(job)}, updated_at = NOW()`;
  }
}

function sanitizeConfigForUi(config) {
  return config;
}

async function handleApi(req, res, pathname) {
  const config = await loadConfig();
  const jobs = await loadJobs();
  const host = req.headers.host || `localhost:${PORT}`;
  const baseUrl = `${req.headers["x-forwarded-proto"] || "http"}://${host}`;

  // Skip logging for high-frequency read endpoints
  if (pathname !== "/api/health" && pathname !== "/api/config" && pathname !== "/api/jobs") {
    log("api-request", { method: req.method, pathname });
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, port: PORT });
  }

  if (req.method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, sanitizeConfigForUi(config));
  }

  if (req.method === "PUT" && pathname === "/api/config") {
    log("config-update", { source: "dashboard" });
    const body = await parseBody(req);
    const saved = await saveConfig(body);
    return sendJson(res, 200, saved);
  }

  if (req.method === "GET" && pathname === "/api/jobs") {
    const sorted = clone(jobs).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sendJson(res, 200, sorted);
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    const body = await parseBody(req);
    log("job-create", { source: "api", callerName: body.callerName, issueType: body.issueType, urgency: body.urgency });
    const job = createJobFromPayload(body, config);
    const batch = buildDispatchBatch(job, config);
    jobs.push(job);
    log("job-created", { jobId: job.id, matchedRule: job.matchedRuleId || "(none)", batchSize: batch.contacts.length });
    await saveJobs(jobs);
    return sendJson(res, 201, { job, batch });
  }

  // --- Vapi tool-call webhooks ---
  // Vapi sends: { message: { type: "tool-calls", toolCallList: [{ id, name, arguments }] } }
  // We must respond: { results: [{ toolCallId, result }] }

  if (req.method === "POST" && pathname === "/api/vapi/create-job") {
    const body = await parseBody(req);
    const toolCall = body.message?.toolCallList?.[0];
    const args = toolCall?.arguments || toolCall?.function?.arguments || body;

    log("job-create", { source: "vapi", callerName: args.callerName, issueType: args.issueType, urgency: args.urgency, locationArea: args.locationArea });
    const job = createJobFromPayload(args, config);
    jobs.push(job);

    // Human review triggers at creation
    if (normalizeString(job.hazards)) await checkHumanReview(job, config, "safetyRisk", `Hazards reported: ${job.hazards}`);
    if (job.authorizedContact === false) await checkHumanReview(job, config, "pricingIssue", "Caller is not an authorized contact");
    if (normalizeString(job.poApprovalRequired)) await checkHumanReview(job, config, "pricingIssue", `PO/approval required: ${job.poApprovalRequired}`);

    // Post initial Slack summary and capture thread timestamp
    const slackText = renderTemplate(config.messageTemplates?.slackSummary, getTemplateValues(job));
    try {
      const slackResult = await sendSlackMessage(config, slackText);
      if (slackResult.ts) job.slackThreadTs = slackResult.ts;
      appendTimeline(job, "slack-summary", slackResult, "system");
    } catch (error) {
      appendTimeline(job, "slack-summary-failed", { message: error.message });
    }

    // Dispatch first step in escalation sequence
    const target = getEscalationTarget(job, config);
    let resultMessage;
    if (target) {
      const rule = (config.routingRules || []).find((r) => r.id === job.matchedRuleId);
      const sequence = rule?.strategy?.escalationSequence || [];
      const newState = stateForStep(target.step, sequence);
      if (newState) transitionState(job, newState, { contactId: target.contact.id });
      log("job-created", { jobId: job.id, matchedRule: job.matchedRuleId || "(none)", firstContact: target.contact.name, step: target.step });

      const smsTemplate = target.isPartner
        ? (config.messageTemplates?.subcontractorSms || defaultConfig.messageTemplates.subcontractorSms)
        : (config.messageTemplates?.techSms || defaultConfig.messageTemplates.techSms);
      const values = getTemplateValues(job, target.contact);
      const batch = {
        contacts: [{ ...target.contact, renderedSms: renderTemplate(smsTemplate, values), renderedSummary: buildJobSummary(job) }],
        strategy: rule?.strategy || { sendSms: true },
        tier: target.contact.priorityTier || 1,
        matchedRule: rule
      };
      await dispatchBatch(job, batch, config);

      const timerMinutes = Number(rule?.strategy?.escalateAfterMinutes || config.escalation?.defaultTimerMinutes || 3);
      scheduleEscalation(job.id, timerMinutes, config, job.escalationStep);
      resultMessage = `Job ${job.id} created. Contacting ${target.contact.name}.`;
    } else {
      log("job-created", { jobId: job.id, matchedRule: job.matchedRuleId || "(none)", firstContact: "(none)" });
      resultMessage = `Job ${job.id} created. No contacts available for dispatch.`;
    }
    await saveJobs(jobs);

    if (toolCall?.id) {
      return sendJson(res, 200, {
        results: [{ toolCallId: toolCall.id, result: JSON.stringify({ success: true, message: resultMessage, jobId: job.id }) }]
      });
    }
    return sendJson(res, 200, { success: true, message: resultMessage, jobId: job.id });
  }

  if (req.method === "POST" && pathname === "/api/vapi/accept-job") {
    const body = await parseBody(req);
    const toolCall = body.message?.toolCallList?.[0];
    const args = toolCall?.arguments || toolCall?.function?.arguments || body;
    log("vapi-accept-job", { jobId: args.jobId, contactId: args.contactId, status: args.status || "accepted" });

    // Vapi agent may pass contact name instead of ID — resolve it
    if (args.contactId && !(config.contacts || []).find((c) => c.id === args.contactId)) {
      const byName = (config.contacts || []).find((c) => c.name.toLowerCase() === String(args.contactId).toLowerCase());
      if (byName) args.contactId = byName.id;
    }

    let job = jobs.find((item) => item.id === args.jobId);
    // Fuzzy match — voice models sometimes truncate UUIDs
    if (!job && args.jobId) {
      job = jobs.find((item) => item.id.startsWith(args.jobId) || item.id.includes(args.jobId));
    }
    // Last resort — use most recent open job
    if (!job) {
      job = [...jobs].reverse().find((item) => item.status === "open");
    }
    if (!job) {
      const err = { error: "Job not found." };
      if (toolCall?.id) return sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: JSON.stringify(err) }] });
      return sendJson(res, 404, err);
    }

    // Guard: already accepted
    if (getJobStatus(job) === "accepted" || job.state === STATES.CLOSED) {
      const err = { success: false, reason: "Job already accepted." };
      if (toolCall?.id) return sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: JSON.stringify(err) }] });
      return sendJson(res, 200, err);
    }

    if (args.status === "declined") {
      log("job-declined", { source: "vapi", jobId: job.id, contactId: args.contactId });
      const declinedContact = (config.contacts || []).find((item) => item.id === args.contactId);
      const attempt = {
        id: `attempt_${randomUUID()}`,
        at: new Date().toISOString(),
        contactId: normalizeString(args.contactId),
        channel: "call",
        status: "declined",
        notes: normalizeString(args.notes)
      };
      job.attempts.push(attempt);
      job.updatedAt = new Date().toISOString();
      appendTimeline(job, "job-declined", attempt, `tech:${args.contactId}`);

      try {
        await sendSlackMessage(config, `*Tech declined* — ${declinedContact?.name || args.contactId} declined job ${job.id} (${job.issueType} at ${job.locationArea}).`);
      } catch {}

      // Immediately advance to next escalation step
      await advanceEscalation(job, config, jobs);

      const result = { success: true, status: "declined" };
      if (toolCall?.id) return sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: JSON.stringify(result) }] });
      return sendJson(res, 200, result);
    }

    // accepted
    const contact = (config.contacts || []).find((item) => item.id === args.contactId);
    log("job-accepted", { source: "vapi", jobId: job.id, contactId: args.contactId, contactName: contact?.name || args.contactId, etaMinutes: args.etaMinutes });

    // Handle late accepts (provisional sub or exhausted state)
    if (job.state === STATES.PROVISIONAL_SUB_ASSIGNMENT || job.state === STATES.UNABLE_TO_DISPATCH) {
      const handled = await handleLateAccept(job, config, contact || { id: args.contactId, name: args.contactId }, jobs);
      if (handled) {
        job.acceptedBy = { contactId: normalizeString(args.contactId), contactName: contact?.name || "", channel: "call", at: new Date().toISOString(), etaMinutes: args.etaMinutes || null, notes: normalizeString(args.notes) };
        await saveJobs(jobs);
        const result = { success: true, status: "accepted" };
        if (toolCall?.id) return sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: JSON.stringify(result) }] });
        return sendJson(res, 200, result);
      }
    }

    transitionState(job, STATES.DISPATCH_CONFIRMED_INTERNAL, { contactId: args.contactId });
    job.acceptedBy = {
      contactId: normalizeString(args.contactId),
      contactName: contact?.name || "",
      channel: "call",
      at: new Date().toISOString(),
      etaMinutes: args.etaMinutes || null,
      notes: normalizeString(args.notes)
    };
    appendTimeline(job, "job-accepted", job.acceptedBy, `tech:${args.contactId}`);
    clearEscalation(job.id);

    const acknowledgement = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(job, contact));
    try { await sendSlackMessage(config, acknowledgement); } catch {}

    const customerCallResult = await callCustomerUpdate(config, job, "accepted", contact?.name || "a technician", args.etaMinutes);
    appendTimeline(job, "customer-callback", { type: "accepted", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
    job.customerCallbacks.push({ type: "accepted", at: new Date().toISOString(), outcome: customerCallResult.ok ? "completed" : "failed", callId: customerCallResult.callId, error: customerCallResult.error || null });
    await saveJobs(jobs);

    const result = { success: true, status: "accepted" };
    if (toolCall?.id) return sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: JSON.stringify(result) }] });
    return sendJson(res, 200, result);
  }

  // Twilio incoming SMS webhook — techs reply YES/NO
  if (req.method === "POST" && pathname === "/api/twilio/incoming-sms") {
    const body = await parseBody(req);
    const from = normalizeString(body.From);
    const smsBody = normalizeString(body.Body).toLowerCase();
    const isAccept = ["yes", "y", "accept", "ok"].includes(smsBody);
    const isDecline = ["no", "n", "decline", "pass"].includes(smsBody);
    log("sms-incoming", { from, body: body.Body, isAccept, isDecline });

    // Find the contact by phone number
    const contact = (config.contacts || []).find((c) => normalizeString(c.phone) === from || normalizeString(c.smsPhone) === from);
    if (!contact) {
      log("sms-unknown-number", { from });
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end("<Response><Message>Unknown number. Contact dispatch directly.</Message></Response>");
    }

    log("sms-contact-matched", { from, contactId: contact.id, contactName: contact.name });

    // Find the most recent open job this contact was dispatched to
    // Find open, provisional, or exhausted jobs this contact was dispatched to
    const activeJobs = jobs.filter((j) => getJobStatus(j) === "open" || j.state === STATES.PROVISIONAL_SUB_ASSIGNMENT || j.state === STATES.UNABLE_TO_DISPATCH);
    const matchedJob = activeJobs.find((j) =>
      (j.attempts || []).some((a) => a.contactId === contact.id)
    ) || activeJobs.find((j) => j.provisionalSubId === contact.id);

    if (!matchedJob) {
      log("sms-no-open-job", { contactId: contact.id });
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end("<Response><Message>No active job found for you.</Message></Response>");
    }

    if (isAccept) {
      log("job-accepted", { source: "sms", jobId: matchedJob.id, contactId: contact.id, contactName: contact.name });

      // Handle late accepts
      if (matchedJob.state === STATES.PROVISIONAL_SUB_ASSIGNMENT || matchedJob.state === STATES.UNABLE_TO_DISPATCH) {
        const handled = await handleLateAccept(matchedJob, config, contact, jobs);
        if (handled) {
          matchedJob.acceptedBy = { contactId: contact.id, contactName: contact.name, channel: "sms", at: new Date().toISOString() };
          await saveJobs(jobs);
          const ackText = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(matchedJob, contact));
          await sendTwilioSms(config, from, ackText);
          res.writeHead(200, { "Content-Type": "text/xml" });
          return res.end(`<Response><Message>${ackText}</Message></Response>`);
        }
      }

      transitionState(matchedJob, STATES.DISPATCH_CONFIRMED_INTERNAL, { contactId: contact.id });
      matchedJob.acceptedBy = {
        contactId: contact.id,
        contactName: contact.name,
        channel: "sms",
        at: new Date().toISOString()
      };
      appendTimeline(matchedJob, "job-accepted", matchedJob.acceptedBy, `tech:${contact.id}`);
      clearEscalation(matchedJob.id);

      const ackText = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(matchedJob, contact));
      await sendTwilioSms(config, from, ackText);
      try { await sendSlackMessage(config, ackText); } catch {}

      // Call customer to let them know a tech is on the way
      const customerCallResult = await callCustomerUpdate(config, matchedJob, "accepted", contact.name);
      appendTimeline(matchedJob, "customer-callback", { type: "accepted", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
      await saveJobs(jobs);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(`<Response><Message>${ackText}</Message></Response>`);
    }

    if (isDecline) {
      log("job-declined", { source: "sms", jobId: matchedJob.id, contactId: contact.id, contactName: contact.name });
      const attempt = {
        id: `attempt_${randomUUID()}`,
        at: new Date().toISOString(),
        contactId: contact.id,
        channel: "sms",
        status: "declined",
        notes: `SMS reply: ${body.Body}`
      };
      matchedJob.attempts.push(attempt);
      matchedJob.updatedAt = new Date().toISOString();
      appendTimeline(matchedJob, "job-declined", attempt, `tech:${contact.id}`);

      try {
        await sendSlackMessage(config, `*Tech declined via SMS* — ${contact.name} declined job ${matchedJob.id} (${matchedJob.issueType} at ${matchedJob.locationArea}).`);
      } catch {}

      // Immediately advance to next escalation step
      await advanceEscalation(matchedJob, config, jobs);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end("<Response><Message>Got it, you've been removed from this job.</Message></Response>");
    }

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end("<Response><Message>Reply YES to accept or NO to decline.</Message></Response>");
  }

  // Vapi call-ended webhook
  if (req.method === "POST" && pathname === "/api/vapi/call-ended") {
    const body = await parseBody(req);
    const metadata = body.message?.call?.metadata || body.metadata || {};
    const jobId = metadata.jobId;
    const contactId = metadata.contactId || metadata.techContactId;
    const callStatus = normalizeString(body.message?.call?.status || body.status || body.call_status);
    log("call-ended", { source: "vapi", jobId, contactId, callStatus, duration: body.message?.call?.duration || body.duration });

    if (jobId) {
      const job = jobs.find((j) => j.id === jobId);
      if (job) {
        appendTimeline(job, "call-ended", { contactId, callStatus, duration: body.message?.call?.duration || body.duration });
        const attempt = (job.attempts || []).find((a) => a.contactId === contactId && a.channel === "call" && a.status === "ringing");
        if (attempt) {
          attempt.status = callStatus === "ended" || callStatus === "completed" ? "answered" : (callStatus || "no-answer");
        }
        // If call ended without acceptance and job is still open, advance escalation
        const noAnswer = !["ended", "completed"].includes(callStatus);
        if (noAnswer && getJobStatus(job) === "open") {
          log("call-no-answer-advance", { jobId, contactId, callStatus });
          await advanceEscalation(job, config, jobs);
        } else {
          job.updatedAt = new Date().toISOString();
          await saveJobs(jobs);
        }
      }
    }
    return sendJson(res, 200, { success: true });
  }

  // Resolve human review flag
  if (req.method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/resolve-review")) {
    const jobId = pathname.split("/")[3];
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return sendJson(res, 404, { error: "Job not found." });
    const body = await parseBody(req);
    const flagIndex = (job.humanReviewFlags || []).findIndex((f) => f.trigger === body.trigger && !f.resolved);
    if (flagIndex >= 0) {
      job.humanReviewFlags[flagIndex].resolved = true;
      job.humanReviewFlags[flagIndex].resolvedAt = new Date().toISOString();
      job.humanReviewFlags[flagIndex].resolvedBy = normalizeString(body.resolvedBy || "dispatcher");
      appendTimeline(job, "human-review-resolved", { trigger: body.trigger }, "dispatcher");
      await saveJobs(jobs);
    }
    return sendJson(res, 200, { success: true, job });
  }

  sendJson(res, 404, { error: "Not found." });
}

async function serveStatic(res, pathname) {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(relativePath).replace(/^(\.\.[/\\])+/, ""));

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return serveStatic(res, path.join(relativePath, "index.html"));
    }
    const ext = path.extname(filePath).toLowerCase();
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    sendText(res, 404, "Not found.");
  }
}

let _initialized = false;

async function ensureInit() {
  if (_initialized) return;
  await ensureDataFiles();
  _initialized = true;
}

async function handler(req, res) {
  try {
    await ensureInit();
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url.pathname);
    }
    if (process.env.VERCEL === "1") {
      return sendText(res, 404, "Not found.");
    }
    return await serveStatic(res, url.pathname);
  } catch (error) {
    log("api-error", { method: req.method, url: req.url, error: error.message, stack: error.stack?.split("\n").slice(0, 3).join(" | ") });
    sendJson(res, 500, { error: error.message });
  }
}

async function start() {
  await ensureDataFiles();
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`Phone Viking dashboard running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start();
}

// Vercel serverless handler
module.exports = handler;
module.exports.default = handler;
