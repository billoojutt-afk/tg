/* ================= helpers ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s, root) => [...(root || document).querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const headers = {};
  const token = localStorage.getItem("tg_token");
  if (token) headers["Authorization"] = "Bearer " + token;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch("/api" + path, { method: opts.method || "GET", headers, body });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.detail) || "Request failed (" + res.status + ")");
    err.status = res.status;
    if (res.status === 401 && path !== "/login" && !opts.silent) showLoginOnce();
    throw err;
  }
  return data;
}

let _loginPrompted = false;
function showLoginOnce() {
  if (_loginPrompted) return;
  _loginPrompted = true;
  openLogin();
}

function toast(msg, type = "") {
  const box = $("#toastBox");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

let shopData = null;
let _valAbort = null;

function showLanding() {
  $("#landing").style.display = "flex";
  $("#appShell").hidden = true;
  loadLandingPacks();
}

function showAppShell() {
  $("#appShell").hidden = false;
  $("#landing").style.display = "none";
}

function openLogin() {
  $("#lockErr").hidden = true;
  $("#loginModal").classList.add("show");
}

function closeLogin() {
  $("#loginModal").classList.remove("show");
  _loginPrompted = false;
}

function openRegister() {
  $("#regErr").hidden = true;
  $("#registerModal").classList.add("show");
}

function closeRegister() {
  $("#registerModal").classList.remove("show");
}

function showLogin() { openLogin(); }

function hideLogin() { closeLogin(); }

async function unlock() {
  const username = $("#lockUser").value.trim();
  const pass = $("#lockPass").value;
  if (!pass) return;
  $("#btnUnlock").disabled = true;
  try {
    const d = await api("/login", { method: "POST", json: { username: username || undefined, password: pass } });
    localStorage.setItem("tg_token", d.token);
    _loginPrompted = false;
    $("#lockErr").hidden = true;
    hideLogin();
    toast("Logged in", "ok");
    await afterLogin();
  } catch (e) {
    $("#lockErr").hidden = false;
    toast(e.message, "err");
  } finally {
    $("#btnUnlock").disabled = false;
  }
}

function renderUserChip() {
  const chip = $("#userChip");
  if (!S.me) return;
  if (S.me.role === "owner") {
    chip.innerHTML = '<span class="chip-ico">🛡</span><span class="chip-name">Owner</span>' +
      (S.me.id ? `<span class="chip-id"> (ID ${esc(S.me.id)})</span>` : "");
  } else if (S.me.role === "admin") {
    const n = S.me.name || S.me.username || "—";
    const un = S.me.username ? "@" + S.me.username : "";
    const sub = [un, S.me.id ? "ID " + S.me.id : ""].filter(Boolean).join(" · ");
    chip.innerHTML = `<span class="chip-ico">🛡</span><span class="chip-name">${esc(n)} · Admin</span>` +
      (sub ? `<span class="chip-id"> (${esc(sub)})</span>` : "");
  } else {
    const n = S.me.name || S.me.username || "—";
    const un = S.me.username ? "@" + S.me.username : "";
    const sub = [un, S.me.id ? "ID " + S.me.id : ""].filter(Boolean).join(" · ");
    chip.innerHTML = `<span class="chip-ico">👤</span><span class="chip-name">${esc(n)}</span>` +
      (sub ? `<span class="chip-id"> (${esc(sub)})</span>` : "");
  }
}

async function afterLogin() {
  const me = await api("/me");
  S.role = me.role;
  S.me = me;
  S.customerMode = me.role === "customer";
  buildNav();
  renderUserChip();
  showAppShell();
  $("#adminCard").hidden = me.role !== "owner";
  $("#buyCard").hidden = !S.customerMode;
if (S.customerMode) {
    $("#myHistoryCard").hidden = false;
    renderBalance();
    loadValAccountSelect();
    renderMyHistory();
    loadShop();
    setPage("validate");
  } else {
    adminRefresh();
    loadShop();
    setPage("dashboard");
  }
  startRefreshLoop();
}

function buildNav() {
  const role = S.role;
  $$(".nav-link").forEach((a) => {
    const page = a.dataset.page;
    const allowed = role === "owner" || role === "admin"
      ? ["dashboard", "accounts", "scrape", "send", "validate", "settings"].includes(page)
      : ["validate", "settings"].includes(page);
    a.style.display = allowed ? "" : "none";
  });
}

function defaultPage() {
  return "dashboard";
}

async function loadValAccountSelect() {
  let accs = [];
  try {
    if (S.customerMode) {
      accs = (await api("/accounts/public")).accounts || [];
    } else {
      accs = (await api("/accounts")).accounts || [];
    }
  } catch { /* keep empty */ }
  const active = accs.filter((a) => a.status === "active");
  $("#valAccount").innerHTML = active.length
    ? `<option value="0">All accounts (` + active.length + `)</option>` + active.map((a) => `<option value="${a.id}">${esc(a.phone)}${a.username ? " @" + a.username : ""}${a.spam_limited ? " (⚑ blocked)" : ""}</option>`).join("")
    : `<option value="">— no active account —</option>`;
}

function startRefreshLoop() {
  if (S._refreshTimer) return;
  refresh();
  S._refreshTimer = setInterval(refresh, 5000);
}

function fmtTime(t) {
  if (!t) return "—";
  const d = new Date(t.replace(" ", "T") + "Z");
  if (isNaN(d)) return t;
  return d.toLocaleString();
}

const STATUS_META = {
  created: { label: "Created", cls: "gray" },
  running: { label: "RUNNING", cls: "blue" },
  paused: { label: "Paused", cls: "yellow" },
  stopped: { label: "Stopped", cls: "yellow" },
  finished: { label: "Finished", cls: "green" },
  failed: { label: "Failed", cls: "red" },
  new: { label: "New", cls: "gray" },
  waiting_code: { label: "Awaiting code", cls: "yellow" },
  active: { label: "Active", cls: "green" },
  logged_out: { label: "Logged out", cls: "red" },
  pending: { label: "Pending", cls: "gray" },
  running_scrape: { label: "Scraping", cls: "blue" },
  done: { label: "Done", cls: "green" },
  sent: { label: "Sent", cls: "green" },
  sending: { label: "Sending", cls: "blue" },
  flood_wait: { label: "Flood wait", cls: "yellow" },
};
function badge(status) {
  const m = STATUS_META[status] || { label: status, cls: "gray" };
  return `<span class="badge ${m.cls}">${esc(m.label)}</span>`;
}
function dot(status) {
  const map = { done: "green", active: "green", sent: "green", finished: "green", running: "blue", pending: "gray", failed: "red", stopped: "yellow", waiting_code: "yellow", flood_wait: "yellow" };
  return `<span class="dot ${map[status] || "gray"}"></span>`;
}

/* ================= state ================= */
const S = {
  page: "dashboard",
  accounts: [],
  jobs: [],
  campaigns: [],
  members: { list: [], total: 0, job_total: 0, offset: 0, hasMore: false },
  filters: { has_username: false, has_phone: false, exclude_bots: true, search: "" },
  campFilters: { has_username: false, has_phone: false, exclude_bots: true, search: "" },
  selJobId: null,
  detailCid: null,
  selectedAccounts: new Set(),
  busy: false,
  role: "owner",
  me: null,
  customerMode: false,
  pendingAccountId: null,
  _refreshTimer: null,
};

