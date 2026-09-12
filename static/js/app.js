/* ================= helpers ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
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
    if (res.status === 401 && path !== "/login") showLogin();
    throw new Error((data && data.detail) || "Request failed (" + res.status + ")");
  }
  return data;
}

function toast(msg, type = "") {
  const box = $("#toastBox");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function showLogin() {
  $("#lockScreen").classList.add("show");
}

function hideLogin() {
  $("#lockScreen").classList.remove("show");
}

async function unlock() {
  const pass = $("#lockPass").value;
  if (!pass) return;
  $("#btnUnlock").disabled = true;
  try {
    const d = await api("/login", { method: "POST", json: { password: pass } });
    localStorage.setItem("tg_token", d.token);
    $("#lockErr").hidden = true;
    hideLogin();
    toast("Unlocked", "ok");
    startApp();
  } catch (e) {
    $("#lockErr").hidden = false;
    toast(e.message, "err");
  } finally {
    $("#btnUnlock").disabled = false;
  }
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
};

/* ================= navigation ================= */
function setPage(name) {
  S.page = name;
  $$(".page").forEach((p) => p.classList.remove("active"));
  $("#page-" + name).classList.add("active");
  $$(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.page === name));
  $("#mainNav").classList.remove("open");
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
  try { S.accounts = (await api("/accounts")).accounts; } catch { return; }
  renderAccountList();
  renderScrapeAccountSelect();
  renderCampaignAccountChips();
}

function renderAccountList() {
  $("#accCount").textContent = S.accounts.filter((a) => a.status === "active").length;
  const list = $("#accountsList");
  if (!S.accounts.length) { list.innerHTML = `<div class="empty">No accounts yet.</div>`; return; }
  list.innerHTML = S.accounts.map((a) => `
    <div class="row-item">
      <div class="main">
        <div class="title">${esc(a.name || "—")} ${badge(a.status)}</div>
        <div class="sub">${esc(a.phone || "")}${a.username ? " · @" + esc(a.username) : ""}</div>
      </div>
      <div class="row-actions">
        ${a.status === "active" ? `<button class="btn ghost sm" data-del="${a.id}">Log out</button>` : ""}
      </div>
    </div>`).join("");
  $$("#accountsList [data-del]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/accounts/" + b.dataset.del, { method: "DELETE" }); toast("Account logged out", "ok"); await loadAccounts(); }
    catch (e) { toast(e.message, "err"); }
  }));
}

function renderScrapeAccountSelect() {
  const active = S.accounts.filter((a) => a.status === "active");
  $("#scrapeAccount").innerHTML = active.length
    ? active.map((a) => `<option value="${a.id}">${esc(a.phone)}${a.username ? " @" + a.username : ""}</option>`).join("")
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
    await api("/accounts/send-code", { method: "POST", json: { phone } });
    $("#codeBox").hidden = false;
    $("#needPassHint").hidden = true;
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
    const a = list[0]; if (!a) return toast("No account in progress. Send a code first.", "err");
    if (a.status !== "waiting_code") return toast("No account waiting for a code. Send a code first.", "err");
    const res = await api("/accounts/verify", { method: "POST", json: { account_id: a.id, code, password: password || undefined } });
    if (res.need_password) { $("#needPassHint").hidden = false; return; }
    toast("Account logged in!", "ok");
    $("#codeBox").hidden = true; $("#accPhone").value = ""; $("#accCode").value = ""; $("#accPass").value = ""; $("#btnSendCode").textContent = "Send code";
    await loadAccounts();
  } catch (e) { toast(e.message, "err"); }
  finally { S.busy = false; }
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
        <div class="sub">${c.sent} sent · ${c.failed} failed · ${Math.max(0, total - done)} pending</div>
        <div class="progress-outer"><div class="progress-inner" style="width:${pct}%"></div></div>
      </div>
      <div class="row-actions">
        <button class="btn ghost sm" data-logs="${c.id}">Logs</button>
        ${c.status !== "running" && c.status !== "finished" && c.sent + c.failed < total ? `<button class="btn primary sm" data-start="${c.id}">Start</button>` : ""}
        ${running ? `<button class="btn danger sm" data-stop="${c.id}">Stop</button>` : ""}
      </div>
    </div>`;
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
}

async function openDetail() {
  $("#campaignDetailCard").hidden = false;
  $("#campaignDetailCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  await renderCampaignDetail();
}

async function renderCampaignDetail(c) {
  try {
    if (!c) c = (await api("/campaigns/" + S.detailCid)).campaign;
  } catch { return; }
  $("#cpDetailTitle").textContent = c.name;
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
  try {
    const jobs = (await api("/scrape/jobs")).jobs.map((j) => j.id + ":" + j.status + ":" + j.member_count).join(",");
    const camps = (await api("/campaigns")).campaigns.map((c) => c.id + ":" + c.status + ":" + (c.sent || 0) + ":" + (c.failed || 0)).join(",");
    const accs = (await api("/accounts")).accounts.map((a) => a.id + ":" + a.status).join(",");
    const jobsChanged = jobs !== lastJobs;
    const campsChanged = camps !== lastCamps;
    const accsChanged = accs !== lastAccs;
    lastJobs = jobs; lastCamps = camps; lastAccs = accs;

    if (jobsChanged) { S.jobs = (await api("/scrape/jobs")).jobs; renderScrapeJobs(); renderSrcJobSelect(); }
    if (accsChanged) { await loadAccounts(); }
    if (S.page === "dashboard") { await renderDashboard(); }
    if (S.page === "send" && (campsChanged || camps)) { await renderCampaigns(); }
    if (S.detailCid) await renderCampaignDetail();
    if (S.selJobId && $("#membersCard") && !$("#membersCard").hidden && jobsChanged) {
      // members refresh kept manual via filters
    }
  } catch { /* transient */ }
}

function init() {
  bindNav();
  bindMemberFilters();
  $("#btnSendCode").addEventListener("click", sendCode);
  $("#btnVerify").addEventListener("click", verify);
  $("#btnStartScrape").addEventListener("click", startScrape);
  $("#btnCreateCampaign").addEventListener("click", createCampaign);
  $("#btnCloseDetail").addEventListener("click", () => { S.detailCid = null; $("#campaignDetailCard").hidden = true; });
  $("#btnUnlock").addEventListener("click", unlock);
  $("#lockPass").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  ["cpFUsername", "cpFPhone", "cpFNoBot"].forEach((id) => $("#" + id).addEventListener("change", (e) => {
    S.campFilters[id === "cpFUsername" ? "has_username" : id === "cpFPhone" ? "has_phone" : "exclude_bots"] = e.target.checked;
  }));
  $("#cpFSearch").addEventListener("input", () => { S.campFilters.search = $("#cpFSearch").value; });

  api("/auth/check").then(() => {
    hideLogin();
    startApp();
  }).catch(() => showLogin());
}

function startApp() {
  setPage("dashboard");
  refresh();
  setInterval(refresh, 3500);
}

document.addEventListener("DOMContentLoaded", init);