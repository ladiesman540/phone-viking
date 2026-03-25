const state = {
  config: null,
  jobs: [],
  activeTab: "jobs"
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
    const acceptedBy = job.acceptedBy?.contactName ? `Accepted by ${job.acceptedBy.contactName}` : "Unassigned";
    const attempts = (job.attempts || [])
      .slice(-3)
      .map((attempt) => `${attempt.channel}:${attempt.status}:${attempt.contactId}`)
      .join(" | ");

    const head = document.createElement("div");
    head.className = "job-head";

    const headLeft = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = job.state || job.status || "open";
    const title = document.createElement("h3");
    title.textContent = `${job.issueType || "Unspecified issue"} · ${job.locationArea || "Unknown area"}`;
    headLeft.append(eyebrow, title);

    const timestamp = document.createElement("span");
    timestamp.textContent = new Date(job.createdAt).toLocaleString();
    head.append(headLeft, timestamp);

    const summary = document.createElement("p");
    summary.textContent = job.summary || "No summary";

    const callerMeta = document.createElement("p");
    callerMeta.className = "job-meta";
    callerMeta.textContent = `Caller: ${job.callerName || "-"} · Callback: ${job.callbackNumber || "-"} · Rule: ${job.matchedRuleId || "none"}`;

    const acceptedMeta = document.createElement("p");
    acceptedMeta.className = "job-meta";
    acceptedMeta.textContent = acceptedBy;

    const attemptsMeta = document.createElement("p");
    attemptsMeta.className = "job-meta";
    attemptsMeta.textContent = `Recent attempts: ${attempts || "none"}`;

    const escalationMeta = document.createElement("p");
    escalationMeta.className = "job-meta";
    escalationMeta.textContent = job.escalationDueAt
      ? `Next escalation: ${new Date(job.escalationDueAt).toLocaleString()}`
      : "Next escalation: none";

    article.append(head, summary, callerMeta, acceptedMeta, attemptsMeta, escalationMeta);
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
    mayReplaceSubcontractor: contact.mayReplaceSubcontractor !== false
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

loadAll()
  .then(wireActions)
  .catch((error) => {
    setSaveStatus(error.message, "error");
  });