/* ================= navigation ================= */
function setPage(name) {
  S.page = name;
  $$(".page").forEach((p) => p.classList.remove("active"));
  $("#page-" + name).classList.add("active");
  $$(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.page === name));
  $("#mainNav").classList.remove("open");
  if (name === "validate") loadValAccountSelect();
  window.scrollTo(0, 0);
  refresh();
}

function bindNav() {
  $$(".nav-link").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    setPage(a.dataset.page);
  }));
  $("#hamburger").addEventListener("click", () => $("#mainNav").classList.toggle("open"));
}

/* ================= dashboard ================= */
async function renderDashboard() {
  const [camps, jobs, accounts] = await Promise.all([
    api("/campaigns").then((d) => d.campaigns).catch(() => []),
    api("/scrape/jobs").then((d) => d.jobs).catch(() => []),
    api("/accounts").then((d) => d.accounts).catch(() => []),
  ]);
  const sent = camps.reduce((a, c) => a + (c.sent || 0), 0);
  const failed = camps.reduce((a, c) => a + (c.failed || 0), 0);
  const members = jobs.reduce((a, j) => a + (j.member_count || 0), 0);
  const activeAccs = accounts.filter((a) => a.status === "active").length;

  $("#statsGrid").innerHTML = [
    ["👤", activeAccs, "Active accounts"],
    ["👥", members, "Members scraped"],
    ["📨", sent, "Messages sent"],
    ["📤", failed, "Failed / blocked"],
  ].map(([ic, n, l]) => `<div class="stat-card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");

  $("#dashCampaigns").innerHTML = camps.length
    ? camps.slice(0, 5).map(campRow).join("")
    : `<div class="empty">No campaigns yet — go to <b>Send</b>.</div>`;
  $("#dashJobs").innerHTML = jobs.length
    ? jobs.slice(0, 5).map(jobRow).join("")
    : `<div class="empty">No scrape jobs yet — go to <b>Scrape</b>.</div>`;
}

/* ================= accounts ================= */
async function loadAccounts() {
  try {
    const [acc, keys] = await Promise.all([
      api("/accounts").catch(() => ({ accounts: [] })),
      api("/accounts/api-keys").catch(() => ({ api_keys: [] })),
    ]);
    S.accounts = acc.accounts || [];
    S.apiKeyOpts = keys.api_keys || [];
  } catch { return; }
  renderAccountList();
  renderScrapeAccountSelect();
  renderCampaignAccountChips();
}

function apiKeyOptions(acc) {
  const set = (S.apiKeyOpts && S.apiKeyOpts.length) ? S.apiKeyOpts : [];
  return `<option value="0">Default (config)</option>` +
    set.map((k) => `<option value="${k.id}" ${acc.api_key_id === k.id ? "selected" : ""}>${esc(k.label || "App " + k.api_id)} (${k.api_id})</option>`).join("");
}

function renderAccountList() {
  $("#accCount").textContent = S.accounts.filter((a) => a.status === "active").length;
  const list = $("#accountsList");
  if (!S.accounts.length) { list.innerHTML = `<div class="empty">No accounts yet.</div>`; return; }
  list.innerHTML = S.accounts.map((a) => `
    <div class="row-item">
      <div class="main">
        <div class="title">${esc(a.name || "—")} ${badge(a.status)} ${a.spam_limited ? '<span class="badge red">⚠ SPAM</span>' : ""} ${a.api_limited ? '<span class="badge red">KEY LIMITED</span>' : ""}</div>
        <div class="sub">${esc(a.phone || "")}${a.username ? " · @" + esc(a.username) : ""}${a.spam_since ? ` <span class="muted">· flagged ${esc(a.spam_since)}</span>` : ""}</div>
      </div>
      <div class="api-row">
        <span class="label">API</span>
        <select class="input sel sm" data-accapi="${a.id}">${apiKeyOptions(a)}</select>
      </div>
      <div class="row-actions">
        ${a.spam_limited ? `<button class="btn ghost sm" data-unflag="${a.id}">Clear spam flag</button>` : ""}
        ${a.status === "active" ? `<button class="btn ghost sm" data-del="${a.id}">Log out</button>` : ""}
      </div>
    </div>`).join("");
  $$("#accountsList [data-del]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/accounts/" + b.dataset.del, { method: "DELETE" }); toast("Account logged out", "ok"); await loadAccounts(); }
    catch (e) { toast(e.message, "err"); }
  }));
  $$("#accountsList [data-unflag]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/accounts/" + b.dataset.unflag + "/unflag", { method: "POST" }); toast("Spam flag cleared", "ok"); await loadAccounts(); }
    catch (e) { toast(e.message, "err"); }
  }));
  $$("#accountsList [data-accapi]").forEach((s) => s.addEventListener("change", async () => {
    const kid = Number(s.value) || null;
    try {
      await api("/accounts/" + s.dataset.accapi + "/api-key", {
        method: "PATCH", body: { api_key_id: kid },
      });
      toast("API key updated — re-login the account to apply", "ok");
    } catch (e) { toast(e.message, "err"); await loadAccounts(); }
  }));
}

function renderScrapeAccountSelect() {
  const active = S.accounts.filter((a) => a.status === "active");
  $("#scrapeAccount").innerHTML = active.length
    ? active.map((a) => `<option value="${a.id}">${esc(a.phone)}${a.username ? " @" + a.username : ""}</option>`).join("")
    : `<option value="">— add an active account first —</option>`;
  $("#valAccount").innerHTML = active.length
    ? `<option value="0">All accounts (` + active.length + `)</option>` + active.map((a) => `<option value="${a.id}">${esc(a.phone)}${a.username ? " @" + a.username : ""}</option>`).join("")
    : `<option value="">— add an active account first —</option>`;
}

function renderCampaignAccountChips() {
  const active = S.accounts.filter((a) => a.status === "active");
  const box = $("#cpAccounts");
  if (!S.selectedAccounts.size) active.forEach((a) => S.selectedAccounts.add(a.id));
  box.innerHTML = active.length
    ? active.map((a) => `
        <label class="chip ${S.selectedAccounts.has(a.id) ? "on" : ""}" data-acc="${a.id}">
          <input type="checkbox" ${S.selectedAccounts.has(a.id) ? "checked" : ""} onchange="toggleAccountChip(event)" hidden>
          ${esc(a.username ? "@" + a.username : a.phone)}
        </label>`).join("")
    : `<span class="muted sm">No active accounts. Add one in Accounts tab.</span>`;
}

function toggleAccountChip(e) {
  const id = Number(e.target.closest("[data-acc]").dataset.acc);
  e.target.closest(".chip").classList.toggle("on", e.target.checked);
  if (e.target.checked) S.selectedAccounts.add(id); else S.selectedAccounts.delete(id);
}

async function sendCode() {
  const phone = $("#accPhone").value.trim();
  if (!phone) return toast("Enter your phone number", "err");
  S.busy = true; $("#btnSendCode").disabled = true;
  try {
    const d = await api("/accounts/send-code", { method: "POST", json: { phone } });
    S.pendingAccountId = d.account_id;
    $("#codeBox").hidden = false;
    $("#needPassHint").hidden = true;
    $("#codePhoneHint").textContent = `Code sent to ${phone} — paste it below.`;
    $("#codePhoneHint").hidden = false;
    $("#btnSendCode").textContent = "Code sent! Re-send";
    toast("Code sent! Check your Telegram", "ok");
  } catch (e) { toast(e.message, "err"); }
  finally { S.busy = false; $("#btnSendCode").disabled = false; }
}

async function verify() {
  const list = (await api("/accounts")).accounts;
  S.busy = true;
  try {
    const code = $("#accCode").value.trim();
    const password = $("#accPass").value;
    if (!code) return toast("Enter the code", "err");
    let a = list.find((x) => x.id === S.pendingAccountId && x.status === "waiting_code");
    if (!a) a = list.find((x) => x.status === "waiting_code");
    if (!a) return toast("No account waiting for a code. Send a code first.", "err");
    const res = await api("/accounts/verify", { method: "POST", json: { account_id: a.id, code, password: password || undefined } });
    if (res.need_password) { $("#needPassHint").hidden = false; return; }
    toast("Account logged in!", "ok");
    $("#codeBox").hidden = true; $("#accPhone").value = ""; $("#accCode").value = ""; $("#accPass").value = ""; $("#btnSendCode").textContent = "Send code"; $("#codePhoneHint").hidden = true;
    S.pendingAccountId = null;
    await loadAccounts();
  } catch (e) { toast(e.message, "err"); }
  finally { S.busy = false; }
}

/* ================= validate numbers ================= */
async function validateNumbers() {
  const accountId = $("#valAccount").value;
  const nums = $("#valNumbers").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!accountId) return toast("Add & verify an account first", "err");
  if (!nums.length) return toast("Enter at least one number", "err");
  S.busy = true; $("#btnValidate").disabled = true;
  $("#btnValidate").innerHTML = '<span class="spin"></span> Checking...';
  $("#btnStopVal").style.display = "";
  window._valResults = [];
  _valAbort = new AbortController();
  $("#valResultsCard").hidden = false;
  $("#valCount").textContent = `0/${nums.length} registered`;
  $("#valSummary").innerHTML = [
    ["Found", 0], ["Not found", 0], ["Online now", 0],
  ].map(([l, n]) => `<div class="tile"><b>${n}</b>${l}</div>`).join("");
  $("#valBody").innerHTML = "";
  const token = localStorage.getItem("tg_token");
  try {
    const res = await fetch("/api/validate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify({ account_id: Number(accountId), numbers: nums }),
      signal: _valAbort.signal,
    });
    if (!res.ok) {
      let msg = "Request failed (" + res.status + ")";
      try { const d = await res.json(); if (d && d.detail) msg = d.detail; } catch { /* ignore */ }
      if (res.status === 401) showLoginOnce();
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = ""; let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buf += dec.decode(chunk.value || new Uint8Array(0), { stream: !done });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "result") {
          window._valResults.push(msg.result);
          renderSingleValResult(msg.result, nums.length);
        } else if (msg.type === "done") {
          if (msg.results && msg.results.length !== window._valResults.length) {
            window._valResults = msg.results;
            renderValResults(msg.results);
          }
          if (msg.balance_after !== null && msg.balance_after !== undefined) {
            if (S.me) { S.me.credits = msg.balance_after; renderBalance(); }
            try { renderMyHistory(); } catch { /* noop */ }
          }
          toast(`Checked ${window._valResults.length} numbers`, "ok");
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      toast(`Stopped — ${window._valResults.length}/${nums.length} checked`, "err");
      renderValResults(window._valResults);
    } else if (!e.status) {
      toast(e.message, "err");
    }
  } finally {
    _valAbort = null;
    S.busy = false;
    $("#btnValidate").disabled = false;
    $("#btnValidate").textContent = "Check";
    $("#btnStopVal").style.display = "none";
  }
}

function stopValidate() {
  if (_valAbort) _valAbort.abort();
}

function renderSingleValResult(r, total) {
  const ok = window._valResults.filter((x) => x.registered);
  const online = ok.filter((x) => x.online);
  $("#valCount").textContent = `${ok.length}/${total} registered`;
  $("#valSummary").innerHTML = [
    ["Found", ok.length],
    ["Not found", window._valResults.length - ok.length],
    ["Online now", online.length],
  ].map(([l, n]) => `<div class="tile"><b>${n}</b>${l}</div>`).join("");
  $("#valBody").insertAdjacentHTML("beforeend", valRowHtml(r));
}

function valRowHtml(r) {
  if (!r.registered) {
    const err = r.error ? `<span class="muted">${esc(r.error)}</span>` : "not on Telegram";
    return `<tr>
      <td>${esc(r.number)}</td>
      <td><span class="badge red">No</span></td>
      <td colspan="3">${err}</td>
    </tr>`;
  }
  const name = esc([r.first_name, r.last_name].filter(Boolean).join(" ") || "—");
  const uname = r.username ? "@" + esc(r.username) : "—";
  const seen = r.online
    ? `<span class="badge green">● online</span>`
    : esc(r.last_seen || "Unknown");
  return `<tr>
    <td>${esc(r.number)}</td>
    <td><span class="badge green">Yes</span></td>
    <td>${name} <span class="muted sm">${esc(r.user_id || "")}</span></td>
    <td>${uname}</td>
    <td>${seen}</td>
  </tr>`;
}

function renderValResults(results) {
  const ok = results.filter((r) => r.registered);
  $("#valResultsCard").hidden = false;
  $("#valCount").textContent = `${ok.length}/${results.length} registered`;
  $("#valSummary").innerHTML = [
    ["Found", ok.length],
    ["Not found", results.length - ok.length],
    ["Online now", ok.filter((r) => r.online).length],
  ].map(([l, n]) => `<div class="tile"><b>${n}</b>${l}</div>`).join("");
  window._valResults = results;
  $("#valBody").innerHTML = results.map(valRowHtml).join("");
}

function exportValResults() {
  const res = window._valResults || [];
  if (!res.length) return toast("Nothing to export", "err");
  let csv = "number,registered,user_id,username,first_name,last_name,online,last_seen\n";
  for (const r of res) {
    csv += [
      r.number || "", r.registered ? "yes" : "no", r.user_id || "", r.username || "",
      r.first_name || "", r.last_name || "", r.online ? "yes" : "no", r.last_seen || "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",") + "\n";
  }
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "validate_results.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ================= scrape jobs ================= */
function renderSrcJobSelect() {
  const jobs = S.jobs;
  const sel = $("#cpJob");
  const done = jobs.filter((j) => j.status === "done" && j.member_count > 0);
  sel.innerHTML =
    `<option value="">— pick a scraped group —</option>` +
    done.map((j) => `<option value="${j.id}">${esc(j.group_title || j.group_input)} (${j.member_count})</option>`).join("");
  if (S.selJobId && done.some((j) => j.id === S.selJobId)) sel.value = S.selJobId;
}

async function loadJobs() {
  try { S.jobs = (await api("/scrape/jobs")).jobs; } catch { return; }
  renderScrapeJobs();
  renderSrcJobSelect();
}

function renderScrapeJobs() {
  const list = $("#scrapeJobs");
  if (!S.jobs.length) { list.innerHTML = `<div class="empty">No scrape jobs yet.</div>`; return; }
  list.innerHTML = S.jobs.map((j) => {
    const running = j.status === "running";
    const pct = j.total ? Math.min(100, Math.round((j.member_count / (j.total || 1)) * 100)) : 0;
    return `
    <div class="row-item">
      <div class="main">
        <div class="title">${esc(j.group_title || j.group_input)} ${dot(j.status)} ${badge(j.status)}</div>
        <div class="sub">${esc(j.group_input)} · ${j.member_count} members${j.total ? " / " + j.total : ""}${j.error ? " · " + esc(j.error) : ""}</div>
        ${running ? `<div class="progress-outer mt"><div class="progress-inner" style="width:${pct}%"></div></div>` : ""}
        <div class="sub">${fmtTime(j.created_at)}</div>
      </div>
      <div class="row-actions">
        ${j.status === "done" ? `<button class="btn primary sm" data-view="${j.id}">View</button>` : ""}
        <button class="btn ghost sm danger" data-del="${j.id}">Delete</button>
      </div>
    </div>`;
  }).join("");

  $$("#scrapeJobs [data-view]").forEach((b) => b.addEventListener("click", () => openMembers(b.dataset.view)));
  $$("#scrapeJobs [data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this job and its scraped members?")) return;
    try { await api("/scrape/jobs/" + b.dataset.del, { method: "DELETE" }); toast("Job deleted", "ok"); await loadJobs(); }
    catch (e) { toast(e.message, "err"); }
  }));
}

function jobRow(j) {
  return `
    <div class="row-item">
      <div class="main">
        <div class="title">${esc(j.name || j.group_input || "Campaign")} ${badge(j.status)}</div>
        <div class="sub">${esc(j.group_title || j.group_input || "")} · ${j.sent}/${j.total} sent</div>
      </div>
      <div class="row-actions"><span class="muted sm">${fmtTime(j.created_at)}</span></div>
    </div>`;
}

async function startScrape() {
  const account = $("#scrapeAccount").value;
  const group = $("#scrapeGroup").value.trim();
  if (!account) return toast("Add & verify an account first", "err");
  if (!group) return toast("Enter a group link or @username", "err");
  S.busy = true; $("#btnStartScrape").disabled = true;
  try {
    await api("/scrape/jobs", { method: "POST", json: { account_id: Number(account), group } });
    toast("Scraping started", "ok");
    $("#scrapeGroup").value = "";
    await loadJobs();
  } catch (e) { toast(e.message, "err"); }
  finally { S.busy = false; $("#btnStartScrape").disabled = false; }
}

/* ================= members ================= */
async function openMembers(jobId) {
  S.selJobId = Number(jobId);
  S.filters.has_username = $("#fUsername").checked;
  S.filters.has_phone = $("#fPhone").checked;
  S.filters.exclude_bots = $("#fNoBot").checked;
  S.filters.search = $("#fSearch").value;
  S.members.offset = 0; S.members.list = []; S.members.hasMore = true;
  const job = S.jobs.find((j) => j.id === Number(jobId));
  $("#membersCard").hidden = false;
  $("#membersJobTitle").textContent = (job && (job.group_title || job.group_input)) || jobId;
  $("#membersCard").scrollIntoView({ behavior: "smooth" });
  await loadMembers();
}

async function loadMembers() {
  const f = S.filters;
  const q = new URLSearchParams({
    job_id: S.selJobId, has_username: f.has_username, has_phone: f.has_phone,
    exclude_bots: f.exclude_bots, search: f.search,
    limit: 100, offset: S.members.offset,
  });
  try {
    const d = await api("/members?" + q.toString());
    S.members.list = S.members.list.concat(d.members);
    S.members.total = d.total;
    S.members.hasMore = d.members.length === 100 && d.total > S.members.list.length;
    renderMembers();
  } catch (e) { toast(e.message, "err"); }
}

function renderMembers() {
  $("#membersCount").textContent = `${S.members.total} matches`;
  const body = $("#membersBody");
  if (!S.members.list.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">No members match the filters.</td></tr>`;
  } else {
    body.innerHTML = S.members.list.map((m) => `
      <tr>
        <td>${esc(m.first_name || "")} ${esc(m.last_name || "")}</td>
        <td>${m.username ? "@" + esc(m.username) : "—"}</td>
        <td>${esc(m.phone || "—")}</td>
        <td>${esc(m.user_id || "—")}</td>
        <td>${m.is_bot ? `<span class="badge yellow">bot</span>` : ""} ${m.is_verified ? `<span class="badge blue">✓</span>` : ""} ${m.is_premium ? `<span class="badge gray">★</span>` : ""}</td>
      </tr>`).join("");
  }
  $("#btnLoadMore").style.display = S.members.hasMore ? "" : "none";
}

