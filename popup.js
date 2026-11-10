// ---------------------------------------------------------------------------
// Storage
//   chrome.storage.sync  -> pinned repos (follows you across Chrome profiles)
//   chrome.storage.local -> token + cached repo lists (stays on this device)
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 15 * 60 * 1000;

// storage.sync caps each key at ~8KB, so pins are split across "pins:0", "pins:1", …
// with "pinsCount" recording how many chunks exist.
const PINS_PER_CHUNK = 15;

const store = {
  async getPins() {
    const { pinsCount = 0 } = await chrome.storage.sync.get("pinsCount");
    if (!pinsCount) return [];
    const keys = Array.from({ length: pinsCount }, (_, i) => `pins:${i}`);
    const data = await chrome.storage.sync.get(keys);
    return keys.flatMap((k) => data[k] || []);
  },
  async setPins(pins) {
    const { pinsCount: oldCount = 0 } = await chrome.storage.sync.get("pinsCount");
    const chunks = {};
    let n = 0;
    for (let i = 0; i < pins.length; i += PINS_PER_CHUNK) chunks[`pins:${n++}`] = pins.slice(i, i + PINS_PER_CHUNK);
    await chrome.storage.sync.set({ ...chunks, pinsCount: n });
    const stale = [];
    for (let i = n; i < oldCount; i++) stale.push(`pins:${i}`);
    if (stale.length) await chrome.storage.sync.remove(stale);
  },
  async getAuth() {
    const { token = "", user = null, authMethod = null } = await chrome.storage.local.get(["token", "user", "authMethod"]);
    return { token, user, authMethod };
  },
  async setAuth({ token, user, authMethod }) {
    await chrome.storage.local.set({ token, user, authMethod });
  },
  async clearAuth() {
    await chrome.storage.local.remove(["token", "user", "authMethod", "cache:mine", "cache:contrib"]);
  },
  async getCache(key) {
    const { [`cache:${key}`]: entry } = await chrome.storage.local.get(`cache:${key}`);
    if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.data;
    return null;
  },
  async setCache(key, data) {
    await chrome.storage.local.set({ [`cache:${key}`]: { at: Date.now(), data } });
  },
  async clearCache() {
    await chrome.storage.local.remove(["cache:mine", "cache:contrib"]);
  },
};

// Pins store only what's needed to render the row (kept small for the sync quota).
// The avatar is derived from the owner name at render time.
function toPin(repo) {
  const { fullName, url, description, language, stars, private: isPrivate } = repo;
  return { fullName, url, description: (description || "").slice(0, 120), language, stars, private: isPrivate };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  pins: [],
  token: "",
  user: null, // { login, avatarUrl }
  authMethod: null, // "oauth" | "pat"
  authFlow: null, // in-progress device flow, from the service worker
  editing: false,
  tab: "mine",
  lists: { mine: null, contrib: null }, // loaded lazily
  searchResults: [],
  searchAbort: null,
};

