const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const IS_VERCEL = process.env.VERCEL === "1";
const DATA_DIR = IS_VERCEL ? "/tmp/data" : path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const PORT = Number(process.env.PORT || 3007);

// Active escalation timers keyed by jobId
const escalationTimers = new Map();

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
  millis: {
    apiKey: process.env.MILLIS_API_KEY || "",
    publicKey: process.env.MILLIS_PUBLIC_KEY || "",
    intakeAgentId: process.env.MILLIS_AGENT_ID || "",
    dispatchAgentId: process.env.MILLIS_AGENT_ID || "",
    baseUrl: "https://api-west.millis.ai"
  },
  vapi: {
    apiKey: process.env.VAPI_API_KEY || "",
    dispatchAssistantId: process.env.VAPI_DISPATCH_ASSISTANT_ID || "",
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || "",
    baseUrl: "https://api.vapi.ai"
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
      "Confirmed. {{contactName}} has accepted job {{jobId}}."
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
        escalateAfterMinutes: 5,
        leaveVoicemail: false,
        sendSms: true,
        notifySlackOnEscalation: true
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
        escalateAfterMinutes: 5,
        leaveVoicemail: false,
        sendSms: true,
        notifySlackOnEscalation: true
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
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await ensureFile(CONFIG_FILE, defaultConfig);
  await ensureFile(JOBS_FILE, []);
}

async function ensureFile(filePath, fallbackValue) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, `${JSON.stringify(fallbackValue, null, 2)}\n`, "utf8");
  }
}