function bindMemberFilters() {
  const refresh = () => { S.members.offset = 0; S.members.list = []; loadMembers(); };
  ["fUsername", "fPhone", "fNoBot"].forEach((id) => $("#" + id).addEventListener("change", () => {
    S.filters[id === "fUsername" ? "has_username" : id === "fPhone" ? "has_phone" : "exclude_bots"]
      = $("#" + id).checked;
    refresh();
  }));
  let deb;
  $("#fSearch").addEventListener("input", (e) => {
    clearTimeout(deb); deb = setTimeout(() => { S.filters.search = e.target.value; S.members.offset = 0; S.members.list = []; loadMembers(); }, 350);
  });
  $("#fUsername").checked = S.filters.has_username;
  $("#fPhone").checked = S.filters.has_phone;
  $("#fNoBot").checked = S.filters.exclude_bots;
  $("#fSearch").value = S.filters.search;

  $("#btnLoadMore").addEventListener("click", () => { S.members.offset += 100; loadMembers(); });
  $("#btnExport").addEventListener("click", () => {
    const f = S.filters;
    const q = new URLSearchParams({ job_id: S.selJobId, has_username: f.has_username, has_phone: f.has_phone, exclude_bots: f.exclude_bots, search: f.search });
    window.open("/api/members/export.csv?" + q.toString(), "_blank");
  });
  $("#btnUseCampaign").addEventListener("click", () => {
    S.campFilters = { ...S.filters };
    $("#cpJob").value = String(S.selJobId);
    $("#cpFUsername").checked = S.campFilters.has_username;
    $("#cpFPhone").checked = S.campFilters.has_phone;
    $("#cpFNoBot").checked = S.campFilters.exclude_bots;
    $("#cpFSearch").value = S.campFilters.search;
    setPage("send");
  });
}