const $ = (sel) => document.querySelector(sel);
const pinnedNames = () => new Set(state.pins.map((p) => p.fullName.toLowerCase()));

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function formatStars(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function repoInfo(repo) {
  const [owner, name] = repo.fullName.split("/");
  const meta = [];
  if (repo.language) meta.push(el("span", {}, repo.language));
  if (repo.stars) meta.push(el("span", {}, `★ ${formatStars(repo.stars)}`));
  return el(
    "div",
    { class: "info" },
    el(
      "div",
      { class: "name", title: repo.fullName },
      el("span", { class: "owner" }, `${owner} / `),
      name,
      repo.private ? el("span", { class: "badge" }, "Private") : null
    ),
    repo.description ? el("div", { class: "desc", title: repo.description }, repo.description) : null,
    meta.length ? el("div", { class: "meta" }, meta) : null
  );
}

function avatar(repo) {
  const src = repo.avatar
    ? `${repo.avatar}${repo.avatar.includes("?") ? "&" : "?"}s=48`
    : `https://github.com/${repo.fullName.split("/")[0]}.png?size=48`;
  const img = el("img", { class: "avatar", src, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.removeAttribute("src"), { once: true });
  return img;
}

function openRepo(url) {
  chrome.tabs.create({ url });
}

// ---------------------------------------------------------------------------
// Main view: pinned repos
// ---------------------------------------------------------------------------
function renderPinned() {
  const list = $("#pinned-list");
  list.replaceChildren();
  document.body.classList.toggle("editing", state.editing);
  $("#btn-edit").textContent = state.editing ? "Done" : "Edit";
  $("#btn-edit").classList.toggle("active", state.editing);
  $("#btn-edit").classList.toggle("hidden", state.pins.length === 0 && !state.editing);
  $("#pinned-empty").classList.toggle("hidden", state.pins.length > 0);

  state.pins.forEach((repo, i) => {
    const li = el("li", { class: "repo", "data-index": i });

    if (state.editing) {
      li.draggable = true;
      li.append(
        el("span", { class: "handle", title: "Drag to reorder" }, "⋮⋮"),
        avatar(repo),
        repoInfo(repo),
        el(
          "div",
          { class: "controls" },
          el("button", { class: "icon-btn", title: "Move up", "aria-label": "Move up", disabled: i === 0, onclick: () => movePin(i, i - 1) }, "↑"),
          el("button", { class: "icon-btn", title: "Move down", "aria-label": "Move down", disabled: i === state.pins.length - 1, onclick: () => movePin(i, i + 1) }, "↓"),
          el("button", { class: "icon-btn danger", title: "Remove", "aria-label": "Remove", onclick: () => removePin(repo.fullName) }, "✕")
        )
      );
      attachDrag(li);
    } else {
      li.tabIndex = 0;
      li.title = repo.url;
      li.append(avatar(repo), repoInfo(repo));
      li.addEventListener("click", () => openRepo(repo.url));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter") openRepo(repo.url);
      });
    }
    list.append(li);
  });
}

async function savePins() {
  await store.setPins(state.pins);
}

async function movePin(from, to) {
  if (to < 0 || to >= state.pins.length || from === to) return;
  const [item] = state.pins.splice(from, 1);
  state.pins.splice(to, 0, item);
  await savePins();
  renderPinned();
}

async function removePin(fullName) {
  state.pins = state.pins.filter((p) => p.fullName.toLowerCase() !== fullName.toLowerCase());
  await savePins();
  renderPinned();
}

async function togglePin(repo) {
  const key = repo.fullName.toLowerCase();
  if (pinnedNames().has(key)) {
    state.pins = state.pins.filter((p) => p.fullName.toLowerCase() !== key);
  } else {
    state.pins.push(toPin(repo));
  }
  await savePins();
}

// Drag & drop reordering (edit mode)
let dragIndex = null;
function attachDrag(li) {
  li.addEventListener("dragstart", (e) => {
    dragIndex = Number(li.dataset.index);
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    dragIndex = null;
    document.querySelectorAll(".repo").forEach((n) => n.classList.remove("dragging", "drop-before", "drop-after"));
  });
  li.addEventListener("dragover", (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    const rect = li.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    li.classList.toggle("drop-before", before);
    li.classList.toggle("drop-after", !before);
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    if (dragIndex === null) return;
    const target = Number(li.dataset.index);
    const before = li.classList.contains("drop-before");
    let to = before ? target : target + 1;
    if (dragIndex < to) to -= 1; // account for removal shifting indices
    movePin(dragIndex, to);
  });
}

// ---------------------------------------------------------------------------
// Add view
// ---------------------------------------------------------------------------
function setStatus(msg, kind = "") {
  const s = $("#add-status");
  if (!msg) return s.classList.add("hidden");
  s.className = `status ${kind}`;
  s.replaceChildren(...(Array.isArray(msg) ? msg : [msg]));
}

