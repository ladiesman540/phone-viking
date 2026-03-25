const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { createHmac, randomUUID, timingSafeEqual } = require("crypto");
const { URL } = require("url");
const { neon } = require("@neondatabase/serverless");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const PORT = Number(process.env.PORT || 3007);
const MAX_BODY_BYTES = 1024 * 1024;
const OUTBOUND_TIMEOUT_MS = 12000;
const VALID_DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const ALLOWED_SCHEDULE_MODES = new Set(["any", "business-hours", "after-hours"]);
const ALLOWED_INPUT_TYPES = new Set(["text", "phone", "textarea", "select", "number"]);
const ALLOWED_CONTACT_TYPES = new Set(["tech", "partner"]);
const CRON_LOCK_NAME = "cron_process_escalations";

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function log(event, data = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  console.log(JSON.stringify(entry));
}

function getDb() {
  if (!process.env.DATABASE_URL) return null;
  return neon(process.env.DATABASE_URL);
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getRequestOrigin(req) {
  const proto = normalizeString(req.headers["x-forwarded-proto"]) || "http";
  const host = normalizeString(req.headers["x-forwarded-host"] || req.headers.host) || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function buildRequestUrl(req, pathname) {
  const url = new URL(req.url, getRequestOrigin(req));
  if (pathname) {
    url.pathname = pathname;
  }
  return url.toString();
}

function readBasicAuth(req) {
  const header = normalizeString(req.headers.authorization);
  if (!header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
}

function hasDashboardAuth() {
  return Boolean(normalizeString(process.env.DASHBOARD_USERNAME) && normalizeString(process.env.DASHBOARD_PASSWORD));
}

function isWebhookPath(pathname) {
  return pathname.startsWith("/api/vapi/") || pathname.startsWith("/api/twilio/");
}

function isCronPath(pathname) {
  return pathname === "/api/cron/process-escalations";
}

function requiresDashboardAuth(pathname) {
  if (!hasDashboardAuth()) {
    return false;
  }
  if (pathname === "/api/health" || isWebhookPath(pathname) || isCronPath(pathname)) {
    return false;
  }
  return true;
}

function requireDashboardAuth(req, res) {
  if (!hasDashboardAuth()) {
    return true;
  }

  const credentials = readBasicAuth(req);
  const expectedUsername = normalizeString(process.env.DASHBOARD_USERNAME);
  const expectedPassword = normalizeString(process.env.DASHBOARD_PASSWORD);
  const isAuthorized =
    credentials &&
    safeEqualString(credentials.username, expectedUsername) &&
    safeEqualString(credentials.password, expectedPassword);

  if (isAuthorized) {
    return true;
  }

  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="Phone Viking Dashboard"'
  });
  res.end("Authentication required.");
  return false;
}

function readBearerToken(req) {
  const header = normalizeString(req.headers.authorization);
  if (!header.startsWith("Bearer ")) {
    return "";
  }
  return normalizeString(header.slice(7));
}

function requireBearerToken(req, expectedToken, label) {
  if (!normalizeString(expectedToken)) {
    return true;
  }
  if (safeEqualString(readBearerToken(req), expectedToken)) {
    return true;
  }
  throw new HttpError(401, `${label} authorization failed.`);
}

function getVapiWebhookSecret(config) {
  return normalizeString(process.env.VAPI_WEBHOOK_TOKEN || config?.vapi?.webhookToken);
}

function validateVapiSignature(secret, rawBody, signatureHeader) {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqualString(expected, signatureHeader);
}

function validateTwilioSignature(authToken, signature, requestUrl, params) {
  if (!authToken || !signature) {
    return false;
  }

  const normalizedParams = Object.keys(params || {})
    .sort()
    .reduce((accumulator, key) => {
      accumulator.push(`${key}${params[key] ?? ""}`);
      return accumulator;
    }, [requestUrl])
    .join("");

  const digest = createHmac("sha1", authToken).update(normalizedParams, "utf8").digest("base64");
  return safeEqualString(digest, signature);
}

function sendTwimlMessage(res, message) {
  const escaped = String(message || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(`<Response><Message>${escaped}</Message></Response>`);
}

function normalizeJobIdToken(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
}

function parseSmsResponse(body) {
  const raw = normalizeString(body);
  const normalized = raw.toLowerCase();
  const firstWord = normalized.split(/\s+/).filter(Boolean)[0] || "";
  const decision = ["yes", "y", "accept", "accepted", "ok"].includes(firstWord)
    ? "accepted"
    : ["no", "n", "decline", "declined", "pass"].includes(firstWord)
      ? "declined"
      : null;
  const jobIdMatch = normalized.match(/\bjob[_-][a-z0-9_-]+\b/);

  return {
    raw,
    normalized,
    decision,
    jobId: jobIdMatch ? normalizeJobIdToken(jobIdMatch[0]) : ""
  };
}

function getActiveJobsForContact(jobs, contactId) {
  return jobs.filter((job) => {
    const isActive =
      getJobStatus(job) === "open" ||
      job.state === STATES.PROVISIONAL_SUB_ASSIGNMENT ||
      job.state === STATES.UNABLE_TO_DISPATCH;
    if (!isActive) {
      return false;
    }
    if (job.provisionalSubId === contactId) {
      return true;
    }
    return (job.attempts || []).some((attempt) => attempt.contactId === contactId);
  });
}

function resolveSmsJobForContact(jobs, contactId, smsBody) {
  const parsed = parseSmsResponse(smsBody);
  const candidates = getActiveJobsForContact(jobs, contactId);

  if (!candidates.length) {
    return { status: "none", parsed, candidates: [] };
  }

  if (parsed.jobId) {
    const matchedJob = candidates.find((job) => normalizeJobIdToken(job.id) === parsed.jobId);
    if (matchedJob) {
      return { status: "matched", parsed, candidates, job: matchedJob };
    }
    return { status: "unknown-job", parsed, candidates };
  }

  if (candidates.length > 1) {
    return { status: "ambiguous", parsed, candidates };
  }

  return { status: "matched", parsed, candidates, job: candidates[0] };
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

// All AWAITING_* states can transition to any other AWAITING_* state (sequence is configurable),
// to DISPATCH_CONFIRMED_INTERNAL (accepted), or to UNABLE_TO_DISPATCH (exhausted).
const AWAITING_STATES = [STATES.AWAITING_TECH1_RESPONSE, STATES.AWAITING_TECH2_RESPONSE, STATES.AWAITING_TECH1_FINAL_RETRY, STATES.AWAITING_SUBCONTRACTOR_RESPONSE];
const FROM_AWAITING = [...AWAITING_STATES, STATES.DISPATCH_CONFIRMED_INTERNAL, STATES.UNABLE_TO_DISPATCH, STATES.PROVISIONAL_SUB_ASSIGNMENT];
const ALLOWED_TRANSITIONS = {
  [STATES.OPEN_PENDING_DISPATCH]: [...AWAITING_STATES, STATES.UNABLE_TO_DISPATCH],
  [STATES.AWAITING_TECH1_RESPONSE]: FROM_AWAITING,
  [STATES.AWAITING_TECH2_RESPONSE]: FROM_AWAITING,
  [STATES.AWAITING_TECH1_FINAL_RETRY]: FROM_AWAITING,
  [STATES.AWAITING_SUBCONTRACTOR_RESPONSE]: FROM_AWAITING,
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
    subReplacementWindowMinutes: 10,
    autoCloseMinutes: 60
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
      id: "summary",
      label: "Summary",
      type: "textarea",
      required: true,
      helpText: "Short description of the issue."
    },
    {
      id: "notes",
      label: "Notes",
      type: "textarea",
      required: false,
      helpText: "Anything the tech should know before calling."
    },
    {
      id: "hazards",
      label: "Hazards",
      type: "text",
      required: false,
      helpText: "Gas leak, flooding, unsafe conditions, etc."
    },
    {
      id: "access_instructions",
      label: "Access instructions",
      type: "textarea",
      required: false,
      helpText: "Gate codes, which door, dogs, locked areas."
    },
    {
      id: "anyone_onsite",
      label: "Anyone on site?",
      type: "text",
      required: false,
      helpText: "Is someone currently at the location?"
    },
    {
      id: "equipment_involved",
      label: "Equipment involved",
      type: "text",
      required: false,
      helpText: "Furnace model, water heater type, etc."
    },
    {
      id: "company_site_name",
      label: "Company / site name",
      type: "text",
      required: false,
      helpText: "Business name or site identifier if commercial."
    },
    {
      id: "alternate_number",
      label: "Alternate number",
      type: "phone",
      required: false,
      helpText: "Second number to reach the caller."
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
  if (!process.env.DATABASE_URL) {
    await ensureFile(CONFIG_FILE, defaultConfig);
    await ensureFile(JOBS_FILE, []);
  }
}

async function ensureDbSchema() {
  const sql = getDb();
  if (!sql) {
    return;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS pv_config (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS pv_jobs (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS pv_jobs_created_at_idx ON pv_jobs (created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS pv_runtime_locks (
      name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
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
    return clone(fallbackValue);
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

async function parseBody(req, options = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body too large.");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return options.returnRaw ? { parsed: {}, raw: "" } : {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = req.headers["content-type"] || "";

  function wrapResult(parsed) {
    return options.returnRaw ? { parsed, raw } : parsed;
  }

  if (contentType.includes("application/json")) {
    try {
      return wrapResult(JSON.parse(raw));
    } catch {
      throw new HttpError(400, "Invalid JSON payload.");
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return wrapResult(Object.fromEntries(new URLSearchParams(raw).entries()));
  }

  // Try parsing as JSON even without Content-Type header
  try {
    return wrapResult(JSON.parse(raw));
  } catch {}

  return wrapResult({ raw });
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

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function withTimeoutSignal(timeoutMs = OUTBOUND_TIMEOUT_MS) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function toSlug(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "item";
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
  const isAllowedDay = normalizeArray(businessHours.days)
    .map((value) => value.toLowerCase().slice(0, 3))
    .filter((value) => VALID_DAYS.has(value))
    .includes(parts.weekday);
  const startHour = clampInteger(businessHours.startHour, 0, 23, 8);
  const endHour = clampInteger(businessHours.endHour, 1, 24, 18);
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

  if (areas.length) {
    if (!jobArea) {
      return false;
    }
    if (!areas.some((area) => jobArea.includes(area) || area.includes(jobArea))) {
      return false;
    }
  }

  const businessHours = isBusinessHours(config);
  if (scheduleMode === "business-hours" && !businessHours) {
    return false;
  }
  if (scheduleMode === "after-hours" && businessHours) {
    return false;
  }
  if (!ALLOWED_SCHEDULE_MODES.has(scheduleMode)) {
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
      if (!area) {
        return false;
      }
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

function getTemplateValues(job, contact, config) {
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
    company: contact?.company || "",
    businessName: config?.workspace?.businessName || defaultConfig.workspace.businessName
  };
}

function computeNextTargets(job, config, options = {}) {
  const matchedRule =
    config.routingRules?.find((rule) => rule.id === job.matchedRuleId) ||
    findMatchingRule(job, config) ||
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
      const values = getTemplateValues(job, contact, config);
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

function buildDefaultSequence(rule, config) {
  const contactMap = getContactMap(config);
  const targetIds = normalizeArray(rule?.targetContactIds);
  if (!targetIds.length) return [];
  return targetIds
    .map((id) => ({ contactId: id, partner: normalizeString(contactMap.get(id)?.type).toLowerCase() === "partner" }))
    .filter((entry) => contactMap.has(entry.contactId));
}

function getEscalationTarget(job, config) {
  const rule = (config.routingRules || []).find((r) => r.id === job.matchedRuleId);
  let sequence = rule?.strategy?.escalationSequence;
  if (!sequence || !sequence.length) {
    sequence = buildDefaultSequence(rule, config);
  }
  if (!sequence.length) return null;

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
  // If the timer fired on a provisional sub assignment, finalize instead of advancing
  if (job.state === STATES.PROVISIONAL_SUB_ASSIGNMENT) {
    await handleSubReplacementTimeout(job, config, jobs);
    return;
  }

  job.escalationStep++;
  const target = getEscalationTarget(job, config);

  if (!target) {
    log("escalation-exhausted", { jobId: job.id, step: job.escalationStep });
    transitionState(job, STATES.UNABLE_TO_DISPATCH);
    job.escalationDueAt = null;
    job.escalationScheduledForStep = null;
    const customerResult = await callCustomerUpdate(config, job, "unavailable");
    appendTimeline(job, "customer-callback", { type: "unavailable", callId: customerResult.callId, error: customerResult.error, skipped: customerResult.skipped });
    (job.customerCallbacks = job.customerCallbacks || []).push({ type: "unavailable", at: new Date().toISOString(), outcome: customerResult.ok ? "completed" : "failed", callId: customerResult.callId, error: customerResult.error || null });
    await sendSlackMessage(config, `*Escalation exhausted* for job ${job.id} — no more contacts available.`);
    clearEscalation(job.id);
    closeJobIfTerminal(job);
    await saveJobs(jobs);
    return;
  }

  job.escalationStep = target.step;
  const rule = (config.routingRules || []).find((r) => r.id === job.matchedRuleId);
  const sequence = rule?.strategy?.escalationSequence?.length ? rule.strategy.escalationSequence : buildDefaultSequence(rule, config);
  const newState = stateForStep(target.step, sequence);
  if (newState) transitionState(job, newState, { contactId: target.contact.id });

  const smsTemplate = target.isPartner
    ? (config.messageTemplates?.subcontractorSms || defaultConfig.messageTemplates.subcontractorSms)
    : (normalizeString(target.contact.type).toLowerCase() === "partner"
      ? (config.messageTemplates?.partnerSms || defaultConfig.messageTemplates.partnerSms)
      : (config.messageTemplates?.techSms || defaultConfig.messageTemplates.techSms));

  const values = getTemplateValues(job, target.contact, config);
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
  setEscalationDeadline(job, timerMinutes, job.escalationStep);
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
    job.escalationDueAt = null;
    job.escalationScheduledForStep = null;
    const customerResult = await callCustomerUpdate(config, job, "sub_cancelled_tech_assigned", contact.name);
    appendTimeline(job, "customer-callback", { type: "sub_cancelled_tech_assigned", callId: customerResult.callId, error: customerResult.error, skipped: customerResult.skipped });
    (job.customerCallbacks = job.customerCallbacks || []).push({ type: "sub_cancelled_tech_assigned", at: new Date().toISOString(), outcome: customerResult.ok ? "completed" : "failed", callId: customerResult.callId, error: customerResult.error || null });
    clearEscalation(job.id);
    closeJobIfTerminal(job);
    await saveJobs(jobs);
    return true;
  }

  // Tech accepting after exhaustion — late but better than nothing
  if (job.state === STATES.UNABLE_TO_DISPATCH) {
    log("late-accept-from-exhausted", { jobId: job.id, contactId: contact.id });
    transitionState(job, STATES.DISPATCH_CONFIRMED_INTERNAL, { contactId: contact.id });
    job.escalationDueAt = null;
    job.escalationScheduledForStep = null;
    const customerResult = await callCustomerUpdate(config, job, "accepted", contact.name);
    appendTimeline(job, "customer-callback", { type: "accepted", callId: customerResult.callId, error: customerResult.error, skipped: customerResult.skipped });
    (job.customerCallbacks = job.customerCallbacks || []).push({ type: "accepted", at: new Date().toISOString(), outcome: customerResult.ok ? "completed" : "failed", callId: customerResult.callId, error: customerResult.error || null });
    await sendSlackMessage(config, `*Late tech accept* — ${contact.name} accepted job ${job.id} after exhaustion.`);
    closeJobIfTerminal(job);
    await saveJobs(jobs);
    return true;
  }

  return false;
}

async function handleSubReplacementTimeout(job, config, jobs) {
  log("sub-replacement-timeout", { jobId: job.id, provisionalSubId: job.provisionalSubId });
  transitionState(job, STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR, { contactId: job.provisionalSubId });
  job.escalationDueAt = null;
  job.escalationScheduledForStep = null;
  clearEscalation(job.id);
  await sendSlackMessage(config, `*Subcontractor confirmed* — provisional assignment finalized for job ${job.id}.`);
  closeJobIfTerminal(job);
  await saveJobs(jobs);
}

function closeJobIfTerminal(job) {
  const closeable = [STATES.DISPATCH_CONFIRMED_INTERNAL, STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR, STATES.UNABLE_TO_DISPATCH];
  if (!closeable.includes(job.state)) return false;
  transitionState(job, STATES.CLOSED, { reason: "final-callback-complete" });
  return true;
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
    escalationDueAt: null,
    escalationScheduledForStep: null,
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
    customerCallbacks: [],
    // Concurrency
    version: 1
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
    try {
      log("slack-send", { channel: channelId, threadTs: threadTs || "(new)", textPreview: text.slice(0, 120) });
      const payload = { channel: channelId, text };
      if (threadTs) payload.thread_ts = threadTs;
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${botToken}` },
        body: JSON.stringify(payload),
        signal: withTimeoutSignal()
      });
      const data = await response.json();
      log("slack-result", { ok: data.ok, ts: data.ts, error: data.error });
      return { skipped: false, ok: data.ok, ts: data.ts, threadTs: threadTs || data.ts, error: data.error };
    } catch (error) {
      log("slack-error", { error: error.message });
      return { skipped: false, ok: false, error: error.message };
    }
  }

  // Fallback to webhook (no threading)
  if (!config?.slack?.enabled || !normalizeString(config.slack.webhookUrl)) {
    log("slack-skip", { reason: "Slack disabled or webhook missing." });
    return { skipped: true, reason: "Slack disabled or webhook missing." };
  }

  try {
    log("slack-send", { channel: config.slack.channelLabel, textPreview: text.slice(0, 120) });
    const response = await fetch(config.slack.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: withTimeoutSignal()
    });

    const body = await response.text();
    const result = { skipped: false, ok: response.ok, status: response.status, body };
    log("slack-result", { ok: response.ok, status: response.status });
    return result;
  } catch (error) {
    log("slack-error", { error: error.message });
    return { skipped: false, ok: false, error: error.message };
  }
}

async function sendTwilioSms(config, to, body) {
  const { accountSid, authToken, smsNumber } = config.twilio || {};
  if (!accountSid || !authToken || !smsNumber) {
    log("sms-skip", { to, reason: "Twilio not configured." });
    return { skipped: true, reason: "Twilio not configured." };
  }

  try {
    log("sms-send", { from: smsNumber, to, bodyPreview: body.slice(0, 120) });
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const params = new URLSearchParams({ From: smsNumber, To: to, Body: body });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
      },
      body: params.toString(),
      signal: withTimeoutSignal()
    });

    const result = await response.json();
    log("sms-result", { to, ok: response.ok, status: response.status, sid: result.sid, error: result.message });
    return { skipped: false, ok: response.ok, status: response.status, sid: result.sid, error: result.message };
  } catch (error) {
    log("sms-error", { to, error: error.message });
    return { skipped: false, ok: false, error: error.message };
  }
}

async function startVapiOutboundCall(config, toPhone, job, contactId, contactName) {
  const { apiKey, dispatchAssistantId, phoneNumberId, baseUrl } = config.vapi || {};
  if (!apiKey || !dispatchAssistantId) {
    log("vapi-call-skip", { contactId, contactName, reason: "Vapi dispatch agent not configured." });
    return { skipped: true, reason: "Vapi dispatch agent not configured." };
  }

  try {
    log("vapi-call-start", { jobId: job.id, contactId, contactName, toPhone, phoneNumberId });

    const response = await fetch(`${baseUrl || "https://api.vapi.ai"}/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      signal: withTimeoutSignal(),
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
          },
          metadata: {
            jobId: job.id,
            contactId,
            techContactId: contactId
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
  } catch (error) {
    log("vapi-call-error", { jobId: job.id, contactId, error: error.message });
    return { skipped: false, ok: false, error: error.message };
  }
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
  const templateValues = { ...getTemplateValues(job, null, config), techName: techName || "a technician", etaMinutes: etaMinutes || "30 to 45", etaText };

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

  try {
    const response = await fetch(`${baseUrl || "https://api.vapi.ai"}/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      signal: withTimeoutSignal(),
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
  } catch (error) {
    log("customer-callback-error", { jobId: job.id, updateType, error: error.message });
    return { skipped: false, ok: false, error: error.message };
  }
}

async function dispatchBatch(job, batch, config) {
  log("dispatch-batch", { jobId: job.id, tier: batch.tier, contactCount: batch.contacts.length, contactNames: batch.contacts.map((c) => c.name) });
  const results = [];
  for (const contact of batch.contacts) {
    const callPhone = normalizeString(contact.phone);
    const smsPhone = normalizeString(contact.smsPhone || contact.phone);
    if (!callPhone && !smsPhone) {
      log("dispatch-skip-no-phone", { jobId: job.id, contactId: contact.id, contactName: contact.name });
      continue;
    }

    // Idempotency: skip if we already dispatched to this contact at this step
    const idemSms = `idem_${job.id}_${contact.id}_${job.escalationStep}_sms`;
    const idemCall = `idem_${job.id}_${contact.id}_${job.escalationStep}_call`;
    const hasActiveSms = (job.attempts || []).some((a) => a.idempotencyKey === idemSms && a.status !== "failed");
    const hasActiveCall = (job.attempts || []).some((a) => a.idempotencyKey === idemCall && a.status !== "failed");

    // Send SMS if enabled (default to true)
    if (batch.strategy.sendSms !== false && contact.renderedSms && smsPhone && !hasActiveSms) {
      const smsResult = await sendTwilioSms(config, smsPhone, contact.renderedSms);
      const attempt = {
        id: `attempt_${randomUUID()}`,
        idempotencyKey: idemSms,
        at: new Date().toISOString(),
        contactId: contact.id,
        channel: "sms",
        status: smsResult.ok ? "queued" : "failed",
        notes: smsResult.error || ""
      };
      job.attempts.push(attempt);
      appendTimeline(job, "attempt-logged", { ...attempt, twilioSid: smsResult.sid });
      results.push({ contactId: contact.id, channel: "sms", result: smsResult });
    } else if (hasActiveSms) {
      log("dispatch-dedup", { jobId: job.id, contactId: contact.id, channel: "sms", key: idemSms });
    }

    // Start outbound call via Vapi
    if (!callPhone) {
      log("dispatch-skip-no-call-phone", { jobId: job.id, contactId: contact.id, contactName: contact.name });
      continue;
    }
    if (hasActiveCall) {
      log("dispatch-dedup", { jobId: job.id, contactId: contact.id, channel: "call", key: idemCall });
      continue;
    }
    const callResult = await startVapiOutboundCall(config, callPhone, job, contact.id, contact.name);
    if (!callResult.skipped) {
      const attempt = {
        id: `attempt_${randomUUID()}`,
        idempotencyKey: idemCall,
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
  if (process.env.VERCEL === "1") {
    return;
  }
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

function setEscalationDeadline(job, delayMinutes, scheduledForStep = job.escalationStep) {
  job.escalationDueAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  job.escalationScheduledForStep = scheduledForStep;
  job.updatedAt = new Date().toISOString();
}

async function withCronLock(work) {
  const sql = getDb();
  if (!sql) {
    return { acquired: true, result: await work() };
  }

  const ownerId = `lock_${randomUUID()}`;
  const rows = await sql`
    INSERT INTO pv_runtime_locks (name, owner_id, expires_at, updated_at)
    VALUES (${CRON_LOCK_NAME}, ${ownerId}, NOW() + INTERVAL '55 seconds', NOW())
    ON CONFLICT (name) DO UPDATE
    SET
      owner_id = CASE
        WHEN pv_runtime_locks.expires_at <= NOW() THEN EXCLUDED.owner_id
        ELSE pv_runtime_locks.owner_id
      END,
      expires_at = CASE
        WHEN pv_runtime_locks.expires_at <= NOW() THEN EXCLUDED.expires_at
        ELSE pv_runtime_locks.expires_at
      END,
      updated_at = CASE
        WHEN pv_runtime_locks.expires_at <= NOW() THEN NOW()
        ELSE pv_runtime_locks.updated_at
      END
    RETURNING owner_id
  `;

  if (!rows.length || rows[0].owner_id !== ownerId) {
    return { acquired: false, result: null };
  }

  try {
    return { acquired: true, result: await work() };
  } finally {
    await sql`DELETE FROM pv_runtime_locks WHERE name = ${CRON_LOCK_NAME} AND owner_id = ${ownerId}`;
  }
}

function preserveSecret(nextValue, existingValue) {
  const next = normalizeString(nextValue);
  return next || normalizeString(existingValue);
}

function ensureUniqueId(baseId, usedIds, prefix, index) {
  let candidate = normalizeString(baseId) || `${prefix}_${index + 1}`;
  if (!usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }

  const base = `${candidate}_${prefix}`;
  let suffix = 2;
  while (usedIds.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  candidate = `${base}_${suffix}`;
  usedIds.add(candidate);
  return candidate;
}

function sanitizeWorkspace(workspace = {}) {
  const merged = {
    ...clone(defaultConfig.workspace),
    ...(workspace || {}),
    businessHours: {
      ...clone(defaultConfig.workspace.businessHours),
      ...((workspace || {}).businessHours || {})
    }
  };

  const days = normalizeArray(merged.businessHours.days)
    .map((value) => value.toLowerCase().slice(0, 3))
    .filter((value) => VALID_DAYS.has(value));

  return {
    businessName: normalizeString(merged.businessName) || defaultConfig.workspace.businessName,
    timezone: normalizeString(merged.timezone) || defaultConfig.workspace.timezone,
    businessHours: {
      days: days.length ? days : clone(defaultConfig.workspace.businessHours.days),
      startHour: clampInteger(merged.businessHours.startHour, 0, 23, defaultConfig.workspace.businessHours.startHour),
      endHour: clampInteger(merged.businessHours.endHour, 1, 24, defaultConfig.workspace.businessHours.endHour)
    }
  };
}

function sanitizeIntakeFields(intakeFields = []) {
  const usedIds = new Set();
  const fields = (Array.isArray(intakeFields) ? intakeFields : clone(defaultConfig.intakeFields)).map((field, index) => {
    const type = normalizeString(field.type).toLowerCase();
    return {
      ...field,
      id: ensureUniqueId(field.id || `field_${toSlug(field.label)}`, usedIds, "field", index),
      label: normalizeString(field.label) || `Field ${index + 1}`,
      type: ALLOWED_INPUT_TYPES.has(type) ? type : "text",
      required: Boolean(field.required),
      helpText: normalizeString(field.helpText)
    };
  });

  return fields.length ? fields : clone(defaultConfig.intakeFields);
}

function sanitizeContacts(contacts = []) {
  const usedIds = new Set();
  return (Array.isArray(contacts) ? contacts : clone(defaultConfig.contacts)).map((contact, index) => {
    const type = normalizeString(contact.type).toLowerCase();
    return {
      ...contact,
      id: ensureUniqueId(contact.id || `contact_${toSlug(contact.name)}`, usedIds, "contact", index),
      name: normalizeString(contact.name) || `Contact ${index + 1}`,
      company: normalizeString(contact.company),
      type: ALLOWED_CONTACT_TYPES.has(type) ? type : "tech",
      priorityTier: clampInteger(contact.priorityTier, 1, 99, 1),
      phone: normalizeString(contact.phone),
      smsPhone: normalizeString(contact.smsPhone || contact.phone),
      serviceAreas: normalizeArray(contact.serviceAreas),
      availability: normalizeString(contact.availability),
      notes: normalizeString(contact.notes),
      active: contact.active !== false,
      doNotUse: Boolean(contact.doNotUse),
      mayReplaceSubcontractor: contact.mayReplaceSubcontractor !== false,
      blackoutPeriods: Array.isArray(contact.blackoutPeriods) ? contact.blackoutPeriods : [],
      tempOverrides: typeof contact.tempOverrides === "object" && contact.tempOverrides ? contact.tempOverrides : {}
    };
  });
}

function sanitizeRoutingRules(routingRules = [], contacts = []) {
  const usedIds = new Set();
  const validContactIds = new Set(contacts.map((contact) => contact.id));
  return (Array.isArray(routingRules) ? routingRules : clone(defaultConfig.routingRules)).map((rule, index) => {
    const conditions = rule.conditions || {};
    const strategy = rule.strategy || {};
    const scheduleMode = normalizeString(conditions.scheduleMode || "any").toLowerCase();
    const contactTypes = normalizeArray(conditions.contactTypes)
      .map((value) => value.toLowerCase())
      .filter((value) => ALLOWED_CONTACT_TYPES.has(value));

    const escalationSequence = Array.isArray(strategy.escalationSequence)
      ? strategy.escalationSequence
          .map((entry) => ({
            contactId: normalizeString(entry.contactId),
            partner: Boolean(entry.partner)
          }))
          .filter((entry) => validContactIds.has(entry.contactId))
      : [];

    return {
      ...rule,
      id: ensureUniqueId(rule.id || `rule_${toSlug(rule.name)}`, usedIds, "rule", index),
      name: normalizeString(rule.name) || `Rule ${index + 1}`,
      active: rule.active !== false,
      sortOrder: clampInteger(rule.sortOrder, 1, 9999, index + 1),
      conditions: {
        issueTypes: normalizeArray(conditions.issueTypes),
        urgencies: normalizeArray(conditions.urgencies),
        areas: normalizeArray(conditions.areas),
        scheduleMode: ALLOWED_SCHEDULE_MODES.has(scheduleMode) ? scheduleMode : "any",
        contactTypes
      },
      strategy: {
        ...strategy,
        initialTier: clampInteger(strategy.initialTier, 1, 99, 1),
        batchSize: clampInteger(strategy.batchSize, 1, 20, 1),
        escalateAfterMinutes: clampInteger(strategy.escalateAfterMinutes, 1, 120, 3),
        leaveVoicemail: Boolean(strategy.leaveVoicemail),
        sendSms: strategy.sendSms !== false,
        notifySlackOnEscalation: Boolean(strategy.notifySlackOnEscalation),
        subReplacementWindowMinutes: clampInteger(strategy.subReplacementWindowMinutes, 1, 240, 10),
        escalationSequence
      },
      targetContactIds: normalizeArray(rule.targetContactIds).filter((contactId) => validContactIds.has(contactId))
    };
  });
}

function sanitizeConfigInput(config = {}, existingConfig = {}) {
  const merged = mergeConfig({
    ...existingConfig,
    ...config,
    slack: {
      ...(existingConfig.slack || {}),
      ...(config.slack || {})
    },
    twilio: {
      ...(existingConfig.twilio || {}),
      ...(config.twilio || {})
    },
    vapi: {
      ...(existingConfig.vapi || {}),
      ...(config.vapi || {})
    }
  });

  const contacts = sanitizeContacts(merged.contacts);
  const routingRules = sanitizeRoutingRules(merged.routingRules, contacts);

  return {
    ...merged,
    workspace: sanitizeWorkspace(merged.workspace),
    intakeFields: sanitizeIntakeFields(merged.intakeFields),
    contacts,
    routingRules,
    slack: {
      enabled: merged.slack.enabled !== false,
      webhookUrl: preserveSecret(merged.slack.webhookUrl, existingConfig?.slack?.webhookUrl),
      botToken: preserveSecret(merged.slack.botToken, existingConfig?.slack?.botToken),
      channelId: normalizeString(merged.slack.channelId || existingConfig?.slack?.channelId),
      channelLabel: normalizeString(merged.slack.channelLabel) || "#dispatch"
    },
    twilio: {
      voiceNumber: normalizeString(merged.twilio.voiceNumber),
      smsNumber: normalizeString(merged.twilio.smsNumber || merged.twilio.voiceNumber),
      accountSid: preserveSecret(merged.twilio.accountSid, existingConfig?.twilio?.accountSid),
      authToken: preserveSecret(merged.twilio.authToken, existingConfig?.twilio?.authToken)
    },
    vapi: {
      baseUrl: normalizeString(merged.vapi.baseUrl) || defaultConfig.vapi.baseUrl,
      apiKey: preserveSecret(merged.vapi.apiKey, existingConfig?.vapi?.apiKey),
      dispatchAssistantId: normalizeString(merged.vapi.dispatchAssistantId),
      phoneNumberId: normalizeString(merged.vapi.phoneNumberId)
    },
    messageTemplates: {
      ...clone(defaultConfig.messageTemplates),
      ...(merged.messageTemplates || {})
    },
    voiceScripts: {
      ...clone(defaultConfig.voiceScripts),
      ...(merged.voiceScripts || {})
    },
    humanReview: {
      ...clone(defaultConfig.humanReview),
      ...(merged.humanReview || {})
    },
    escalation: {
      ...clone(defaultConfig.escalation),
      ...(merged.escalation || {})
    }
  };
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
  const existing = await loadStoredConfig();
  const merged = sanitizeConfigInput(config, existing);
  const sql = getDb();
  if (sql) {
    await sql`INSERT INTO pv_config (id, data, updated_at) VALUES ('default', ${JSON.stringify(merged)}, NOW())
              ON CONFLICT (id) DO UPDATE SET data = ${JSON.stringify(merged)}, updated_at = NOW()`;
  } else {
    await writeJson(CONFIG_FILE, merged);
  }
  return merged;
}

async function loadStoredConfig() {
  const sql = getDb();
  if (!sql) {
    return readJson(CONFIG_FILE, defaultConfig);
  }

  let current = clone(defaultConfig);
  const rows = await sql`SELECT data FROM pv_config WHERE id = 'default'`;
  if (rows.length > 0) {
    current = rows[0].data;
  }
  return current;
}

async function loadConfig() {
  const current = await loadStoredConfig();
  const merged = mergeConfig(current);
  overlayEnvSecrets(merged);
  return sanitizeConfigInput(merged, current);
}

async function loadJobs() {
  const sql = getDb();
  if (!sql) return readJson(JOBS_FILE, []);
  const rows = await sql`SELECT data FROM pv_jobs ORDER BY created_at DESC LIMIT 200`;
  return rows.map((r) => r.data);
}

async function saveJobs(jobs) {
  const sql = getDb();
  if (!sql) {
    await writeJson(JOBS_FILE, jobs);
    return;
  }
  for (const job of jobs) {
    job.version = (job.version || 0) + 1;
    await sql`INSERT INTO pv_jobs (id, data, created_at, updated_at) VALUES (${job.id}, ${JSON.stringify(job)}, ${job.createdAt}, NOW())
              ON CONFLICT (id) DO UPDATE SET data = ${JSON.stringify(job)}, updated_at = NOW()`;
  }
}

async function saveJobWithLock(job) {
  const sql = getDb();
  const expectedVersion = job.version || 1;
  job.version = expectedVersion + 1;
  if (!sql) {
    // File-based: no real locking, just save
    const jobs = await readJson(JOBS_FILE, []);
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) jobs[idx] = job; else jobs.push(job);
    await writeJson(JOBS_FILE, jobs);
    return true;
  }
  const rows = await sql`
    UPDATE pv_jobs SET data = ${JSON.stringify(job)}, updated_at = NOW()
    WHERE id = ${job.id} AND (data->>'version')::int = ${expectedVersion}
    RETURNING id
  `;
  if (rows.length === 0) {
    job.version = expectedVersion; // revert
    return false;
  }
  return true;
}

function sanitizeConfigForUi(config) {
  return {
    ...config,
    slack: {
      ...config.slack,
      webhookUrl: "",
      botToken: "",
      hasWebhookUrl: Boolean(normalizeString(config.slack?.webhookUrl)),
      hasBotToken: Boolean(normalizeString(config.slack?.botToken))
    },
    twilio: {
      ...config.twilio,
      accountSid: "",
      authToken: "",
      hasAccountSid: Boolean(normalizeString(config.twilio?.accountSid)),
      hasAuthToken: Boolean(normalizeString(config.twilio?.authToken))
    },
    vapi: {
      ...config.vapi,
      apiKey: "",
      hasApiKey: Boolean(normalizeString(config.vapi?.apiKey))
    }
  };
}

function isVapiResponsePath(pathname) {
  return pathname === "/api/vapi/accept-job" || pathname === "/api/vapi/report-response" || pathname === "/api/vapi/report_response";
}

function assertString(value, fieldName) {
  if (!normalizeString(value)) {
    throw new HttpError(400, `Missing required field: ${fieldName}.`);
  }
}

function assertCreateJobPayload(payload) {
  assertString(payload.callbackNumber, "callbackNumber");
  assertString(payload.serviceAddress || payload.locationArea, "serviceAddress");
  assertString(payload.issueType, "issueType");
  assertString(payload.summary || payload.notes, "summary");
}

async function handleApi(req, res, pathname) {
  const config = await loadConfig();
  const jobs = await loadJobs();

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
    return sendJson(res, 200, sanitizeConfigForUi(saved));
  }

  if (req.method === "GET" && pathname === "/api/jobs") {
    const sorted = clone(jobs).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sendJson(res, 200, sorted);
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    const body = await parseBody(req);
    assertCreateJobPayload(body);
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
    const { parsed: body, raw: rawBody } = await parseBody(req, { returnRaw: true });
    const vapiSecret = getVapiWebhookSecret(config);
    if (!validateVapiSignature(vapiSecret, rawBody, normalizeString(req.headers["x-vapi-signature"]))) {
      throw new HttpError(401, "Vapi webhook signature verification failed.");
    }
    const toolCall = body.message?.toolCallList?.[0];
    const args = toolCall?.arguments || toolCall?.function?.arguments || body;
    assertCreateJobPayload(args);

    log("job-create", { source: "vapi", callerName: args.callerName, issueType: args.issueType, urgency: args.urgency, locationArea: args.locationArea });
    const job = createJobFromPayload(args, config);
    jobs.push(job);

    // Human review triggers at creation
    if (normalizeString(job.hazards)) await checkHumanReview(job, config, "safetyRisk", `Hazards reported: ${job.hazards}`);
    if (job.authorizedContact === false) await checkHumanReview(job, config, "pricingIssue", "Caller is not an authorized contact");
    if (normalizeString(job.poApprovalRequired)) await checkHumanReview(job, config, "pricingIssue", `PO/approval required: ${job.poApprovalRequired}`);

    // Post initial Slack summary and capture thread timestamp
    const slackText = renderTemplate(config.messageTemplates?.slackSummary, getTemplateValues(job, null, config));
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
      const sequence = rule?.strategy?.escalationSequence?.length ? rule.strategy.escalationSequence : buildDefaultSequence(rule, config);
      const newState = stateForStep(target.step, sequence);
      if (newState) transitionState(job, newState, { contactId: target.contact.id });
      log("job-created", { jobId: job.id, matchedRule: job.matchedRuleId || "(none)", firstContact: target.contact.name, step: target.step });

      const smsTemplate = target.isPartner
        ? (config.messageTemplates?.subcontractorSms || defaultConfig.messageTemplates.subcontractorSms)
        : (config.messageTemplates?.techSms || defaultConfig.messageTemplates.techSms);
      const values = getTemplateValues(job, target.contact, config);
      const batch = {
        contacts: [{ ...target.contact, renderedSms: renderTemplate(smsTemplate, values), renderedSummary: buildJobSummary(job) }],
        strategy: rule?.strategy || { sendSms: true },
        tier: target.contact.priorityTier || 1,
        matchedRule: rule
      };
      await dispatchBatch(job, batch, config);

      const timerMinutes = Number(rule?.strategy?.escalateAfterMinutes || config.escalation?.defaultTimerMinutes || 3);
      setEscalationDeadline(job, timerMinutes, job.escalationStep);
      scheduleEscalation(job.id, timerMinutes, config, job.escalationStep);
      // Initial customer callback — "we received your request, team is being contacted"
      const initialCallResult = await callCustomerUpdate(config, job, "initial");
      appendTimeline(job, "customer-callback", { type: "initial", callId: initialCallResult.callId, error: initialCallResult.error, skipped: initialCallResult.skipped });
      (job.customerCallbacks = job.customerCallbacks || []).push({ type: "initial", at: new Date().toISOString(), outcome: initialCallResult.ok ? "completed" : "failed", callId: initialCallResult.callId, error: initialCallResult.error || null });

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

  if (req.method === "POST" && isVapiResponsePath(pathname)) {
    const { parsed: body, raw: rawBody } = await parseBody(req, { returnRaw: true });
    const vapiSecret = getVapiWebhookSecret(config);
    if (!validateVapiSignature(vapiSecret, rawBody, normalizeString(req.headers["x-vapi-signature"]))) {
      throw new HttpError(401, "Vapi webhook signature verification failed.");
    }
    const toolCall = body.message?.toolCallList?.[0];
    const args = toolCall?.arguments || toolCall?.function?.arguments || body;
    assertString(args.jobId, "jobId");
    assertString(args.contactId, "contactId");
    log("vapi-accept-job", { jobId: args.jobId, contactId: args.contactId, status: args.status || "accepted" });

    // Vapi agent may pass contact name instead of ID — resolve it
    if (args.contactId && !(config.contacts || []).find((c) => c.id === args.contactId)) {
      const byName = (config.contacts || []).find((c) => c.name.toLowerCase() === String(args.contactId).toLowerCase());
      if (byName) args.contactId = byName.id;
    }

    const job = jobs.find((item) => item.id === args.jobId);
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
    const acceptedAttempt = {
      id: `attempt_${randomUUID()}`,
      at: new Date().toISOString(),
      contactId: normalizeString(args.contactId),
      channel: "call",
      status: "accepted",
      notes: normalizeString(args.notes)
    };
    job.attempts.push(acceptedAttempt);

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

    const isPartnerAccept = normalizeString(contact?.type).toLowerCase() === "partner";

    job.acceptedBy = {
      contactId: normalizeString(args.contactId),
      contactName: contact?.name || "",
      channel: "call",
      at: new Date().toISOString(),
      etaMinutes: args.etaMinutes || null,
      notes: normalizeString(args.notes)
    };
    appendTimeline(job, "job-accepted", { ...job.acceptedBy, attemptId: acceptedAttempt.id, isPartner: isPartnerAccept }, `tech:${args.contactId}`);

    const acknowledgement = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(job, contact, config));
    try { await sendSlackMessage(config, acknowledgement); } catch {}

    if (isPartnerAccept) {
      // Provisional subcontractor assignment — hold for replacement window
      transitionState(job, STATES.PROVISIONAL_SUB_ASSIGNMENT, { contactId: args.contactId });
      job.provisionalSubId = normalizeString(args.contactId);
      job.provisionalSubAt = new Date().toISOString();
      const customerCallResult = await callCustomerUpdate(config, job, "sub_dispatched");
      appendTimeline(job, "customer-callback", { type: "sub_dispatched", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
      (job.customerCallbacks = job.customerCallbacks || []).push({ type: "sub_dispatched", at: new Date().toISOString(), outcome: customerCallResult.ok ? "completed" : "failed", callId: customerCallResult.callId, error: customerCallResult.error || null });

      const rule = (config.routingRules || []).find((r) => r.id === job.matchedRuleId);
      const subWindow = Number(rule?.strategy?.subReplacementWindowMinutes || config.escalation?.subReplacementWindowMinutes || 10);
      setEscalationDeadline(job, subWindow, job.escalationStep);
      scheduleEscalation(job.id, subWindow, config, job.escalationStep);
      await saveJobs(jobs);
    } else {
      // Internal tech confirmed
      transitionState(job, STATES.DISPATCH_CONFIRMED_INTERNAL, { contactId: args.contactId });
      clearEscalation(job.id);
      job.escalationDueAt = null;
      job.escalationScheduledForStep = null;

      const customerCallResult = await callCustomerUpdate(config, job, "accepted", contact?.name || "a technician", args.etaMinutes);
      appendTimeline(job, "customer-callback", { type: "accepted", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
      (job.customerCallbacks = job.customerCallbacks || []).push({ type: "accepted", at: new Date().toISOString(), outcome: customerCallResult.ok ? "completed" : "failed", callId: customerCallResult.callId, error: customerCallResult.error || null });
      closeJobIfTerminal(job);
      await saveJobs(jobs);
    }

    const result = { success: true, status: "accepted" };
    if (toolCall?.id) return sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: JSON.stringify(result) }] });
    return sendJson(res, 200, result);
  }

  // Twilio incoming SMS webhook — techs reply YES/NO
  if (req.method === "POST" && pathname === "/api/twilio/incoming-sms") {
    const body = await parseBody(req);
    const signature = normalizeString(req.headers["x-twilio-signature"]);
    const requestUrl = buildRequestUrl(req, pathname);
    const authToken = normalizeString(config.twilio?.authToken);
    if (authToken && !validateTwilioSignature(authToken, signature, requestUrl, body)) {
      log("sms-invalid-signature", { requestUrl });
      throw new HttpError(401, "Twilio signature verification failed.");
    }

    const from = normalizeString(body.From);
    const parsedSms = parseSmsResponse(body.Body);
    log("sms-incoming", { from, body: body.Body, decision: parsedSms.decision || "(none)", jobId: parsedSms.jobId || "(none)" });

    // Find the contact by phone number
    const contact = (config.contacts || []).find((c) => normalizeString(c.phone) === from || normalizeString(c.smsPhone) === from);
    if (!contact) {
      log("sms-unknown-number", { from });
      return sendTwimlMessage(res, "Unknown number. Contact dispatch directly.");
    }

    log("sms-contact-matched", { from, contactId: contact.id, contactName: contact.name });

    const resolution = resolveSmsJobForContact(jobs, contact.id, body.Body);
    if (resolution.status === "none") {
      log("sms-no-open-job", { contactId: contact.id });
      return sendTwimlMessage(res, "No active job found for you.");
    }

    if (resolution.status === "unknown-job") {
      const choices = resolution.candidates
        .slice(0, 3)
        .map((job) => `${job.id} (${job.issueType || "service"} at ${job.locationArea || "unknown location"})`)
        .join("; ");
      log("sms-unknown-job-id", { contactId: contact.id, requestedJobId: resolution.parsed.jobId, candidateCount: resolution.candidates.length });
      return sendTwimlMessage(res, `I couldn't match that job ID. Reply YES ${resolution.candidates[0].id} or NO ${resolution.candidates[0].id}. Open jobs: ${choices}`);
    }

    if (resolution.status === "ambiguous") {
      const choices = resolution.candidates
        .slice(0, 3)
        .map((job) => `${job.id} (${job.issueType || "service"} at ${job.locationArea || "unknown location"})`)
        .join("; ");
      log("sms-ambiguous-job", { contactId: contact.id, candidateCount: resolution.candidates.length });
      return sendTwimlMessage(res, `Multiple active jobs found. Reply YES job_id or NO job_id. Open jobs: ${choices}`);
    }

    const matchedJob = resolution.job;

    if (parsedSms.decision === "accepted") {
      log("job-accepted", { source: "sms", jobId: matchedJob.id, contactId: contact.id, contactName: contact.name });
      const acceptedAttempt = {
        id: `attempt_${randomUUID()}`,
        at: new Date().toISOString(),
        contactId: contact.id,
        channel: "sms",
        status: "accepted",
        notes: `SMS reply: ${body.Body}`
      };
      matchedJob.attempts.push(acceptedAttempt);

      // Handle late accepts
      if (matchedJob.state === STATES.PROVISIONAL_SUB_ASSIGNMENT || matchedJob.state === STATES.UNABLE_TO_DISPATCH) {
        const handled = await handleLateAccept(matchedJob, config, contact, jobs);
        if (handled) {
          matchedJob.acceptedBy = { contactId: contact.id, contactName: contact.name, channel: "sms", at: new Date().toISOString() };
          await saveJobs(jobs);
          const ackText = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(matchedJob, contact, config));
          return sendTwimlMessage(res, ackText);
        }
      }

      const isPartnerAccept = normalizeString(contact.type).toLowerCase() === "partner";

      matchedJob.acceptedBy = {
        contactId: contact.id,
        contactName: contact.name,
        channel: "sms",
        at: new Date().toISOString()
      };
      appendTimeline(matchedJob, "job-accepted", { ...matchedJob.acceptedBy, attemptId: acceptedAttempt.id, isPartner: isPartnerAccept }, `tech:${contact.id}`);

      const ackText = renderTemplate(config.messageTemplates?.acceptanceAck, getTemplateValues(matchedJob, contact, config));
      try { await sendSlackMessage(config, ackText); } catch {}

      if (isPartnerAccept) {
        transitionState(matchedJob, STATES.PROVISIONAL_SUB_ASSIGNMENT, { contactId: contact.id });
        matchedJob.provisionalSubId = contact.id;
        matchedJob.provisionalSubAt = new Date().toISOString();
        const customerCallResult = await callCustomerUpdate(config, matchedJob, "sub_dispatched");
        appendTimeline(matchedJob, "customer-callback", { type: "sub_dispatched", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
        (matchedJob.customerCallbacks = matchedJob.customerCallbacks || []).push({ type: "sub_dispatched", at: new Date().toISOString(), outcome: customerCallResult.ok ? "completed" : "failed", callId: customerCallResult.callId, error: customerCallResult.error || null });

        const rule = (config.routingRules || []).find((r) => r.id === matchedJob.matchedRuleId);
        const subWindow = Number(rule?.strategy?.subReplacementWindowMinutes || config.escalation?.subReplacementWindowMinutes || 10);
        setEscalationDeadline(matchedJob, subWindow, matchedJob.escalationStep);
        scheduleEscalation(matchedJob.id, subWindow, config, matchedJob.escalationStep);
        await saveJobs(jobs);
      } else {
        transitionState(matchedJob, STATES.DISPATCH_CONFIRMED_INTERNAL, { contactId: contact.id });
        clearEscalation(matchedJob.id);
        matchedJob.escalationDueAt = null;
        matchedJob.escalationScheduledForStep = null;

        const customerCallResult = await callCustomerUpdate(config, matchedJob, "accepted", contact.name);
        appendTimeline(matchedJob, "customer-callback", { type: "accepted", callId: customerCallResult.callId, error: customerCallResult.error, skipped: customerCallResult.skipped });
        (matchedJob.customerCallbacks = matchedJob.customerCallbacks || []).push({ type: "accepted", at: new Date().toISOString(), outcome: customerCallResult.ok ? "completed" : "failed", callId: customerCallResult.callId, error: customerCallResult.error || null });
        closeJobIfTerminal(matchedJob);
        await saveJobs(jobs);
      }
      return sendTwimlMessage(res, ackText);
    }

    if (parsedSms.decision === "declined") {
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

      return sendTwimlMessage(res, "Got it, you've been removed from this job.");
    }

    if (resolution.candidates.length > 1) {
      return sendTwimlMessage(res, "Reply YES job_id to accept or NO job_id to decline.");
    }
    return sendTwimlMessage(res, `Reply YES ${matchedJob.id} to accept or NO ${matchedJob.id} to decline.`);
  }

  // Vapi call-ended webhook
  if (req.method === "POST" && pathname === "/api/vapi/call-ended") {
    const { parsed: body, raw: rawBody } = await parseBody(req, { returnRaw: true });
    const vapiSecret = getVapiWebhookSecret(config);
    if (!validateVapiSignature(vapiSecret, rawBody, normalizeString(req.headers["x-vapi-signature"]))) {
      throw new HttpError(401, "Vapi webhook signature verification failed.");
    }
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
        // But only if the dispatch agent didn't already report a response (accept/decline)
        // during this call — check if there's a recent accept/decline attempt for this contact
        const hasRecentResponse = (job.attempts || []).some((a) =>
          a.contactId === contactId && (a.status === "accepted" || a.status === "declined")
        );
        const noAnswer = !["ended", "completed"].includes(callStatus);
        if (noAnswer && !hasRecentResponse && getJobStatus(job) === "open") {
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

  if ((req.method === "POST" || req.method === "GET") && pathname === "/api/cron/process-escalations") {
    requireBearerToken(req, normalizeString(process.env.CRON_SECRET), "Cron");
    const lockResult = await withCronLock(async () => {
      const now = Date.now();
      const dueJobs = jobs.filter((job) => {
        if (getJobStatus(job) !== "open") {
          return false;
        }
        if (!job.escalationDueAt) {
          return false;
        }
        return new Date(job.escalationDueAt).getTime() <= now;
      });

      for (const job of dueJobs) {
        if (job.escalationScheduledForStep != null && job.escalationScheduledForStep !== job.escalationStep) {
          continue;
        }
        await advanceEscalation(job, config, jobs);
      }

      // Auto-close stale confirmed/unable jobs
      const autoCloseMinutes = Number(config.escalation?.autoCloseMinutes || 60);
      const closedIds = [];
      for (const job of jobs) {
        const closeable = [STATES.DISPATCH_CONFIRMED_INTERNAL, STATES.DISPATCH_CONFIRMED_SUBCONTRACTOR, STATES.UNABLE_TO_DISPATCH];
        if (!closeable.includes(job.state)) continue;
        const age = now - new Date(job.updatedAt).getTime();
        if (age > autoCloseMinutes * 60 * 1000) {
          transitionState(job, STATES.CLOSED, { reason: "auto-close" });
          closedIds.push(job.id);
        }
      }

      if (dueJobs.length || closedIds.length) {
        await saveJobs(jobs);
      }

      return { escalated: dueJobs.map((job) => job.id), closed: closedIds };
    });

    if (!lockResult.acquired) {
      return sendJson(res, 202, { success: true, skipped: true, reason: "lock-unavailable", processed: [] });
    }

    return sendJson(res, 200, { success: true, ...lockResult.result });
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
  const resolvedPath = path.resolve(PUBLIC_DIR, `.${relativePath}`);
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden.");
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return serveStatic(res, path.join(relativePath, "index.html"));
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    const body = await fs.readFile(resolvedPath);
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
  await ensureDbSchema();
  _initialized = true;
}

async function handler(req, res) {
  try {
    await ensureInit();
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (requiresDashboardAuth(url.pathname) && !requireDashboardAuth(req, res)) {
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url.pathname);
    }
    return await serveStatic(res, url.pathname);
  } catch (error) {
    log("api-error", { method: req.method, url: req.url, error: error.message, stack: error.stack?.split("\n").slice(0, 3).join(" | ") });
    if (error instanceof HttpError) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
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
module.exports._internals = {
  STATES,
  buildDispatchBatch,
  closeJobIfTerminal,
  computeNextTargets,
  createJobFromPayload,
  defaultConfig,
  findMatchingRule,
  getJobStatus,
  getActiveJobsForContact,
  handleSubReplacementTimeout,
  isVapiResponsePath,
  matchesRule,
  mergeConfig,
  parseSmsResponse,
  requiresDashboardAuth,
  resolveSmsJobForContact,
  safeEqualString,
  sanitizeConfigForUi,
  sanitizeConfigInput,
  transitionState,
  validateTwilioSignature
};