/* ================= campaigns ================= */
function campRow(c) {
  const total = c.total || 0;
  const done = (c.sent || 0) + (c.failed || 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const running = c.status === "running";
  return `
    <div class="row-item">
      <div class="main" style="flex:1;min-width:200px">
        <div class="title">${esc(c.name)} ${badge(c.status)}</div>
        <div class="sub">${c.sent} sent · ${c.failed} failed · ${Math.max(0, total - done)} pending · delay ${c.min_delay}-${c.max_delay}s</div>
        <div class="progress-outer"><div class="progress-inner" style="width:${pct}%"></div></div>
      </div>
      <div class="row-actions">
        <button class="btn ghost sm" data-logs="${c.id}">Logs</button>
        ${c.status !== "running" && c.status !== "finished" && c.sent + c.failed < total ? `<button class="btn primary sm" data-start="${c.id}">Start</button>` : ""}
        ${running ? `<button class="btn danger sm" data-stop="${c.id}">Stop</button>` : ""}
        <button class="btn ghost sm" data-del="${c.id}" title="Delete campaign + logs">Del</button>
      </div>
    </div>`;
}

function bindCampaignDelete() {
  $$("#campaignsList [data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this campaign and all its logs? This cannot be undone.")) return;
    try {
      await api("/campaigns/" + b.dataset.del, { method: "DELETE" });
      toast("Campaign deleted", "ok");
      if (S.detailCid === Number(b.dataset.del)) { S.detailCid = null; $("#campaignDetailCard").hidden = true; }
      await renderCampaigns();
    } catch (e) { toast(e.message, "err"); }
  }));
}