async function readJson(filePath, fallbackValue) {
  try {
    const value = await fs.readFile(filePath, "utf8");
    return JSON.parse(value);
  } catch {
    return fallbackValue;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

  // Try parsing as JSON even without the header (Millis may not send Content-Type)
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

function appendTimeline(job, type, payload = {}) {
  const event = {
    id: `evt_${randomUUID()}`,
    type,
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
    status: "open",
    callerName: normalizeString(payload.callerName),
    callbackNumber: normalizeString(payload.callbackNumber),
    serviceAddress: normalizeString(payload.serviceAddress),
    locationArea: normalizeString(payload.locationArea || payload.serviceAddress),
    issueType: normalizeString(payload.issueType),
    urgency: normalizeString(payload.urgency || "routine"),
    summary: normalizeString(payload.summary),
    notes: normalizeString(payload.notes),
    metadata: payload.metadata || {},
    matchedRuleId: "",
    attempts: [],
    acceptedBy: null,
    timeline: []
  };

  const matchedRule = findMatchingRule(job, config);
  job.matchedRuleId = matchedRule?.id || "";
  appendTimeline(job, "job-created", { matchedRuleId: job.matchedRuleId });
  return job;
}

async function sendSlackMessage(config, text) {
  if (!config?.slack?.enabled || !normalizeString(config.slack.webhookUrl)) {
    return { skipped: true, reason: "Slack disabled or webhook missing." };
  }

  const response = await fetch(config.slack.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  const body = await response.text();
  return {
    skipped: false,
    ok: response.ok,
    status: response.status,
    body
  };
}

async function sendTwilioSms(config, to, body) {
  const { accountSid, authToken, smsNumber } = config.twilio || {};
  if (!accountSid || !authToken || !smsNumber) {
    return { skipped: true, reason: "Twilio not configured." };
  }

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
  return { skipped: false, ok: response.ok, status: response.status, sid: result.sid, error: result.message };
}

async function startMillisOutboundCall(config, toPhone, job, contactId, contactName) {
  const { apiKey, dispatchAgentId, baseUrl } = config.millis || {};
  if (!apiKey || !dispatchAgentId) {
    return { skipped: true, reason: "Millis dispatch agent not configured." };
  }

  const fromPhone = normalizeString(config.millis?.outboundNumber);

  const response = await fetch(`${baseUrl || "https://api-west.millis.ai"}/start_outbound_call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey
    },
    body: JSON.stringify({
      agent_id: dispatchAgentId,
      from_phone: fromPhone || undefined,
      to_phone: toPhone,
      metadata: {
        jobId: job.id,
        contactId,
        techName: contactName,
        issueType: job.issueType,
        jobAddress: job.serviceAddress,
        summary: job.summary,
        callerName: job.callerName,
        callbackNumber: job.callbackNumber,
        notes: job.notes
      },
      include_metadata_in_prompt: true
    })
  });

  const result = await response.json();
  return { skipped: false, ok: response.ok, status: response.status, callId: result.call_id, sessionId: result.session_id };
}

async function startVapiOutboundCall(config, toPhone, job, contactId, contactName) {
  const { apiKey, dispatchAssistantId, phoneNumberId, baseUrl } = config.vapi || {};
  if (!apiKey || !dispatchAssistantId) {
    return { skipped: true, reason: "Vapi dispatch agent not configured." };
  }

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
  return { skipped: false, ok: response.ok, status: response.status, callId: result.id, error: result.message || result.error || null };
}

async function callCustomerUpdate(config, job, updateType, techName, etaMinutes) {
  const { apiKey, phoneNumberId, baseUrl } = config.vapi || {};
  if (!apiKey) return { skipped: true, reason: "Vapi not configured." };

  const customerPhone = normalizeString(job.callbackNumber);
  if (!customerPhone) return { skipped: true, reason: "No callback number." };

  let firstMessage, systemPrompt;
  if (updateType === "accepted") {
    const eta = etaMinutes ? ` They should be there in about ${etaMinutes} minutes.` : "";
    firstMessage = `Hi ${job.callerName || "there"}, this is Viking Refrigeration calling back about your ${job.issueType || "service"} emergency. Good news — we've got a tech heading your way.${eta} They'll call you when they're close. Is there anything else you need before they arrive?`;
    systemPrompt = `You are a callback agent for Viking Refrigeration. You just informed the customer that a tech has been dispatched. Answer any simple questions briefly. If they ask about pricing, say the tech can discuss that on site. If they ask for an ETA, say approximately ${etaMinutes || "30 to 45"} minutes. Keep it short and friendly. Once they confirm they're good, say "Great, sit tight and the tech will be there soon. Have a good night." and end the call.`;
  } else {
    firstMessage = `Hi ${job.callerName || "there"}, this is Viking Refrigeration calling back about your ${job.issueType || "service"} request. Unfortunately we weren't able to reach any of our on-call techs tonight. If this is still urgent, you can call our direct line at 587-809-6383. We really apologize for the inconvenience.`;
    systemPrompt = `You are a callback agent for Viking Refrigeration. You just informed the customer that no technician is available tonight. Be empathetic and apologetic. If they're upset, acknowledge it. Remind them they can call 587-809-6383 for the direct line, or call back when the office opens at 8 AM. Keep it brief. Once they acknowledge, say "Again, we're sorry about this. Stay safe tonight." and end the call.`;
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
        voice: { provider: "11labs", voiceId: "21m00Tcm4TlvDq8ikWAM" },
        firstMessage
      },
      phoneNumberId: phoneNumberId || undefined,
      customer: { number: customerPhone }
    })
  });

  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { raw: text }; }
  return { skipped: false, ok: response.ok, status: response.status, callId: result.id, error: result.message || result.error || null };
}

