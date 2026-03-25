const state = {
  config: null,
  jobs: [],
  activeTab: "jobs",
  selectedJobId: null,
  selectedJob: null,
  lastEventTime: "",
  events: []
};

const elements = {
  saveButton: document.querySelector("#save-config"),
  refreshButton: document.querySelector("#refresh-all"),
  saveStatus: document.querySelector("#save-status"),
  intakeFields: document.querySelector("#intake-fields"),
  contacts: document.querySelector("#contacts"),
  routingRules: document.querySelector("#routing-rules"),
  jobs: document.querySelector("#jobs"),
  jobResult: document.querySelector("#job-result")
};

const templates = {
  field: document.querySelector("#field-template"),
  contact: document.querySelector("#contact-template"),
  rule: document.querySelector("#rule-template")
};

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tab === tabName);
  });
  render();
}

function setSaveStatus(message, mode = "idle") {
  elements.saveStatus.textContent = message;
  elements.saveStatus.dataset.mode = mode;
}

function normalizeCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function deepGet(object, path) {
  return path.split(".").reduce((current, key) => (current == null ? current : current[key]), object);
}

function deepSet(object, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let current = object;
  for (const part of parts) {
    if (current[part] == null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[last] = value;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "item";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json();
}

function bindRootInputs() {
  document.querySelectorAll("[data-path]").forEach((input) => {
    const path = input.dataset.path;
    let value;

    if (path === "workspace.businessHours.daysCsv") {
      value = (state.config.workspace.businessHours.days || []).join(",");
    } else {
      value = deepGet(state.config, path);
    }

    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value ?? "";
    }

    input.oninput = () => {
      const nextValue =
        input.type === "checkbox"
          ? input.checked
          : input.type === "number"
            ? Number(input.value || 0)
            : input.value;

      if (path === "workspace.businessHours.daysCsv") {
        state.config.workspace.businessHours.days = normalizeCsv(nextValue);
      } else {
        deepSet(state.config, path, nextValue);
      }

      setSaveStatus("Unsaved changes.", "dirty");
    };
  });
}

function createFieldCard(field, index) {
  const node = templates.field.content.firstElementChild.cloneNode(true);

  node.querySelectorAll("[data-prop]").forEach((input) => {
    const prop = input.dataset.prop;
    const value = field[prop];

    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value ?? "";
    }

    input.oninput = () => {
      field[prop] = input.type === "checkbox" ? input.checked : input.value;
      if (prop === "id" && !field.id) {
        field.id = `field_${index + 1}`;
      }
      setSaveStatus("Unsaved changes.", "dirty");
    };
  });

  node.querySelector("[data-action='remove']").onclick = () => {
    state.config.intakeFields.splice(index, 1);
    render();
    setSaveStatus("Unsaved changes.", "dirty");
  };

  return node;
}

function createContactCard(contact, index) {
  const node = templates.contact.content.firstElementChild.cloneNode(true);
  node.querySelector("h3").textContent = contact.name || `Contact ${index + 1}`;

  node.querySelectorAll("[data-prop]").forEach((input) => {
    const prop = input.dataset.prop;
    let value = contact[prop];
    if (prop === "serviceAreasCsv") {
      value = (contact.serviceAreas || []).join(",");
    }
    if (prop === "tradeTagsCsv") {
      value = (contact.tradeTags || []).join(",");
    }

    if (input.type === "checkbox") {
      if (prop === "active" || prop === "mayReplaceSubcontractor") {
        input.checked = value !== false;
      } else {
        input.checked = Boolean(value);
      }
    } else {
      input.value = value ?? "";
    }

    input.oninput = () => {
      if (prop === "serviceAreasCsv") {
        contact.serviceAreas = normalizeCsv(input.value);
      } else if (prop === "tradeTagsCsv") {
        contact.tradeTags = normalizeCsv(input.value);
      } else if (input.type === "checkbox") {
        contact[prop] = input.checked;
      } else if (input.type === "number") {
        contact[prop] = Number(input.value || 0);
      } else {
        contact[prop] = input.value;
      }

      if (!contact.id) {
        contact.id = `contact_${slugify(contact.name || `contact_${index + 1}`)}`;
      }
      renderRoutingRules();
      setSaveStatus("Unsaved changes.", "dirty");
    };
  });

  node.querySelector("[data-action='remove']").onclick = () => {
    state.config.contacts.splice(index, 1);
    render();
    setSaveStatus("Unsaved changes.", "dirty");
  };

  return node;
}