async function renderCampaigns() {
  try { S.campaigns = (await api("/campaigns")).campaigns; } catch { return; }
  $("#cpCount").textContent = S.campaigns.length;
  const list = $("#campaignsList");
  if (!S.campaigns.length) { list.innerHTML = `<div class="empty">No campaigns yet.</div>`; return; }
  list.innerHTML = S.campaigns.map(campRow).join("");
  bindCampaignControls();
  if (S.detailCid) renderCampaignDetail(S.campaigns.find((c) => c.id === S.detailCid));
}

function bindCampaignControls() {
  $$("#campaignsList [data-start]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await api("/campaigns/" + b.dataset.start + "/start", { method: "POST" });
      toast("Campaign started", "ok"); await renderCampaigns();
      refreshBalance();
      S.detailCid = Number(b.dataset.start); openDetail();
    } catch (e) { toast(e.message, "err"); }
  }));
  $$("#campaignsList [data-stop]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/campaigns/" + b.dataset.stop + "/stop", { method: "POST" }); toast("Campaign stopped", "warn"); await renderCampaigns(); }
    catch (e) { toast(e.message, "err"); }
  }));
  $$("#campaignsList [data-logs]").forEach((b) => b.addEventListener("click", async () => {
    S.detailCid = Number(b.dataset.logs); openDetail();
  }));
  bindCampaignDelete();
}