function renderAddList(repos) {
  const list = $("#add-list");
  list.replaceChildren();
  const pinned = pinnedNames();
  for (const repo of repos) {
    const isPinned = pinned.has(repo.fullName.toLowerCase());
    const btn = el("button", { class: `pin-btn${isPinned ? " pinned" : ""}` }, isPinned ? "✓ Pinned" : "+ Pin");
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await togglePin(repo);
      const now = pinnedNames().has(repo.fullName.toLowerCase());
      btn.classList.toggle("pinned", now);
      btn.textContent = now ? "✓ Pinned" : "+ Pin";
    });
    const li = el("li", { class: "repo", title: `Open ${repo.url}` }, avatar(repo), repoInfo(repo), btn);
    li.addEventListener("click", () => openRepo(repo.url));
    list.append(li);
  }
}

function needTokenMessage() {
  return [
    el("a", { onclick: () => showView("settings") }, "Sign in with GitHub"),
    " to see this list.",
  ];
}

async function loadList(kind, force = false) {
  if (!state.token) return null;
  if (!force && state.lists[kind]) return state.lists[kind];
  if (!force) {
    const cached = await store.getCache(kind);
    if (cached) return (state.lists[kind] = cached);
  }
  const data = kind === "mine" ? await GH.listMyRepos(state.token) : await GH.listContributedRepos(state.token);
  state.lists[kind] = data;
  await store.setCache(kind, data);
  return data;
}

