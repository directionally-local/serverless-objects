// Dashboard for the loopback admin API. No framework and no build step: it
// renders with DOM APIs and textContent only, so storage values never become
// markup.

const $ = (id) => document.getElementById(id);
const state = { className: "", next: undefined, scope: undefined, kvNext: undefined, backupsNext: undefined };

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "x-sobjects-request": "1", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !(method === "POST" && data.error?.kind)) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

function showError(error) {
  const banner = $("error");
  banner.textContent = error ? String(error.message ?? error) : "";
  banner.hidden = !error;
}

function element(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function renderStats(target, entries) {
  target.replaceChildren(...entries
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([label, value]) => {
      const box = element("div");
      box.append(element("dt", label), element("dd", String(value)));
      return box;
    }));
}

function formatBytes(bytes) {
  if (typeof bytes !== "number") return undefined;
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function refreshNode() {
  try {
    const health = await api("/api/v1/health");
    const pill = $("health");
    pill.textContent = health.ok ? "engine healthy" : "engine unhealthy";
    pill.className = `pill ${health.ok ? "ok" : "bad"}`;
    $("version").textContent = `sobjects ${health.version}`;
  } catch (error) {
    $("health").textContent = "engine unreachable";
    $("health").className = "pill bad";
  }
  try {
    const node = await api("/api/v1/node");
    renderStats($("node"), [
      ["Resident objects", node.residentCells],
      ["Owned objects", node.ownedCells],
      ["WebSockets", node.websockets],
      ["Memory (RSS)", formatBytes(node.rssBytes)],
      ["CPU", node.cpuPercent === undefined ? undefined : `${node.cpuPercent.toFixed(1)}%`],
      ["Deployment", node.deployment?.version],
      ["Draining", node.draining ? "yes" : "no"],
      ["Memory pressure", node.pressured ? "yes" : "no"],
    ]);
  } catch (error) {
    $("node").replaceChildren(element("p", `Node state unavailable: ${error.message}`, { class: "muted" }));
  }
}

async function loadObjects({ append = false } = {}) {
  const params = new URLSearchParams({ limit: "50" });
  if (state.className) params.set("class", state.className);
  if (append && state.next) params.set("after", state.next);
  const page = await api(`/api/v1/objects?${params}`);
  const rows = page.objects.map((object) => {
    const row = element("tr", undefined, { "data-scope": object.scope });
    const id = element("td");
    id.append(element("code", object.id));
    row.append(element("td", object.className), id, element("td", object.resident ? "resident" : "stored"));
    if (object.scope === state.scope) row.classList.add("selected");
    return row;
  });
  if (append) $("object-rows").append(...rows);
  else $("object-rows").replaceChildren(...rows);
  if (!append && rows.length === 0) {
    const empty = element("tr");
    empty.append(element("td", "No objects yet.", { colspan: "3", class: "muted" }));
    $("object-rows").append(empty);
  }
  state.next = page.next;
  $("more").hidden = !page.next;
}

async function openObject(scope) {
  state.scope = scope;
  for (const row of $("object-rows").querySelectorAll("tr")) {
    row.classList.toggle("selected", row.dataset.scope === scope);
  }
  $("detail").hidden = false;
  $("detail-scope").textContent = scope;
  $("sql-result").replaceChildren();
  const encoded = encodeURIComponent(scope);
  $("export").href = `/api/v1/objects/${encoded}/export`;
  const summary = await api(`/api/v1/objects/${encoded}`);
  renderStats($("summary"), [
    ["Alarm", summary.alarm ?? "none"],
    ["WebSockets", summary.websockets?.count],
    ["SQL tables", summary.tables?.length],
  ]);
  const tables = $("tables");
  tables.replaceChildren();
  if (summary.tables?.length) {
    const list = element("p", "Tables: ", { class: "muted" });
    summary.tables.forEach((table, index) => {
      const button = element("button", `${table.name} (${table.rows ?? "?"})`, { type: "button" });
      button.addEventListener("click", () => {
        $("sql").value = `SELECT * FROM "${table.name.replace(/"/g, '""')}" LIMIT 100`;
        runSql().catch(showError);
      });
      if (index > 0) list.append(" ");
      list.append(button);
    });
    tables.append(list);
  }
  await listKv();
}

async function listKv({ append = false } = {}) {
  const params = new URLSearchParams({ limit: "50" });
  const prefix = $("kv-prefix").value;
  if (prefix) params.set("prefix", prefix);
  if (append && state.kvNext) params.set("startAfter", state.kvNext);
  const page = await api(`/api/v1/objects/${encodeURIComponent(state.scope)}/kv?${params}`);
  const rows = page.entries.map((entry) => {
    const row = element("tr");
    const key = element("td");
    key.append(element("code", entry.key));
    const value = element("td");
    value.append(element("pre", formatValue(entry.value)));
    row.append(key, value);
    return row;
  });
  if (append) $("kv-rows").append(...rows);
  else $("kv-rows").replaceChildren(...rows);
  state.kvNext = page.next;
  $("kv-more").hidden = !page.next;
}

async function runSql() {
  const result = await api(`/api/v1/objects/${encodeURIComponent(state.scope)}/sql`, {
    method: "POST",
    body: { query: $("sql").value },
  });
  const table = element("table");
  const head = element("tr");
  for (const column of result.columns) head.append(element("th", column));
  const thead = element("thead");
  thead.append(head);
  const tbody = element("tbody");
  for (const row of result.rows) {
    const tr = element("tr");
    for (const column of result.columns) {
      const cell = element("td");
      cell.append(element("pre", formatValue(row[column])));
      tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const note = element("p", `${result.rows.length} row(s)${result.truncated ? ", truncated" : ""}`, { class: "muted" });
  $("sql-result").replaceChildren(note, table);
}

async function loadBackups({ append = false } = {}) {
  const params = new URLSearchParams({ limit: "50" });
  if (state.className) params.set("class", state.className);
  if (append && state.backupsNext) params.set("after", state.backupsNext);
  const page = await api(`/api/v1/backups?${params}`);
  $("retention").textContent = page.retentionSeconds
    ? `celld deletes superseded epochs older than ${page.retentionSeconds}s (CELLD_LTX_RETENTION_SECS). Point-in-time restore is not available in this version; use Export JSON for a logical backup.`
    : "CELLD_LTX_RETENTION_SECS is unset, so celld keeps every superseded epoch. Point-in-time restore is not available in this version; use Export JSON for a logical backup.";
  const rows = page.objects.map((object) => {
    const row = element("tr", undefined, { "data-scope": object.scope });
    const scope = element("td");
    scope.append(element("code", object.scope));
    row.append(
      scope,
      element("td", String(object.restoreBaseEpoch ?? "?")),
      element("td", String(object.supersededEpochs.length)),
      element("td", formatBytes(object.supersededBytes) ?? "?"),
    );
    return row;
  });
  if (append) $("backup-rows").append(...rows);
  else $("backup-rows").replaceChildren(...rows);
  state.backupsNext = page.next;
  $("backups-more").hidden = !page.next;
}

async function evict() {
  const result = await api(`/api/v1/objects/${encodeURIComponent(state.scope)}/evict`, { method: "POST" });
  if (result.ok) {
    showError();
    await Promise.all([loadObjects(), refreshNode()]);
  } else {
    showError(new Error(`Eviction ${result.error?.kind ?? "failed"}: ${result.error?.reason ?? "unknown"}`));
  }
}

const guard = (action) => (event) => {
  event?.preventDefault();
  showError();
  action().catch(showError);
};

$("filter").addEventListener("submit", guard(() => {
  state.className = $("class").value.trim();
  return loadObjects();
}));
$("more").addEventListener("click", guard(() => loadObjects({ append: true })));
$("object-rows").addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-scope]");
  if (row) guard(() => openObject(row.dataset.scope))();
});
$("kv-form").addEventListener("submit", guard(() => listKv()));
$("kv-more").addEventListener("click", guard(() => listKv({ append: true })));
$("sql-form").addEventListener("submit", guard(runSql));
$("evict").addEventListener("click", guard(evict));
$("load-backups").addEventListener("click", guard(() => loadBackups()));
$("backups-more").addEventListener("click", guard(() => loadBackups({ append: true })));
$("backup-rows").addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-scope]");
  if (row) guard(() => openObject(row.dataset.scope))();
});

guard(() => Promise.all([refreshNode(), loadObjects()]))();
setInterval(() => refreshNode().catch(() => {}), 5_000);