function createTargetsSelector(rule) {
  const wrapper = document.createElement("div");
  wrapper.className = "target-grid";
  const selectedIds = new Set(rule.targetContactIds || []);

  state.config.contacts.forEach((contact) => {
    const label = document.createElement("label");
    label.className = "target-pill";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedIds.has(contact.id);
    checkbox.oninput = () => {
      if (checkbox.checked) {
        selectedIds.add(contact.id);
      } else {
        selectedIds.delete(contact.id);
      }
      rule.targetContactIds = Array.from(selectedIds);
      setSaveStatus("Unsaved changes.", "dirty");
    };

    const text = document.createElement("span");
    text.textContent = `${contact.name || "Unnamed"} (${contact.type || "tech"} / tier ${contact.priorityTier || 1})`;

    label.append(checkbox, text);
    wrapper.append(label);
  });

  if (!state.config.contacts.length) {
    wrapper.innerHTML = '<p class="hint">Add contacts first, then choose which ones each rule can use.</p>';
  }

  return wrapper;
}

function createRuleCard(rule, index) {
  const node = templates.rule.content.firstElementChild.cloneNode(true);
  node.querySelector("h3").textContent = rule.name || `Rule ${index + 1}`;

  node.querySelectorAll("[data-prop]").forEach((input) => {
    const prop = input.dataset.prop;
    let value = deepGet(rule, prop);

    if (prop === "conditions.issueTypesCsv") {
      value = (rule.conditions.issueTypes || []).join(",");
    }
    if (prop === "conditions.urgenciesCsv") {
      value = (rule.conditions.urgencies || []).join(",");
    }
    if (prop === "conditions.areasCsv") {
      value = (rule.conditions.areas || []).join(",");
    }
    if (prop === "conditions.contactTypesCsv") {
      value = (rule.conditions.contactTypes || []).join(",");
    }
    if (prop === "conditions.requiredTradeTagsCsv") {
      value = (rule.conditions.requiredTradeTags || []).join(",");
    }
    if (prop === "strategy.escalationSequenceJson") {
      value = JSON.stringify(rule.strategy.escalationSequence || [], null, 2);
    }

    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value ?? "";
    }

    input.oninput = () => {
      const nextValue =
        input.type === "checkbox"
          ? input.checked
          : input.type === "number"
            ? Number(input.value || 0)
            : input.value;

      if (prop === "conditions.issueTypesCsv") {
        rule.conditions.issueTypes = normalizeCsv(nextValue);
      } else if (prop === "conditions.urgenciesCsv") {
        rule.conditions.urgencies = normalizeCsv(nextValue);
      } else if (prop === "conditions.areasCsv") {
        rule.conditions.areas = normalizeCsv(nextValue);
      } else if (prop === "conditions.contactTypesCsv") {
        rule.conditions.contactTypes = normalizeCsv(nextValue);
      } else if (prop === "conditions.requiredTradeTagsCsv") {
        rule.conditions.requiredTradeTags = normalizeCsv(nextValue);
      } else if (prop === "strategy.escalationSequenceJson") {
        try {
          rule.strategy.escalationSequence = JSON.parse(nextValue || "[]");
          input.setCustomValidity("");
        } catch {
          input.setCustomValidity("Invalid JSON");
        }
      } else {
        deepSet(rule, prop, nextValue);
      }

      if (!rule.id) {
        rule.id = `rule_${slugify(rule.name || `rule_${index + 1}`)}`;
      }
      setSaveStatus("Unsaved changes.", "dirty");
    };
  });

  const targetContainer = node.querySelector("[data-role='targets']");
  targetContainer.replaceChildren(createTargetsSelector(rule));

  node.querySelector("[data-action='remove']").onclick = () => {
    state.config.routingRules.splice(index, 1);
    render();
    setSaveStatus("Unsaved changes.", "dirty");
  };

  return node;
}