function filterRepos(repos, q) {
  if (!q) return repos;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return repos.filter((r) => {
    const hay = `${r.fullName} ${r.description} ${r.language || ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

let searchTimer = null;
async function refreshAdd({ force = false } = {}) {
  const q = $("#add-query").value.trim();
  renderDirectAdd(q);

  if (state.tab === "search") {
    clearTimeout(searchTimer);
    if (!q) {
      renderAddList([]);
      return setStatus("Search all of GitHub by name, topic, or owner/repo.");
    }
    setStatus("Searching…");
    searchTimer = setTimeout(() => runSearch(q), 350);
    return;
  }

  if (!state.token) {
    renderAddList([]);
    return setStatus(needTokenMessage());
  }

  const kind = state.tab;
  try {
    if (!state.lists[kind] || force) setStatus("Loading…");
    const repos = await loadList(kind, force);
    if (state.tab !== kind) return; // user switched tabs while loading
    const filtered = filterRepos(repos, q);
    renderAddList(filtered);
    if (!repos.length) setStatus(kind === "mine" ? "No repos found." : "No contributions found in the past year.");
    else if (!filtered.length) setStatus("No matches. Try the Search tab.");
    else setStatus("");
  } catch (err) {
    renderAddList([]);
    setStatus(err.message, "error");
  }
}

async function runSearch(q) {
  state.searchAbort?.abort();
  const ctrl = new AbortController();
  state.searchAbort = ctrl;
  try {
    const results = await GH.searchRepos(q, state.token, ctrl.signal);
    if (ctrl.signal.aborted) return;
    renderAddList(results);
    setStatus(results.length ? "" : "No results.");
  } catch (err) {
    if (err.name === "AbortError") return;
    renderAddList([]);
    setStatus(err.message, "error");
  }
}

// When the query looks like "owner/repo" or a GitHub URL, offer a one-click pin.
function renderDirectAdd(q) {
  const box = $("#direct-add");
  const ref = GH.parseRepoRef(q);
  if (!ref || pinnedNames().has(ref.toLowerCase())) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const btn = el("button", { class: "btn" }, `+ Pin ${ref}`);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = `Looking up ${ref}…`;
    try {
      const repo = await GH.getRepo(ref, state.token);
      if (!pinnedNames().has(repo.fullName.toLowerCase())) await togglePin(repo);
      btn.textContent = `✓ Pinned ${repo.fullName}`;
      refreshAdd();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = err.status === 404 ? `${ref} not found (or no access)` : err.message;
    }
  });
  box.replaceChildren(btn);
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("#add-query").placeholder = tab === "search" ? "Search GitHub or paste owner/repo…" : "Filter, or paste owner/repo…";
  $("#btn-refresh").classList.toggle("hidden", tab === "search");
  refreshAdd();
}

// ---------------------------------------------------------------------------
// Account view (sign in with GitHub via device flow, or a PAT fallback)
// ---------------------------------------------------------------------------
function acctStatus(msg, kind = "") {
  const s = $("#acct-status");
  s.className = `status ${kind}`;
  s.replaceChildren(...(Array.isArray(msg) ? msg : [msg || ""]));
  s.classList.toggle("hidden", !msg);
}

function renderAccountButton() {
  const btn = $("#btn-settings");
  if (state.user?.avatarUrl) {
    btn.replaceChildren(el("img", { src: `${state.user.avatarUrl}${state.user.avatarUrl.includes("?") ? "&" : "?"}s=40`, alt: "" }));
    btn.title = `Signed in as ${state.user.login}`;
  } else {
    btn.textContent = "⚙";
    btn.title = state.token ? "Account" : "Sign in";
  }
}

function renderAccount() {
  const signedIn = !!state.token;
  const pending = !signedIn && state.authFlow?.status === "pending";
  const needsSetup = !signedIn && !pending && (!state.clientId || state.editingClientId);
  $("#acct-in").classList.toggle("hidden", !signedIn);
  $("#acct-setup").classList.toggle("hidden", !needsSetup);
  $("#acct-out").classList.toggle("hidden", signedIn || pending || needsSetup);
  $("#btn-change-client-id").classList.toggle("hidden", !!GITHUB_CLIENT_ID); // fixed in config.js
  if (needsSetup) $("#client-id-input").value = state.clientId;
  $("#acct-pending").classList.toggle("hidden", !pending);
  $("#pat-details").classList.toggle("hidden", signedIn);

  if (signedIn) {
    $("#acct-login").textContent = state.user?.login || "GitHub user";
    if (state.user?.avatarUrl) $("#acct-avatar").src = state.user.avatarUrl;
    $("#acct-method").textContent = state.authMethod === "pat" ? "Using a personal access token" : "Signed in with GitHub";
  }
  if (pending) $("#device-code").textContent = state.authFlow.userCode;

  if (!signedIn && state.authFlow?.status === "error") acctStatus(state.authFlow.error, "error");
  else acctStatus("");
  renderAccountButton();
}

async function saveClientId() {
  const id = $("#client-id-input").value.trim();
  if (!/^[\w.-]{10,}$/.test(id)) return acctStatus("That doesn't look like a Client ID. Copy it from the OAuth App page.", "error");
  await chrome.storage.local.set({ clientId: id });
  state.clientId = id;
  state.editingClientId = false;
  renderAccount();
}

async function startSignIn() {
  const btn = $("#btn-signin");
  btn.disabled = true;
  acctStatus("Contacting GitHub…");
  try {
    // Sign-in endpoints on github.com don't allow web requests, so Chrome needs the
    // extension's github.com/login host permission. It can be withheld, e.g. when a
    // reloaded unpacked extension adds a new host, so ask for it if missing.
    // request() resolves true right away if already granted. It must be the first
    // await so the click still counts as a user gesture.
    const granted = await chrome.permissions.request({ origins: ["https://github.com/login/*"] });
    if (!granted) throw new Error("The extension needs access to github.com/login to sign you in. Click Sign in again and choose Allow.");
    state.authFlow = await Auth.start();
    renderAccount();
    Auth.poll(); // poll while the popup is open; the service worker takes over once it closes
  } catch (err) {
    acctStatus(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function openDevicePage() {
  const flow = state.authFlow;
  if (!flow) return;
  try {
    await navigator.clipboard.writeText(flow.userCode);
  } catch {}
  chrome.tabs.create({ url: flow.verificationUri }); // closes the popup; polling continues in the background
}

async function cancelSignIn() {
  await Auth.setFlow(null);
  state.authFlow = null;
  renderAccount();
}

async function signOut() {
  const wasPat = state.authMethod === "pat";
  await store.clearAuth();
  Object.assign(state, { token: "", user: null, authMethod: null, lists: { mine: null, contrib: null } });
  renderAccount();
  acctStatus(
    wasPat ? "Signed out." : [
      "Signed out. To fully revoke access, visit ",
      el("a", { onclick: () => openRepo("https://github.com/settings/applications") }, "GitHub › Applications"),
      ".",
    ]
  );
}

async function saveToken() {
  const token = $("#token-input").value.trim();
  if (!token) return acctStatus("Paste a token first.", "error");
  acctStatus("Checking token…");
  try {
    const u = await GH.getViewer(token);
    const user = { login: u.login, avatarUrl: u.avatar_url };
    await store.clearCache();
    await store.setAuth({ token, user, authMethod: "pat" });
    Object.assign(state, { token, user, authMethod: "pat", lists: { mine: null, contrib: null } });
    $("#token-input").value = "";
    renderAccount();
  } catch (err) {
    acctStatus(err.message, "error");
  }
}

async function initAccount() {
  state.authFlow = await Auth.getFlow();
  renderAccount();
  if (state.authFlow?.status === "pending") Auth.poll();
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function showView(name) {
  for (const v of ["main", "add", "settings"]) {
    $(`#view-${v}`).classList.toggle("hidden", v !== name);
  }
  if (name === "main") {
    state.editing = false;
    renderPinned();
  } else if (name === "add") {
    $("#add-query").value = "";
    setTab(state.tab);
    $("#add-query").focus();
  } else if (name === "settings") {
    initAccount();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  const [pins, auth] = await Promise.all([store.getPins(), store.getAuth()]);
  state.pins = pins;
  Object.assign(state, auth);
  const { clientId = "" } = await chrome.storage.local.get("clientId");
  state.clientId = GITHUB_CLIENT_ID || clientId;
  state.editingClientId = false;

  $("#btn-add").addEventListener("click", () => showView("add"));
  $("#btn-add-empty").addEventListener("click", () => showView("add"));
  $("#btn-settings").addEventListener("click", () => showView("settings"));
  $("#btn-edit").addEventListener("click", () => {
    state.editing = !state.editing;
    renderPinned();
  });
  document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => showView("main")));
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
  $("#add-query").addEventListener("input", () => refreshAdd());
  $("#btn-refresh").addEventListener("click", () => refreshAdd({ force: true }));
  $("#btn-signin").addEventListener("click", startSignIn);
  $("#btn-save-client-id").addEventListener("click", saveClientId);
  $("#client-id-input").addEventListener("keydown", (e) => e.key === "Enter" && saveClientId());
  $("#btn-change-client-id").addEventListener("click", () => {
    state.editingClientId = true;
    renderAccount();
  });
  $("#btn-open-device").addEventListener("click", openDevicePage);
  $("#btn-cancel-signin").addEventListener("click", cancelSignIn);
  $("#btn-signout").addEventListener("click", signOut);
  $("#btn-save-token").addEventListener("click", saveToken);
  $("#token-input").addEventListener("keydown", (e) => e.key === "Enter" && saveToken());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#view-main").classList.contains("hidden")) {
      e.preventDefault();
      showView("main");
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    // Pins changed in another window/profile.
    if (area === "sync" && Object.keys(changes).some((k) => k === "pinsCount" || k.startsWith("pins:"))) {
      store.getPins().then((pins) => {
        state.pins = pins;
        if (!$("#view-main").classList.contains("hidden") && !state.editing) renderPinned();
      });
    }
    // Sign-in completed (or failed) in the service worker while the popup is open.
    if (area === "local" && (changes.token || changes.user)) {
      store.getAuth().then((auth) => {
        Object.assign(state, auth, { lists: { mine: null, contrib: null } });
        renderAccountButton();
        if (!$("#view-settings").classList.contains("hidden")) renderAccount();
      });
    }
    if (area === "session" && changes.authFlow) {
      state.authFlow = changes.authFlow.newValue || null;
      if (!$("#view-settings").classList.contains("hidden")) renderAccount();
    }
  });

  renderAccountButton();
  // First run with no account: go straight to sign-in.
  showView(!state.token && !state.pins.length ? "settings" : "main");
}

init();