async function openDetail() {
  $("#campaignDetailCard").hidden = false;
  $("#campaignDetailCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  await renderCampaignDetail();
}

async function setCampaignDelay() {
  if (!S.detailCid) return toast("Open a campaign first", "err");
  const min = Number($("#cpMinDelay").value);
  const max = Number($("#cpMaxDelay").value);
  if (!(min > 0) || !(max >= min)) return toast("Invalid delay (min 1s, min <= max)", "err");
  try {
    await api("/campaigns/" + S.detailCid + "/delay", { method: "PATCH", json: { min_delay: min, max_delay: max } });
    toast("Delay updated — applies immediately", "ok");
    const row = (S.campaigns || []).find((x) => x.id === S.detailCid);
    if (row) { row.min_delay = min; row.max_delay = max; }
    await renderCampaigns();
  } catch (e) { toast(e.message, "err"); }
}

async function renderCampaignDetail(c) {
  try {
    if (!c) c = (await api("/campaigns/" + S.detailCid)).campaign;
  } catch { return; }
  $("#cpDetailTitle").textContent = c.name;
  $("#cpMinDelay").value = c.min_delay ?? 30;
  $("#cpMaxDelay").value = c.max_delay ?? 90;
  const tc = c.target_counts || {};
  $("#cpDetailStats").innerHTML = [
    ["Total", c.total || 0],
    ["Sent", (tc.sent || 0) + (c.sent || 0)],
    ["Failed", (tc.failed || 0) || c.failed || 0],
    ["Pending", tc.pending || 0],
  ].map(([l, n]) => `<div class="tile"><b>${n}</b>${l}</div>`).join("");
  const done = (tc.sent || 0) + (tc.failed || 0);
  const pct = c.total ? Math.min(100, Math.round((done / c.total) * 100)) : 0;
  $("#cpDetailBar").style.width = pct + "%";
  try {
    const logs = (await api("/campaigns/" + S.detailCid + "/logs")).logs;
    const body = $("#cpLogsBody");
    body.innerHTML = logs.length
      ? logs.map((l) => `<tr>
          <td>${fmtTime(l.sent_at)}</td>
          <td>${esc(l.account_id || "")}</td>
          <td>${esc(l.target || "")}</td>
          <td>${badge(l.status)}</td>
          <td>${esc(l.error || "")}</td>
        </tr>`).join("")
      : `<tr><td colspan="5" class="empty">No activity yet.</td></tr>`;
  } catch { /* ignore */ }
}

async function createCampaign() {
  const fd = new FormData();
  const accountIds = S.selectedAccounts.size ? [...S.selectedAccounts] : [];
  if (!accountIds.length) return toast("Select at least one account", "err");
  const name = $("#cpName").value.trim() || "Campaign";
  const jobId = Number($("#cpJob").value || 0);
  const custom = $("#cpCustom").value.trim();
  if (!jobId && !custom) return toast("Pick a scrape job OR paste custom targets", "err");
  const minD = Number($("#cpMinDelay").value) || 30;
  const maxD = Number($("#cpMaxDelay").value) || 90;
  if (maxD < minD) return toast("Max delay must be >= min delay", "err");

  fd.append("name", name);
  fd.append("account_ids", accountIds.join(","));
  if (jobId) fd.append("job_id", jobId);
  fd.append("custom_targets", custom);
  fd.append("has_username", S.campFilters.has_username);
  fd.append("has_phone", S.campFilters.has_phone);
  fd.append("exclude_bots", S.campFilters.exclude_bots);
  fd.append("search", S.campFilters.search);
  fd.append("message", $("#cpMessage").value);
  fd.append("min_delay", minD);
  fd.append("max_delay", maxD);
  fd.append("max_per_account", Number($("#cpMaxPerAcc").value) || 0);
  const file = $("#cpMedia").files[0];
  if (file) fd.append("media", file);

  S.busy = true; $("#btnCreateCampaign").disabled = true;
  try {
    const d = await api("/campaigns", { method: "POST", body: fd });
    toast(`Campaign created with ${d.campaign.total} targets`, "ok");
    S.detailCid = d.campaign.id;
    $("#cpMessage").value = ""; $("#cpCustom").value = ""; $("#cpMedia").value = "";
    const sel = $("#cpJob"); sel.selectedIndex = 0;
    await renderCampaigns();
    openDetail();
  } catch (e) { toast(e.message, "err"); }
  finally { S.busy = false; $("#btnCreateCampaign").disabled = false; }
}

/* ================= polling / refresh ================= */
let lastJobs = "", lastCamps = "", lastAccs = "";
async function refresh() {
  if (S.customerMode) return;
  try {
    const jobs = (await api("/scrape/jobs", { silent: true })).jobs.map((j) => j.id + ":" + j.status + ":" + j.member_count).join(",");
    const camps = (await api("/campaigns", { silent: true })).campaigns.map((c) => c.id + ":" + c.status + ":" + (c.sent || 0) + ":" + (c.failed || 0)).join(",");
    const accs = (await api("/accounts", { silent: true })).accounts.map((a) => a.id + ":" + a.status).join(",");
    const jobsChanged = jobs !== lastJobs;
    const campsChanged = camps !== lastCamps;
    const accsChanged = accs !== lastAccs;
    lastJobs = jobs; lastCamps = camps; lastAccs = accs;

    if (jobsChanged) { S.jobs = (await api("/scrape/jobs", { silent: true })).jobs; renderScrapeJobs(); renderSrcJobSelect(); }
    if (accsChanged) { await loadAccounts(); }
    if (S.page === "dashboard") { await renderDashboard(); }
    if (S.page === "send" && (campsChanged || camps)) { await renderCampaigns(); }
    if (S.detailCid) await renderCampaignDetail();
    if (S.selJobId && $("#membersCard") && !$("#membersCard").hidden && jobsChanged) {
      // members refresh kept manual via filters
    }
  } catch (e) {
    if (e && e.status === 401) { clearInterval(S._refreshTimer); S._refreshTimer = null; }
  }
}

/* ================= customer buy credits ================= */
function renderBalance() {
  const n = Math.floor(S.me && S.me.credits || 0);
  $("#balChip").textContent = n.toLocaleString() + " credits";
}

function renderPricing() {
  const body = $("#pricingBody");
  const pr = (shopData && shopData.pricing) || [];
  const unitMap = { "numbers checked": "number", "messages sent": "message", "members scraped": "member" };
  const unitPlural = { "numbers checked": "numbers", "messages sent": "messages", "members scraped": "members" };
  body.innerHTML = pr.length
    ? pr.map((p) => {
        const rate = (p.credits_per_unit || 0);
        const rateTxt = (rate % 1 ? rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : rate) +
          " credit" + (rate === 1 ? "" : "s") + " / " + (unitMap[p.unit] || p.unit);
        return `<tr>
          <td>${esc(p.label)}</td>
          <td class="sm">${rateTxt}</td>
          <td class="sm">$${p.usd} / ${p.per.toLocaleString()} ${unitPlural[p.unit] || p.unit}</td>
          <td class="sm">${Math.round(p.credits_for_per).toLocaleString()} credits</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" class="muted">Pricing not loaded.</td></tr>`;
}

async function loadShop() {
  try {
    shopData = await api("/shop");
  } catch (e) { toast(e.message, "err"); return; }
  renderPricing();
  const sel = $("#packSel");
  sel.innerHTML = (shopData.packs || []).map((p) =>
    `<option value="${p.usd}" data-credits="${p.credits}">${p.credits.toLocaleString()} credits  =  $${p.usd} USDT</option>`).join("");
  const w = $("#shopWallet");
  w.textContent = shopData.wallet_configured ? shopData.wallet : "Wallet not configured yet — contact the owner.";
  w.classList.toggle("muted", !shopData.wallet_configured);
  $("#btnCopyWallet").disabled = !shopData.wallet_configured;
}

async function refreshBalance() {
  if (!S.customerMode) return;
  try {
    S.me = await api("/me");
    renderBalance();
  } catch { /* ignore */ }
}

async function copyWallet() {
  const txt = shopData && shopData.wallet;
  if (!txt) return toast("No wallet address set", "err");
  try { await navigator.clipboard.writeText(txt); toast("Wallet copied", "ok"); }
  catch { $("#shopWallet").select(); document.execCommand("copy"); toast("Wallet copied", "ok"); }
}

async function verifyPay() {
  const txid = $("#payTxid").value.trim();
  if (!txid) return toast("Paste your transaction hash (TXID)", "err");
  const amount = Number($("#packSel").value || 0);
  $("#btnVerifyPay").disabled = true;
  $("#btnVerifyPay").innerHTML = '<span class="spin"></span> Verifying...';
  try {
    const d = await api("/pay", { method: "POST", json: { txid } });
    S.me.credits = d.credits;
    renderBalance();
    $("#payTxid").value = "";
    toast(`Credited ${d.credits_added.toLocaleString()} credits!`, "ok");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    $("#btnVerifyPay").disabled = false;
    $("#btnVerifyPay").textContent = "Verify & add credits";
  }
}

/* ================= admin ================= */
async function adminCreateCustomer() {
  const name = $("#adName").value.trim();
  const username = $("#adUser").value.trim();
  const password = $("#adPass").value;
  if (!username) return toast("Username is required", "err");
  if (!password) return toast("Password is required", "err");
  try {
    await api("/admin/customers", { method: "POST", json: { name: name || undefined, username, password } });
    $("#adName").value = ""; $("#adUser").value = ""; $("#adPass").value = "";
    toast("Customer created", "ok");
    await adminRefresh();
  } catch (e) { toast(e.message, "err"); }
}

async function adminAddCredits() {
  const cid = Number($("#adCredCust").value);
  const amt = Number($("#adCredAmt").value);
  if (!cid) return toast("Select a customer", "err");
  if (!amt || amt < 1) return toast("Enter credits to add", "err");
  try {
    const d = await api("/admin/credits", { method: "POST", json: { customer_id: cid, credits: amt } });
    $("#adCredAmt").value = "";
    toast(`Added ${amt.toLocaleString()} credits`, "ok");
    await adminRefresh();
  } catch (e) { toast(e.message, "err"); }
}

async function renderMyHistory() {
  let checks = [], txs = [];
  try {
    [checks, txs] = await Promise.all([
      api("/checks/mine").then((d) => d.checks || []).catch(() => []),
      api("/transactions/mine").then((d) => d.transactions || []).catch(() => []),
    ]);
  } catch { /* ignore */ }
  $("#myHistCount").textContent = (checks.length ? checks.length + " runs · " : "") +
    (txs.length ? txs.length + " txns" : "");
  const cBody = $("#myChecksBody");
  cBody.innerHTML = checks.length
    ? checks.map((c) => {
        const found = (c.results || []).filter((r) => r.registered).length;
        return `<tr>
          <td class="sm">${esc(c.created_at || "")}</td>
          <td class="sm">${esc((c.numbers || []).slice(0, 3).join(", "))}${(c.numbers || []).length > 3 ? ` <span class="muted">+${(c.numbers||[]).length - 3} more</span>` : ""}</td>
          <td><span class="badge ${found ? "green" : "gray"}">${found}/${(c.numbers || []).length}</span></td>
          <td class="sm">${Math.floor(c.cost || 0)} credits</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" class="muted">No checks yet.</td></tr>`;
  const tBody = $("#myTxBody");
  tBody.innerHTML = txs.length
    ? txs.map((t) => {
        const delta = t.type === "buy" || t.type === "admin"
          ? `+${Math.floor(t.credits || 0)}` : Math.floor(t.credits || 0);
        return `<tr>
          <td class="sm">${esc(t.created_at || "")}</td>
          <td class="sm">${esc(t.type || "")}</td>
          <td class="sm">${delta}</td>
          <td class="sm">$${t.usd || 0}</td>
          <td class="sm mono">${esc((t.txid || "").slice(0, 16))}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="muted">No transactions yet.</td></tr>`;
}

async function adminLoadData() {
  let checks = [], txs = [], keys = [], pricing = null, supportBot = "";
  try {
    [checks, txs, keys, pricing, supportBot] = await Promise.all([
      api("/admin/checks").then((d) => d.checks || []).catch(() => []),
      api("/admin/transactions").then((d) => d.transactions || []).catch(() => []),
      api("/admin/api-keys").then((d) => d.api_keys || []).catch(() => []),
      api("/admin/pricing").then((d) => d.pricing || null).catch(() => null),
      api("/admin/settings").then((d) => (d.settings || {}).support_bot || "").catch(() => ""),
    ]);
  } catch { /* ignore */ }
  $("#adSupportBot").value = supportBot ? "@" + supportBot : "";
  if (pricing) renderAdminPricing(pricing);
  const kb = $("#adApiKeysBody");
  kb.innerHTML = keys.length
    ? keys.map((k) => `<tr>
        <td class="sm">${esc(k.label || "App " + k.api_id)} ${k.limited ? '<span class="badge red">LIMITED</span>' : ""}</td>
        <td class="sm">${esc(String(k.api_id))}</td>
        <td class="sm mono">${esc(String(k.api_hash).slice(0, 12))}…</td>
        <td class="sm">${esc(k.created_at || "")}</td>
        <td>${k.limited ? `<button class="btn ghost sm" data-unlimit="${k.id}">Unflag</button>` : ""}<button class="btn ghost sm" data-adel="${k.id}">Delete</button></td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="muted">No API keys yet. Use config.json or add one below.</td></tr>`;
  $$("#adApiKeysBody [data-adel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this API key?")) return;
    try { await api("/admin/api-keys/" + b.dataset.adel, { method: "DELETE" }); toast("API key deleted", "ok"); adminLoadData(); }
    catch (e) { toast(e.message, "err"); }
  }));
  $$("#adApiKeysBody [data-unlimit]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/admin/api-keys/" + b.dataset.unlimit + "/unlimit", { method: "POST" }); toast("API key unflagged", "ok"); adminLoadData(); }
    catch (e) { toast(e.message, "err"); }
  }));
  const cb = $("#adChecksBody");
  cb.innerHTML = checks.length
    ? checks.map((c) => `<tr>
        <td class="sm">${esc(c.customer_name || c.customer_username || "—")}</td>
        <td class="sm">${esc(c.created_at || "")}</td>
        <td class="sm">${esc((c.numbers || []).length)} numbers</td>
        <td><span class="badge ${c.found ? "green" : "gray"}">${c.found}/${(c.numbers || []).length}</span></td>
        <td class="sm">${Math.floor(c.cost || 0)} cr</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="muted">No checks yet.</td></tr>`;
  const tb = $("#adTxBody");
  tb.innerHTML = txs.length
    ? txs.map((t) => `<tr>
        <td class="sm">${esc(t.username || "—")}</td>
        <td class="sm">${esc(t.created_at || "")}</td>
        <td class="sm">${esc(t.type || "")}</td>
        <td class="sm">${Math.floor(t.credits || 0)}</td>
        <td class="sm">$${t.usd || 0}</td>
        <td class="sm mono">${esc((t.txid || "").slice(0, 16))}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="muted">No transactions yet.</td></tr>`;
}

function renderAdminPricing(pr) {
  const body = $("#adPricingBody");
  const unitMap = { "numbers checked": "number", "messages sent": "message", "members scraped": "member" };
  body.innerHTML = Object.entries(pr).map(([svc, p]) => {
    const rate = (p.usd / 0.003 / p.per);
    const rateTxt = (rate % 1 ? rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : rate) +
      " credit" + (rate === 1 ? "" : "s") + " / " + (unitMap[p.unit] || p.unit);
    return `<tr>
      <td>${esc(p.label)}<div class="muted sm">${rateTxt}</div></td>
      <td class="sm">${esc(unitMap[p.unit] || p.unit)}</td>
      <td><input class="input sm-num" type="number" min="0.01" step="0.5" value="${p.usd}" data-psvc="${svc}" data-pfield="usd" style="width:90px"></td>
      <td><input class="input sm-num" type="number" min="1" step="100" value="${p.per}" data-psvc="${svc}" data-pfield="per" style="width:110px"></td>
      <td><button class="btn primary sm" data-psave="${svc}">Save</button></td>
      <td><button class="btn ghost sm" data-preset="${svc}">Reset</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="muted">No services configured.</td></tr>`;
  $$("#adPricingBody [data-psave]").forEach((b) => b.addEventListener("click", async () => {
    const usd = Number($(`[data-psvc="${b.dataset.psave}"][data-pfield="usd"]`).value);
    const per = Number($(`[data-psvc="${b.dataset.psave}"][data-pfield="per"]`).value);
    if (!(usd > 0) || !(per > 0)) return toast("Enter valid price and volume", "err");
    try {
      await api("/admin/pricing/" + b.dataset.psave, { method: "PUT", json: { usd, per } });
      toast("Pricing updated", "ok");
      await loadShop();
      adminLoadData();
    } catch (e) { toast(e.message, "err"); }
  }));
  $$("#adPricingBody [data-preset]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await api("/admin/pricing/" + b.dataset.preset, { method: "DELETE" });
      toast("Back to default", "ok");
      await loadShop();
      adminLoadData();
    } catch (e) { toast(e.message, "err"); }
  }));
}

async function adminAddApiKey() {
  const api_id = $("#adApiId").value.trim();
  const api_hash = $("#adApiHash").value.trim();
  const label = $("#adApiLabel").value.trim();
  if (!api_id || !api_hash) return toast("api_id and api_hash are required", "err");
  try {
    await api("/admin/api-keys", { method: "POST", json: { api_id: Number(api_id), api_hash, label } });
    $("#adApiId").value = ""; $("#adApiHash").value = ""; $("#adApiLabel").value = "";
    toast("API key added", "ok");
    adminLoadData();
    loadAccounts();
  } catch (e) { toast(e.message, "err"); }
}

async function updateSupportButton() {
  const btn = $("#supportBtn");
  try {
    const d = await api("/support", { silent: true });
    const u = (d && d.username) || "";
    if (u) { btn.href = "https://t.me/" + u; btn.hidden = false; }
    else btn.hidden = true;
  } catch { btn.hidden = true; }
}

async function saveSupport() {
  const val = $("#adSupportBot").value.trim().replace(/^@/, "");
  try {
    const d = await api("/admin/settings/support", { method: "PUT", json: { username: val } });
    const u = (d.settings || {}).support_bot || "";
    $("#adSupportBot").value = u ? "@" + u : "";
    toast(u ? "Support bot saved" : "Support bot removed", "ok");
    await updateSupportButton();
  } catch (e) { toast(e.message, "err"); }
}

async function changeAdminRoleFromId(role) {
  const input = $("#adAdminId");
  const id = Number(input.value);
  if (!id) { toast("Enter a valid user ID", "err"); return; }
  try {
    await api("/admin/customers/" + id + "/role", { method: "PATCH", json: { role } });
    toast(role === "admin" ? "Admin access granted" : "Admin access revoked", "ok");
    input.value = "";
    await adminRefresh();
  } catch (e) { toast(e.message, "err"); }
}


async function adminRefresh() {
  let d;
  try { d = await api("/admin/customers"); }
  catch (e) { toast(e.message, "err"); return; }
  const custs = d.customers || [];
  const body = $("#adCustomersBody");
  body.innerHTML = custs.length
    ? custs.map((c) => `
      <tr>
        <td>${esc(c.id)}</td>
        <td>${esc(c.name || "—")}</td>
        <td>@${esc(c.username)}</td>
        <td>${c.role === "admin" ? "🛡 Admin" : "User"}</td>
        <td>${Math.floor(c.credits || 0).toLocaleString()} <button class="btn ghost sm" data-bump="${c.id}">+1000</button></td>
        <td class="ta-r">
          ${c.role === "admin"
            ? `<button class="btn ghost sm" data-revoke="${c.id}">Revoke</button>`
            : `<button class="btn ghost sm" data-grant="${c.id}">Make admin</button>`}
          <button class="btn ghost sm" data-del="${c.id}">Delete</button>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="muted">No customers yet.</td></tr>`;
  $$("#adCustomersBody [data-bump]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await api("/admin/credits", { method: "POST", json: { customer_id: Number(b.dataset.bump), credits: 1000 } });
      toast("+1000 credits", "ok");
      await adminRefresh();
    } catch (e) { toast(e.message, "err"); }
  }));
  $$("#adCustomersBody [data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this customer?")) return;
    try {
      await api("/admin/customers/" + b.dataset.del, { method: "DELETE" });
      toast("Customer deleted", "ok");
      await adminRefresh();
    } catch (e) { toast(e.message, "err"); }
  }));
  $$("#adCustomersBody [data-grant], #adCustomersBody [data-revoke]").forEach((b) => b.addEventListener("click", async () => {
    const id = Number(b.dataset.grant || b.dataset.revoke);
    const role = b.dataset.grant ? "admin" : "customer";
    try {
      await api("/admin/customers/" + id + "/role", { method: "PATCH", json: { role } });
      toast(role === "admin" ? "Admin access granted" : "Admin access revoked", "ok");
      await adminRefresh();
    } catch (e) { toast(e.message, "err"); }
  }));
  const sel = $("#adCredCust");
  sel.innerHTML = custs.map((c) => `<option value="${c.id}">@${esc(c.username)} (${Math.floor(c.credits || 0).toLocaleString()})</option>`).join("");
  adminLoadData();
}