function renderIntakeFields() {
  elements.intakeFields.replaceChildren(...state.config.intakeFields.map(createFieldCard));
}

function renderContacts() {
  elements.contacts.replaceChildren(...state.config.contacts.map(createContactCard));
}

function renderRoutingRules() {
  elements.routingRules.replaceChildren(...state.config.routingRules.map(createRuleCard));
}

function jobStatusLabel(job) {
  const s = job.state;
  if (!s) return "open";
  if (s === "DISPATCH_CONFIRMED_INTERNAL" || s === "DISPATCH_CONFIRMED_SUBCONTRACTOR") return "accepted";
  if (s === "HUMAN_REVIEW_REQUIRED") return "paused";
  if (s === "CLOSED" || s === "UNABLE_TO_DISPATCH") return "closed";
  return "open";
}

function timeAgo(isoString) {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(isoString).toLocaleDateString();
}

function renderJobs() {
  if (!state.jobs.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "No jobs yet. Use the simulator or the voice-agent create-job function to create one.";
    elements.jobs.replaceChildren(hint);
    return;
  }

  const articles = state.jobs.map((job) => {
    const article = document.createElement("article");
    article.className = "job-card";
    article.onclick = () => openJobDetail(job.id);

    const head = document.createElement("div");
    head.className = "job-head";

    const headLeft = document.createElement("div");
    const badge = document.createElement("span");
    badge.className = "state-badge";
    badge.dataset.status = jobStatusLabel(job);
    badge.textContent = job.finalStatus || job.state || "open";
    const title = document.createElement("h3");
    title.textContent = `${job.issueType || "Unspecified"} · ${job.locationArea || "Unknown"}`;
    headLeft.append(badge, title);

    const timestamp = document.createElement("span");
    timestamp.textContent = timeAgo(job.createdAt);
    head.append(headLeft, timestamp);

    const summary = document.createElement("p");
    summary.textContent = job.summary || "No summary";

    const meta = document.createElement("p");
    meta.className = "job-meta";
    const acceptedBy = job.acceptedBy?.contactName ? `${job.acceptedBy.contactName}` : "unassigned";
    const attemptCount = (job.attempts || []).length;
    meta.textContent = `${job.callerName || "-"} · ${acceptedBy} · ${attemptCount} attempt${attemptCount !== 1 ? "s" : ""}`;

    const escalation = document.createElement("p");
    escalation.className = "job-meta";
    if (job.escalationDueAt) {
      const remaining = Math.max(0, Math.round((new Date(job.escalationDueAt).getTime() - Date.now()) / 1000));
      escalation.textContent = remaining > 0 ? `Escalation in ${remaining}s` : "Escalation due";
    }

    article.append(head, summary, meta, escalation);
    return article;
  });

  elements.jobs.replaceChildren(...articles);
}

function render() {
  if (!state.config) return;
  const tab = state.activeTab;
  if (tab === "jobs") {
    renderJobs();
  } else if (tab === "contacts") {
    renderContacts();
  } else if (tab === "routing") {
    bindRootInputs();
    renderIntakeFields();
    renderRoutingRules();
  } else if (tab === "setup") {
    bindRootInputs();
  }
}

async function loadAll() {
  const [config, jobs] = await Promise.all([
    fetchJson("/api/config"),
    fetchJson("/api/jobs")
  ]);

  state.config = config;
  state.jobs = jobs;
  render();
  setSaveStatus("Dashboard loaded.", "ok");
}