async function dispatchBatch(job, batch, config) {
  const results = [];
  for (const contact of batch.contacts) {
    const phone = normalizeString(contact.phone);
    if (!phone) continue;

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

    // Start outbound call via Vapi (fallback to Millis if Vapi not configured)
    const callResult = (config.vapi?.apiKey && config.vapi?.dispatchAssistantId)
      ? await startVapiOutboundCall(config, phone, job, contact.id, contact.name)
      : await startMillisOutboundCall(config, phone, job, contact.id, contact.name);
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

function scheduleEscalation(jobId, delayMinutes, config) {
  clearEscalation(jobId);
  const timer = setTimeout(async () => {
    escalationTimers.delete(jobId);
    try {
      const jobs = await loadJobs();
      const job = jobs.find((j) => j.id === jobId);
      if (!job || job.status === "accepted") return;

      const currentConfig = await loadConfig();
      const batch = buildDispatchBatch(job, currentConfig);
      if (!batch.contacts.length) {
        appendTimeline(job, "escalation-exhausted", { message: "No more contacts available." });
        if (batch.strategy.notifySlackOnEscalation) {
          await sendSlackMessage(currentConfig, `*Escalation exhausted* for job ${job.id} — no more contacts available.`);
        }
        // Call the customer to let them know no tech is available
        const customerCallResult = await callCustomerUpdate(currentConfig, job, "unavailable");
        appendTimeline(job, "customer-callback", { type: "unavailable", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
        await saveJobs(jobs);
        return;
      }

      appendTimeline(job, "escalation-triggered", { tier: batch.tier, contactIds: batch.contacts.map((c) => c.id) });
      if (batch.strategy.notifySlackOnEscalation) {
        await sendSlackMessage(currentConfig, `*Escalating* job ${job.id} to tier ${batch.tier}: ${batch.contacts.map((c) => c.name).join(", ")}`);
      }

      await dispatchBatch(job, batch, currentConfig);
      job.updatedAt = new Date().toISOString();
      await saveJobs(jobs);

      // Schedule next escalation
      scheduleEscalation(jobId, batch.strategy.escalateAfterMinutes, currentConfig);
    } catch (error) {
      console.error(`Escalation error for job ${jobId}:`, error.message);
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

async function saveConfig(config) {
  const merged = {
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
    slack: {
      ...clone(defaultConfig.slack),
      ...(config.slack || {})
    },
    twilio: {
      ...clone(defaultConfig.twilio),
      ...(config.twilio || {})
    },
    millis: {
      ...clone(defaultConfig.millis),
      ...(config.millis || {})
    },
    vapi: {
      ...clone(defaultConfig.vapi),
      ...(config.vapi || {})
    },
    intakeFields: Array.isArray(config.intakeFields) ? config.intakeFields : clone(defaultConfig.intakeFields),
    contacts: Array.isArray(config.contacts) ? config.contacts : [],
    routingRules: Array.isArray(config.routingRules) ? config.routingRules : clone(defaultConfig.routingRules),
    messageTemplates: {
      ...clone(defaultConfig.messageTemplates),
      ...(config.messageTemplates || {})
    }
  };

  await writeJson(CONFIG_FILE, merged);
  return merged;
}

async function loadConfig() {
  const current = await readJson(CONFIG_FILE, clone(defaultConfig));
  // Overlay secrets from env vars (so config.json can be committed without creds)
  if (process.env.SLACK_WEBHOOK_URL) current.slack = { ...current.slack, webhookUrl: process.env.SLACK_WEBHOOK_URL };
  if (process.env.TWILIO_ACCOUNT_SID) current.twilio = { ...current.twilio, accountSid: process.env.TWILIO_ACCOUNT_SID };
  if (process.env.TWILIO_AUTH_TOKEN) current.twilio = { ...current.twilio, authToken: process.env.TWILIO_AUTH_TOKEN };
  if (process.env.MILLIS_API_KEY) current.millis = { ...current.millis, apiKey: process.env.MILLIS_API_KEY };
  if (process.env.MILLIS_PUBLIC_KEY) current.millis = { ...current.millis, publicKey: process.env.MILLIS_PUBLIC_KEY };
  if (process.env.VAPI_API_KEY) current.vapi = { ...current.vapi, apiKey: process.env.VAPI_API_KEY };
  if (process.env.VAPI_DISPATCH_ASSISTANT_ID) current.vapi = { ...current.vapi, dispatchAssistantId: process.env.VAPI_DISPATCH_ASSISTANT_ID };
  if (process.env.VAPI_PHONE_NUMBER_ID) current.vapi = { ...current.vapi, phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID };
  return saveConfig(current);
}

async function loadJobs() {
  return readJson(JOBS_FILE, []);
}

async function saveJobs(jobs) {
  await writeJson(JOBS_FILE, jobs);
}

function sanitizeConfigForUi(config) {
  return config;
}

function buildFunctionDefinitions(baseUrl) {
  return [
    {
      name: "create_job",
      method: "POST",
      url: `${baseUrl}/api/millis/create-job`,
      description: "Create a dispatch job from the intake agent and immediately return the best first outreach batch.",
      parameters: {
        callerName: "string",
        callbackNumber: "string",
        serviceAddress: "string",
        locationArea: "string",
        issueType: "string",
        urgency: "string",
        summary: "string",
        notes: "string"
      }
    },
    {
      name: "get_next_targets",
      method: "POST",
      url: `${baseUrl}/api/millis/get-next-targets`,
      description: "Return the next call/SMS batch for a job based on routing rules and prior attempts.",
      parameters: {
        jobId: "string",
        overrideTier: "number?"
      }
    },
    {
      name: "log_attempt",
      method: "POST",
      url: `${baseUrl}/api/millis/log-attempt`,
      description: "Record the result of a call or SMS attempt.",
      parameters: {
        jobId: "string",
        contactId: "string",
        channel: "call|sms",
        status: "queued|ringing|answered|accepted|declined|no-answer|voicemail|failed",
        notes: "string?"
      }
    },
    {
      name: "accept_job",
      method: "POST",
      url: `${baseUrl}/api/millis/accept-job`,
      description: "Mark a job accepted and stop escalation.",
      parameters: {
        jobId: "string",
        contactId: "string",
        channel: "call|sms",
        notes: "string?"
      }
    },
    {
      name: "decline_job",
      method: "POST",
      url: `${baseUrl}/api/millis/decline-job`,
      description: "Mark that a contact declined the job and return the next available batch if needed.",
      parameters: {
        jobId: "string",
        contactId: "string",
        channel: "call|sms",
        notes: "string?"
      }
    }
  ];
}

async function handleApi(req, res, pathname) {
  const config = await loadConfig();
  const jobs = await loadJobs();
  const host = req.headers.host || `localhost:${PORT}`;
  const baseUrl = `${req.headers["x-forwarded-proto"] || "http"}://${host}`;

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, port: PORT });
  }

  if (req.method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, sanitizeConfigForUi(config));
  }

  if (req.method === "PUT" && pathname === "/api/config") {
    const body = await parseBody(req);
    const saved = await saveConfig(body);
    return sendJson(res, 200, saved);
  }

  if (req.method === "GET" && pathname === "/api/jobs") {
    const sorted = clone(jobs).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sendJson(res, 200, sorted);
  }

  if (req.method === "GET" && pathname === "/api/millis/function-definitions") {
    return sendJson(res, 200, buildFunctionDefinitions(baseUrl));
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    const body = await parseBody(req);
    const job = createJobFromPayload(body, config);
    const batch = buildDispatchBatch(job, config);
    jobs.push(job);
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

    const job = createJobFromPayload(args, config);
    const batch = buildDispatchBatch(job, config);
    const slackText = renderTemplate(config.messageTemplates?.slackSummary, getTemplateValues(job));
    jobs.push(job);
    appendTimeline(job, "initial-batch-generated", {
      tier: batch.tier,
      contactIds: batch.contacts.map((contact) => contact.id)
    });
    await saveJobs(jobs);

    let slackResult = { skipped: true, reason: "Not attempted." };
    try {
      slackResult = await sendSlackMessage(config, slackText);
      appendTimeline(job, "slack-summary", slackResult);
      await saveJobs(jobs);
    } catch (error) {
      appendTimeline(job, "slack-summary-failed", { message: error.message });
      await saveJobs(jobs);
    }

    let dispatchResults = [];
    if (batch.contacts.length) {
      dispatchResults = await dispatchBatch(job, batch, config);
      await saveJobs(jobs);
      if (batch.strategy.escalateAfterMinutes > 0) {
        scheduleEscalation(job.id, batch.strategy.escalateAfterMinutes, config);
      }
    }

    const resultMessage = `Job ${job.id} created. ${batch.contacts.length} contact(s) being dispatched.`;

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

    if (args.status === "declined") {
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
      appendTimeline(job, "job-declined", attempt);

      // Notify Slack that tech declined
      try {
        await sendSlackMessage(config, `*Tech declined* — ${declinedContact?.name || args.contactId} declined job ${job.id} (${job.issueType} at ${job.locationArea}).`);
      } catch {}

      const batch = buildDispatchBatch(job, config);

      // If no more contacts to try, call customer immediately
      if (!batch.contacts.length) {
        appendTimeline(job, "escalation-exhausted", { message: "No more contacts available." });
        try {
          await sendSlackMessage(config, `*Escalation exhausted* for job ${job.id} — no techs available. Calling customer.`);
        } catch {}
        const customerCallResult = await callCustomerUpdate(config, job, "unavailable");
        appendTimeline(job, "customer-callback", { type: "unavailable", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
      }

      await saveJobs(jobs);

      const result = { success: true, status: "declined" };
      if (toolCall?.id) return sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: JSON.stringify(result) }] });
      return sendJson(res, 200, result);
    }

    // accepted
    const contact = (config.contacts || []).find((item) => item.id === args.contactId);
    job.status = "accepted";
    job.updatedAt = new Date().toISOString();
    job.acceptedBy = {
      contactId: normalizeString(args.contactId),
      contactName: contact?.name || "",
      channel: "call",
      at: new Date().toISOString(),
      etaMinutes: args.etaMinutes || null,
      notes: normalizeString(args.notes)
    };
    appendTimeline(job, "job-accepted", job.acceptedBy);
    clearEscalation(job.id);

    const acknowledgement = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(job, contact));
    try { await sendSlackMessage(config, acknowledgement); } catch {}

    // Call the customer to let them know a tech is on the way
    const customerCallResult = await callCustomerUpdate(config, job, "accepted", contact?.name || "a technician", args.etaMinutes);
    appendTimeline(job, "customer-callback", { type: "accepted", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
    await saveJobs(jobs);

    const result = { success: true, status: "accepted" };
    if (toolCall?.id) return sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: JSON.stringify(result) }] });
    return sendJson(res, 200, result);
  }

  // --- Millis endpoints (kept for backward compatibility) ---

  if (req.method === "POST" && pathname === "/api/millis/create-job") {
    const body = await parseBody(req);
    const job = createJobFromPayload(body, config);
    const batch = buildDispatchBatch(job, config);
    const slackText = renderTemplate(config.messageTemplates?.slackSummary, getTemplateValues(job));
    jobs.push(job);
    appendTimeline(job, "initial-batch-generated", {
      tier: batch.tier,
      contactIds: batch.contacts.map((contact) => contact.id)
    });
    await saveJobs(jobs);

    let slackResult = { skipped: true, reason: "Not attempted." };
    try {
      slackResult = await sendSlackMessage(config, slackText);
      appendTimeline(job, "slack-summary", slackResult);
      await saveJobs(jobs);
    } catch (error) {
      appendTimeline(job, "slack-summary-failed", { message: error.message });
      await saveJobs(jobs);
      slackResult = { skipped: false, ok: false, message: error.message };
    }

    // Actually dispatch SMS + calls to the first batch
    let dispatchResults = [];
    if (batch.contacts.length) {
      dispatchResults = await dispatchBatch(job, batch, config);
      await saveJobs(jobs);

      // Schedule escalation if no response
      if (batch.strategy.escalateAfterMinutes > 0) {
        scheduleEscalation(job.id, batch.strategy.escalateAfterMinutes, config);
      }
    }

    return sendJson(res, 200, {
      success: true,
      message: `Job ${job.id} created. ${batch.contacts.length} contact(s) being dispatched.`,
      jobId: job.id
    });
  }

  if (req.method === "POST" && pathname === "/api/millis/get-next-targets") {
    const body = await parseBody(req);
    const job = jobs.find((item) => item.id === body.jobId);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }
    const batch = buildDispatchBatch(job, config, { overrideTier: body.overrideTier });
    appendTimeline(job, "batch-requested", { tier: batch.tier, contactIds: batch.contacts.map((contact) => contact.id) });
    job.updatedAt = new Date().toISOString();
    await saveJobs(jobs);
    return sendJson(res, 200, { success: true, job, batch });
  }

  if (req.method === "POST" && pathname === "/api/millis/log-attempt") {
    const body = await parseBody(req);
    const job = jobs.find((item) => item.id === body.jobId);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }

    const attempt = {
      id: `attempt_${randomUUID()}`,
      at: new Date().toISOString(),
      contactId: normalizeString(body.contactId),
      channel: normalizeString(body.channel || "call"),
      status: normalizeString(body.status || "queued"),
      notes: normalizeString(body.notes)
    };

    job.attempts.push(attempt);
    job.updatedAt = new Date().toISOString();
    appendTimeline(job, "attempt-logged", attempt);

    if (attempt.status === "accepted") {
      const contact = (config.contacts || []).find((item) => item.id === attempt.contactId);
      job.status = "accepted";
      job.acceptedBy = {
        contactId: attempt.contactId,
        contactName: contact?.name || "",
        channel: attempt.channel,
        at: attempt.at
      };
    }

    await saveJobs(jobs);
    return sendJson(res, 200, { success: true, job, attempt });
  }

  if (req.method === "POST" && pathname === "/api/millis/accept-job") {
    const body = await parseBody(req);
    const job = jobs.find((item) => item.id === body.jobId);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }

    const contact = (config.contacts || []).find((item) => item.id === body.contactId);
    job.status = "accepted";
    job.updatedAt = new Date().toISOString();
    job.acceptedBy = {
      contactId: normalizeString(body.contactId),
      contactName: contact?.name || "",
      channel: normalizeString(body.channel || "call"),
      at: new Date().toISOString(),
      notes: normalizeString(body.notes)
    };
    appendTimeline(job, "job-accepted", job.acceptedBy);
    clearEscalation(job.id);

    const acknowledgement = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(job, contact));
    let slackResult = { skipped: true, reason: "Not attempted." };

    try {
      slackResult = await sendSlackMessage(config, acknowledgement);
      appendTimeline(job, "slack-acceptance", slackResult);
    } catch (error) {
      appendTimeline(job, "slack-acceptance-failed", { message: error.message });
      slackResult = { skipped: false, ok: false, message: error.message };
    }

    await saveJobs(jobs);
    return sendJson(res, 200, { success: true, job, slack: slackResult });
  }

  // Twilio incoming SMS webhook — techs reply YES/NO
  if (req.method === "POST" && pathname === "/api/twilio/incoming-sms") {
    const body = await parseBody(req);
    const from = normalizeString(body.From);
    const smsBody = normalizeString(body.Body).toLowerCase();
    const isAccept = ["yes", "y", "accept", "ok"].includes(smsBody);
    const isDecline = ["no", "n", "decline", "pass"].includes(smsBody);

    // Find the contact by phone number
    const contact = (config.contacts || []).find((c) => normalizeString(c.phone) === from || normalizeString(c.smsPhone) === from);
    if (!contact) {
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end("<Response><Message>Unknown number. Contact dispatch directly.</Message></Response>");
    }

    // Find the most recent open job this contact was dispatched to
    const openJobs = jobs.filter((j) => j.status === "open");
    const matchedJob = openJobs.find((j) =>
      (j.attempts || []).some((a) => a.contactId === contact.id)
    );

    if (!matchedJob) {
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end("<Response><Message>No active job found for you.</Message></Response>");
    }

    if (isAccept) {
      matchedJob.status = "accepted";
      matchedJob.updatedAt = new Date().toISOString();
      matchedJob.acceptedBy = {
        contactId: contact.id,
        contactName: contact.name,
        channel: "sms",
        at: new Date().toISOString()
      };
      appendTimeline(matchedJob, "job-accepted", matchedJob.acceptedBy);
      clearEscalation(matchedJob.id);

      const ackText = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(matchedJob, contact));
      await sendTwilioSms(config, from, ackText);
      try { await sendSlackMessage(config, ackText); } catch {}
      await saveJobs(jobs);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(`<Response><Message>${ackText}</Message></Response>`);
    }

    if (isDecline) {
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
      appendTimeline(matchedJob, "job-declined", attempt);
      await saveJobs(jobs);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end("<Response><Message>Got it, you've been removed from this job.</Message></Response>");
    }

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end("<Response><Message>Reply YES to accept or NO to decline.</Message></Response>");
  }

  // Millis end-of-call webhook — capture call results
  if (req.method === "POST" && pathname === "/api/millis/call-ended") {
    const body = await parseBody(req);
    const metadata = body.metadata || {};
    const jobId = metadata.jobId;
    const contactId = metadata.contactId;
    const callStatus = normalizeString(body.status || body.call_status);

    if (jobId) {
      const job = jobs.find((j) => j.id === jobId);
      if (job) {
        appendTimeline(job, "call-ended", {
          contactId,
          callStatus,
          duration: body.duration,
          callId: body.call_id
        });

        // Update the attempt status based on call outcome
        const attempt = (job.attempts || []).find(
          (a) => a.contactId === contactId && a.channel === "call" && a.status === "ringing"
        );
        if (attempt) {
          attempt.status = callStatus === "completed" ? "answered" : (callStatus || "no-answer");
        }

        job.updatedAt = new Date().toISOString();
        await saveJobs(jobs);
      }
    }

    return sendJson(res, 200, { success: true });
  }

  if (req.method === "POST" && pathname === "/api/millis/decline-job") {
    const body = await parseBody(req);
    const job = jobs.find((item) => item.id === body.jobId);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }

    const attempt = {
      id: `attempt_${randomUUID()}`,
      at: new Date().toISOString(),
      contactId: normalizeString(body.contactId),
      channel: normalizeString(body.channel || "call"),
      status: "declined",
      notes: normalizeString(body.notes)
    };

    job.attempts.push(attempt);
    job.updatedAt = new Date().toISOString();
    appendTimeline(job, "job-declined", attempt);

    const batch = buildDispatchBatch(job, config);
    await saveJobs(jobs);
    return sendJson(res, 200, { success: true, job, nextBatch: batch });
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
  // On Vercel cold start, seed config from bundled defaults
  if (IS_VERCEL) {
    try {
      await fs.access(CONFIG_FILE);
    } catch {
      const bundled = path.join(ROOT, "data", "config.json");
      try {
        const seed = await fs.readFile(bundled, "utf8");
        await fs.writeFile(CONFIG_FILE, seed, "utf8");
      } catch {
        // No bundled config, will use defaults
      }
    }
  }
  _initialized = true;
}

async function handler(req, res) {
  try {
    await ensureInit();
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url.pathname);
    }
    if (IS_VERCEL) {
      return sendText(res, 404, "Not found.");
    }
    return await serveStatic(res, url.pathname);
  } catch (error) {
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