async function logout() {
  try { await api("/logout", { method: "POST" }); } catch { /* token may be gone */ }
  localStorage.removeItem("tg_token");
  if (S._refreshTimer) { clearInterval(S._refreshTimer); S._refreshTimer = null; }
  location.reload();
}

async function registerUser() {
  const name = $("#regName").value.trim();
  const username = $("#regUser").value.trim();
  const password = $("#regPass").value;
  const err = $("#regErr");
  err.hidden = true;
  if (username.length < 3) { err.textContent = "Username must be at least 3 characters"; err.hidden = false; return; }
  if (password.length < 4) { err.textContent = "Password must be at least 4 characters"; err.hidden = false; return; }
  $("#btnRegister").disabled = true;
  try {
    await api("/register", { method: "POST", json: { name: name || undefined, username, password } });
    toast("Account created! Now login.", "ok");
    closeRegister();
    $("#lockUser").value = username;
    $("#lockPass").value = "";
    openLogin();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    $("#btnRegister").disabled = false;
  }
}

async function loadLandingPacks() {
  let d;
  try { d = await api("/shop"); }
  catch {
    $("#landPacks").innerHTML = '<div class="muted">Packs unavailable</div>';
    const lp = $("#landPricing");
    if (lp) lp.innerHTML = '<tr><td colspan="3" class="muted">Pricing unavailable</td></tr>';
    return;
  }
  const pr = d.pricing || [];
  const lp = $("#landPricing");
  if (lp) {
    const unitMap = { "numbers checked": "number", "messages sent": "message", "members scraped": "member" };
    const unitPlural = { "numbers checked": "numbers", "messages sent": "messages", "members scraped": "members" };
    lp.innerHTML = pr.length
      ? pr.map((p) => {
          const rate = (p.credits_per_unit || 0);
          const rateTxt = (rate % 1 ? rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : rate) +
            " credit" + (rate === 1 ? "" : "s") + " / " + (unitMap[p.unit] || p.unit);
          return `<tr>
            <td>${esc(p.label)}</td>
            <td class="sm">${rateTxt}</td>
            <td class="sm">$${p.usd} / ${p.per.toLocaleString()} ${unitPlural[p.unit] || p.unit}</td>
          </tr>`;
        }).join("")
      : '<tr><td colspan="3" class="muted">No services yet.</td></tr>';
  }
  const packs = d.packs || [];
  if (!packs.length) { $("#landPacks").innerHTML = '<div class="muted">Pricing coming soon.</div>'; return; }
  const hot = Math.floor(packs.length / 2);
  $("#landPacks").innerHTML = packs.map((p, i) => `
      <div class="pack ${i === hot ? "hot" : ""}">
        ${i === hot ? '<div class="pack-tag">MOST POPULAR</div>' : ""}
        <div class="credits">${p.credits.toLocaleString()}</div>
        <div class="usd">$${p.usd} USDT</div>
        <div class="per">credits. Use for checks, sends &amp; scrapes</div>
      </div>`).join("");
}