async function saveConfig() {
  setSaveStatus("Saving dashboard...", "busy");
  state.config.contacts = state.config.contacts.map((contact, index) => ({
    ...contact,
    id: contact.id || `contact_${slugify(contact.name || `contact_${index + 1}`)}`,
    name: contact.name || "",
    company: contact.company || "",
    type: contact.type || "tech",
    priorityTier: Number(contact.priorityTier || 1),
    phone: contact.phone || "",
    smsPhone: contact.smsPhone || contact.phone || "",
    serviceAreas: contact.serviceAreas || [],
    availability: contact.availability || "",
    notes: contact.notes || "",
    active: contact.active !== false,
    doNotUse: Boolean(contact.doNotUse),
    mayReplaceSubcontractor: contact.mayReplaceSubcontractor !== false,
    tradeTags: contact.tradeTags || []
  }));

  state.config.routingRules = state.config.routingRules.map((rule, index) => ({
    ...rule,
    id: rule.id || `rule_${slugify(rule.name || `rule_${index + 1}`)}`,
    name: rule.name || `Rule ${index + 1}`,
    active: rule.active !== false,
    sortOrder: Number(rule.sortOrder || index + 1),
    conditions: {
      ...(rule.conditions || {}),
      issueTypes: rule.conditions.issueTypes || [],
      urgencies: rule.conditions.urgencies || [],
      areas: rule.conditions.areas || [],
      scheduleMode: rule.conditions.scheduleMode || "any",
      contactTypes: rule.conditions.contactTypes || []
    },
    strategy: {
      ...(rule.strategy || {}),
      initialTier: Number(rule.strategy.initialTier || 1),
      batchSize: Number(rule.strategy.batchSize || 3),
      escalateAfterMinutes: Number(rule.strategy.escalateAfterMinutes || 5),
      subReplacementWindowMinutes: Number(rule.strategy.subReplacementWindowMinutes || 10),
      leaveVoicemail: Boolean(rule.strategy.leaveVoicemail),
      sendSms: rule.strategy.sendSms !== false,
      notifySlackOnEscalation: Boolean(rule.strategy.notifySlackOnEscalation),
      escalationSequence: Array.isArray(rule.strategy.escalationSequence) ? rule.strategy.escalationSequence : []
    },
    targetContactIds: rule.targetContactIds || []
  }));

  state.config.intakeFields = state.config.intakeFields.map((field, index) => ({
    ...field,
    id: field.id || `field_${index + 1}`,
    label: field.label || `Field ${index + 1}`,
    type: field.type || "text",
    required: Boolean(field.required),
    helpText: field.helpText || ""
  }));

  state.config.workspace.businessHours.days = normalizeCsv(state.config.workspace.businessHours.days);

  state.config = await fetchJson("/api/config", {
    method: "PUT",
    body: JSON.stringify(state.config)
  });

  render();
  setSaveStatus("Dashboard saved.", "ok");
}

async function createTestJob() {
  const payload = {
    callerName: document.querySelector("#job-callerName").value,
    callbackNumber: document.querySelector("#job-callbackNumber").value,
    serviceAddress: document.querySelector("#job-serviceAddress").value,
    locationArea: document.querySelector("#job-locationArea").value,
    issueType: document.querySelector("#job-issueType").value,
    urgency: document.querySelector("#job-urgency").value,
    summary: document.querySelector("#job-summary").value,
    notes: document.querySelector("#job-notes").value
  };

  const result = await fetchJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  elements.jobResult.textContent = JSON.stringify(result, null, 2);
  state.jobs = await fetchJson("/api/jobs");
  renderJobs();
}

function wireActions() {
  elements.saveButton.onclick = () => saveConfig().catch((error) => setSaveStatus(error.message, "error"));
  elements.refreshButton.onclick = () => loadAll().catch((error) => setSaveStatus(error.message, "error"));

  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  document.querySelector("#add-field").onclick = () => {
    state.config.intakeFields.push({
      id: `field_${state.config.intakeFields.length + 1}`,
      label: "",
      type: "text",
      required: false,
      helpText: ""
    });
    renderIntakeFields();
    setSaveStatus("Unsaved changes.", "dirty");
  };
  document.querySelector("#add-contact").onclick = () => {
    state.config.contacts.push({
      id: "",
      name: "",
      company: "",
      type: "tech",
      priorityTier: 1,
      phone: "",
      smsPhone: "",
      serviceAreas: [],
      availability: "",
      notes: "",
      active: true,
      doNotUse: false,
      mayReplaceSubcontractor: true
    });
    render();
    setSaveStatus("Unsaved changes.", "dirty");
  };
  document.querySelector("#add-rule").onclick = () => {
    state.config.routingRules.push({
      id: "",
      name: "",
      active: true,
      sortOrder: state.config.routingRules.length + 1,
      conditions: {
        issueTypes: [],
        urgencies: [],
        areas: [],
        scheduleMode: "any",
        contactTypes: []
      },
      strategy: {
        initialTier: 1,
        batchSize: 3,
        escalateAfterMinutes: 5,
        subReplacementWindowMinutes: 10,
        leaveVoicemail: false,
        sendSms: true,
        notifySlackOnEscalation: true,
        escalationSequence: []
      },
      targetContactIds: []
    });
    render();
    setSaveStatus("Unsaved changes.", "dirty");
  };
  document.querySelector("#create-job").onclick = () => {
    createTestJob().catch((error) => {
      elements.jobResult.textContent = error.message;
    });
  };
}

// --- Polling ---

let pollTimer = null;