function openForgot() {
  $("#btnUnlock").hidden = true;
  $("#btnForgot").hidden = true;
  $("#forgotBox").hidden = false;
  $("#forgotUser").focus();
}

function cancelForgot() {
  $("#btnUnlock").hidden = false;
  $("#btnForgot").hidden = false;
  $("#forgotBox").hidden = true;
}

async function sendForgot() {
  const u = $("#forgotUser").value.trim();
  try {
    const d = await api("/forgot-password", { method: "POST", json: { username: u } });
    toast(d.msg || "Password sent", "ok");
    cancelForgot();
  } catch (e) { toast(e.message, "err"); }
}

function init() {
  bindNav();
  bindMemberFilters();
  $("#btnSendCode").addEventListener("click", sendCode);
  $("#btnVerify").addEventListener("click", verify);
  $("#btnStartScrape").addEventListener("click", startScrape);
  $("#btnCreateCampaign").addEventListener("click", createCampaign);
  $("#btnCloseDetail").addEventListener("click", () => { S.detailCid = null; $("#campaignDetailCard").hidden = true; });
  $("#btnSetDelay").addEventListener("click", setCampaignDelay);
  $("#btnUnlock").addEventListener("click", unlock);
  $("#btnLogout").addEventListener("click", logout);
  ["btnNavLogin", "btnHeroLogin"].forEach((id) => $("#" + id).addEventListener("click", openLogin));
  ["btnNavRegister", "btnHeroRegister", "btnFootRegister"].forEach((id) => $("#" + id).addEventListener("click", openRegister));
  $("#btnCloseLogin").addEventListener("click", closeLogin);
  $("#btnCloseReg").addEventListener("click", closeRegister);
  $("#btnRegister").addEventListener("click", registerUser);
  $("#gotoRegister").addEventListener("click", (e) => { e.preventDefault(); closeLogin(); openRegister(); });
  $("#gotoLogin").addEventListener("click", (e) => { e.preventDefault(); closeRegister(); openLogin(); });
  $("#btnForgot").addEventListener("click", (e) => { e.preventDefault(); openForgot(); });
  $("#btnCancelForgot").addEventListener("click", (e) => { e.preventDefault(); cancelForgot(); });
  $("#btnSendForgot").addEventListener("click", sendForgot);
  $("#forgotUser").addEventListener("keydown", (e) => { if (e.key === "Enter") sendForgot(); });
  $("#regUser").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#regPass").focus(); });
  $("#regPass").addEventListener("keydown", (e) => { if (e.key === "Enter") registerUser(); });
  $("#lockPass").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  $("#lockUser").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#lockPass").focus(); });
  $("#btnValidate").addEventListener("click", validateNumbers);
  $("#btnStopVal").addEventListener("click", stopValidate);
  $("#btnValExport").addEventListener("click", exportValResults);
  $("#btnCopyWallet").addEventListener("click", copyWallet);
  $("#btnVerifyPay").addEventListener("click", verifyPay);
  $("#btnAddCustomer").addEventListener("click", adminCreateCustomer);
  $("#btnAddCredits").addEventListener("click", adminAddCredits);
  $("#btnAddApiKey").addEventListener("click", adminAddApiKey);
  $("#btnSaveSupport").addEventListener("click", saveSupport);
  $("#btnRefreshAdmin").addEventListener("click", adminRefresh);
  $("#btnGrantAdmin").addEventListener("click", () => changeAdminRoleFromId("admin"));
  $("#btnRevokeAdmin").addEventListener("click", () => changeAdminRoleFromId("customer"));
  ["cpFUsername", "cpFPhone", "cpFNoBot"].forEach((id) => $("#" + id).addEventListener("change", (e) => {
    S.campFilters[id === "cpFUsername" ? "has_username" : id === "cpFPhone" ? "has_phone" : "exclude_bots"] = e.target.checked;
  }));
  $("#cpFSearch").addEventListener("input", () => { S.campFilters.search = $("#cpFSearch").value; });

  updateSupportButton();

  api("/auth/check", { silent: true }).then(() => {
    afterLogin();
  }).catch(() => showLanding());
}

document.addEventListener("DOMContentLoaded", init);