function startPolling(ms = 5000) {
  stopPolling();
  pollTimer = setInterval(() => {
    loadAll().catch(() => {});
    if (state.activeTab === "jobs" && !state.selectedJobId) loadEvents().catch(() => {});
  }, ms);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// --- Event feed ---

const EVENT_LABELS = {
  "job-created": (e) => `Job created (${e.issueType || "service"})`,
  "state-change": (e) => `State \u2192 ${e.to}`,
  "attempt-logged": (e) => `${e.channel || "?"} to ${e.contactId} (${e.status})`,
  "customer-callback": (e) => `Customer callback: ${e.type} (${e.outcome || "?"})`,
  "call-ended": (e) => `Call ended: ${e.callStatus || "?"}`,
  "job-accepted": (e) => `Accepted by ${e.contactName || e.contactId}`,
  "job-declined": (e) => `Declined by ${e.contactId}`,
  "human-review-flagged": (e) => `REVIEW NEEDED: ${e.trigger}`,
  "human-review-resolved": (e) => `Review resolved: ${e.trigger}`,
  "sub-cancelled": () => "Sub cancelled",
  "en-route-confirmed": () => "Sub marked en route",
  "workflow-resumed": (e) => `Workflow resumed \u2192 ${e.resumedTo}`,
  "slack-summary": () => "Slack posted",
  "manual-close": () => "Manually closed"
};

const EVENT_SEVERITY = {
  "job-created": "info", "state-change": "info", "attempt-logged": "info",
  "customer-callback": "success", "job-accepted": "success", "en-route-confirmed": "success",
  "workflow-resumed": "success", "slack-summary": "info", "manual-close": "info",
  "call-ended": "warning", "job-declined": "warning", "sub-cancelled": "warning",
  "human-review-flagged": "error", "human-review-resolved": "success"
};

async function loadEvents() {
  const since = state.lastEventTime || new Date(Date.now() - 3600000).toISOString();
  const events = await fetchJson(`/api/events?since=${encodeURIComponent(since)}&limit=30`);
  if (events.length) {
    state.events = events;
    state.lastEventTime = events[0].at;
    renderEventFeed();
  }
}

function renderEventFeed() {
  const feed = document.querySelector("#event-feed");
  const countBadge = document.querySelector("#event-count");
  if (!feed) return;

  const rows = state.events.slice(0, 25).map((evt) => {
    const row = document.createElement("div");
    row.className = "event-row";
    row.dataset.severity = EVENT_SEVERITY[evt.type] || "info";
    row.onclick = () => openJobDetail(evt.jobId);

    const time = document.createElement("span");
    time.className = "evt-time";
    time.textContent = new Date(evt.at).toLocaleTimeString();

    const jobId = document.createElement("span");
    jobId.className = "evt-job";
    jobId.textContent = evt.jobId?.slice(0, 12) || "?";

    const text = document.createElement("span");
    text.className = "evt-text";
    const labelFn = EVENT_LABELS[evt.type];
    text.textContent = labelFn ? labelFn(evt) : evt.type;

    row.append(time, jobId, text);
    return row;
  });

  feed.replaceChildren(...rows);
  if (countBadge) countBadge.textContent = state.events.length > 0 ? String(state.events.length) : "";
}

// --- Job detail panel ---

async function openJobDetail(jobId) {
  state.selectedJobId = jobId;
  try {
    state.selectedJob = await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`);
  } catch {
    state.selectedJob = state.jobs.find((j) => j.id === jobId) || null;
  }
  document.querySelector("#jobs-list-view").style.display = "none";
  const panel = document.querySelector("#job-detail");
  panel.style.display = "block";
  renderJobDetail();
}

function closeJobDetail() {
  state.selectedJobId = null;
  state.selectedJob = null;
  document.querySelector("#job-detail").style.display = "none";
  document.querySelector("#jobs-list-view").style.display = "";
}

function renderJobDetail() {
  const job = state.selectedJob;
  if (!job) return;
  const container = document.querySelector("#job-detail-content");
  const status = jobStatusLabel(job);
  const contactMap = new Map((state.config?.contacts || []).map((c) => [c.id, c]));

  let html = `<div class="panel">`;

  // Header
  html += `<div class="detail-header">
    <div>
      <span class="state-badge" data-status="${status}">${job.finalStatus || job.state || "open"}</span>
      <h2>${job.issueType || "Service request"} &middot; ${job.locationArea || "Unknown"}</h2>
      <p class="job-meta">${job.id} &middot; ${new Date(job.createdAt).toLocaleString()} &middot; Rule: ${job.matchedRuleId || "none"}</p>
    </div>
  </div>`;

  // Caller info grid
  html += `<div class="detail-grid">`;
  const fields = [
    ["Caller", job.callerName], ["Callback", job.callbackNumber], ["Alternate", job.alternateNumber],
    ["Address", job.serviceAddress], ["Area", job.locationArea], ["Issue", job.issueType],
    ["Urgency", job.urgency], ["Severity", job.severity], ["Hazards", job.hazards],
    ["Company", job.companySiteName], ["Access", job.accessInstructions], ["On site", job.anyoneOnsite ? "Yes" : ""]
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    html += `<div class="detail-field"><div class="field-label">${label}</div><div class="field-value">${escapeHtml(String(value))}</div></div>`;
  }
  html += `</div>`;

  // Summary
  if (job.summary) html += `<p>${escapeHtml(job.summary)}</p>`;

  // Dispatch status
  if (job.acceptedBy) {
    html += `<div class="detail-grid" style="margin-top:12px">
      <div class="detail-field"><div class="field-label">Accepted by</div><div class="field-value">${escapeHtml(job.acceptedBy.contactName || job.acceptedBy.contactId)}</div></div>
      <div class="detail-field"><div class="field-label">Channel</div><div class="field-value">${job.acceptedBy.channel}</div></div>
      <div class="detail-field"><div class="field-label">ETA</div><div class="field-value">${job.acceptedBy.etaMinutes ? job.acceptedBy.etaMinutes + " min" : "-"}</div></div>
    </div>`;
  }
  if (job.escalationDueAt && status === "open") {
    const remaining = Math.max(0, Math.round((new Date(job.escalationDueAt).getTime() - Date.now()) / 1000));
    html += `<p class="job-meta" style="margin-top:8px">Escalation step ${job.escalationStep || 0} &middot; ${remaining > 0 ? remaining + "s remaining" : "due now"}</p>`;
  }

  // Attempts table
  const attempts = job.attempts || [];
  if (attempts.length) {
    html += `<div class="detail-section"><h3>Dispatch Attempts (${attempts.length})</h3>`;
    html += `<table class="attempts-table"><thead><tr><th>Time</th><th>Contact</th><th>Channel</th><th>Status</th><th>Notes</th></tr></thead><tbody>`;
    for (const a of attempts) {
      const contact = contactMap.get(a.contactId);
      const name = contact ? contact.name : a.contactId;
      html += `<tr>
        <td>${new Date(a.at).toLocaleTimeString()}</td>
        <td>${escapeHtml(name)}</td>
        <td>${a.channel}</td>
        <td class="status-${a.status}">${a.status}</td>
        <td>${escapeHtml(a.notes || "")}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // Customer callbacks
  const callbacks = job.customerCallbacks || [];
  if (callbacks.length) {
    html += `<div class="detail-section"><h3>Customer Callbacks (${callbacks.length})</h3>`;
    html += `<table class="attempts-table"><thead><tr><th>Time</th><th>Type</th><th>Outcome</th><th>Error</th></tr></thead><tbody>`;
    for (const cb of callbacks) {
      html += `<tr>
        <td>${new Date(cb.at).toLocaleTimeString()}</td>
        <td>${cb.type}</td>
        <td class="status-${cb.outcome === "completed" ? "accepted" : "failed"}">${cb.outcome}</td>
        <td>${escapeHtml(cb.error || "")}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // Timeline
  const timeline = (job.timeline || []).slice().reverse();
  if (timeline.length) {
    html += `<div class="detail-section"><h3>Timeline (${timeline.length} events)</h3><div class="timeline-list">`;
    for (const evt of timeline) {
      const severity = EVENT_SEVERITY[evt.type] || "info";
      const labelFn = EVENT_LABELS[evt.type];
      const label = labelFn ? labelFn(evt) : evt.type;
      html += `<div class="timeline-item" data-severity="${severity}">
        <span class="tl-time">${new Date(evt.at).toLocaleTimeString()}</span>
        <span class="tl-type">${escapeHtml(label)}</span>
        <span class="tl-detail">${evt.actor || ""}</span>
      </div>`;
    }
    html += `</div></div>`;
  }

  // Action buttons
  const actions = [];
  if (job.state === "HUMAN_REVIEW_REQUIRED") {
    const unresolvedFlags = (job.humanReviewFlags || []).filter((f) => !f.resolved);
    for (const flag of unresolvedFlags) {
      actions.push(`<button class="button button-warning" onclick="resolveReview('${job.id}','${flag.trigger}')">Resolve: ${escapeHtml(flag.trigger)}</button>`);
    }
  }
  if (job.state === "PROVISIONAL_SUB_ASSIGNMENT" && !job.enRouteConfirmedAt) {
    actions.push(`<button class="button button-success" onclick="markEnRoute('${job.id}')">Mark Sub En Route</button>`);
  }
  if (["DISPATCH_CONFIRMED_INTERNAL", "DISPATCH_CONFIRMED_SUBCONTRACTOR", "UNABLE_TO_DISPATCH"].includes(job.state)) {
    actions.push(`<button class="button button-secondary" onclick="closeJob('${job.id}')">Close Job</button>`);
  }
  if (actions.length) {
    html += `<div class="detail-actions">${actions.join("")}</div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Action handlers ---

async function resolveReview(jobId, trigger) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/resolve-review`, {
    method: "POST",
    body: JSON.stringify({ trigger, resolvedBy: "dispatcher" })
  });
  openJobDetail(jobId);
}

async function markEnRoute(jobId) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/en-route`, {
    method: "POST",
    body: JSON.stringify({})
  });
  openJobDetail(jobId);
}

async function closeJob(jobId) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/close`, {
    method: "POST",
    body: JSON.stringify({ closedBy: "dispatcher" })
  });
  openJobDetail(jobId);
}

loadAll()
  .then(() => {
    wireActions();
    document.querySelector("#job-detail-back").onclick = closeJobDetail;
    startPolling();
    loadEvents().catch(() => {});
  })
  .catch((error) => {
    setSaveStatus(error.message, "error");
  });
