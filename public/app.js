/**
 * Alex-Aero (ax.) · Robo Workers Frontend Application
 * Typography: Helvetica Medium
 * Design: Google Material Design 3 + Rounded Black Buttons + VS Code Icons & Syntax Highlighting
 * Client IP determined from HTTP requests (Dashboard only) · Zero Horizontal Scrolling
 */

const appState = {
  config: {},
  runtimeInfo: {},
  activeWorker: '',
  editorPreferences: {
    spaces: 2,
    indentUsingTabs: false,
    encoding: 'UTF-8',
    eol: 'LF',
    layout: 'Layout: US',
    language: 'javascript'
  },
  workers: {},
  storageFiles: [],
  languages: [],
  clientDevice: {},
  systemTelemetry: {},
  currentView: 'applications',
  currentDetailSubtab: 'overview',
  activeFileByWorker: {},
  explorerInlineMode: null,
  bottomPanelTab: 'output',
  lastHttpRawResponse: '',
  lastHttpContentType: 'application/json',
  lastHttpStatus: 200,
  lastHttpDurationMs: 0,
  lastHttpHeaders: {},
  issuesFilterStatus: 'active',
  customHeaders: [],
  notifications: [
    { time: new Date().toLocaleTimeString(), text: 'Robo Workers runtime initialized and synced with local storage' }
  ],
  diagnostics: []
};

let autoSaveTimer = null;
let hasUnsavedEditorChanges = false;
let workerModalMode = 'create';

const el = (id) => document.getElementById(id);

function addNotification(text, type = 'ok') {
  appState.notifications.unshift({
    time: new Date().toLocaleTimeString(),
    text
  });
  if (appState.notifications.length > 30) {
    appState.notifications.pop();
  }

  const stack = el('notifStack');
  if (stack) {
    const toast = document.createElement('div');
    toast.className = 'vscode-toast';
    const iconSvg =
      (window.VSCODE_ICONS && (type === 'info' ? window.VSCODE_ICONS.ICON_INFO : window.VSCODE_ICONS.ICON_OK)) ||
      '';
    toast.innerHTML = `
      ${iconSvg}
      <span>${escapeHtml(text)}</span>
      <button type="button" class="vscode-toast-close" aria-label="Dismiss">×</button>
    `;
    toast.querySelector('.vscode-toast-close').addEventListener('click', () => toast.remove());
    stack.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 3200);
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getLangLogoHtml(langId) {
  if (typeof window.langIconHTML === 'function') {
    return window.langIconHTML(langId || 'javascript');
  }
  return '';
}

function getLangDisplayName(langId) {
  if (typeof window.langLabel === 'function') {
    return window.langLabel(langId || 'javascript');
  }
  const spec = appState.languages.find((l) => l.id === langId);
  return spec ? spec.label : 'JavaScript';
}

function getConfiguredCustomDomain() {
  const cfg = appState.config || {};
  const sub = String(cfg.subdomain || '').trim();
  const root = String(cfg.rootDomain || '').trim();
  if (sub && root) return `${sub}.${root}`;
  if (root) return root;
  return '';
}

function getDisplayHost() {
  const custom = getConfiguredCustomDomain();
  if (custom) return custom;
  const cfg = appState.config || {};
  const ip = cfg.localIp || 'localhost';
  const port = cfg.publicPort || 27715;
  return `${ip}:${port}`;
}

function getWorkerPrimaryPublishingLink(w) {
  if (!w) return '/worker';
  return String(w.publishingLink || `/${w.name}`).trim() || `/${w.name}`;
}

function getWorkerPrimaryPublishingPath(w) {
  if (!w) return '/worker';
  if (w.publishingPath) return w.publishingPath;
  const raw = getWorkerPrimaryPublishingLink(w);
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname.replace(/\*+$/, '').replace(/\/+$/, '') || '/';
    } catch (_) {}
  }
  if (!raw.startsWith('/')) {
    const idx = raw.indexOf('/');
    if (idx !== -1 && (raw.slice(0, idx).includes('.') || raw.slice(0, idx).includes(':'))) {
      return raw.slice(idx).replace(/\*+$/, '').replace(/\/+$/, '') || '/';
    }
    return `/${raw.replace(/^\/+/, '').replace(/\*+$/, '').replace(/\/+$/, '')}`;
  }
  return raw.replace(/\*+$/, '').replace(/\/+$/, '') || '/';
}

function getAllWorkerPublishingLinks(w) {
  if (!w) return [];
  const primary = getWorkerPrimaryPublishingLink(w);
  const primaryPath = getWorkerPrimaryPublishingPath(w);
  const extra = Array.isArray(w.customRoutes)
    ? w.customRoutes.map((r) => ({
        id: r.id,
        label: r.pattern || r.path,
        href: r.path || (String(r.pattern || '').startsWith('/') ? r.pattern : `/${w.name}`),
        isPrimary: false
      }))
    : [];
  return [
    { id: 'primary', label: primary, href: primaryPath, isPrimary: true },
    ...extra
  ];
}

// ============================================================================
// State Synchronization & Dashboard HTTP Request Client IP Detection
// ============================================================================
function formatRuntimeName(rt) {
  if (!rt || String(rt).toLowerCase() === 'workerd') return 'Robo Workers';
  return String(rt);
}

async function fetchAppState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    appState.config = data.config || {};
    appState.runtimeInfo = data.runtimeInfo || {};
    appState.systemTelemetry = data.systemTelemetry || data.runtimeInfo || {};
    appState.languages = data.languages || [];
    appState.clientDevice = data.clientDevice || {};
    appState.storageFiles = data.storageFiles || [];
    appState.editorPreferences = data.editorPreferences || appState.editorPreferences;

    appState.workers = {};
    for (const w of data.workers || []) {
      appState.workers[w.name] = w;
      if (!appState.activeFileByWorker[w.name]) {
        appState.activeFileByWorker[w.name] = w.filename || (w.files && w.files[0]?.name) || 'worker.js';
      } else if (Array.isArray(w.files) && w.files.length > 0) {
        const exists = w.files.some((f) => f.name === appState.activeFileByWorker[w.name]);
        if (!exists) {
          appState.activeFileByWorker[w.name] = w.filename || w.files[0].name;
        }
      }
    }

    if (data.activeWorker && appState.workers[data.activeWorker]) {
      appState.activeWorker = data.activeWorker;
    } else {
      appState.activeWorker = Object.keys(appState.workers)[0] || '';
    }

    // Preserve any live unsaved buffer in #codeEditor so a background state poll never clobbers edits
    if (hasUnsavedEditorChanges || autoSaveTimer) {
      syncEditorBufferToMemory();
    }
  } catch (err) {
    console.warn('State sync warning:', err);
  }

  renderAll();
}

async function refreshDashboardClientIpFromHttp() {
  try {
    const res = await fetch('/api/client-ip');
    const data = await res.json();
    if (data.ok && data.clientDevice) {
      appState.clientDevice = data.clientDevice;
      addNotification(`Determined client IP from HTTP request: ${data.clientDevice.ip}`);
      renderAll();
    }
  } catch (_) {}
}

function getActiveWorkerObj() {
  return appState.workers[appState.activeWorker] || Object.values(appState.workers)[0];
}

function getLanguageSpec(langId) {
  const normalized = window.normalizeLangId ? window.normalizeLangId(langId) : (langId || 'javascript');
  const found = appState.languages.find((l) => l.id === normalized || l.id === langId);
  if (found) {
    return {
      ...found,
      displayRuntime: formatRuntimeName(found.runtime)
    };
  }
  const label = getLangDisplayName(normalized);
  const ext = (window.VSCODE_EXT_MAP && Object.keys(window.VSCODE_EXT_MAP).find((k) => window.VSCODE_EXT_MAP[k] === normalized)) || 'js';
  return {
    id: normalized,
    label,
    badge: ext.toUpperCase().slice(0, 4),
    ext,
    runtime: 'workerd',
    displayRuntime: 'Robo Workers',
    defaultFile: `worker.${ext}`
  };
}

// ============================================================================
// View & Sub-Tab Navigation
// ============================================================================
function switchView(viewName) {
  if (appState.currentView === 'editor' && viewName !== 'editor') {
    syncEditorBufferToMemory();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    saveActiveWorkerToStorage({ deploy: false });
  }
  appState.currentView = viewName;

  const isEditor = viewName === 'editor';
  // Hide top global header (including HTTP Client IP badge) when in Editor so Client IP is Dashboard-only
  // and Quick Edit has a single clean topbar without stacked duplicate headers.
  const globalHeader = el('cfGlobalHeader');
  if (globalHeader) {
    globalHeader.classList.toggle('hidden', isEditor);
  }

  el('dashboardShell').classList.toggle('hidden', isEditor);
  el('viewEditor').classList.toggle('hidden', !isEditor);

  const viewsMap = {
    applications: 'viewApplications',
    detail: 'viewDetail',
    records: 'viewRecords',
    websites: 'viewWebsites',
    analytics: 'viewAnalytics',
    storage: 'viewStorage',
    plans: 'viewPlans'
  };

  if (!isEditor) {
    for (const [k, domId] of Object.entries(viewsMap)) {
      const node = el(domId);
      if (node) node.classList.toggle('hidden', k !== viewName);
    }
  }

  document.querySelectorAll('.cf-side-item').forEach((btn) => {
    const isWorkersSection = ['applications', 'detail', 'storage', 'plans'].includes(viewName);
    if (btn.id === 'sideWorkersPagesBtn') {
      btn.classList.toggle('active', isWorkersSection);
    } else {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    }
  });

  document.querySelectorAll('.cf-side-subitem').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  const w = getActiveWorkerObj();
  if (viewName === 'applications') {
    document.title = 'Workers & Pages · Overview';
    renderApplicationsView();
  } else if (viewName === 'detail') {
    document.title = `${w ? w.name : 'Worker'} · Details`;
    renderDetailView();
  } else if (viewName === 'records') {
    document.title = 'Public links · Tunnel & DNS';
    renderRecordsView();
  } else if (viewName === 'websites') {
    document.title = 'Websites & Proxy';
    renderWebsitesView();
  } else if (viewName === 'analytics') {
    document.title = 'Analytics & Logs';
    renderAnalyticsView();
  } else if (viewName === 'storage') {
    document.title = 'Local Storage & KV';
    renderStorageView();
  } else if (viewName === 'plans') {
    document.title = 'Plans & Runtimes';
    renderPlansView();
  } else if (viewName === 'editor') {
    document.title = `${w ? w.name : 'worker'} · Quick Edit`;
    renderEditorView();
  }
}

function switchDetailSubtab(subtabName) {
  appState.currentDetailSubtab = subtabName;
  const subtabMap = {
    overview: 'subpaneOverview',
    metrics: 'subpaneMetrics',
    deployments: 'subpaneDeployments',
    observability: 'subpaneObservability',
    issues: 'subpaneIssues',
    domains: 'subpaneDomains',
    access: 'subpaneAccess',
    bindings: 'subpaneBindings',
    settings: 'subpaneSettings'
  };

  for (const [k, domId] of Object.entries(subtabMap)) {
    const pane = el(domId);
    if (pane) pane.classList.toggle('hidden', k !== subtabName);
  }

  document.querySelectorAll('#detailSubtabsBar .cf-subtab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.subtab === subtabName);
  });

  renderDetailView();
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return 'just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000));
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function computePercentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function buildMiniSparklineSvg(points, color = '#111111') {
  const nums = Array.isArray(points) && points.length > 0 ? points : [0];
  if (nums.every((v) => v === 0)) {
    return `<svg class="cf-sparkline" viewBox="0 0 120 34" preserveAspectRatio="none">
      <line x1="0" y1="30" x2="120" y2="30" stroke="#cbd5e1" stroke-width="2"></line>
    </svg>`;
  }
  const vals = nums.length === 1 ? [nums[0] * 0.7, nums[0], nums[0] * 0.9, nums[0]] : nums.slice(-12);
  const maxVal = Math.max(...vals, 1);
  const minVal = Math.min(...vals, 0);
  const span = Math.max(1, maxVal - minVal);
  const coords = vals.map((v, i) => {
    const x = Math.round((i / Math.max(1, vals.length - 1)) * 120);
    const y = Math.round(28 - ((v - minVal) / span) * 22);
    return `${x},${y}`;
  });
  const polyPoints = coords.join(' ');
  const areaPath = `M0,32 L${coords.join(' L')} L120,32 Z`;
  return `<svg class="cf-sparkline" viewBox="0 0 120 34" preserveAspectRatio="none">
    <path d="${areaPath}" fill="rgba(17,17,17,0.08)"></path>
    <polyline fill="none" stroke="${color}" stroke-width="2" points="${polyPoints}"></polyline>
  </svg>`;
}

// ============================================================================
// Render Functions for All 8 Pages
// ============================================================================
function renderAll() {
  const displayHost = getDisplayHost();
  if (el('detectedIpText')) {
    el('detectedIpText').textContent = appState.clientDevice.ip || '127.0.0.1';
  }
  if (el('sidebarDomainLabel')) {
    el('sidebarDomainLabel').textContent = displayHost;
  }

  const dnsDot = el('navDnsDot');
  if (dnsDot) {
    dnsDot.className = 'nav-status-dot';
    if (appState.config.dnsRecordStatus === 'verified') dnsDot.classList.add('verified');
    else if (appState.config.dnsRecordStatus === 'pending') dnsDot.classList.add('pending');
  }

  const steps = [
    renderWorkerDropdown,
    renderApplicationsView,
    renderDetailView,
    renderEditorView,
    renderRecordsView,
    renderWebsitesView,
    renderAnalyticsView,
    renderStorageView,
    renderPlansView
  ];
  for (const step of steps) {
    try {
      step();
    } catch (err) {
      console.error(`Error in ${step.name}:`, err);
    }
  }
}

function renderWorkerDropdown() {
  const select = el('workerSelect');
  if (!select) return;
  select.innerHTML = '';
  const names = Object.keys(appState.workers).sort();
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (/${name})`;
    if (name === appState.activeWorker) opt.selected = true;
    select.appendChild(opt);
  }
}

// 1. Workers & Pages -> Overview (Dashboard with HTTP Request Client IP)
function renderApplicationsView() {
  const allWorkers = Object.values(appState.workers);
  const customDomain = getConfiguredCustomDomain();
  const displayHost = getDisplayHost();
  const totalReqs = allWorkers.reduce((sum, w) => sum + (w.requestsToday ?? w.requests ?? 0), 0);
  const reqsTodayLabel = `${totalReqs} Request${totalReqs === 1 ? '' : 's'} made today`;

  el('statWorkerCount').textContent = String(allWorkers.length);
  el('statTotalRequests').textContent = String(totalReqs);
  if (el('statRequestsTodayFoot')) {
    el('statRequestsTodayFoot').textContent = reqsTodayLabel;
  }
  el('statClientIp').textContent = appState.clientDevice.ip || '127.0.0.1';
  el('statClientDevice').textContent = `HTTP Request · ${appState.clientDevice.os || 'Linux'} · ${appState.clientDevice.browser || 'Browser'}`;

  el('asideRequestsToday').textContent = reqsTodayLabel;
  el('asideWorkerTotal').textContent = `${allWorkers.length} worker${allWorkers.length === 1 ? '' : 's'}`;
  el('statPublicHostname').textContent = customDomain || displayHost;
  el('asideClientIpCode').textContent = appState.clientDevice.ip || '127.0.0.1';
  const hintEl = el('asideClientIpHint');
  if (hintEl) {
    hintEl.textContent = `Determined from HTTP request (${appState.clientDevice.os || 'Linux'} / ${appState.clientDevice.browser || 'Browser'})`;
  }

  const searchQuery = (el('workerSearchInput')?.value || '').trim().toLowerCase();
  const filterBy = el('workerFilterSelect')?.value || 'all';
  const sortBy = el('workerSortSelect')?.value || 'updated';

  const filtered = allWorkers.filter((w) => {
    const langSpec = getLanguageSpec(w.language);
    if (searchQuery) {
      const hay = `${w.name} ${langSpec.label} ${langSpec.runtime} ${w.filename} ${w.publishingLink || ''}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    if (filterBy === 'workerd' && langSpec.runtime !== 'workerd') return false;
    if (filterBy === 'python' && w.language !== 'python') return false;
    if (filterBy === 'shell' && w.language !== 'shellscript' && w.language !== 'shell') return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'requests') return (b.requests || 0) - (a.requests || 0);
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });

  el('appsListCountBadge').textContent = `Showing ${filtered.length} of ${allWorkers.length} application${allWorkers.length === 1 ? '' : 's'}`;

  const container = el('workersListContainer');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="card"><p class="card-desc">No matching workers found. Click "Create application" to create a new worker action.</p></div>`;
    return;
  }

  container.innerHTML = filtered
    .map((w) => {
      const langSpec = getLanguageSpec(w.language);
      const langLogo = getLangLogoHtml(w.language);
      const pubLink = getWorkerPrimaryPublishingLink(w);
      const pubPath = getWorkerPrimaryPublishingPath(w);
      const allLinks = getAllWorkerPublishingLinks(w);
      const wReqsToday = w.requestsToday ?? w.requests ?? 0;
      const lastDeployed = w.updatedAt ? new Date(w.updatedAt).toLocaleTimeString() : 'just now';
      const dur = w.lastDurationMs ? `${w.lastDurationMs} ms` : '1.8 ms';
      return `
      <div class="cf-worker-card">
        <div class="cf-worker-card-body">
          <div class="cf-worker-card-left">
            <div class="cf-worker-title-line">
              ${langLogo}
              <button type="button" class="cf-worker-name-btn" onclick="openWorkerDetail('${w.name}')">
                ${escapeHtml(w.name)}
              </button>
              <span class="cf-plan-pill">${escapeHtml(langSpec.label)}</span>
              <span style="font-size:12px;color:var(--text-secondary);">${wReqsToday} Request${wReqsToday === 1 ? '' : 's'} made today</span>
            </div>
            <div class="cf-worker-submeta">
              <span><i class="fa-solid fa-circle-check" style="color:#15803d;"></i> production</span>
              <span>·</span>
              <span>${escapeHtml(formatRuntimeName(langSpec.runtime))}</span>
              <span>·</span>
              <code>storage/workers/${escapeHtml(w.name)}/${escapeHtml(w.filename)}</code>
            </div>
            <div class="cf-worker-route-url">
              Publishing Link${allLinks.length > 1 ? 's' : ''}:
              ${allLinks
                .map(
                  (lnk) =>
                    `<a href="${escapeHtml(lnk.href)}" target="_blank" rel="noopener" style="color:#111111;font-weight:600;margin-right:8px;">${escapeHtml(lnk.label)}</a>`
                )
                .join('')}
              <button type="button" class="btn-outline btn-xs" style="height:22px;padding:0 8px;font-size:11px;" onclick="openWorkerPublishLinksEditor('${escapeHtml(w.name)}')">
                <i class="fa-solid fa-link"></i> Choose link
              </button>
            </div>
          </div>

          <div class="cf-worker-card-right">
            <a href="${escapeHtml(pubPath)}" target="_blank" rel="noopener" class="btn-outline btn-xs">
              <span>Visit Link</span>
              <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
            <div class="cf-card-stats-cluster">
              <div class="cf-stat-col">
                <span class="cf-stat-col-head">Requests today</span>
                <span class="cf-stat-col-val">${wReqsToday}</span>
              </div>
              <div class="cf-stat-col">
                <span class="cf-stat-col-head">Errors</span>
                <span class="cf-stat-col-val">${w.errors || 0}</span>
              </div>
              <div class="cf-stat-col">
                <span class="cf-stat-col-head">Execution</span>
                <span class="cf-stat-col-val">${dur}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="cf-worker-card-footer">
          <div class="cf-footer-left">
            <span class="cf-prod-badge">Production</span>
            <span class="cf-rev-code"><i class="fa-solid fa-code-branch"></i> rev ${escapeHtml(w.deployId || '00000000')}</span>
            <span style="color:#15803d;"><i class="fa-solid fa-floppy-disk"></i> Auto-saved ${lastDeployed}</span>
          </div>
          <div class="cf-footer-right">
            <button type="button" class="btn-black btn-xs" onclick="openWorkerInEditor('${w.name}')">
              <i class="fa-solid fa-code"></i> Edit code
            </button>
            <button type="button" class="btn-outline btn-xs" onclick="openWorkerDetail('${w.name}')">
              <i class="fa-solid fa-sliders"></i> Details
            </button>
            <button type="button" class="btn-outline btn-xs" onclick="promptRenameWorker('${w.name}')">
              <i class="fa-solid fa-pen"></i> Edit / Link
            </button>
            <button type="button" class="btn-outline btn-xs" style="color:#b91c1c;" onclick="deleteWorkerByName('${w.name}')">
              <i class="fa-solid fa-trash"></i> Delete
            </button>
          </div>
        </div>
      </div>
    `;
    })
    .join('');
}

// 2. Worker Detail View (Real Telemetry & Chosen Publishing Links)
function renderDetailView() {
  const w = getActiveWorkerObj();
  if (!w) return;
  const langSpec = getLanguageSpec(w.language);
  const customDomain = getConfiguredCustomDomain();
  const displayHost = getDisplayHost();
  const primaryLink = getWorkerPrimaryPublishingLink(w);
  const primaryPath = getWorkerPrimaryPublishingPath(w);
  const allLinks = getAllWorkerPublishingLinks(w);
  const wReqsToday = w.requestsToday ?? w.requests ?? 0;
  const reqsTodayLabel = `${wReqsToday} Request${wReqsToday === 1 ? '' : 's'} made today`;
  const invocations = Array.isArray(w.invocations) ? w.invocations : [];
  const files = Array.isArray(w.files) && w.files.length > 0 ? w.files : [{ name: w.filename || 'worker.js', sizeBytes: w.sizeBytes || 0, language: w.language }];
  const deployments = Array.isArray(w.deployments) ? w.deployments : [];
  const latestDeploy = deployments[0] || { id: w.deployId || '00000000', timestamp: w.updatedAt, author: appState.config.username || 'admin', source: 'Manually deployed' };
  const bindingEntries = Object.entries(w.bindings || {});

  const cpuUsList = invocations.map((i) => i.cpuUs || 900);
  const wallMsList = invocations.map((i) => i.wallMs || i.durationMs || 1.4);
  const lastCpuUs = w.lastCpuUs || (cpuUsList.length ? cpuUsList[cpuUsList.length - 1] : 967);
  const cpuDisplay = lastCpuUs < 1000 ? `${lastCpuUs} µs` : `${(lastCpuUs / 1000).toFixed(2)} ms`;
  const durDisplay = w.lastDurationMs ? `${w.lastDurationMs} ms` : '1.4 ms';

  el('detailWorkerNameTitle').textContent = w.name;
  el('detailVisitBtn').href = primaryPath;
  el('bindingNodeWorkerName').textContent = w.name;
  el('bindingRuntimeText').textContent = `${langSpec.label} (${formatRuntimeName(langSpec.runtime)})`;
  if (el('archRequestsTodayText')) {
    el('archRequestsTodayText').textContent = reqsTodayLabel;
  }

  // Overview Subtab
  const liveLink = el('overviewLiveUrlLink');
  if (liveLink) {
    liveLink.href = primaryPath;
    liveLink.textContent = primaryLink;
  }
  if (el('overviewRequestsTodayBadge')) {
    el('overviewRequestsTodayBadge').textContent = reqsTodayLabel;
  }
  if (el('overviewPrimaryPublishInput') && document.activeElement !== el('overviewPrimaryPublishInput')) {
    el('overviewPrimaryPublishInput').value = primaryLink;
  }
  if (el('overviewPublishLinksChips')) {
    el('overviewPublishLinksChips').innerHTML = allLinks
      .map(
        (lnk) => `
        <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:999px;font-family:var(--font-mono);font-size:12px;">
          <a href="${escapeHtml(lnk.href)}" target="_blank" rel="noopener" style="color:#111111;text-decoration:none;font-weight:600;">${escapeHtml(lnk.label)}</a>
          ${
            lnk.isPrimary
              ? `<span style="font-size:10px;color:#15803d;font-family:var(--font-sans);">primary</span>`
              : `<button type="button" class="explorer-icon-btn" style="width:18px;height:18px;" onclick="removeWorkerCustomRoute('${escapeHtml(lnk.id)}')" title="Remove link"><i class="fa-solid fa-xmark"></i></button>`
          }
        </span>`
      )
      .join('');
  }

  const authorTime = el('overviewDeployAuthorTime');
  if (authorTime) {
    authorTime.textContent = `by ${latestDeploy.author || 'admin'} · ${formatRelativeTime(latestDeploy.timestamp || w.updatedAt)}`;
  }

  if (el('archDomainsCount')) el('archDomainsCount').textContent = String(allLinks.length);
  if (el('archDomainsSub')) el('archDomainsSub').textContent = allLinks.map((l) => l.label).join(', ');
  if (el('archFilesCount')) el('archFilesCount').textContent = String(files.length);
  if (el('archFilesSub')) el('archFilesSub').textContent = files.map((f) => f.name).join(', ');
  if (el('archBindingsCount')) el('archBindingsCount').textContent = String(bindingEntries.length);
  if (el('overviewStoragePathCode')) el('overviewStoragePathCode').textContent = `/home/user/storage/workers/${w.name}/`;
  if (el('overviewCurlWorkerSlug')) el('overviewCurlWorkerSlug').textContent = primaryPath.replace(/^\/+/, '') || w.name;

  const archBindingsList = el('archBindingsItemsList');
  if (archBindingsList) {
    if (bindingEntries.length === 0) {
      archBindingsList.innerHTML = `<div style="color:var(--text-muted);">No bindings added</div>`;
    } else {
      archBindingsList.innerHTML = bindingEntries
        .slice(0, 5)
        .map(([k]) => `<div><i class="fa-solid fa-key"></i> env.${escapeHtml(k)}</div>`)
        .join('');
    }
  }

  el('detailMetricRequests').textContent = String(wReqsToday);
  if (el('detailMetricReqTrend')) el('detailMetricReqTrend').textContent = reqsTodayLabel;
  el('detailMetricErrors').textContent = String(w.errors || 0);
  el('detailMetricCpu').textContent = cpuDisplay;
  if (el('overviewSparkInvocations')) {
    el('overviewSparkInvocations').innerHTML = buildMiniSparklineSvg(
      invocations.length ? invocations.map((_, idx) => idx + 1) : [wReqsToday]
    );
  }
  if (el('overviewSparkCpu')) {
    el('overviewSparkCpu').innerHTML = buildMiniSparklineSvg(cpuUsList.length ? cpuUsList : [lastCpuUs]);
  }
  if (el('overviewSparkErrors')) {
    el('overviewSparkErrors').innerHTML = buildMiniSparklineSvg(
      invocations.map((i) => (i.status >= 500 ? 1 : 0)),
      '#dc2626'
    );
  }

  const renderDeployRowsHtml = (list) =>
    list
      .map((d) => {
        const isCurrent = d.id === w.deployId;
        return `
      <div class="cf-deploy-item-row">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap;">
          <span style="color:${isCurrent ? '#16a34a' : '#94a3b8'};font-size:11px;" title="${isCurrent ? 'Active Version' : 'Historical Version'}">
            <i class="fa-solid ${isCurrent ? 'fa-circle-dot' : 'fa-circle'}"></i>
          </span>
          <code class="cf-deploy-hash-pill">${escapeHtml(d.id)}</code>
          <button type="button" class="explorer-icon-btn" onclick="copyTextToClipboard('${escapeHtml(d.id)}')" title="Copy Version ID">
            <i class="fa-regular fa-copy"></i>
          </button>
          <span>${escapeHtml(d.source || 'Manually deployed')}</span>
          <span style="color:var(--text-muted);font-family:var(--font-mono);font-size:11.5px;">(${escapeHtml(d.filename || w.filename)} · ${d.sizeBytes || w.sizeBytes || 0} B)</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="cf-ready-dot"><i class="fa-solid fa-circle" style="font-size:7px;"></i> ${isCurrent ? 'Active (100%)' : 'Stored'}</span>
          <span class="cf-plan-pill">Dashboard</span>
          <span style="color:var(--text-secondary);">by ${escapeHtml(d.author || 'admin')}</span>
          <span style="color:var(--text-muted);min-width:65px;text-align:right;">${formatRelativeTime(d.timestamp)}</span>
          ${
            !isCurrent
              ? `<button type="button" class="btn-black btn-xs" onclick="rollbackWorkerVersion('${escapeHtml(d.id)}')" title="Rollback to version ${escapeHtml(d.id)}">
                  <i class="fa-solid fa-rotate-left"></i> Rollback
                </button>`
              : ''
          }
          <button type="button" class="btn-outline btn-xs" onclick="openWorkerInEditor('${escapeHtml(w.name)}')">
            <i class="fa-solid fa-code"></i> Edit
          </button>
        </div>
      </div>
    `;
      })
      .join('');

  if (el('overviewDeploymentsList')) {
    el('overviewDeploymentsList').innerHTML = renderDeployRowsHtml(deployments.slice(0, 5));
  }

  if (el('overviewDomainsSummary')) {
    el('overviewDomainsSummary').innerHTML = `
      <div class="cf-domains-mini-row">
        <span style="color:var(--text-secondary);">Primary Publishing Link</span>
        <a href="${escapeHtml(primaryPath)}" target="_blank" rel="noopener" style="font-family:var(--font-mono);font-weight:600;color:#111111;">${escapeHtml(primaryLink)}</a>
      </div>
      ${allLinks
        .filter((l) => !l.isPrimary)
        .map(
          (l) => `
      <div class="cf-domains-mini-row">
        <span style="color:var(--text-secondary);">Additional Link</span>
        <a href="${escapeHtml(l.href)}" target="_blank" rel="noopener" style="font-family:var(--font-mono);font-weight:600;color:#111111;">${escapeHtml(l.label)}</a>
      </div>`
        )
        .join('')}
      <div class="cf-domains-mini-row">
        <span style="color:var(--text-secondary);">Local Host</span>
        <code>http://${escapeHtml(displayHost)}${escapeHtml(primaryPath)}</code>
      </div>
    `;
  }

  if (el('stepPublicUrlText')) {
    el('stepPublicUrlText').textContent = primaryLink;
  }

  // Subtab 2: Metrics (Matches Screenshot 2 with Real Hardware & Invocation Data)
  const sixStrip = el('metricsSixSummaryStrip');
  if (sixStrip) {
    sixStrip.innerHTML = `
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label">Requests</span>
        <strong class="cf-metric-mini-val">${w.requests || 0}</strong>
        ${buildMiniSparklineSvg(invocations.map((_, i) => i + 1))}
      </div>
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label">Subrequests</span>
        <strong class="cf-metric-mini-val">${w.subrequests || 0}</strong>
        ${buildMiniSparklineSvg([0])}
      </div>
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label">Errors</span>
        <strong class="cf-metric-mini-val">${w.errors || 0}</strong>
        ${buildMiniSparklineSvg(invocations.map((i) => (i.status >= 500 ? 1 : 0)), '#dc2626')}
      </div>
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label">CPU Time</span>
        <strong class="cf-metric-mini-val">${cpuDisplay}</strong>
        ${buildMiniSparklineSvg(cpuUsList.length ? cpuUsList : [lastCpuUs])}
      </div>
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label">Wall Time</span>
        <strong class="cf-metric-mini-val">${durDisplay}</strong>
        ${buildMiniSparklineSvg(wallMsList.length ? wallMsList : [w.lastDurationMs || 1.4])}
      </div>
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label">Request Duration</span>
        <strong class="cf-metric-mini-val">${durDisplay}</strong>
        ${buildMiniSparklineSvg(wallMsList.length ? wallMsList : [w.lastDurationMs || 1.4])}
      </div>
    `;
  }

  const activeDeployCardHtml = `
    <div style="padding:16px 20px;">
      <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:10px;">Active deployment</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:14px;align-items:center;">
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Version ID</div>
          <code class="cf-deploy-hash-pill">* ${escapeHtml(w.deployId || '00000000')}</code>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Deployed</div>
          <strong style="font-size:13px;">${formatRelativeTime(w.updatedAt)}</strong>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Traffic %</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="cf-progress-track" style="flex:1;margin:0;"><div class="cf-progress-fill" style="width:100%;"></div></div>
            <strong style="font-size:12.5px;">100%</strong>
          </div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Files in Worker</div>
          <strong style="font-size:13px;">${files.length} (${w.sizeBytes || 0} B)</strong>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Error rate</div>
          <strong style="font-size:13px;">${w.requests ? (((w.errors || 0) / w.requests) * 100).toFixed(1) : 0}%</strong>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);">Median CPU time</div>
          <strong style="font-size:13px;">${cpuDisplay}</strong>
        </div>
      </div>
    </div>
  `;

  if (el('metricsActiveDeploymentBar')) el('metricsActiveDeploymentBar').innerHTML = activeDeployCardHtml;
  if (el('deploymentsActiveCard')) el('deploymentsActiveCard').innerHTML = activeDeployCardHtml;

  const p50Cpu = computePercentile(cpuUsList.length ? cpuUsList : [lastCpuUs], 50);
  const p75Cpu = computePercentile(cpuUsList.length ? cpuUsList : [lastCpuUs], 75);
  const p99Cpu = computePercentile(cpuUsList.length ? cpuUsList : [lastCpuUs], 99);
  const p50Wall = computePercentile(wallMsList.length ? wallMsList : [w.lastDurationMs || 1.4], 50);
  const p75Wall = computePercentile(wallMsList.length ? wallMsList : [w.lastDurationMs || 1.4], 75);
  const p99Wall = computePercentile(wallMsList.length ? wallMsList : [w.lastDurationMs || 1.4], 99);
  const sys = appState.systemTelemetry || {};

  const verFilterEl = el('metricsVersionFilterSelect');
  if (verFilterEl) {
    const prevVal = verFilterEl.value || 'all';
    verFilterEl.innerHTML =
      `<option value="all">All deployed versions (${deployments.length})</option>` +
      deployments
        .map(
          (d) =>
            `<option value="${escapeHtml(d.id)}" ${d.id === prevVal ? 'selected' : ''}>Version ${escapeHtml(d.id)}${d.id === w.deployId ? ' (Active)' : ''}</option>`
        )
        .join('');
  }

  const selectedVer = verFilterEl ? verFilterEl.value : 'all';
  const filteredInvocations =
    selectedVer && selectedVer !== 'all'
      ? invocations.filter((inv) => inv.versionId === selectedVer)
      : invocations;

  // Build real client IP breakdown from invocations
  const ipCounts = {};
  for (const inv of filteredInvocations) {
    const key = `${inv.clientIp || appState.clientDevice.ip || '127.0.0.1'} (${inv.os || 'Linux'} / ${inv.browser || 'Browser'})`;
    ipCounts[key] = (ipCounts[key] || 0) + 1;
  }
  if (Object.keys(ipCounts).length === 0) {
    const d = appState.clientDevice || {};
    ipCounts[`${d.ip || '127.0.0.1'} (${d.os || 'Linux'} / ${d.browser || 'Browser'})`] = w.requests || 1;
  }

  const totalDiskBytes = files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);
  const totalServedBytes =
    w.totalBytesServed ||
    filteredInvocations.reduce((sum, inv) => sum + (inv.responseBytes || 540), 0) ||
    (w.requests || 1) * 540;

  const metricsBoxes = el('detailMetricsBoxes');
  if (metricsBoxes) {
    metricsBoxes.innerHTML = `
      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Requests</span>
          <div class="cf-chart-legend"><span>${escapeHtml(reqsTodayLabel)}</span><span>Errors: ${w.errors || 0}</span></div>
        </div>
        ${buildMiniSparklineSvg(filteredInvocations.length ? filteredInvocations.map((_, i) => i + 1) : [wReqsToday || 1])}
        <div style="font-size:12px;color:var(--text-secondary);">Last run: ${w.lastRunAt ? new Date(w.lastRunAt).toLocaleTimeString() : 'Ready'} · 100% served from local storage</div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Invocations by Outcome</span>
          <div class="cf-chart-legend"><span>OK: ${Math.max(0, (w.requests || 0) - (w.errors || 0))}</span><span>Error: ${w.errors || 0}</span></div>
        </div>
        ${buildMiniSparklineSvg(filteredInvocations.length ? filteredInvocations.map((inv) => (inv.status < 500 ? 1 : 0)) : [1], '#16a34a')}
        <div style="font-size:12px;color:var(--text-secondary);">Outcome distribution across all invocations</div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Errors by Type</span>
          <div class="cf-chart-legend"><span>${w.errors || 0} total</span></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
          <div style="padding:8px 10px;background:var(--bg-subtle);border-radius:8px;">Exceeded Memory: <strong>0</strong></div>
          <div style="padding:8px 10px;background:var(--bg-subtle);border-radius:8px;">Exceeded CPU Limit: <strong>0</strong></div>
          <div style="padding:8px 10px;background:var(--bg-subtle);border-radius:8px;">Client Disconnected: <strong>0</strong></div>
          <div style="padding:8px 10px;background:var(--bg-subtle);border-radius:8px;">Script Exceptions: <strong>${w.errors || 0}</strong></div>
        </div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Errors by Invocation Status</span>
          <div class="cf-chart-legend"><span>2xx: ${filteredInvocations.filter((i) => i.status < 400).length || w.requests || 0}</span><span>5xx: ${w.errors || 0}</span></div>
        </div>
        ${buildMiniSparklineSvg(filteredInvocations.map((i) => (i.status >= 500 ? 1 : 0)), '#dc2626')}
        <div style="font-size:12px;color:var(--text-secondary);">HTTP status distribution from Robo Workers</div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>CPU Time per Execution</span>
          <div class="cf-chart-legend"><span>P50: ${p50Cpu} µs</span><span>P75: ${p75Cpu} µs</span><span>P99: ${p99Cpu} µs</span></div>
        </div>
        ${buildMiniSparklineSvg(cpuUsList.length ? cpuUsList : [lastCpuUs])}
        <div style="font-size:12px;color:var(--text-secondary);">Measured high-resolution execution time in <code>${escapeHtml(formatRuntimeName(langSpec.runtime))}</code></div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Wall Time per Execution</span>
          <div class="cf-chart-legend"><span>P50: ${p50Wall} ms</span><span>P75: ${p75Wall} ms</span><span>P99: ${p99Wall} ms</span></div>
        </div>
        ${buildMiniSparklineSvg(wallMsList.length ? wallMsList : [w.lastDurationMs || 1.4])}
        <div style="font-size:12px;color:var(--text-secondary);">Total wall-clock time per worker invocation</div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Request Duration</span>
          <div class="cf-chart-legend"><span>P50: ${p50Wall} ms</span><span>P75: ${p75Wall} ms</span><span>P99: ${p99Wall} ms</span></div>
        </div>
        ${buildMiniSparklineSvg(wallMsList.length ? wallMsList : [w.lastDurationMs || 1.4])}
        <div style="font-size:12px;color:var(--text-secondary);">End-to-end HTTP request duration through Nginx port ${(appState.config && appState.config.publicPort) || 27715}</div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Memory Usage &amp; Host Hardware</span>
          <div class="cf-chart-legend"><span>Worker RSS: ${sys.workerMemoryMb || 42} MB</span></div>
        </div>
        ${buildMiniSparklineSvg(filteredInvocations.map((i) => i.memoryMb || sys.workerMemoryMb || 42))}
        <div style="font-size:12px;color:var(--text-secondary);">Host RAM: ${sys.memoryUsedMb || 0} MB / ${sys.memoryTotalMb || 0} MB (${escapeHtml(sys.arch || 'linux')} · ${sys.cpus || 1} CPU cores)</div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Subrequests &amp; Storage Module Reads</span>
          <div class="cf-chart-legend"><span>Files in env.FILES: ${files.length}</span></div>
        </div>
        ${buildMiniSparklineSvg(filteredInvocations.length ? filteredInvocations.map(() => files.length) : [files.length])}
        <div style="font-size:12px;color:var(--text-secondary);">Every run pulls ${files.length} file${files.length === 1 ? '' : 's'} (${totalDiskBytes} B) fresh from <code>/home/user/storage/workers/${escapeHtml(w.name)}/</code></div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Subrequests by Storage Mode</span>
          <div class="cf-chart-legend"><span>Fresh Disk Pull: 100%</span><span>Stale Cache: 0%</span></div>
        </div>
        ${buildMiniSparklineSvg([100, 100, 100, 100], '#0284c7')}
        <div style="font-size:12px;color:var(--text-secondary);">Zero stale caching — code is read directly from local disk on every execution</div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Request Distribution (Real HTTP Client IPs)</span>
          <span class="cf-chart-legend">Live Nginx Proxy</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
          ${Object.entries(ipCounts)
            .slice(0, 4)
            .map(
              ([label, cnt]) =>
                `<div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--bg-subtle);border-radius:8px;">
                  <code>${escapeHtml(label)}</code>
                  <strong>${cnt} req</strong>
                </div>`
            )
            .join('')}
        </div>
      </div>

      <div class="cf-chart-card">
        <div class="cf-chart-head">
          <span>Response Bandwidth &amp; Disk Footprint</span>
          <div class="cf-chart-legend"><span>Served: ${(totalServedBytes / 1024).toFixed(2)} KB</span><span>Disk: ${totalDiskBytes} B</span></div>
        </div>
        ${buildMiniSparklineSvg(filteredInvocations.length ? filteredInvocations.map((inv) => inv.responseBytes || 540) : [totalServedBytes])}
        <div style="font-size:12px;color:var(--text-secondary);">Last response payload: ${w.lastResponseBytes || 540} bytes · Stored files: ${files.map((f) => escapeHtml(f.name)).join(', ')}</div>
      </div>
    `;
  }

  // Subtab 3: Deployments (Screenshot 3)
  const deploymentsList = el('detailDeploymentsList');
  if (deploymentsList) {
    deploymentsList.innerHTML = renderDeployRowsHtml(deployments);
  }

  // Subtab 4: Observability (Screenshot 4)
  const obsType = el('obsTypeFilterSelect')?.value || 'all';
  const obsQuery = (el('obsQuerySearchInput')?.value || '').trim().toLowerCase();
  const obsLegend = el('obsEventsLegend');
  if (obsLegend) {
    obsLegend.innerHTML = `
      <span style="color:#16a34a;font-weight:600;"><i class="fa-solid fa-circle" style="font-size:7px;"></i> ${w.requests || 0} Success</span>
      <span style="color:#dc2626;font-weight:600;"><i class="fa-solid fa-circle" style="font-size:7px;"></i> ${w.errors || 0} Errors</span>
    `;
  }
  const obsTimeline = el('obsEventsTimelineChart');
  if (obsTimeline) {
    obsTimeline.innerHTML = buildMiniSparklineSvg(
      invocations.length ? invocations.map((inv) => inv.cpuUs || 500) : [w.requests || 1]
    );
  }

  const obsContainer = el('detailObservabilityLogs');
  if (obsContainer) {
    let combinedEvents = [];
    if (obsType === 'all' || obsType === 'invocations') {
      for (const inv of invocations) {
        combinedEvents.push({
          timestamp: inv.timestamp,
          level: inv.status >= 500 ? 'error' : 'info',
          message: `[${inv.status}] ${inv.method} ${inv.path} · Client IP ${inv.clientIp} (${inv.os || 'Linux'} / ${inv.browser || 'Browser'}) · CPU ${inv.cpuUs} µs · Wall ${inv.durationMs} ms · rev ${inv.versionId}`,
          rawJson: inv
        });
      }
    }
    if (obsType === 'all' || obsType === 'logs') {
      for (const l of w.logs || []) {
        combinedEvents.push({
          ...l,
          rawJson: l
        });
      }
    }
    combinedEvents.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    if (obsQuery) {
      combinedEvents = combinedEvents.filter((ev) =>
        `${ev.level} ${ev.message} ${JSON.stringify(ev.rawJson || {})}`.toLowerCase().includes(obsQuery)
      );
    }
    obsContainer.innerHTML = combinedEvents.length
      ? combinedEvents
          .map((ev, i) => {
            const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '';
            const lvl = (ev.level || 'info').toLowerCase();
            const detailId = `obs-ev-detail-${i}`;
            const jsonPretty = JSON.stringify(ev.rawJson || ev, null, 2);
            return `<div class="obs-expandable-row" style="border-bottom:1px solid #f1f5f9;">
              <div class="log-row" style="cursor:pointer;" onclick="const d=document.getElementById('${detailId}'); if(d) d.classList.toggle('hidden');">
                <span class="log-time"><i class="fa-solid fa-caret-right" style="margin-right:5px;color:#64748b;"></i>${escapeHtml(time)}</span>
                <span class="log-level ${escapeHtml(lvl)}">${escapeHtml(lvl)}</span>
                <span>${escapeHtml(ev.message)}</span>
              </div>
              <pre id="${detailId}" class="hidden" style="margin:4px 0 10px 24px;padding:10px 12px;background:#f8fafc;border:1px solid var(--border-color);border-radius:8px;font-family:var(--font-mono);font-size:11.5px;white-space:pre-wrap;overflow-wrap:anywhere;">${escapeHtml(jsonPretty)}</pre>
            </div>`;
          })
          .join('')
      : buildLogsHtml([], w.name);
  }

  // Subtab 5: Issues (Screenshots 5 & 6)
  renderDetailIssuesSubtab(w);

  // Subtab 6: Domains (Screenshot 7)
  renderDetailDomainsSubtab(w, displayHost, primaryLink);

  // Subtab 7: Bindings
  const bindingsList = el('detailBindingsList');
  if (bindingsList) {
    const fileItemsHtml = files
      .map(
        (f) => `
      <div class="action-path-item">
        <div class="action-path-urls">
          <span class="action-path-slug">${getLangLogoHtml(f.language)} env.FILES["${escapeHtml(f.name)}"]</span>
          <span class="action-path-sub">Local Storage File · ${f.sizeBytes || 0} bytes · Auto-synced into Robo Workers</span>
        </div>
        <button type="button" class="btn-outline btn-xs" onclick="openWorkerFileInEditor('${escapeHtml(w.name)}', '${escapeHtml(f.name)}')">
          <i class="fa-solid fa-code"></i> Edit File
        </button>
      </div>
    `
      )
      .join('');

    const envItemsHtml = bindingEntries
      .map(
        ([k, v]) => `
      <div class="action-path-item">
        <div class="action-path-urls">
          <span class="action-path-slug"><i class="fa-solid fa-key"></i> env.${escapeHtml(k)}</span>
          <span class="action-path-sub">Environment Variable · Value: <code>${escapeHtml(String(v))}</code></span>
        </div>
        <button type="button" class="btn-outline btn-xs" onclick="removeWorkerBinding('${escapeHtml(k)}')">
          <i class="fa-solid fa-trash"></i> Remove
        </button>
      </div>
    `
      )
      .join('');

    bindingsList.innerHTML = fileItemsHtml + envItemsHtml;
  }

  // Subtab 8: Settings (Screenshot 8)
  const settingsVarsWrap = el('settingsVarsTableWrap');
  if (settingsVarsWrap) {
    if (bindingEntries.length === 0) {
      settingsVarsWrap.innerHTML = `<p class="card-desc">No runtime variables configured.</p>`;
    } else {
      settingsVarsWrap.innerHTML = `<div class="action-paths-list">${bindingEntries
        .map(
          ([k, v]) => `
        <div class="action-path-item">
          <div class="action-path-urls">
            <span class="action-path-slug"><code>${escapeHtml(k)}</code> <span class="cf-plan-pill">Plaintext</span></span>
            <span class="action-path-sub">Value: <code>${escapeHtml(String(v))}</code></span>
          </div>
          <button type="button" class="btn-outline btn-xs" onclick="removeWorkerBinding('${escapeHtml(k)}')">
            <i class="fa-solid fa-trash"></i> Delete
          </button>
        </div>`
        )
        .join('')}</div>`;
    }
  }

  const settingsBindingsWrap = el('settingsBindingsSummaryWrap');
  if (settingsBindingsWrap) {
    settingsBindingsWrap.innerHTML = `
      <div class="action-paths-list">
        <div class="action-path-item">
          <div class="action-path-urls">
            <span class="action-path-slug"><i class="fa-regular fa-folder-open"></i> Local Disk Multi-File Storage (<code>env.FILES</code>)</span>
            <span class="action-path-sub">${files.length} file${files.length === 1 ? '' : 's'} in <code>/home/user/storage/workers/${escapeHtml(w.name)}/</code> (${files.map((f) => escapeHtml(f.name)).join(', ')})</span>
          </div>
          <span class="cf-plan-pill">Connected</span>
        </div>
        <div class="action-path-item">
          <div class="action-path-urls">
            <span class="action-path-slug"><i class="fa-solid fa-microchip"></i> Live System Telemetry (<code>env.SYSTEM_INFO</code>)</span>
            <span class="action-path-sub">Host: ${escapeHtml(sys.hostname || 'local')} · ${sys.cpus || 1} CPUs · ${sys.memoryTotalMb || 0} MB RAM</span>
          </div>
          <span class="cf-plan-pill">Connected</span>
        </div>
      </div>
    `;
  }

  const logsToggle = el('settingLogsToggle');
  if (logsToggle) logsToggle.checked = !w.observabilityConfig || w.observabilityConfig.logsEnabled !== false;
  const issuesToggle = el('settingIssuesToggle');
  if (issuesToggle) issuesToggle.checked = w.issueDetectionEnabled !== false;

  const renameInp = el('detailSettingRenameInput');
  if (renameInp && document.activeElement !== renameInp) {
    renameInp.value = w.name;
  }
  const langSel = el('detailSettingLangSelect');
  if (langSel) {
    const allLangs = window.VSCODE_LANGS || appState.languages.map((l) => [l.label, l.id]);
    langSel.innerHTML = allLangs
      .map(
        ([label, id]) =>
          `<option value="${id}" ${id === w.language ? 'selected' : ''}>${escapeHtml(label)} (${escapeHtml(id)})</option>`
      )
      .join('');
  }
}

function renderDetailIssuesSubtab(w) {
  const container = el('detailIssuesContainer');
  if (!container) return;

  if (w.issueDetectionEnabled === false) {
    // Matches Screenshot 5: Enable Issue detection card
    container.innerHTML = `
      <div class="cf-card" style="padding:48px 24px;text-align:center;">
        <div style="width:48px;height:48px;margin:0 auto 14px;border-radius:12px;background:#eff6ff;color:#1d4ed8;display:flex;align-items:center;justify-content:center;font-size:22px;">
          <i class="fa-solid fa-bug"></i>
        </div>
        <h2 style="font-size:18px;font-weight:600;margin-bottom:8px;">Enable Issue detection</h2>
        <p style="font-size:13px;color:var(--text-secondary);max-width:460px;margin:0 auto 18px;line-height:1.55;">
          Track exceptions, errors, and runtime failures across all files in <code>${escapeHtml(w.name)}</code>, making recurring failures easy to inspect and resolve.
        </p>
        <button type="button" class="btn-black" onclick="toggleWorkerIssueDetection(true)">
          <i class="fa-solid fa-check"></i> Enable issues
        </button>
      </div>
    `;
    return;
  }

  // Matches Screenshot 6: Active Issues view
  const allIssues = Array.isArray(w.issues) ? w.issues : [];
  const activeIssues = allIssues.filter((i) => i.status !== 'resolved');
  const resolvedIssues = allIssues.filter((i) => i.status === 'resolved');
  const activeOccurrences = activeIssues.reduce((sum, i) => sum + (i.occurrences || 1), 0);
  const latestOccurrence = allIssues[0]?.lastSeen ? formatRelativeTime(allIssues[0].lastSeen) : '-';

  const filteredIssues =
    appState.issuesFilterStatus === 'resolved'
      ? resolvedIssues
      : appState.issuesFilterStatus === 'all'
      ? allIssues
      : activeIssues;

  container.innerHTML = `
    <div class="cf-obs-filter-bar" style="margin-bottom:14px;">
      <select class="cf-select" style="width:150px;" onchange="appState.issuesFilterStatus=this.value;renderDetailView();">
        <option value="active" ${appState.issuesFilterStatus === 'active' ? 'selected' : ''}>Active (${activeIssues.length})</option>
        <option value="resolved" ${appState.issuesFilterStatus === 'resolved' ? 'selected' : ''}>Resolved (${resolvedIssues.length})</option>
        <option value="all" ${appState.issuesFilterStatus === 'all' ? 'selected' : ''}>All (${allIssues.length})</option>
      </select>
      <div style="margin-left:auto;display:flex;gap:8px;">
        <button type="button" class="btn-outline btn-sm" onclick="fetchAppState()">
          <i class="fa-solid fa-rotate"></i> Refresh
        </button>
        <button type="button" class="btn-outline btn-sm" onclick="toggleWorkerIssueDetection(false)">
          Disable Issue Detection
        </button>
      </div>
    </div>

    <div class="cf-card" style="margin-bottom:16px;padding:16px 20px;">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;">
        <div>
          <div style="font-size:12px;color:var(--text-secondary);">Latest occurrence</div>
          <strong style="font-size:20px;">${escapeHtml(latestOccurrence)}</strong>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-secondary);">Active issues</div>
          <strong style="font-size:20px;">${activeIssues.length}</strong>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-secondary);">Active occurrences</div>
          <strong style="font-size:20px;">${activeOccurrences}</strong>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-secondary);">Resolved issues</div>
          <strong style="font-size:20px;">${resolvedIssues.length}</strong>
        </div>
      </div>
    </div>

    <div class="cf-card" style="padding:24px;">
      ${
        filteredIssues.length === 0
          ? `<div style="text-align:center;padding:24px 0;color:var(--text-secondary);">
              <i class="fa-solid fa-magnifying-glass" style="font-size:20px;margin-bottom:8px;display:block;color:var(--text-muted);"></i>
              <strong>No issues match this status</strong>
              <p style="font-size:12.5px;margin-top:4px;">Your worker is running cleanly with 0 unhandled exceptions.</p>
            </div>`
          : `<div class="action-paths-list">${filteredIssues
              .map(
                (iss) => `
              <div class="action-path-item">
                <div class="action-path-urls">
                  <span class="action-path-slug" style="color:#dc2626;"><i class="fa-solid fa-bug"></i> ${escapeHtml(iss.title)}</span>
                  <span class="action-path-sub">File: <code>${escapeHtml(iss.filename || w.filename)}</code> · Occurrences: ${iss.occurrences || 1} · Last seen: ${formatRelativeTime(iss.lastSeen)}</span>
                </div>
                ${
                  iss.status !== 'resolved'
                    ? `<button type="button" class="btn-black btn-xs" onclick="resolveWorkerIssue('${escapeHtml(iss.id)}')">Resolve</button>`
                    : `<span class="cf-plan-pill">Resolved</span>`
                }
              </div>`
              )
              .join('')}</div>`
      }
    </div>
  `;
}

function renderDetailDomainsSubtab(w, displayHost) {
  const container = el('detailDomainsContainer');
  if (!container) return;
  const primaryLink = getWorkerPrimaryPublishingLink(w);
  const primaryPath = getWorkerPrimaryPublishingPath(w);
  const customRoutes = Array.isArray(w.customRoutes) ? w.customRoutes : [];

  container.innerHTML = `
    <div class="cf-card" style="padding:20px 22px;margin-bottom:18px;">
      <div class="cf-card-head-row" style="padding:0 0 12px 0;margin-bottom:12px;">
        <div>
          <h3 class="cf-settings-card-title">Primary Publishing Link</h3>
          <p class="cf-settings-card-desc">Choose the primary publishing link (path or full URL) where <code>${escapeHtml(w.name)}</code> is served.</p>
        </div>
        <a href="${escapeHtml(primaryPath)}" target="_blank" rel="noopener" class="btn-outline btn-xs">
          <span>Open ${escapeHtml(primaryLink)}</span>
          <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </a>
      </div>

      <form onsubmit="event.preventDefault(); savePrimaryPublishingLinkFromDomains();" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <input
          type="text"
          id="domainsPrimaryPublishInput"
          value="${escapeHtml(primaryLink)}"
          placeholder="e.g. /${escapeHtml(w.name)}, /ipdata, or https://example.com/ipdata"
          style="flex:1;min-width:220px;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:10px;font-family:var(--font-mono);font-size:12.5px;"
          required
        />
        <button type="submit" class="btn-black btn-sm">
          <i class="fa-solid fa-check"></i> Save Primary Link
        </button>
      </form>

      <div class="cf-settings-kv-rows">
        <div class="cf-settings-kv-row">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <span class="cf-prod-badge">Active Link</span>
            <a href="${escapeHtml(primaryPath)}" target="_blank" rel="noopener" style="font-family:var(--font-mono);font-size:13px;color:#111111;font-weight:600;">${escapeHtml(primaryLink)}</a>
            <span style="font-size:12px;color:var(--text-muted);">(Local: <code>http://${escapeHtml(displayHost)}${escapeHtml(primaryPath)}</code>)</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <button type="button" class="btn-outline btn-xs" onclick="copyTextToClipboard('${escapeHtml(primaryLink)}')">
              <i class="fa-regular fa-copy"></i> Copy
            </button>
            <label class="cf-switch">
              <input type="checkbox" ${w.productionUrlEnabled !== false ? 'checked' : ''} onchange="toggleWorkerUrlState('productionUrlEnabled', this.checked)" />
              <span class="cf-slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <div class="cf-card" style="padding:20px 22px;">
      <div class="cf-card-head-row" style="padding:0 0 14px 0;margin-bottom:14px;">
        <div>
          <h3 class="cf-settings-card-title">Additional Publishing Links &amp; Custom Routes</h3>
          <p class="cf-settings-card-desc">Add any additional publishing links, custom paths, or domains that route directly to <code>${escapeHtml(w.name)}</code>.</p>
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-outline btn-sm" onclick="switchView('records')">
            <i class="fa-solid fa-link"></i> Tunnel DNS
          </button>
        </div>
      </div>

      <form onsubmit="event.preventDefault(); addWorkerCustomRoute();" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
        <input type="text" id="newRoutePatternInput" placeholder="e.g. /ipdata, /api/ip, or https://api.example.com/ipdata" style="flex:1;min-width:220px;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:10px;font-family:var(--font-mono);font-size:12.5px;" required />
        <select id="newRouteTypeSelect" class="cf-select" style="width:165px;height:36px;">
          <option value="Publishing Link">Publishing Link</option>
          <option value="Custom Domain">Custom Domain</option>
          <option value="Route">Route</option>
        </select>
        <button type="submit" class="btn-black btn-sm">
          <i class="fa-solid fa-plus"></i> Add Publishing Link
        </button>
      </form>

      <div class="action-paths-list">
        <div class="action-path-item">
          <div class="action-path-urls">
            <span class="action-path-slug"><a href="${escapeHtml(primaryPath)}" target="_blank" rel="noopener" style="color:#111111;text-decoration:none;"><code>${escapeHtml(primaryLink)}</code></a></span>
            <span class="action-path-sub">Primary Publishing Link · Local: <code>http://${escapeHtml(displayHost)}${escapeHtml(primaryPath)}</code></span>
          </div>
          <span class="cf-ready-dot"><i class="fa-solid fa-circle" style="font-size:7px;"></i> Active</span>
        </div>
        ${customRoutes
          .map((r) => {
            const rHref = r.path || (String(r.pattern || '').startsWith('/') ? r.pattern : `/${w.name}`);
            return `
          <div class="action-path-item">
            <div class="action-path-urls">
              <span class="action-path-slug"><a href="${escapeHtml(rHref)}" target="_blank" rel="noopener" style="color:#111111;text-decoration:none;"><code>${escapeHtml(r.pattern)}</code></a></span>
              <span class="action-path-sub">Type: ${escapeHtml(r.type || 'Publishing Link')} · Path: <code>${escapeHtml(rHref)}</code></span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
              <a href="${escapeHtml(rHref)}" target="_blank" rel="noopener" class="btn-outline btn-xs">Open</a>
              <button type="button" class="btn-outline btn-xs" onclick="removeWorkerCustomRoute('${escapeHtml(r.id)}')">
                <i class="fa-solid fa-trash"></i> Remove
              </button>
            </div>
          </div>`;
          })
          .join('')}
      </div>
    </div>
  `;
}

// 3. Quick Edit / VS Code Editor View (with Explorer Sidepanel, Multi-File CRUD & Devicon SVGs)
function getActiveFileObj(worker) {
  if (!worker) return null;
  const files = Array.isArray(worker.files) && worker.files.length > 0
    ? worker.files
    : [{ name: worker.filename || 'worker.js', content: worker.code || '', sizeBytes: (worker.code || '').length, language: worker.language || 'javascript' }];
  const desiredName = appState.activeFileByWorker[worker.name] || worker.filename || files[0].name;
  return files.find((f) => f.name === desiredName) || files[0];
}

function renderEditorView() {
  const worker = getActiveWorkerObj();
  if (!worker) {
    if (el('qeWorkerBreadcrumbName')) el('qeWorkerBreadcrumbName').textContent = 'No worker selected';
    if (el('qeWorkersDevLinkText')) el('qeWorkersDevLinkText').textContent = '/';
    if (el('wbSearchTitleText')) el('wbSearchTitleText').textContent = 'Robo Workers';
    if (el('explorerWorkerHeaderName')) el('explorerWorkerHeaderName').textContent = 'EXPLORER';
    if (el('explorerFilesList')) {
      el('explorerFilesList').innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--text-muted);">No workers yet. Click <strong>+</strong> to create one.</div>`;
    }
    if (el('editorFileTabs')) el('editorFileTabs').innerHTML = '';
    if (el('workerCountSummary')) el('workerCountSummary').textContent = '0 files · 0 workers';
    if (el('statusRuntimeText')) el('statusRuntimeText').textContent = 'Robo Workers';
    return;
  }

  const files = Array.isArray(worker.files) && worker.files.length > 0
    ? worker.files
    : [{ name: worker.filename || 'worker.js', content: worker.code || '', sizeBytes: (worker.code || '').length, language: worker.language || 'javascript' }];
  const activeFile = getActiveFileObj(worker);
  appState.activeFileByWorker[worker.name] = activeFile.name;

  const fileLanguage = activeFile.language || worker.language || 'javascript';
  const langSpec = getLanguageSpec(fileLanguage);
  const langLabelText = getLangDisplayName(fileLanguage);
  const langLogoHtml = getLangLogoHtml(fileLanguage);
  const workerNames = Object.keys(appState.workers).sort();
  const workerCount = workerNames.length;
  const primaryLink = getWorkerPrimaryPublishingLink(worker);
  const primaryPath = getWorkerPrimaryPublishingPath(worker);

  el('qeWorkerBreadcrumbName').textContent = worker.name;
  el('qeWorkersDevLink').href = primaryPath;
  el('qeWorkersDevLinkText').textContent = primaryLink;
  if (el('wbSearchTitleText')) {
    el('wbSearchTitleText').textContent = `${worker.name} — ${activeFile.name}`;
  }

  // Render Explorer Sidepanel (See, Create, Rename, Delete Files in Worker!)
  renderExplorerSidepanel(worker, files, activeFile);

  // Render Multi-File Editor Tabs for the Current Worker
  const tabsContainer = el('editorFileTabs');
  if (tabsContainer) {
    tabsContainer.innerHTML = files
      .map((f) => {
        const isCurrent = f.name === activeFile.name;
        const tabLogo = getLangLogoHtml(f.language || worker.language);
        const canDelete = files.length > 1;
        return `
          <div class="file-tab ${isCurrent ? 'active' : ''}" onclick="selectWorkerFile('${escapeHtml(f.name)}')" title="${escapeHtml(f.name)} (${f.sizeBytes || 0} B)">
            ${tabLogo}
            <span class="file-name">${escapeHtml(f.name)}</span>
            ${
              canDelete
                ? `<button type="button" class="file-tab-close" onclick="event.stopPropagation(); deleteWorkerFile('${escapeHtml(f.name)}');" title="Delete ${escapeHtml(f.name)}">×</button>`
                : ''
            }
          </div>
        `;
      })
      .join('');
  }

  el('workerCountSummary').textContent = `${files.length} file${files.length === 1 ? '' : 's'} · ${workerCount} worker${workerCount === 1 ? '' : 's'}`;

  // Render Breadcrumbs with SVG Language Icon
  const bcIcon = el('breadcrumbIcon');
  if (bcIcon) bcIcon.innerHTML = langLogoHtml;
  el('breadcrumbFile').textContent = activeFile.name;
  el('breadcrumbSymbol').textContent = `${worker.name} › ${langLabelText}`;

  el('deployVersionText').textContent = `${worker.deployId || '00000000'} (Active) Latest`;

  const codeEditor = el('codeEditor');
  const prevWorkerName = codeEditor.dataset.workerName;
  if (
    codeEditor.dataset.workerName !== worker.name ||
    codeEditor.dataset.fileName !== activeFile.name ||
    codeEditor.dataset.workerLang !== fileLanguage
  ) {
    codeEditor.value = activeFile.content !== undefined ? activeFile.content : worker.code || '';
    codeEditor.dataset.workerName = worker.name;
    codeEditor.dataset.fileName = activeFile.name;
    codeEditor.dataset.workerLang = fileLanguage;

    // Copy the exact /<worker> link URL from qeWorkersDevLink for the Preview & HTTP panes
    const liveWorkerUrl = el('qeWorkersDevLink').href;
    if (prevWorkerName !== worker.name || !el('httpUrlInput').value || el('httpUrlInput').value === '/worker') {
      el('httpUrlInput').value = primaryPath;
      if (el('previewUrlBadge')) el('previewUrlBadge').value = liveWorkerUrl;
      el('openRawEndpointLink').href = liveWorkerUrl;
      el('openRawEndpointLink').innerHTML = `Open ${escapeHtml(primaryLink)} <i class="fa-solid fa-arrow-up-right-from-square"></i>`;
      if (el('previewExternalLink')) el('previewExternalLink').href = liveWorkerUrl;
      const iframe = el('previewIframe');
      if (iframe && iframe.dataset.loadedUrl !== liveWorkerUrl) {
        iframe.src = liveWorkerUrl;
        iframe.dataset.loadedUrl = liveWorkerUrl;
      }
    }
  }

  codeEditor.style.tabSize = String(worker.spaces || 2);
  const hlPre = el('codeHighlight');
  if (hlPre) hlPre.style.tabSize = String(worker.spaces || 2);

  updateEditorHighlightAndLines();
  updateCursorPosition();
  runBasicDiagnostics(codeEditor.value, fileLanguage);
  renderExplorerOutlineAndTimeline(worker, activeFile, codeEditor.value);
  renderBottomPanel(worker);

  el('statusIndentBtn').textContent = worker.indentUsingTabs
    ? `Tab Size: ${worker.spaces || 4}`
    : `Spaces: ${worker.spaces || 2}`;
  el('statusEncodingBtn').textContent = worker.encoding || 'UTF-8';
  el('statusEolBtn').textContent = worker.eol || 'LF';

  const statusLangLogo = el('statusLangLogo');
  if (statusLangLogo) statusLangLogo.innerHTML = langLogoHtml;
  el('statusLangName').textContent = langLabelText;
  el('statusLayoutBtn').textContent = worker.layout || 'Layout: US';
  el('statusRuntimeText').textContent = formatRuntimeName(langSpec.runtime);

  renderConsoleLogs(worker);
}

function renderExplorerSidepanel(worker, files, activeFile) {
  const headerName = el('explorerWorkerHeaderName');
  if (headerName) {
    headerName.textContent = worker.name.toUpperCase();
  }

  const treeEl = el('explorerFilesList');
  if (!treeEl) return;

  treeEl.innerHTML = files
    .map((f) => {
      const isSelected = f.name === activeFile.name;
      const logo = getLangLogoHtml(f.language || worker.language);
      return `
        <div class="explorer-file-row ${isSelected ? 'active' : ''}" onclick="selectWorkerFile('${escapeHtml(f.name)}')">
          <div class="explorer-file-left">
            ${logo}
            <span class="explorer-file-name" title="${escapeHtml(f.name)} (${f.sizeBytes || 0} B)">${escapeHtml(f.name)}</span>
          </div>
          <div class="explorer-file-actions">
            <button type="button" class="explorer-row-act" onclick="event.stopPropagation(); duplicateWorkerFile('${escapeHtml(f.name)}');" title="Duplicate ${escapeHtml(f.name)}">
              <i class="fa-regular fa-copy"></i>
            </button>
            <button type="button" class="explorer-row-act" onclick="event.stopPropagation(); promptExplorerRenameFile('${escapeHtml(f.name)}');" title="Rename ${escapeHtml(f.name)}">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button type="button" class="explorer-row-act danger" onclick="event.stopPropagation(); deleteWorkerFile('${escapeHtml(f.name)}');" title="Delete ${escapeHtml(f.name)}">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderExplorerOutlineAndTimeline(worker, activeFile, codeText) {
  const outlineEl = el('explorerOutlineList');
  if (outlineEl) {
    const lines = String(codeText || '').split('\n');
    const symbols = [];
    lines.forEach((lnText, idx) => {
      const mFn = lnText.match(/\b(async\s+fetch|function\s+\w+|const\s+\w+|let\s+\w+|def\s+\w+|class\s+\w+)/);
      const mKey = lnText.match(/^\s*"([a-zA-Z0-9_-]+)"\s*:/);
      if (mFn) {
        symbols.push({ label: mFn[1].replace(/\s+/g, ' '), line: idx + 1 });
      } else if (mKey && symbols.length < 20) {
        symbols.push({ label: mKey[1], line: idx + 1 });
      }
    });
    if (symbols.length === 0) {
      outlineEl.innerHTML = `<div class="explorer-outline-item" style="color:var(--text-muted);">${escapeHtml(activeFile.name)} (Ln 1)</div>`;
    } else {
      outlineEl.innerHTML = symbols
        .slice(0, 18)
        .map(
          (s) => `
          <div class="explorer-outline-item" onclick="jumpEditorToLine(${s.line})">
            <i class="fa-solid fa-cube" style="font-size:10px;color:#0284c7;"></i>
            <span>${escapeHtml(s.label)}</span>
            <span style="margin-left:auto;color:var(--text-muted);font-size:10px;">:${s.line}</span>
          </div>`
        )
        .join('');
    }
  }

  const timelineEl = el('explorerTimelineList');
  if (timelineEl) {
    const deployments = Array.isArray(worker.deployments) ? worker.deployments : [];
    timelineEl.innerHTML = deployments
      .slice(0, 10)
      .map(
        (d) => `
        <div class="explorer-outline-item" title="${escapeHtml(d.source || 'Saved')}">
          <i class="fa-solid fa-code-commit" style="font-size:10px;color:#16a34a;"></i>
          <span>${escapeHtml(d.id)} · ${escapeHtml(d.filename || worker.filename)}</span>
          <span style="margin-left:auto;color:var(--text-muted);font-size:10px;">${formatRelativeTime(d.timestamp)}</span>
        </div>`
      )
      .join('');
  }
}

function renderBottomPanel(worker) {
  const bodyEl = el('bottomPanelBody');
  const termInputRow = el('bottomTerminalInputRow');
  if (!bodyEl || !worker) return;
  const filterQ = (el('bottomPanelFilterInput')?.value || '').trim().toLowerCase();

  if (termInputRow) {
    termInputRow.classList.toggle('hidden', appState.bottomPanelTab !== 'terminal');
  }

  if (appState.bottomPanelTab === 'problems') {
    if (appState.diagnostics.length === 0) {
      bodyEl.textContent = 'No problems have been detected in the workspace.';
    } else {
      bodyEl.textContent = appState.diagnostics
        .map((d) => `[${d.severity.toUpperCase()}] ${d.message}`)
        .join('\n');
    }
  } else if (appState.bottomPanelTab === 'terminal') {
    const files = (worker.files || []).map((f) => `${f.name} (${f.sizeBytes || 0}B)`).join('  ');
    const baseLines = [
      `robo-workers:/home/user/storage/workers/${worker.name}$ ls -la`,
      files || worker.filename,
      `robo-workers:/home/user/storage/workers/${worker.name}$ curl -i http://localhost:${(appState.config && appState.config.publicPort) || 27715}/${worker.name}`,
      `HTTP/1.1 ${appState.lastHttpStatus || 200} OK (${appState.lastHttpDurationMs || worker.lastDurationMs || 1} ms)`
    ];
    if (Array.isArray(appState.terminalHistory) && appState.terminalHistory.length > 0) {
      baseLines.push(...appState.terminalHistory);
    }
    bodyEl.textContent = baseLines.join('\n');
    bodyEl.scrollTop = bodyEl.scrollHeight;
  } else {
    // OUTPUT tab
    const logs = (worker.logs || []).filter(
      (l) => !filterQ || `${l.level} ${l.message}`.toLowerCase().includes(filterQ)
    );
    if (logs.length === 0) {
      bodyEl.textContent = `[Robo Workers] Worker "${worker.name}" synced with /home/user/storage/workers/${worker.name}/`;
    } else {
      bodyEl.textContent = logs
        .map((l) => `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.message}`)
        .join('\n');
    }
  }
}

function buildLogsHtml(logs, workerName) {
  if (!logs || logs.length === 0) {
    return `<div class="log-row"><span class="log-time">--:--:--</span><span class="log-level info">READY</span><span>Worker "${escapeHtml(workerName || 'worker')}" ready. Pulls code from local storage on run.</span></div>`;
  }
  return logs
    .map((entry) => {
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
      const lvl = (entry.level || 'log').toLowerCase();
      const rawMsg = String(entry.message || '');
      const prefix = entry.worker ? `[${entry.worker}]` : '';
      const hasPrefix = prefix && rawMsg.startsWith(prefix);
      const workerTag = prefix && !hasPrefix ? `${escapeHtml(prefix)} ` : '';
      return `<div class="log-row">
        <span class="log-time">${time}</span>
        <span class="log-level ${lvl}">${lvl}</span>
        <span>${workerTag}${escapeHtml(rawMsg)}</span>
      </div>`;
    })
    .join('');
}

function renderConsoleLogs(worker) {
  const container = el('consoleLogs');
  if (!container) return;
  const invocations = Array.isArray(worker?.invocations) ? worker.invocations : [];
  const logs = Array.isArray(worker?.logs) ? worker.logs : [];
  const origin = window.location.origin;

  if (invocations.length === 0 && logs.length === 0) {
    container.innerHTML = `<div class="console-http-req-row">
      <i class="fa-solid fa-caret-right console-caret"></i>
      <span class="console-time">${new Date().toLocaleTimeString('en-GB', { hour12: false })}</span>
      <span class="console-method">GET</span>
      <span class="console-url">${escapeHtml(origin)}/${escapeHtml(worker ? worker.name : 'worker')}</span>
    </div>`;
    return;
  }

  const invRows = invocations
    .slice()
    .reverse()
    .map((inv, idx) => {
      const t = inv.timestamp
        ? new Date(inv.timestamp).toLocaleTimeString('en-GB', { hour12: false })
        : '';
      const fullUrl = `${origin}${inv.path || '/' + (worker ? worker.name : 'worker')}`;
      const detailId = `console-inv-detail-${idx}`;
      return `<div style="border-bottom:1px solid #f1f5f9;">
        <div class="console-http-req-row" style="border-bottom:none;cursor:pointer;" onclick="const d=document.getElementById('${detailId}'); if(d) d.classList.toggle('hidden');" title="Click to inspect request telemetry">
          <i class="fa-solid fa-caret-right console-caret"></i>
          <span class="console-time">${escapeHtml(t)}</span>
          <span class="console-method">${escapeHtml(inv.method || 'GET')}</span>
          <span class="console-url">${escapeHtml(fullUrl)}</span>
        </div>
        <div id="${detailId}" class="hidden" style="padding:4px 12px 8px 24px;font-family:var(--font-mono);font-size:11px;color:#475569;background:#f8fafc;">
          Status: <strong>${inv.status || 200}</strong> · Client IP: <code>${escapeHtml(inv.clientIp || '127.0.0.1')}</code> (${escapeHtml(inv.os || 'Linux')} / ${escapeHtml(inv.browser || 'Browser')}) · CPU: <strong>${inv.cpuUs || 0} µs</strong> · Wall: <strong>${inv.durationMs || 0} ms</strong> · Rev: <code>${escapeHtml(inv.versionId || '')}</code>
        </div>
      </div>`;
    })
    .join('');

  const customLogRows = logs
    .filter((l) => !String(l.message || '').startsWith('[workerd:'))
    .slice(-15)
    .map((l) => {
      const t = l.timestamp
        ? new Date(l.timestamp).toLocaleTimeString('en-GB', { hour12: false })
        : '';
      return `<div class="log-row">
        <span class="log-time">${escapeHtml(t)}</span>
        <span class="log-level ${escapeHtml(l.level || 'log')}">${escapeHtml(l.level || 'log')}</span>
        <span>${escapeHtml(l.message || '')}</span>
      </div>`;
    })
    .join('');

  container.innerHTML = invRows + customLogRows;
  container.scrollTop = container.scrollHeight;
}

// 4. Public Links / Records & Tunnel View
function renderRecordsView() {
  const cfg = appState.config || {};
  const subdomain = String(cfg.subdomain || '').trim();
  const rootDomain = String(cfg.rootDomain || '').trim();
  const customDomain = getConfiguredCustomDomain();
  const localIp = cfg.localIp || '127.0.0.1';
  const port = cfg.publicPort || 27715;
  const tunnelId = cfg.tunnelId || '';
  const cnameTarget = tunnelId ? `${tunnelId}.cfargotunnel.com` : '<tunnel-id>.cfargotunnel.com';

  const statusBadge = el('dnsStatusBadge');
  const status = cfg.dnsRecordStatus || 'unchecked';
  statusBadge.textContent = status;
  statusBadge.className = `status-tag ${status}`;

  el('dnsStatusMessage').textContent =
    cfg.dnsCheckMessage || 'No custom domain configured yet. Enter a domain in Settings to check DNS records.';
  el('cnameSubdomainPreview').textContent = subdomain || '@';
  el('cnameTargetPreview').textContent = cnameTarget;
  el('openCloudflareDnsBtn').href = rootDomain
    ? `https://dash.cloudflare.com/?to=/:account/${rootDomain}/dns`
    : 'https://dash.cloudflare.com';

  el('kvPublicHostname').textContent = customDomain || 'not configured';
  el('kvTunnelId').textContent = tunnelId || 'not configured';
  el('kvConnectorInstalled').textContent = cfg.connectorInstalled ? 'installed' : 'not installed';
  el('kvConnectorRunning').textContent = cfg.connectorRunning ? 'yes' : 'no';
  el('kvService').textContent = `http://127.0.0.1:${port}`;
  el('kvLanTarget').textContent = `http://${localIp}:${port}`;

  el('tunnelHowtoPre').textContent = [
    `hostname: ${customDomain || 'not configured'}`,
    `service: http://127.0.0.1:${port}`,
    `network target: http://${localIp}:${port}`,
    `network CIDRs: ${cfg.networkCidrs || 'not configured'}`,
    `path rule: /*`,
    `zone: ${rootDomain || 'not configured'}`,
    `one tunnel record serves all paths`
  ].join('\n');

  const workerNames = Object.keys(appState.workers).sort();
  el('actionPathsCountBadge').textContent = String(workerNames.length);
  const pathsContainer = el('availableActionPathsList');
  if (workerNames.length === 0) {
    pathsContainer.textContent = 'No worker actions yet.';
  } else {
    pathsContainer.innerHTML = workerNames
      .map((name) => {
        const wObj = appState.workers[name];
        const logoHtml = getLangLogoHtml(wObj?.language);
        const primaryUrl = customDomain
          ? `https://${customDomain}/${name}`
          : `${window.location.origin}/${name}`;
        return `<div class="action-path-item">
          <div class="action-path-urls">
            <span class="action-path-slug">${logoHtml} /${escapeHtml(name)}</span>
            <span class="action-path-sub">Endpoint: ${escapeHtml(primaryUrl)} · LAN: http://${escapeHtml(localIp)}:${port}/${escapeHtml(name)}</span>
          </div>
          <div class="worker-row-actions">
            <a href="/${encodeURIComponent(name)}" target="_blank" rel="noopener" class="btn-outline btn-sm">
              <span>Open /${escapeHtml(name)}</span>
              <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
            <button type="button" class="btn-outline btn-sm" onclick="copyTextToClipboard('${escapeHtml(primaryUrl)}')">
              <i class="fa-regular fa-copy"></i> Copy URL
            </button>
            <button type="button" class="btn-black btn-sm" onclick="openWorkerInEditor('${escapeHtml(name)}')">
              <i class="fa-solid fa-code"></i> Edit code
            </button>
          </div>
        </div>`;
      })
      .join('');
  }

  if (document.activeElement !== el('settingSubdomain')) el('settingSubdomain').value = subdomain;
  if (document.activeElement !== el('settingRootDomain')) el('settingRootDomain').value = rootDomain;
  if (document.activeElement !== el('settingTunnelId')) el('settingTunnelId').value = tunnelId;
  if (document.activeElement !== el('settingTunnelToken')) el('settingTunnelToken').value = cfg.tunnelToken || '';
  if (document.activeElement !== el('settingLocalIp')) el('settingLocalIp').value = localIp;
  if (document.activeElement !== el('settingNetworkCidrs')) el('settingNetworkCidrs').value = cfg.networkCidrs || '';
}

// 5. Websites & Nginx Proxy View
function renderWebsitesView() {
  const d = appState.clientDevice || {};
  const cfg = appState.config || {};
  const displayHost = getDisplayHost();

  const clientList = el('websitesClientKvList');
  if (clientList) {
    clientList.innerHTML = `
      <div class="kv-row"><dt>Client IP (from HTTP Request)</dt><dd>${escapeHtml(d.ip || '127.0.0.1')}</dd></div>
      <div class="kv-row"><dt>X-Forwarded-For</dt><dd>${escapeHtml(d.forwardedFor || d.ip || '127.0.0.1')}</dd></div>
      <div class="kv-row"><dt>Operating System</dt><dd>${escapeHtml(d.os || 'Linux')}</dd></div>
      <div class="kv-row"><dt>Browser / Client</dt><dd>${escapeHtml(d.browser || 'Browser')}</dd></div>
      <div class="kv-row"><dt>Device Category</dt><dd>${escapeHtml(d.deviceType || 'Desktop')}</dd></div>
      <div class="kv-row"><dt>Accept-Language</dt><dd>${escapeHtml(d.language || 'en-US')}</dd></div>
    `;
  }

  const gatewayList = el('websitesGatewayKvList');
  if (gatewayList) {
    const pubPort = cfg.publicPort || 27715;
    const backPort = cfg.backendPort || 17156;
    gatewayList.innerHTML = `
      <div class="kv-row"><dt>Reverse Proxy</dt><dd>Nginx (:${pubPort} -> 127.0.0.1:${backPort})</dd></div>
      <div class="kv-row"><dt>Active Host</dt><dd>${escapeHtml(displayHost)}</dd></div>
      <div class="kv-row"><dt>HTTP Client-IP Headers</dt><dd>CF-Connecting-IP, X-Real-IP, X-Forwarded-For</dd></div>
      <div class="kv-row"><dt>CORS Cross-Page Policy</dt><dd>Access-Control-Allow-Origin: * (JSON)</dd></div>
      <div class="kv-row"><dt>Local Network Address</dt><dd>${escapeHtml(cfg.localIp || '127.0.0.1')}:${pubPort}</dd></div>
    `;
  }

  const routesList = el('websitesRoutesList');
  if (routesList) {
    const names = Object.keys(appState.workers).sort();
    routesList.innerHTML = names
      .map((name) => {
        const w = appState.workers[name];
        const langSpec = getLanguageSpec(w.language);
        const logoHtml = getLangLogoHtml(w.language);
        return `
        <div class="action-path-item">
          <div class="action-path-urls">
            <span class="action-path-slug">${logoHtml} /${escapeHtml(name)}</span>
            <span class="action-path-sub">${escapeHtml(langSpec.label)} (${escapeHtml(formatRuntimeName(langSpec.runtime))}) · ${w.requests || 0} requests served</span>
          </div>
          <div class="worker-row-actions">
            <a href="/${encodeURIComponent(name)}" target="_blank" rel="noopener" class="btn-outline btn-sm">
              <i class="fa-solid fa-arrow-up-right-from-square"></i> Test Route
            </a>
            <button type="button" class="btn-black btn-sm" onclick="openWorkerInEditor('${escapeHtml(name)}')">
              <i class="fa-solid fa-code"></i> Edit Code
            </button>
          </div>
        </div>
      `;
      })
      .join('');
  }
}

// 6. Analytics & Unified Logs View
function renderAnalyticsView() {
  const allWorkers = Object.values(appState.workers);
  const totalReqs = allWorkers.reduce((s, w) => s + (w.requests || 0), 0);
  const totalErrs = allWorkers.reduce((s, w) => s + (w.errors || 0), 0);

  let allLogs = [];
  for (const w of allWorkers) {
    for (const l of w.logs || []) {
      allLogs.push({ ...l, worker: w.name });
    }
  }
  allLogs.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  const cards = el('analyticsSummaryCards');
  if (cards) {
    cards.innerHTML = `
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label"><i class="fa-solid fa-bolt"></i> Total Requests</span>
        <strong class="cf-metric-mini-val">${totalReqs}</strong>
        <div class="cf-metric-mini-foot">Across ${allWorkers.length} workers</div>
      </div>
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label"><i class="fa-solid fa-circle-exclamation"></i> Total Errors</span>
        <strong class="cf-metric-mini-val">${totalErrs}</strong>
        <div class="cf-metric-mini-foot">100% uptime</div>
      </div>
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label"><i class="fa-solid fa-terminal"></i> Log Events</span>
        <strong class="cf-metric-mini-val">${allLogs.length}</strong>
        <div class="cf-metric-mini-foot">Stored on disk</div>
      </div>
      <div class="cf-metric-mini-card">
        <span class="cf-metric-mini-label"><i class="fa-solid fa-location-dot"></i> HTTP Client IP</span>
        <strong class="cf-metric-mini-val">${escapeHtml(appState.clientDevice.ip || '127.0.0.1')}</strong>
        <div class="cf-metric-mini-foot">${escapeHtml(appState.clientDevice.os || 'Linux')}</div>
      </div>
    `;
  }

  const filterQ = (el('analyticsLogFilterInput')?.value || '').trim().toLowerCase();
  if (filterQ) {
    allLogs = allLogs.filter((l) =>
      `${l.worker} ${l.level} ${l.message}`.toLowerCase().includes(filterQ)
    );
  }

  const logsBox = el('analyticsUnifiedLogs');
  if (logsBox) {
    logsBox.innerHTML = buildLogsHtml(allLogs, 'all-workers');
  }
}

// 7. Local Storage & KV Browser View
function renderStorageView() {
  const container = el('storageFilesContainer');
  if (!container) return;
  const files = appState.storageFiles || [];
  if (files.length === 0) {
    container.innerHTML = `<div class="card"><p class="card-desc">No files found in local storage.</p></div>`;
    return;
  }

  container.innerHTML = files
    .map(
      (f, idx) => `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-title-row" style="justify-content:space-between;">
        <div>
          <strong style="font-family:var(--font-mono);font-size:13.5px;"><i class="fa-regular fa-file-code"></i> /home/user/${escapeHtml(f.path)}</strong>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
            Category: ${escapeHtml(f.category)} · Size: ${f.sizeBytes} bytes · Last saved: ${new Date(f.updatedAt).toLocaleString()}
          </div>
        </div>
        <button type="button" class="btn-outline btn-xs" onclick="document.getElementById('filePreview_${idx}').classList.toggle('hidden')">
          <i class="fa-regular fa-eye"></i> Inspect Content
        </button>
      </div>
      <pre id="filePreview_${idx}" class="tunnel-howto-pre hidden" style="margin-top:12px;max-height:240px;overflow-y:auto;">${escapeHtml(f.preview)}</pre>
    </div>
  `
    )
    .join('');
}

// 8. System Runtimes View
function renderPlansView() {
  const rt = appState.runtimeInfo || {};
  const allWorkers = Object.values(appState.workers);
  const totalReqs = allWorkers.reduce((sum, w) => sum + (w.requestsToday ?? w.requests ?? 0), 0);
  if (el('plansRequestsTodayVal')) {
    el('plansRequestsTodayVal').textContent = `${totalReqs} Request${totalReqs === 1 ? '' : 's'} made today`;
  }
  if (el('plansWorkersCountVal')) {
    el('plansWorkersCountVal').textContent = `${allWorkers.length} worker${allWorkers.length === 1 ? '' : 's'}`;
  }
  const list = el('plansRuntimeKvList');
  if (!list) return;
  list.innerHTML = `
    <div class="kv-row"><dt>Robo Workers Engine</dt><dd>Active</dd></div>
    <div class="kv-row"><dt>Node.js Engine</dt><dd>${escapeHtml(rt.node || 'v20')}</dd></div>
    <div class="kv-row"><dt>Python 3 Runtime</dt><dd>${escapeHtml(rt.python || 'Python 3')}</dd></div>
    <div class="kv-row"><dt>Nginx Reverse Proxy</dt><dd>${escapeHtml(rt.nginx || 'nginx/1.26')}</dd></div>
    <div class="kv-row"><dt>Cloudflared Connector</dt><dd>${escapeHtml(rt.cloudflared || 'installed')}</dd></div>
    <div class="kv-row"><dt>Host Architecture</dt><dd>${escapeHtml(rt.platform || 'linux')} / ${escapeHtml(rt.arch || 'x64')}</dd></div>
  `;
}

// ============================================================================
// Editor Syntax Highlighting, Line Numbers & Instant Local Auto-Save
// ============================================================================
function updateEditorHighlightAndLines() {
  const textarea = el('codeEditor');
  const hlPre = el('codeHighlight');
  const lineNumbersEl = el('lineNumbers');
  if (!textarea) return;

  const worker = getActiveWorkerObj();
  const activeFile = getActiveFileObj(worker);
  const lang = (activeFile && activeFile.language) || (worker && worker.language) || 'javascript';
  const code = textarea.value || '';

  if (hlPre) {
    const highlighted =
      typeof window.vscodeHighlight === 'function'
        ? window.vscodeHighlight(code, lang)
        : escapeHtml(code);
    hlPre.innerHTML = highlighted + (code.endsWith('\n') ? ' ' : '');
  }

  if (lineNumbersEl) {
    const lines = code.split('\n');
    let html = '';
    for (let i = 1; i <= lines.length; i++) {
      html += `<span class="ln-row">${i}</span>`;
    }
    lineNumbersEl.innerHTML = html;
  }

  // Keep .code-stage and #codeEditor full-height so .code-editor-wrapper is the ONE scroll container
  if (hlPre) {
    const stage = textarea.parentElement;
    const contentHeight = Math.max(
      hlPre.scrollHeight || 0,
      lineNumbersEl ? lineNumbersEl.scrollHeight || 0 : 0,
      240
    );
    if (stage) stage.style.minHeight = `${contentHeight}px`;
    textarea.style.height = `${contentHeight}px`;
    if (textarea.scrollTop > 0) {
      const wrapper = stage ? stage.parentElement : null;
      if (wrapper) wrapper.scrollTop += textarea.scrollTop;
      textarea.scrollTop = 0;
    }
  }
}

function updateCursorPosition() {
  const textarea = el('codeEditor');
  if (!textarea) return;
  const pos = textarea.selectionStart || 0;
  const textUpToCursor = textarea.value.slice(0, pos);
  const lines = textUpToCursor.split('\n');
  const ln = lines.length;
  const col = lines[lines.length - 1].length + 1;
  el('statusCursorBtn').textContent = `Ln ${ln}, Col ${col}`;

  const gutter = el('lineNumbers');
  if (gutter) {
    gutter.querySelectorAll('.ln-row.cur').forEach((n) => n.classList.remove('cur'));
    const curRow = gutter.children[ln - 1];
    if (curRow) curRow.classList.add('cur');
  }
}

function formatActiveDocument() {
  const textarea = el('codeEditor');
  const worker = getActiveWorkerObj();
  if (!textarea || !worker) return;
  const activeFile = getActiveFileObj(worker);
  const lang = (activeFile && activeFile.language) || worker.language;

  let code = textarea.value;
  if (lang === 'json') {
    try {
      code = JSON.stringify(JSON.parse(code), null, worker.spaces || 2) + '\n';
    } catch (_) {}
  } else {
    const unit = worker.indentUsingTabs ? '\t' : ' '.repeat(worker.spaces || 2);
    code = code
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, '').replace(/^\t+/, (m) => unit.repeat(m.length)))
      .join('\n');
  }
  textarea.value = code;
  updateEditorHighlightAndLines();
  scheduleAutoSave();
  addNotification(`Formatted ${activeFile ? activeFile.name : worker.filename}`);
}

function runBasicDiagnostics(code, language) {
  const diagnostics = [];
  if (language === 'json') {
    try {
      JSON.parse(code);
    } catch (err) {
      diagnostics.push({ severity: 'error', message: `JSON Syntax: ${err.message}` });
    }
  } else if (language === 'javascript' || language === 'typescript') {
    const openBraces = (code.match(/\{/g) || []).length;
    const closeBraces = (code.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      diagnostics.push({
        severity: 'warning',
        message: `Unbalanced curly braces: ${openBraces} '{' vs ${closeBraces} '}'`
      });
    }
  }
  appState.diagnostics = diagnostics;
  el('errorCountText').textContent = String(diagnostics.filter((d) => d.severity === 'error').length);
  el('warnCountText').textContent = String(diagnostics.filter((d) => d.severity === 'warning').length);
}

function syncEditorBufferToMemory() {
  const codeEditor = el('codeEditor');
  if (!codeEditor) return;
  const boundWorkerName = codeEditor.dataset.workerName || appState.activeWorker;
  const w = appState.workers[boundWorkerName] || getActiveWorkerObj();
  if (!w) return;
  const boundFileName = codeEditor.dataset.fileName || appState.activeFileByWorker[w.name] || w.filename || 'worker.js';
  if (!boundFileName) return;

  const currentVal = codeEditor.value;
  if (Array.isArray(w.files)) {
    const fileEntry = w.files.find((f) => f.name === boundFileName);
    if (fileEntry) {
      fileEntry.content = currentVal;
      fileEntry.sizeBytes = currentVal.length;
    }
  }
  if (boundFileName === (w.filename || 'worker.js') || !w.files || w.files.length <= 1) {
    w.code = currentVal;
  }
}

async function saveActiveWorkerToStorage(options = {}) {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  syncEditorBufferToMemory();
  const worker = getActiveWorkerObj();
  if (!worker) return false;
  const activeFile = getActiveFileObj(worker);
  const currentFileName = (activeFile && activeFile.name) || worker.filename || 'worker.js';
  const isEntrypoint = currentFileName === (worker.filename || 'worker.js') || !worker.files || worker.files.length <= 1;
  const liveEditorVal =
    options.code !== undefined ? options.code : el('codeEditor') ? el('codeEditor').value : worker.code || '';
  const prevFilesSnapshot = Array.isArray(worker.files) ? worker.files.map((f) => ({ ...f })) : [];

  const pill = el('autosavePill');
  const pillText = el('autosaveText');
  if (pillText) pillText.textContent = 'Saving...';
  if (pill) pill.classList.add('saving');

  const isMetadataChange =
    options.language !== undefined ||
    options.spaces !== undefined ||
    options.indentUsingTabs !== undefined ||
    options.encoding !== undefined ||
    options.eol !== undefined ||
    options.layout !== undefined ||
    options.bindings !== undefined ||
    options.useLanguageTemplate;

  try {
    if (!isMetadataChange && !isEntrypoint) {
      // Save directly to the selected non-entrypoint file in the Explorer
      const res = await fetch(`/api/workers/${encodeURIComponent(worker.name)}/files`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: currentFileName,
          content: liveEditorVal,
          eol: worker.eol || 'LF',
          deploy: Boolean(options.deploy),
          deploySource: options.deploySource || `Saved ${currentFileName}`
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.ok && data.worker) {
        hasUnsavedEditorChanges = false;
        if (!Array.isArray(data.worker.files) || data.worker.files.length === 0) {
          data.worker.files = prevFilesSnapshot;
        }
        appState.workers[data.worker.name] = data.worker;
        renderAll();
        if (pillText) pillText.textContent = options.deploy ? 'Deployed to storage' : 'Saved to storage';
        if (pill) pill.classList.remove('saving');
        return true;
      }
      return false;
    }

    const payload = {
      code: isEntrypoint ? liveEditorVal : worker.code,
      targetFilename: currentFileName,
      targetFileContent: liveEditorVal,
      files: prevFilesSnapshot,
      language: options.language || worker.language,
      spaces: options.spaces !== undefined ? options.spaces : worker.spaces,
      indentUsingTabs:
        options.indentUsingTabs !== undefined ? options.indentUsingTabs : worker.indentUsingTabs,
      encoding: options.encoding || worker.encoding,
      eol: options.eol || worker.eol,
      layout: options.layout || worker.layout,
      bindings: options.bindings || worker.bindings,
      deploy: Boolean(options.deploy),
      deploySource: options.deploySource,
      useLanguageTemplate: Boolean(options.useLanguageTemplate)
    };

    const res = await fetch(`/api/workers/${encodeURIComponent(worker.name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && data.worker) {
      hasUnsavedEditorChanges = false;
      if (!Array.isArray(data.worker.files) || data.worker.files.length === 0) {
        data.worker.files = prevFilesSnapshot;
      }
      appState.workers[data.worker.name] = data.worker;
      if (options.useLanguageTemplate) {
        const updatedFileObj = getActiveFileObj(data.worker);
        el('codeEditor').value = updatedFileObj ? updatedFileObj.content : data.worker.code;
        el('codeEditor').dataset.workerLang = updatedFileObj?.language || data.worker.language;
        el('codeEditor').dataset.fileName = updatedFileObj ? updatedFileObj.name : data.worker.filename;
      }
      renderAll();
      if (pillText) pillText.textContent = options.deploy ? 'Deployed to storage' : 'Saved to storage';
      if (pill) pill.classList.remove('saving');
      return true;
    }
    return false;
  } catch (err) {
    if (pillText) pillText.textContent = 'Save error';
    return false;
  }
}

function scheduleAutoSave() {
  hasUnsavedEditorChanges = true;
  syncEditorBufferToMemory();
  const pill = el('autosavePill');
  const pillText = el('autosaveText');
  if (pillText) pillText.textContent = 'Unsaved changes...';
  if (pill) pill.classList.add('saving');
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveActiveWorkerToStorage({ deploy: false });
  }, 300);
}

// ============================================================================
// HTTP Runner & Live Preview Execution (Pulls Code from Storage on Run)
// ============================================================================
function getTargetPreviewUrlPath() {
  const worker = getActiveWorkerObj();
  if (!worker) return '/';
  const primaryPath = getWorkerPrimaryPublishingPath(worker);
  const badge = el('previewUrlBadge');
  if (badge && badge.dataset.userEditedWorker === worker.name && badge.value.trim()) {
    let raw = badge.value.trim();
    if (raw.startsWith(window.location.origin)) {
      raw = raw.slice(window.location.origin.length) || '/';
    } else if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        raw = u.pathname + u.search;
      } catch (_) {}
    }
    if (!raw.startsWith('/')) raw = `/${raw}`;
    return raw;
  }
  return primaryPath;
}

function updatePreviewPaneOutput() {
  const worker = getActiveWorkerObj();
  const iframe = el('previewIframe');
  if (!iframe || !worker) return;

  // Copy the exact /<worker> link logic from qeWorkersDevLink
  const primaryLink = getWorkerPrimaryPublishingLink(worker);
  const primaryPath = getWorkerPrimaryPublishingPath(worker);
  if (el('qeWorkersDevLink')) {
    el('qeWorkersDevLink').href = primaryPath;
    if (el('qeWorkersDevLinkText')) el('qeWorkersDevLinkText').textContent = primaryLink;
  }

  const badge = el('previewUrlBadge');
  let targetUrl = el('qeWorkersDevLink') ? el('qeWorkersDevLink').href : `${window.location.origin}${primaryPath}`;
  if (badge && badge.dataset.userEditedWorker === worker.name && badge.value.trim()) {
    const raw = badge.value.trim();
    if (/^https?:\/\//i.test(raw)) {
      targetUrl = raw;
    } else {
      targetUrl = `${window.location.origin}${raw.startsWith('/') ? raw : '/' + raw}`;
    }
  } else if (badge) {
    badge.value = targetUrl;
  }

  if (el('previewExternalLink')) {
    el('previewExternalLink').href = targetUrl;
  }

  let currentIframeHref = '';
  try {
    currentIframeHref =
      iframe.contentWindow && iframe.contentWindow.location ? iframe.contentWindow.location.href : '';
  } catch (_) {}

  if (currentIframeHref && currentIframeHref !== 'about:blank' && currentIframeHref === targetUrl) {
    try {
      iframe.contentWindow.location.reload();
      return;
    } catch (_) {}
  }

  iframe.dataset.loadedUrl = targetUrl;
  iframe.src = targetUrl;
}

async function executeCurrentWorkerHttpRequest(opts = {}) {
  const worker = getActiveWorkerObj();
  if (!worker) return;

  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (!opts.skipSave) {
    await saveActiveWorkerToStorage({ deploy: false });
  }

  const rawMethod = el('httpMethodSelect').value || 'GET';
  const method = rawMethod === 'QUERY' ? 'POST' : rawMethod;
  let urlPath = el('httpUrlInput').value.trim() || `/${worker.name}`;
  if (!urlPath.startsWith('/')) urlPath = `/${urlPath}`;

  const headers = {};
  for (const h of appState.customHeaders) {
    if (h.key && h.key.trim()) {
      headers[h.key.trim()] = h.value || '';
    }
  }

  const fetchOpts = { method, headers };
  if (['POST', 'PUT', 'PATCH', 'QUERY'].includes(rawMethod)) {
    const bodyText = el('httpRequestBody').value;
    if (bodyText) fetchOpts.body = bodyText;
  }

  el('httpResponseOutput').textContent = `Pulling ${worker.filename} from storage and running...`;
  const t0 = performance.now();

  try {
    const resp = await fetch(urlPath, fetchOpts);
    const elapsed = Math.max(1, Math.round(performance.now() - t0));
    const contentType = resp.headers.get('content-type') || 'text/plain';
    const rawText = await resp.text();

    appState.lastHttpRawResponse = rawText;
    appState.lastHttpContentType = contentType;
    appState.lastHttpStatus = resp.status;
    appState.lastHttpDurationMs = elapsed;

    const metaBar = el('httpResponseMeta');
    metaBar.classList.remove('hidden');
    const statusPill = el('httpStatusPill');
    statusPill.innerHTML = `<i class="fa-solid fa-circle" style="font-size:8px;margin-right:4px;"></i> ${resp.status}`;
    statusPill.className = `status-pill ${resp.status >= 400 ? 'error' : ''}`;
    el('httpDurationText').textContent = `${elapsed} ms`;
    el('httpContentTypeText').textContent = contentType.split(';')[0];
    el('openRawEndpointLink').href = urlPath;
    el('openRawEndpointLink').innerHTML = `Open ${escapeHtml(urlPath)} <i class="fa-solid fa-arrow-up-right-from-square"></i>`;

    // Render full HTTP Response Headers list (matching Screenshots 11 & 12)
    const headersBar = el('httpResponseHeadersBar');
    if (headersBar) {
      headersBar.classList.remove('hidden');
      const headerEntries = [];
      resp.headers.forEach((val, key) => {
        headerEntries.push([key, val]);
      });
      headersBar.innerHTML = headerEntries
        .map(
          ([k, v]) =>
            `<div class="http-resp-header-line"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</div>`
        )
        .join('');
    }

    const ctLower = contentType.toLowerCase();
    let formatted = rawText;
    let highlightLang = '';
    if (ctLower.includes('application/json')) {
      try {
        formatted = JSON.stringify(JSON.parse(rawText), null, 2);
        highlightLang = 'json';
      } catch (_) {}
    } else if (ctLower.includes('text/html')) {
      highlightLang = 'html';
    } else if (ctLower.includes('xml') || ctLower.includes('svg')) {
      highlightLang = 'xml';
    } else if (ctLower.includes('text/css')) {
      highlightLang = 'css';
    } else if (ctLower.includes('yaml')) {
      highlightLang = 'yaml';
    } else if (ctLower.includes('markdown')) {
      highlightLang = 'markdown';
    } else if (ctLower.includes('javascript')) {
      highlightLang = 'javascript';
    }

    if (highlightLang && typeof window.vscodeHighlight === 'function') {
      el('httpResponseOutput').innerHTML = window.vscodeHighlight(formatted, highlightLang);
    } else {
      el('httpResponseOutput').textContent = formatted;
    }

    updatePreviewPaneOutput();
    await fetchAppState();
  } catch (err) {
    el('httpResponseOutput').textContent = `Request failed: ${err.message}`;
  }
}

// ============================================================================
// Interactive VS Code Status Bar Pickers (with 72 Language SVG Icons!)
// ============================================================================
function openCommandPalette({ title, placeholder, showSearch = true, items, onSelect }) {
  const overlay = el('paletteOverlay');
  const titleEl = el('paletteTitle');
  const searchWrap = el('paletteSearchWrap');
  const searchInput = el('paletteSearchInput');
  const listEl = el('paletteList');

  titleEl.textContent = title;
  searchWrap.classList.toggle('hidden', !showSearch);
  searchInput.value = '';
  searchInput.placeholder = placeholder || 'Type to filter...';
  overlay.classList.remove('hidden');

  function renderItems(filterText = '') {
    const q = filterText.trim().toLowerCase();
    const filtered = items.filter(
      (item) =>
        !q ||
        item.label.toLowerCase().includes(q) ||
        (item.meta && item.meta.toLowerCase().includes(q)) ||
        (item.id && item.id.toLowerCase().includes(q))
    );

    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="padding:14px;color:#64748b;font-size:13px;">No matching results</div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map(
        (item, idx) => `
      <button type="button" class="palette-option ${item.active ? 'selected' : ''}" data-idx="${idx}">
        <span class="palette-option-left">
          ${item.iconHtml ? item.iconHtml : ''}
          <span>${escapeHtml(item.label)}</span>
        </span>
        <span class="palette-meta">${escapeHtml(item.meta || '')}</span>
      </button>
    `
      )
      .join('');

    listEl.querySelectorAll('.palette-option').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        overlay.classList.add('hidden');
        onSelect(filtered[i]);
      });
    });
  }

  renderItems('');
  searchInput.oninput = () => renderItems(searchInput.value);
  searchInput.onkeydown = (e) => {
    if (e.key === 'Escape') {
      overlay.classList.add('hidden');
    } else if (e.key === 'Enter') {
      const firstBtn = listEl.querySelector('.palette-option');
      if (firstBtn) firstBtn.click();
    }
  };
  if (showSearch) {
    setTimeout(() => searchInput.focus(), 20);
  }
}

function openLanguageModePicker() {
  const worker = getActiveWorkerObj();
  if (!worker) return;

  // All 72 languages from vscode.html with their embedded SVG logos!
  const vscodeLangList = window.VSCODE_LANGS || [
    ['JavaScript', 'javascript'],
    ['TypeScript', 'typescript'],
    ['Python', 'python'],
    ['Shell Script', 'shellscript'],
    ['JSON', 'json'],
    ['HTML', 'html'],
    ['CSS', 'css'],
    ['Go', 'go'],
    ['Rust', 'rust'],
    ['C', 'c'],
    ['C++', 'cpp'],
    ['PHP', 'php'],
    ['Ruby', 'ruby'],
    ['Lua', 'lua'],
    ['SQL', 'sql'],
    ['YAML', 'yaml'],
    ['Markdown', 'markdown'],
    ['Plain Text', 'plaintext']
  ];

  const items = vscodeLangList.map(([label, id]) => ({
    id,
    label,
    iconHtml: getLangLogoHtml(id),
    meta: id === worker.language ? `(${id}) · configured` : `(${id})`,
    active: id === worker.language
  }));

  openCommandPalette({
    title: 'Select Language Mode',
    placeholder: 'Select Language Mode (type to filter 72 languages)...',
    showSearch: true,
    items,
    onSelect: async (chosen) => {
      const logoHtml = getLangLogoHtml(chosen.id);
      openCommandPalette({
        title: `Switch "${worker.name}" to ${chosen.label}`,
        showSearch: false,
        items: [
          {
            id: 'template',
            iconHtml: logoHtml,
            label: `Switch to ${chosen.label} and load ${chosen.label} starter template`,
            meta: 'Recommended',
            active: true
          },
          {
            id: 'keep',
            iconHtml: logoHtml,
            label: `Switch to ${chosen.label} and keep current editor code as-is`,
            meta: 'Preserve code'
          }
        ],
        onSelect: async (subChoice) => {
          addNotification(`Language mode changed to ${chosen.label}`);
          await saveActiveWorkerToStorage({
            language: chosen.id,
            useLanguageTemplate: subChoice.id === 'template',
            deploy: true,
            deploySource: `Switched to ${chosen.label}`
          });
        }
      });
    }
  });
}

function openIndentationPicker() {
  const worker = getActiveWorkerObj();
  if (!worker) return;

  openCommandPalette({
    title: 'Select Indentation',
    showSearch: false,
    items: [
      { label: 'Indent Using Spaces: 2', spaces: 2, tabs: false, meta: '2 spaces', active: !worker.indentUsingTabs && worker.spaces === 2 },
      { label: 'Indent Using Spaces: 4', spaces: 4, tabs: false, meta: '4 spaces', active: !worker.indentUsingTabs && worker.spaces === 4 },
      { label: 'Indent Using Spaces: 8', spaces: 8, tabs: false, meta: '8 spaces', active: !worker.indentUsingTabs && worker.spaces === 8 },
      { label: 'Indent Using Tabs (Tab Size: 2)', spaces: 2, tabs: true, meta: 'Tab = 2', active: worker.indentUsingTabs && worker.spaces === 2 },
      { label: 'Indent Using Tabs (Tab Size: 4)', spaces: 4, tabs: true, meta: 'Tab = 4', active: worker.indentUsingTabs && worker.spaces === 4 },
      { label: 'Format Document & Trim Trailing Whitespace', action: 'format', meta: 'Shift+Alt+F' }
    ],
    onSelect: async (item) => {
      if (item.action === 'format') {
        formatActiveDocument();
        return;
      }
      addNotification(`Indentation set to ${item.label}`);
      await saveActiveWorkerToStorage({ spaces: item.spaces, indentUsingTabs: item.tabs });
    }
  });
}

function openEncodingPicker() {
  const worker = getActiveWorkerObj();
  if (!worker) return;

  const rawEncodings = window.VSCODE_ENCODINGS || [
    ['UTF-8', 'utf8'],
    ['UTF-8 with BOM', 'utf8bom'],
    ['UTF-16 LE', 'utf16le'],
    ['UTF-16 BE', 'utf16be'],
    ['Western (ISO 8859-1)', 'iso88591'],
    ['ASCII', 'ascii']
  ];

  openCommandPalette({
    title: 'Select File Encoding',
    placeholder: 'Select File Encoding to Save or Reopen...',
    showSearch: true,
    items: rawEncodings.map(([label, code]) => ({
      label,
      meta: code,
      active: (worker.encoding || 'UTF-8') === label
    })),
    onSelect: async (item) => {
      addNotification(`Encoding updated to ${item.label}`);
      await saveActiveWorkerToStorage({ encoding: item.label });
    }
  });
}

function openEolPicker() {
  const worker = getActiveWorkerObj();
  if (!worker) return;

  openCommandPalette({
    title: 'Select End of Line Sequence',
    showSearch: false,
    items: [
      { label: 'LF', meta: 'Unix / Raspberry Pi / macOS (\\n)', active: (worker.eol || 'LF') === 'LF' },
      { label: 'CRLF', meta: 'Windows (\\r\\n)', active: worker.eol === 'CRLF' }
    ],
    onSelect: async (item) => {
      addNotification(`Line endings set to ${item.label}`);
      await saveActiveWorkerToStorage({ eol: item.label });
    }
  });
}

function openLayoutPicker() {
  const worker = getActiveWorkerObj();
  if (!worker) return;

  const layouts = [
    { label: 'Layout: US', meta: 'English (US QWERTY)' },
    { label: 'Layout: UK', meta: 'English (UK)' },
    { label: 'Layout: Intl', meta: 'US International' },
    { label: 'Layout: Dvorak', meta: 'US Dvorak' },
    { label: 'Layout: Colemak', meta: 'US Colemak' },
    { label: 'Layout: German', meta: 'Deutsch (QWERTZ)' },
    { label: 'Layout: French', meta: 'Français (AZERTY)' }
  ];

  openCommandPalette({
    title: 'Select Keyboard Layout',
    showSearch: true,
    items: layouts.map((l) => ({
      ...l,
      active: (worker.layout || 'Layout: US') === l.label
    })),
    onSelect: async (item) => {
      addNotification(`Keyboard layout set to ${item.label}`);
      await saveActiveWorkerToStorage({ layout: item.label });
    }
  });
}

function openGoToLinePicker() {
  const textarea = el('codeEditor');
  const lines = textarea.value.split('\n');

  openCommandPalette({
    title: `Go to Line (1 - ${lines.length})`,
    placeholder: 'Type a line number to jump to...',
    showSearch: true,
    items: lines.slice(0, 100).map((text, idx) => ({
      line: idx + 1,
      label: `${idx + 1}: ${text.trim() || '(empty line)'}`,
      meta: `Ln ${idx + 1}`
    })),
    onSelect: (item) => {
      const targetLine = item.line || 1;
      let offset = 0;
      for (let i = 0; i < targetLine - 1 && i < lines.length; i++) {
        offset += lines[i].length + 1;
      }
      textarea.focus();
      textarea.setSelectionRange(offset, offset);
      updateCursorPosition();
    }
  });
}

function openProblemsPicker() {
  const items =
    appState.diagnostics.length > 0
      ? appState.diagnostics.map((d) => ({
          label: d.message,
          meta: d.severity.toUpperCase()
        }))
      : [
          {
            label: 'No syntax errors or warnings detected in current worker.',
            meta: '0 problems'
          }
        ];

  openCommandPalette({
    title: 'Problems & Diagnostics',
    showSearch: false,
    items,
    onSelect: () => {}
  });
}

function openNotificationsPicker() {
  openCommandPalette({
    title: 'Notifications & Auto-Save Log',
    showSearch: false,
    items: appState.notifications.map((n) => ({
      label: n.text,
      meta: n.time
    })),
    onSelect: () => {}
  });
}

function openQuickJumpPalette() {
  const workerItems = Object.values(appState.workers).map((w) => {
    const langSpec = getLanguageSpec(w.language);
    return {
      type: 'worker',
      name: w.name,
      iconHtml: getLangLogoHtml(w.language),
      label: `Worker: ${w.name} (/${w.name})`,
      meta: `${langSpec.label} · Open in Quick Edit`
    };
  });

  openCommandPalette({
    title: 'Go to Worker or Page (Ctrl+K)',
    placeholder: 'Search workers, pages, or actions...',
    showSearch: true,
    items: [
      ...workerItems,
      { type: 'view', view: 'applications', label: 'Workers & Pages: Overview', meta: 'Dashboard' },
      { type: 'view', view: 'detail', label: 'Active Worker Details (Metrics, Bindings, Deployments)', meta: 'Details' },
      { type: 'view', view: 'editor', label: 'Quick Edit: VS Code Editor', meta: 'Code Editor' },
      { type: 'view', view: 'records', label: 'Public links: Cloudflare Tunnel & DNS Records', meta: 'Tunnel' },
      { type: 'view', view: 'websites', label: 'Websites & Nginx Client-IP Proxy', meta: 'Gateway' },
      { type: 'view', view: 'analytics', label: 'Analytics & Live Invocation Logs', meta: 'Observability' },
      { type: 'view', view: 'storage', label: 'Local Storage & Auto-Saved Files', meta: 'Disk Storage' },
      { type: 'view', view: 'plans', label: 'System & Installed Runtimes', meta: 'System' },
      { type: 'create', label: 'Create New Worker', meta: 'New Action' }
    ],
    onSelect: (item) => {
      if (item.type === 'worker') window.openWorkerInEditor(item.name);
      else if (item.type === 'view') switchView(item.view);
      else if (item.type === 'create') openWorkerModal('create');
    }
  });
}

// ============================================================================
// Worker Creation, Renaming, Deletion & Publishing Links Helpers
// ============================================================================
function openWorkerModal(mode, initialName = '') {
  workerModalMode = mode;
  const overlay = el('workerModalOverlay');
  const titleEl = el('workerModalTitle');
  const nameInput = el('modalWorkerNameInput');
  const pubInput = el('modalWorkerPublishLinkInput');
  const langGroup = el('modalWorkerLangGroup');
  const langSelect = el('modalWorkerLangSelect');

  const allLangs = window.VSCODE_LANGS || appState.languages.map((l) => [l.label, l.id]);
  langSelect.innerHTML = allLangs
    .map(([label, id]) => `<option value="${id}" ${id === 'javascript' ? 'selected' : ''}>${escapeHtml(label)} (${escapeHtml(id)})</option>`)
    .join('');

  if (mode === 'rename') {
    const existingWorker = appState.workers[initialName];
    titleEl.textContent = `Edit Worker "${initialName}" & Publishing Link`;
    nameInput.value = initialName;
    if (pubInput) {
      pubInput.value = existingWorker ? getWorkerPrimaryPublishingLink(existingWorker) : `/${initialName}`;
      pubInput.dataset.customized = 'true';
    }
    langGroup.classList.add('hidden');
  } else {
    const suggestedName = `worker-${Object.keys(appState.workers).length + 1}`;
    titleEl.textContent = 'Create New Worker';
    nameInput.value = suggestedName;
    if (pubInput) {
      pubInput.value = `/${suggestedName}`;
      pubInput.dataset.customized = 'false';
    }
    langGroup.classList.remove('hidden');
  }

  overlay.classList.remove('hidden');
  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 20);
}

window.openPublishLinksEditor = function () {
  const editorCard = el('overviewPublishLinkEditor');
  if (editorCard) {
    editorCard.classList.remove('hidden');
    const inp = el('overviewPrimaryPublishInput');
    if (inp) {
      const w = getActiveWorkerObj();
      inp.value = getWorkerPrimaryPublishingLink(w);
      setTimeout(() => {
        inp.focus();
        inp.select();
      }, 20);
    }
  } else {
    switchDetailSubtab('domains');
  }
};

window.openWorkerPublishLinksEditor = async function (workerName) {
  if (!appState.workers[workerName]) return;
  appState.activeWorker = workerName;
  await fetch('/api/active-worker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: workerName })
  });
  renderWorkerDropdown();
  switchView('detail');
  switchDetailSubtab('overview');
  window.openPublishLinksEditor();
};

window.savePrimaryPublishingLinkFromOverview = async function () {
  const w = getActiveWorkerObj();
  const inp = el('overviewPrimaryPublishInput');
  if (!w || !inp) return;
  const linkVal = inp.value.trim() || `/${w.name}`;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publishingLink: linkVal })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    addNotification(`Saved primary publishing link: ${data.worker.publishingLink}`);
    await fetchAppState();
  }
};

window.addAdditionalPublishingLinkFromOverview = async function () {
  const w = getActiveWorkerObj();
  const inp = el('overviewAddPublishInput');
  if (!w || !inp) return;
  const pattern = inp.value.trim();
  if (!pattern) return;
  inp.value = '';
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ addRoute: { pattern, type: 'Publishing Link' } })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    addNotification(`Added publishing link: ${pattern}`);
    await fetchAppState();
  }
};

window.savePrimaryPublishingLinkFromDomains = async function () {
  const w = getActiveWorkerObj();
  const inp = el('domainsPrimaryPublishInput');
  if (!w || !inp) return;
  const linkVal = inp.value.trim() || `/${w.name}`;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publishingLink: linkVal })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    addNotification(`Saved primary publishing link: ${data.worker.publishingLink}`);
    await fetchAppState();
  }
};

window.openWorkerInEditor = async function (name) {
  if (!appState.workers[name]) return;
  syncEditorBufferToMemory();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    await saveActiveWorkerToStorage({ deploy: false });
  }
  appState.activeWorker = name;
  await fetch('/api/active-worker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name })
  });
  renderWorkerDropdown();
  switchView('editor');
  executeCurrentWorkerHttpRequest();
};

window.openWorkerFileInEditor = async function (workerName, fileName) {
  if (!appState.workers[workerName]) return;
  syncEditorBufferToMemory();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    await saveActiveWorkerToStorage({ deploy: false });
  }
  appState.activeWorker = workerName;
  appState.activeFileByWorker[workerName] = fileName;
  await fetch('/api/active-worker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: workerName })
  });
  renderWorkerDropdown();
  switchView('editor');
};

window.selectWorkerFile = async function (fileName) {
  const w = getActiveWorkerObj();
  if (!w) return;
  syncEditorBufferToMemory();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  await saveActiveWorkerToStorage({ deploy: false });
  appState.activeFileByWorker[w.name] = fileName;
  const primaryPath = getWorkerPrimaryPublishingPath(w);
  if (el('httpUrlInput') && el('httpUrlInput').value.startsWith(`/${w.name}/`)) {
    el('httpUrlInput').value = primaryPath;
  }
  if (el('previewUrlBadge') && el('previewUrlBadge').value.includes(`/${w.name}/`)) {
    el('previewUrlBadge').value = `${window.location.origin}${primaryPath}`;
  }
  renderEditorView();
};

window.promptExplorerCreateFile = function () {
  const sidebar = el('editorExplorerSidebar');
  if (sidebar && sidebar.classList.contains('hidden')) {
    sidebar.classList.remove('hidden');
    el('actExplorerBtn')?.classList.add('active');
    el('toggleExplorerBtn')?.classList.add('active');
  }
  const form = el('explorerInlineForm');
  const label = el('explorerInlineLabel');
  const inp = el('explorerInlineInput');
  if (!form || !inp) return;
  appState.explorerInlineMode = { type: 'create' };
  label.textContent = 'Create new file in worker:';
  const w = getActiveWorkerObj();
  const count = (w && Array.isArray(w.files) ? w.files.length : 1) + 1;
  inp.value = `helper-${count}.js`;
  form.classList.remove('hidden');
  setTimeout(() => {
    inp.focus();
    inp.select();
  }, 15);
};

window.promptExplorerRenameFile = function (targetFileName) {
  const w = getActiveWorkerObj();
  if (!w) return;
  const activeFile = getActiveFileObj(w);
  const fileToRename = targetFileName || (activeFile && activeFile.name) || w.filename;
  const form = el('explorerInlineForm');
  const label = el('explorerInlineLabel');
  const inp = el('explorerInlineInput');
  if (!form || !inp) return;
  appState.explorerInlineMode = { type: 'rename', targetFile: fileToRename };
  label.textContent = `Rename "${fileToRename}" to:`;
  inp.value = fileToRename;
  form.classList.remove('hidden');
  setTimeout(() => {
    inp.focus();
    inp.select();
  }, 15);
};

window.submitExplorerInlineForm = async function () {
  const w = getActiveWorkerObj();
  const form = el('explorerInlineForm');
  const inp = el('explorerInlineInput');
  if (!w || !inp || !appState.explorerInlineMode) return;
  const val = inp.value.trim();
  if (!val) return;

  const mode = appState.explorerInlineMode;
  form.classList.add('hidden');
  appState.explorerInlineMode = null;

  syncEditorBufferToMemory();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  await saveActiveWorkerToStorage({ deploy: false });

  if (mode.type === 'create') {
    const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: val, overwrite: true })
    });
    const data = await res.json();
    if (data.ok && data.worker) {
      appState.workers[w.name] = data.worker;
      appState.activeFileByWorker[w.name] = data.file ? data.file.name : val;
      addNotification(`Created file "${appState.activeFileByWorker[w.name]}" in ${w.name}`);
      renderAll();
    } else if (data.error) {
      addNotification(data.error, 'info');
    }
  } else if (mode.type === 'rename') {
    const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/files`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: mode.targetFile, newFilename: val })
    });
    const data = await res.json();
    if (data.ok && data.worker) {
      appState.workers[w.name] = data.worker;
      appState.activeFileByWorker[w.name] = data.filename || val;
      addNotification(`Renamed "${mode.targetFile}" -> "${appState.activeFileByWorker[w.name]}"`);
      renderAll();
    }
  }
};

window.deleteWorkerFile = async function (targetFileName) {
  const w = getActiveWorkerObj();
  if (!w) return;
  syncEditorBufferToMemory();
  const activeFile = getActiveFileObj(w);
  const fileToDelete = targetFileName || (activeFile && activeFile.name) || w.filename;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/files`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: fileToDelete })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    const nextFile = (data.files && data.files[0] && data.files[0].name) || data.worker.filename;
    appState.activeFileByWorker[w.name] = nextFile;
    el('codeEditor').dataset.fileName = '';
    addNotification(`Deleted file "${fileToDelete}" from ${w.name}`);
    renderAll();
  }
};

window.setWorkerEntrypointFile = async function (targetFileName) {
  const w = getActiveWorkerObj();
  if (!w) return;
  syncEditorBufferToMemory();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  await saveActiveWorkerToStorage({ deploy: false });
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/files`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: targetFileName, setAsEntrypoint: true, deploy: true, deploySource: `Set entrypoint ${targetFileName}` })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    appState.activeFileByWorker[w.name] = targetFileName;
    addNotification(`Set "${targetFileName}" as entrypoint for ${w.name}`);
    renderAll();
  }
};

window.duplicateWorkerFile = async function (sourceFileName) {
  const w = getActiveWorkerObj();
  if (!w || !sourceFileName) return;
  syncEditorBufferToMemory();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  await saveActiveWorkerToStorage({ deploy: false });
  const srcFile = (w.files || []).find((f) => f.name === sourceFileName);
  const dotIdx = sourceFileName.lastIndexOf('.');
  const copyName =
    dotIdx > 0
      ? `${sourceFileName.slice(0, dotIdx)}-copy${sourceFileName.slice(dotIdx)}`
      : `${sourceFileName}-copy`;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: copyName,
      content: srcFile ? srcFile.content : ''
    })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    appState.activeFileByWorker[w.name] = data.file ? data.file.name : copyName;
    el('codeEditor').dataset.fileName = '';
    addNotification(`Duplicated "${sourceFileName}" as "${copyName}"`);
    renderAll();
  }
};

window.jumpEditorToLine = function (lineNumber) {
  const textarea = el('codeEditor');
  if (!textarea) return;
  const lines = textarea.value.split('\n');
  let offset = 0;
  for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  textarea.focus();
  textarea.setSelectionRange(offset, offset);
  updateCursorPosition();
};

window.toggleWorkerIssueDetection = async function (enabled) {
  const w = getActiveWorkerObj();
  if (!w) return;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: Boolean(enabled) })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    addNotification(`Issue detection ${enabled ? 'enabled' : 'disabled'} for ${w.name}`);
    renderDetailView();
  }
};

window.resolveWorkerIssue = async function (issueId) {
  const w = getActiveWorkerObj();
  if (!w) return;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resolveIssueId: issueId })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    addNotification(`Resolved issue ${issueId}`);
    renderDetailView();
  }
};

window.toggleWorkerUrlState = async function (field, checked) {
  const w = getActiveWorkerObj();
  if (!w) return;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [field]: Boolean(checked) })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    addNotification(`Updated URL visibility for ${w.name}`);
    renderDetailView();
  }
};

window.addWorkerCustomRoute = async function () {
  const w = getActiveWorkerObj();
  const patInp = el('newRoutePatternInput');
  const typeSel = el('newRouteTypeSelect');
  if (!w || !patInp) return;
  const pattern = patInp.value.trim();
  if (!pattern) return;
  const type = typeSel ? typeSel.value : 'Route';
  patInp.value = '';
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ addRoute: { pattern, type } })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    addNotification(`Added ${type}: ${pattern}`);
    renderDetailView();
  }
};

window.removeWorkerCustomRoute = async function (routeId) {
  const w = getActiveWorkerObj();
  if (!w) return;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ removeRouteId: routeId })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    addNotification(`Removed route from ${w.name}`);
    renderDetailView();
  }
};

window.openWorkerDetail = async function (name) {
  if (!appState.workers[name]) return;
  appState.activeWorker = name;
  await fetch('/api/active-worker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name })
  });
  renderWorkerDropdown();
  switchView('detail');
};

window.promptRenameWorker = function (name) {
  appState.activeWorker = name;
  openWorkerModal('rename', name);
};

window.deleteWorkerByName = async function (name) {
  const res = await fetch(`/api/workers/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  });
  const data = await res.json();
  if (data.ok) {
    addNotification(`Deleted worker "${name}"`);
    await fetchAppState();
  }
};

window.removeWorkerBinding = async function (key) {
  const w = getActiveWorkerObj();
  if (!w) return;
  const nextBindings = { ...(w.bindings || {}) };
  delete nextBindings[key];
  await saveActiveWorkerToStorage({ bindings: nextBindings, deploy: true, deploySource: 'Updated Bindings' });
  addNotification(`Removed binding env.${key}`);
};

window.rollbackWorkerVersion = async function (versionId) {
  const w = getActiveWorkerObj();
  if (!w || !versionId) return;
  const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rollback', versionId })
  });
  const data = await res.json();
  if (data.ok && data.worker) {
    appState.workers[w.name] = data.worker;
    if (el('codeEditor') && el('codeEditor').dataset.workerName === w.name) {
      el('codeEditor').dataset.fileName = '';
    }
    addNotification(`Rolled back ${w.name} to version ${versionId}`);
    renderAll();
  }
};

window.copyTextToClipboard = async function (text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
      } catch (_) {}
      ta.remove();
    }
    addNotification(`Copied to clipboard: ${text}`);
  } catch (_) {}
};

// ============================================================================
// Event Listeners Setup
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  renderAll();
  const initialPath = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const validInitialViews = ['editor', 'records', 'websites', 'analytics', 'storage', 'plans', 'detail'];
  switchView(validInitialViews.includes(initialPath) ? initialPath : 'applications');

  // Top Header & Sidebar navigation
  el('brandBtn').addEventListener('click', () => switchView('applications'));
  el('sidebarAccountBtn').addEventListener('click', () => switchView('websites'));
  el('topEditorSwitchBtn').addEventListener('click', () => switchView('editor'));
  el('topRecordsSwitchBtn').addEventListener('click', () => switchView('records'));
  el('topQuickSearchBtn').addEventListener('click', openQuickJumpPalette);
  el('topAddBtn').addEventListener('click', () => openWorkerModal('create'));

  const refreshIpBtn = el('refreshDashboardIpBtn');
  if (refreshIpBtn) {
    refreshIpBtn.addEventListener('click', refreshDashboardClientIpFromHttp);
  }

  document.querySelectorAll('.cf-side-item, .cf-side-subitem').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view) switchView(btn.dataset.view);
    });
  });

  // Overview search / filter / sort & sidebar buttons
  el('workerSearchInput').addEventListener('input', renderApplicationsView);
  el('workerSearchBtn').addEventListener('click', renderApplicationsView);
  el('workerFilterSelect').addEventListener('change', renderApplicationsView);
  el('workerSortSelect').addEventListener('change', renderApplicationsView);

  el('createWorkerMainBtn').addEventListener('click', () => openWorkerModal('create'));
  el('asideCreateWorkerLink').addEventListener('click', () => openWorkerModal('create'));
  el('asideOpenEditorLink').addEventListener('click', () => switchView('editor'));
  el('goToRecordsFromAppsBtn').addEventListener('click', () => switchView('records'));
  el('copyClientIpBox').addEventListener('click', () =>
    window.copyTextToClipboard(appState.clientDevice.ip || '127.0.0.1')
  );
  el('qaOpenEditor').addEventListener('click', () => switchView('editor'));
  el('qaConfigureTunnel').addEventListener('click', () => switchView('records'));
  el('qaCheckDns').addEventListener('click', () => {
    switchView('records');
    el('topCheckRecordBtn').click();
  });

  // Worker Detail View & All 8 Sub-tabs
  el('detailBackToOverviewBtn').addEventListener('click', () => switchView('applications'));
  el('detailEditCodeBtn').addEventListener('click', () => switchView('editor'));
  if (el('detailRunActionBtn')) {
    el('detailRunActionBtn').addEventListener('click', async () => {
      const w = getActiveWorkerObj();
      if (!w) return;
      await fetch(`/${encodeURIComponent(w.name)}`);
      await fetchAppState();
      addNotification(`Executed /${w.name} and updated live metrics`);
    });
  }
  if (el('stepOpenEditor')) el('stepOpenEditor').addEventListener('click', () => switchView('editor'));
  if (el('stepOpenPublicLinks')) el('stepOpenPublicLinks').addEventListener('click', () => switchDetailSubtab('domains'));
  if (el('stepOpenSettings')) el('stepOpenSettings').addEventListener('click', () => switchDetailSubtab('settings'));
  if (el('jumpToBindingsSubtabBtn')) el('jumpToBindingsSubtabBtn').addEventListener('click', () => switchDetailSubtab('bindings'));
  if (el('jumpToMetricsSubtabBtn')) el('jumpToMetricsSubtabBtn').addEventListener('click', () => switchDetailSubtab('metrics'));
  if (el('jumpToDeploymentsSubtabBtn')) el('jumpToDeploymentsSubtabBtn').addEventListener('click', () => switchDetailSubtab('deployments'));
  if (el('jumpToDomainsSubtabBtn')) el('jumpToDomainsSubtabBtn').addEventListener('click', () => switchDetailSubtab('domains'));
  if (el('settingsJumpBindingsBtn')) {
    el('settingsJumpBindingsBtn').addEventListener('click', () => {
      const box = el('settingsInlineVarBox');
      if (box) {
        box.classList.toggle('hidden');
        el('settingsNewVarKeyInput')?.focus();
      } else {
        switchDetailSubtab('bindings');
      }
    });
  }
  if (el('settingsSaveVarBtn')) {
    el('settingsSaveVarBtn').addEventListener('click', async () => {
      const w = getActiveWorkerObj();
      const kInp = el('settingsNewVarKeyInput');
      const vInp = el('settingsNewVarValInput');
      if (!w || !kInp || !vInp) return;
      const key = kInp.value.trim();
      const val = vInp.value;
      if (!key) return;
      const nextBindings = { ...(w.bindings || {}), [key]: val };
      kInp.value = '';
      vInp.value = '';
      el('settingsInlineVarBox')?.classList.add('hidden');
      await saveActiveWorkerToStorage({ bindings: nextBindings, deploy: true, deploySource: 'Updated Runtime Variables' });
      addNotification(`Saved variable env.${key}`);
    });
  }
  if (el('settingsOpenExplorerBtn')) el('settingsOpenExplorerBtn').addEventListener('click', () => switchView('editor'));
  if (el('deploymentsRefreshBtn')) el('deploymentsRefreshBtn').addEventListener('click', fetchAppState);
  if (el('deploymentsCreateNewBtn')) {
    el('deploymentsCreateNewBtn').addEventListener('click', async () => {
      const w = getActiveWorkerObj();
      if (!w) return;
      const res = await fetch(`/api/workers/${encodeURIComponent(w.name)}/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'deploy', source: 'Deployed from Dashboard' })
      });
      const data = await res.json();
      if (data.ok && data.worker) {
        appState.workers[w.name] = data.worker;
        addNotification(`Deployed new revision ${data.worker.deployId} for ${w.name}`);
        renderAll();
      }
    });
  }

  if (el('metricsVersionFilterSelect')) el('metricsVersionFilterSelect').addEventListener('change', renderDetailView);
  if (el('metricsTimeRangeSelect')) el('metricsTimeRangeSelect').addEventListener('change', renderDetailView);
  if (el('metricsTriggerTestBtn')) {
    el('metricsTriggerTestBtn').addEventListener('click', async () => {
      const w = getActiveWorkerObj();
      if (!w) return;
      await fetch(`/${encodeURIComponent(w.name)}`);
      await fetchAppState();
      addNotification(`Invoked /${w.name} and updated all 12 metrics charts`);
    });
  }

  if (el('obsTypeFilterSelect')) el('obsTypeFilterSelect').addEventListener('change', renderDetailView);
  if (el('obsQuerySearchInput')) el('obsQuerySearchInput').addEventListener('input', renderDetailView);
  if (el('obsRunTestBtn')) {
    el('obsRunTestBtn').addEventListener('click', async () => {
      const w = getActiveWorkerObj();
      if (!w) return;
      await fetch(`/${encodeURIComponent(w.name)}`);
      await fetchAppState();
      addNotification(`Captured live invocation event for /${w.name}`);
    });
  }
  if (el('obsClearLogsBtn')) {
    el('obsClearLogsBtn').addEventListener('click', async () => {
      const w = getActiveWorkerObj();
      if (!w) return;
      await fetch(`/api/workers/${encodeURIComponent(w.name)}/logs`, { method: 'DELETE' });
      await fetchAppState();
      addNotification(`Cleared logs for ${w.name}`);
    });
  }
  if (el('obsLiveTailBtn')) {
    let liveTailInterval = null;
    el('obsLiveTailBtn').addEventListener('click', () => {
      const btn = el('obsLiveTailBtn');
      const txt = el('obsLiveTailBtnText');
      if (liveTailInterval) {
        clearInterval(liveTailInterval);
        liveTailInterval = null;
        btn.classList.remove('btn-black');
        btn.classList.add('btn-outline');
        if (txt) txt.textContent = 'Live Tail';
        addNotification('Stopped Live Tail stream');
      } else {
        btn.classList.remove('btn-outline');
        btn.classList.add('btn-black');
        if (txt) txt.textContent = 'Streaming Live...';
        addNotification('Started Live Tail real-time event stream');
        liveTailInterval = setInterval(async () => {
          if (appState.currentView !== 'detail' || appState.currentDetailSubtab !== 'observability') return;
          await fetchAppState();
        }, 2000);
      }
    });
  }

  if (el('settingLogsToggle')) {
    el('settingLogsToggle').addEventListener('change', async (e) => {
      const w = getActiveWorkerObj();
      if (!w) return;
      await fetch(`/api/workers/${encodeURIComponent(w.name)}/observability`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ observabilityConfig: { logsEnabled: e.target.checked } })
      });
      await fetchAppState();
    });
  }

  if (el('settingIssuesToggle')) {
    el('settingIssuesToggle').addEventListener('change', (e) => {
      window.toggleWorkerIssueDetection(e.target.checked);
    });
  }

  document.querySelectorAll('#detailSubtabsBar .cf-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.subtab) switchDetailSubtab(btn.dataset.subtab);
    });
  });

  // Explorer Sidepanel, Activity Bar, Workbench Bar & Bottom Panel Controls
  function toggleExplorerSidebar() {
    const sb = el('editorExplorerSidebar');
    if (!sb) return;
    const isHidden = sb.classList.toggle('hidden');
    el('actExplorerBtn')?.classList.toggle('active', !isHidden);
    el('toggleExplorerBtn')?.classList.toggle('active', !isHidden);
  }

  function toggleBottomPanel() {
    const bp = el('editorBottomPanel');
    if (!bp) return;
    const isHidden = bp.classList.toggle('hidden');
    el('toggleBottomPanelBtn')?.classList.toggle('active', !isHidden);
    renderBottomPanel(getActiveWorkerObj());
  }

  function toggleRightInspectorPane() {
    const rp = el('editorInspectorPane');
    if (!rp) return;
    const isHidden = rp.classList.toggle('hidden');
    el('toggleRightPaneBtn')?.classList.toggle('active', !isHidden);
  }

  if (el('actExplorerBtn')) el('actExplorerBtn').addEventListener('click', toggleExplorerSidebar);
  if (el('toggleExplorerBtn')) el('toggleExplorerBtn').addEventListener('click', toggleExplorerSidebar);
  if (el('toggleBottomPanelBtn')) el('toggleBottomPanelBtn').addEventListener('click', toggleBottomPanel);
  if (el('bottomPanelCloseBtn')) el('bottomPanelCloseBtn').addEventListener('click', toggleBottomPanel);
  if (el('toggleRightPaneBtn')) el('toggleRightPaneBtn').addEventListener('click', toggleRightInspectorPane);

  if (el('actSearchBtn')) el('actSearchBtn').addEventListener('click', () => el('tabActFindBtn')?.click());
  if (el('wbSearchPill')) el('wbSearchPill').addEventListener('click', () => el('tabActFindBtn')?.click());
  if (el('actNewFileBtn')) el('actNewFileBtn').addEventListener('click', window.promptExplorerCreateFile);
  if (el('actSettingsBtn')) el('actSettingsBtn').addEventListener('click', openLanguageModePicker);

  if (el('explorerNewFileBtn')) el('explorerNewFileBtn').addEventListener('click', window.promptExplorerCreateFile);
  if (el('explorerTopNewFileBtn')) el('explorerTopNewFileBtn').addEventListener('click', window.promptExplorerCreateFile);
  if (el('tabActNewFileBtn')) el('tabActNewFileBtn').addEventListener('click', window.promptExplorerCreateFile);
  if (el('explorerRenameFileBtn')) el('explorerRenameFileBtn').addEventListener('click', () => window.promptExplorerRenameFile());
  if (el('explorerRefreshBtn')) el('explorerRefreshBtn').addEventListener('click', fetchAppState);
  if (el('explorerDeleteFileBtn')) el('explorerDeleteFileBtn').addEventListener('click', () => window.deleteWorkerFile());

  if (el('explorerInlineSubmitBtn')) el('explorerInlineSubmitBtn').addEventListener('click', window.submitExplorerInlineForm);
  if (el('explorerInlineCancelBtn')) {
    el('explorerInlineCancelBtn').addEventListener('click', () => {
      el('explorerInlineForm')?.classList.add('hidden');
      appState.explorerInlineMode = null;
    });
  }
  if (el('explorerInlineInput')) {
    el('explorerInlineInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        window.submitExplorerInlineForm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        el('explorerInlineForm')?.classList.add('hidden');
        appState.explorerInlineMode = null;
      }
    });
  }

  if (el('explorerWorkerFolderToggle')) {
    el('explorerWorkerFolderToggle').addEventListener('click', () => {
      const tree = el('explorerFilesList');
      const caret = el('explorerFolderCaret');
      if (!tree) return;
      const hidden = tree.classList.toggle('hidden');
      if (caret) caret.className = hidden ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-down';
    });
  }

  if (el('explorerOutlineToggle')) {
    el('explorerOutlineToggle').addEventListener('click', () => {
      const list = el('explorerOutlineList');
      const caret = el('explorerOutlineCaret');
      if (!list) return;
      const hidden = list.classList.toggle('hidden');
      if (caret) caret.className = hidden ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-down';
    });
  }

  if (el('explorerTimelineToggle')) {
    el('explorerTimelineToggle').addEventListener('click', () => {
      const list = el('explorerTimelineList');
      const caret = el('explorerTimelineCaret');
      if (!list) return;
      const hidden = list.classList.toggle('hidden');
      if (caret) caret.className = hidden ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-down';
    });
  }

  if (el('wbPrevFileBtn')) {
    el('wbPrevFileBtn').addEventListener('click', () => {
      const w = getActiveWorkerObj();
      if (!w || !Array.isArray(w.files) || w.files.length < 2) return;
      const cur = appState.activeFileByWorker[w.name];
      const idx = w.files.findIndex((f) => f.name === cur);
      const prevIdx = (idx - 1 + w.files.length) % w.files.length;
      window.selectWorkerFile(w.files[prevIdx].name);
    });
  }

  if (el('wbNextFileBtn')) {
    el('wbNextFileBtn').addEventListener('click', () => {
      const w = getActiveWorkerObj();
      if (!w || !Array.isArray(w.files) || w.files.length < 2) return;
      const cur = appState.activeFileByWorker[w.name];
      const idx = w.files.findIndex((f) => f.name === cur);
      const nextIdx = (idx + 1) % w.files.length;
      window.selectWorkerFile(w.files[nextIdx].name);
    });
  }

  document.querySelectorAll('.vscode-bp-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.vscode-bp-tab').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      appState.bottomPanelTab = tabBtn.dataset.btab || 'output';
      renderBottomPanel(getActiveWorkerObj());
    });
  });

  async function executeBottomTerminalCommand() {
    const inp = el('bottomTerminalCmdInput');
    const w = getActiveWorkerObj();
    if (!inp || !w) return;
    const cmd = inp.value.trim();
    if (!cmd) return;
    inp.value = '';
    if (!Array.isArray(appState.terminalHistory)) appState.terminalHistory = [];
    appState.terminalHistory.push(`robo-workers:/home/user/storage/workers/${w.name}$ ${cmd}`);

    const parts = cmd.split(/\s+/);
    const base = parts[0].toLowerCase();
    if (base === 'clear') {
      appState.terminalHistory = [];
    } else if (base === 'ls') {
      const fileStr = (w.files || []).map((f) => `${f.name} (${f.sizeBytes || 0}B)`).join('  ');
      appState.terminalHistory.push(fileStr || w.filename);
    } else if (base === 'pwd') {
      appState.terminalHistory.push(`/home/user/storage/workers/${w.name}`);
    } else if (base === 'cat') {
      const target = parts[1] || w.filename;
      const found = (w.files || []).find((f) => f.name === target);
      appState.terminalHistory.push(found ? found.content : `cat: ${target}: No such file in worker "${w.name}"`);
    } else if (base === 'curl') {
      const targetUrl = parts.find((p) => p.startsWith('/') || p.startsWith('http')) || `/${w.name}`;
      const pathOnly = targetUrl.startsWith('http') ? new URL(targetUrl).pathname : targetUrl;
      const t0 = performance.now();
      const resp = await fetch(pathOnly);
      const txt = await resp.text();
      const ms = Math.round(performance.now() - t0);
      appState.terminalHistory.push(`HTTP/1.1 ${resp.status} OK (${ms} ms)\n${txt}`);
      await fetchAppState();
    } else if (base === 'status') {
      const sys = appState.systemTelemetry || {};
      appState.terminalHistory.push(
        `Worker: ${w.name} | Runtime: ${w.language} | Revision: ${w.deployId} | Host RAM: ${sys.memoryUsedMb || 0}/${sys.memoryTotalMb || 0} MB | Requests: ${w.requests || 0}`
      );
    } else {
      appState.terminalHistory.push(`Available commands: ls, pwd, cat <file>, curl /${w.name}, status, clear`);
    }
    renderBottomPanel(w);
  }

  if (el('bottomTerminalRunBtn')) {
    el('bottomTerminalRunBtn').addEventListener('click', executeBottomTerminalCommand);
  }
  if (el('bottomTerminalCmdInput')) {
    el('bottomTerminalCmdInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        executeBottomTerminalCommand();
      }
    });
  }

  if (el('bottomPanelFilterInput')) {
    el('bottomPanelFilterInput').addEventListener('input', () => renderBottomPanel(getActiveWorkerObj()));
  }
  if (el('bottomPanelClearBtn')) {
    el('bottomPanelClearBtn').addEventListener('click', () => {
      if (el('bottomPanelBody')) el('bottomPanelBody').textContent = '';
    });
  }

  if (el('previewUrlBadge')) {
    el('previewUrlBadge').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el('previewUrlBadge').dataset.userEditedWorker = appState.activeWorker;
        updatePreviewPaneOutput();
      }
    });
  }

  el('metricsTriggerTestBtn').addEventListener('click', async () => {
    const w = getActiveWorkerObj();
    if (!w) return;
    await fetch(`/${encodeURIComponent(w.name)}`);
    await fetchAppState();
    addNotification(`Triggered test request to /${w.name}`);
  });

  el('deploymentsCreateNewBtn').addEventListener('click', async () => {
    await saveActiveWorkerToStorage({ deploy: true, deploySource: 'Manual Deployment' });
    addNotification(`Created new deployment revision for ${appState.activeWorker}`);
  });

  el('addBindingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const k = el('bindingKeyInput').value.trim();
    const v = el('bindingValInput').value.trim();
    if (!k) return;
    const w = getActiveWorkerObj();
    if (!w) return;
    const nextBindings = { ...(w.bindings || {}), [k]: v };
    el('bindingKeyInput').value = '';
    el('bindingValInput').value = '';
    await saveActiveWorkerToStorage({ bindings: nextBindings, deploy: true, deploySource: `Added Binding ${k}` });
    addNotification(`Saved binding env.${k}`);
  });

  el('obsRunTestBtn').addEventListener('click', async () => {
    const w = getActiveWorkerObj();
    if (!w) return;
    await fetch(`/${encodeURIComponent(w.name)}`);
    await fetchAppState();
  });

  el('obsClearLogsBtn').addEventListener('click', async () => {
    const w = getActiveWorkerObj();
    if (!w) return;
    await fetch(`/api/logs/${encodeURIComponent(w.name)}`, { method: 'DELETE' });
    await fetchAppState();
  });

  el('detailSettingRenameBtn').addEventListener('click', async () => {
    const newName = el('detailSettingRenameInput').value.trim();
    const oldName = appState.activeWorker;
    if (!newName || newName === oldName) return;
    const res = await fetch(`/api/workers/${encodeURIComponent(oldName)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName })
    });
    const data = await res.json();
    if (data.ok && data.worker) {
      appState.activeWorker = data.worker.name;
      await fetchAppState();
      addNotification(`Renamed worker to ${data.worker.name}`);
    }
  });

  el('detailSettingLangBtn').addEventListener('click', async () => {
    const nextLang = el('detailSettingLangSelect').value;
    await saveActiveWorkerToStorage({
      language: nextLang,
      useLanguageTemplate: true,
      deploy: true,
      deploySource: `Runtime changed to ${nextLang}`
    });
    addNotification(`Switched runtime to ${nextLang}`);
  });

  el('detailDownloadBtn').addEventListener('click', () => {
    const w = getActiveWorkerObj();
    if (!w) return;
    const blob = new Blob([w.code || ''], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = w.filename || `${w.name}.js`;
    a.click();
  });

  el('detailDeleteWorkerBtn').addEventListener('click', async () => {
    await window.deleteWorkerByName(appState.activeWorker);
    switchView('applications');
  });

  // Websites, Analytics & Storage Page buttons
  el('websitesGoToRecordsBtn').addEventListener('click', () => switchView('records'));
  el('analyticsRefreshBtn').addEventListener('click', fetchAppState);
  el('analyticsLogFilterInput').addEventListener('input', renderAnalyticsView);
  el('analyticsClearAllLogsBtn').addEventListener('click', async () => {
    await fetch('/api/logs/_all', { method: 'DELETE' });
    await fetchAppState();
  });
  el('storageRefreshBtn').addEventListener('click', fetchAppState);

  // Quick Edit Topbar buttons
  el('qeBackToDashboardBtn').addEventListener('click', () => switchView('applications'));
  el('qeGoToRecordsBtn').addEventListener('click', () => switchView('records'));
  el('backToAppsBtn').addEventListener('click', () => switchView('applications'));

  el('workerSelect').addEventListener('change', async (e) => {
    await window.openWorkerInEditor(e.target.value);
  });

  el('newWorkerQuickBtn').addEventListener('click', () => openWorkerModal('create'));
  el('renameWorkerQuickBtn').addEventListener('click', () =>
    openWorkerModal('rename', appState.activeWorker)
  );

  // Worker Modal Form
  el('workerModalCloseBtn').addEventListener('click', () =>
    el('workerModalOverlay').classList.add('hidden')
  );
  el('workerModalCancelBtn').addEventListener('click', () =>
    el('workerModalOverlay').classList.add('hidden')
  );
  if (el('modalWorkerNameInput') && el('modalWorkerPublishLinkInput')) {
    el('modalWorkerNameInput').addEventListener('input', (e) => {
      const pubInp = el('modalWorkerPublishLinkInput');
      if (workerModalMode === 'create' && pubInp && pubInp.dataset.customized !== 'true') {
        const clean = e.target.value.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
        pubInp.value = clean ? `/${clean}` : '/';
      }
    });
    el('modalWorkerPublishLinkInput').addEventListener('input', (e) => {
      e.target.dataset.customized = 'true';
    });
  }
  el('workerModalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawName = el('modalWorkerNameInput').value.trim();
    if (!rawName) return;
    const publishingLink = el('modalWorkerPublishLinkInput')
      ? el('modalWorkerPublishLinkInput').value.trim() || `/${rawName}`
      : `/${rawName}`;

    if (workerModalMode === 'create') {
      const language = el('modalWorkerLangSelect').value || 'javascript';
      const res = await fetch('/api/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: rawName, language, publishingLink })
      });
      const data = await res.json();
      if (data.ok && data.worker) {
        addNotification(`Created worker "${data.worker.name}" at ${data.worker.publishingLink || '/' + data.worker.name}`);
        el('workerModalOverlay').classList.add('hidden');
        await fetchAppState();
        switchView('editor');
        await executeCurrentWorkerHttpRequest({ skipSave: true });
      }
    } else {
      const oldName = appState.activeWorker;
      const res = await fetch(`/api/workers/${encodeURIComponent(oldName)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newName: rawName, publishingLink })
      });
      const data = await res.json();
      if (data.ok && data.worker) {
        addNotification(`Saved worker "${data.worker.name}" (${data.worker.publishingLink || '/' + data.worker.name})`);
        el('workerModalOverlay').classList.add('hidden');
        appState.activeWorker = data.worker.name;
        await fetchAppState();
      }
    }
  });

  // Deploy button & dropdown menu
  el('deployBtn').addEventListener('click', async () => {
    const saved = await saveActiveWorkerToStorage({ deploy: true, deploySource: 'Quick Edit Deploy' });
    if (saved !== false) {
      addNotification(`Deployed "${appState.activeWorker}" to Robo Workers`);
    } else {
      addNotification(`Error saving "${appState.activeWorker}" to storage`, 'info');
    }
    await executeCurrentWorkerHttpRequest({ skipSave: true });
  });

  el('deployMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    el('deployDropdown').classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    el('deployDropdown').classList.add('hidden');
  });

  el('menuDeployNow').addEventListener('click', async () => {
    const saved = await saveActiveWorkerToStorage({ deploy: true, deploySource: 'Quick Edit Deploy' });
    if (saved !== false) {
      addNotification(`Deployed "${appState.activeWorker}" to Robo Workers`);
    }
    await executeCurrentWorkerHttpRequest({ skipSave: true });
  });

  el('menuOpenEndpoint').addEventListener('click', () => {
    window.open(`/${appState.activeWorker}`, '_blank');
  });

  el('menuLoadTemplate').addEventListener('click', async () => {
    const w = getActiveWorkerObj();
    if (!w) return;
    await saveActiveWorkerToStorage({
      language: w.language,
      useLanguageTemplate: true,
      deploy: true,
      deploySource: 'Reset Template'
    });
    await executeCurrentWorkerHttpRequest({ skipSave: true });
  });

  el('menuDownloadFile').addEventListener('click', () => {
    const w = getActiveWorkerObj();
    if (!w) return;
    const blob = new Blob([el('codeEditor').value], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = w.filename || `${w.name}.js`;
    a.click();
  });

  el('menuDeleteWorker').addEventListener('click', async () => {
    await window.deleteWorkerByName(appState.activeWorker);
  });

  // Code Editor events
  const codeEditor = el('codeEditor');
  codeEditor.addEventListener('input', () => {
    updateEditorHighlightAndLines();
    updateCursorPosition();
    const w = getActiveWorkerObj();
    runBasicDiagnostics(codeEditor.value, w ? w.language : 'javascript');
    scheduleAutoSave();
  });

  codeEditor.addEventListener('click', updateCursorPosition);
  codeEditor.addEventListener('keyup', updateCursorPosition);

  codeEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const w = getActiveWorkerObj();
      const indent = w && w.indentUsingTabs ? '\t' : ' '.repeat((w && w.spaces) || 2);
      const start = codeEditor.selectionStart;
      const end = codeEditor.selectionEnd;
      codeEditor.value =
        codeEditor.value.substring(0, start) + indent + codeEditor.value.substring(end);
      codeEditor.selectionStart = codeEditor.selectionEnd = start + indent.length;
      updateEditorHighlightAndLines();
      updateCursorPosition();
      scheduleAutoSave();
    }
  });

  // Inspector Tabs (Preview vs HTTP)
  el('tabPreviewBtn').addEventListener('click', () => {
    el('tabPreviewBtn').classList.add('active');
    el('tabHttpBtn').classList.remove('active');
    el('panePreview').classList.remove('hidden');
    el('paneHttp').classList.add('hidden');
    executeCurrentWorkerHttpRequest();
  });

  el('tabHttpBtn').addEventListener('click', () => {
    el('tabHttpBtn').classList.add('active');
    el('tabPreviewBtn').classList.remove('active');
    el('paneHttp').classList.remove('hidden');
    el('panePreview').classList.add('hidden');
  });

  el('httpMethodSelect').addEventListener('change', (e) => {
    const m = e.target.value;
    el('httpBodySection').classList.toggle('hidden', !['POST', 'PUT', 'PATCH', 'QUERY'].includes(m));
  });

  el('httpSendBtn').addEventListener('click', executeCurrentWorkerHttpRequest);
  el('refreshPreviewBtn').addEventListener('click', executeCurrentWorkerHttpRequest);
  el('httpUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeCurrentWorkerHttpRequest();
  });

  el('addHeaderBtn').addEventListener('click', () => {
    appState.customHeaders.push({ key: '', value: '' });
    renderCustomHeaders();
  });

  function renderCustomHeaders() {
    const container = el('httpHeadersList');
    container.innerHTML = appState.customHeaders
      .map(
        (h, idx) => `
      <div class="header-row">
        <input type="text" placeholder="Header-Name" value="${escapeHtml(h.key)}" data-idx="${idx}" data-field="key" />
        <input type="text" placeholder="Value" value="${escapeHtml(h.value)}" data-idx="${idx}" data-field="value" />
        <button type="button" class="header-remove-btn" data-remove="${idx}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `
      )
      .join('');

    container.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const i = Number(e.target.dataset.idx);
        const f = e.target.dataset.field;
        appState.customHeaders[i][f] = e.target.value;
      });
    });

    container.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.remove);
        appState.customHeaders.splice(i, 1);
        renderCustomHeaders();
      });
    });
  }

  el('clearConsoleBtn').addEventListener('click', async () => {
    const w = getActiveWorkerObj();
    if (!w) return;
    await fetch(`/api/logs/${encodeURIComponent(w.name)}`, { method: 'DELETE' });
    w.logs = [];
    renderConsoleLogs(w);
  });

  // Bottom VS Code Blue Status Bar Interactive Buttons
  el('statusLanguageBtn').addEventListener('click', openLanguageModePicker);
  el('statusIndentBtn').addEventListener('click', openIndentationPicker);
  el('statusEncodingBtn').addEventListener('click', openEncodingPicker);
  el('statusEolBtn').addEventListener('click', openEolPicker);
  el('statusFormatBtn').addEventListener('click', formatActiveDocument);
  el('statusLayoutBtn').addEventListener('click', openLayoutPicker);
  el('statusCursorBtn').addEventListener('click', openGoToLinePicker);
  el('statusProblemsBtn').addEventListener('click', openProblemsPicker);
  el('statusBranchBtn').addEventListener('click', () => switchView('storage'));
  el('statusNotifyBtn').addEventListener('click', openNotificationsPicker);

  // Tab Strip Action Buttons & Find-in-File Widget (from vscode.html)
  const tabActNew = el('tabActNewBtn');
  if (tabActNew) {
    tabActNew.addEventListener('click', () => {
      if (getActiveWorkerObj()) {
        window.promptExplorerCreateFile();
      } else {
        openWorkerModal('create');
      }
    });
  }
  const tabActMore = el('tabActMoreBtn');
  if (tabActMore) tabActMore.addEventListener('click', openQuickJumpPalette);

  function openFindWidget() {
    const fw = el('findWidget');
    const fwInp = el('fwInput');
    if (!fw || !fwInp) return;
    fw.classList.remove('hidden');
    const sel = codeEditor.value.slice(codeEditor.selectionStart, codeEditor.selectionEnd);
    if (sel && !sel.includes('\n')) fwInp.value = sel;
    fwInp.focus();
    fwInp.select();
    updateFindCount();
  }

  function closeFindWidget() {
    const fw = el('findWidget');
    if (fw) fw.classList.add('hidden');
    codeEditor.focus();
  }

  function getFindMatches() {
    const q = (el('fwInput')?.value || '').toLowerCase();
    if (!q) return [];
    const src = codeEditor.value.toLowerCase();
    const matches = [];
    let idx = src.indexOf(q);
    while (idx !== -1) {
      matches.push(idx);
      idx = src.indexOf(q, idx + Math.max(1, q.length));
    }
    return matches;
  }

  function updateFindCount() {
    const countEl = el('fwCount');
    if (!countEl) return;
    const q = el('fwInput')?.value || '';
    const matches = getFindMatches();
    countEl.textContent = !q || matches.length === 0 ? 'No results' : `${matches.length} found`;
  }

  function stepFindMatch(dir) {
    const q = el('fwInput')?.value || '';
    const matches = getFindMatches();
    if (!q || matches.length === 0) {
      updateFindCount();
      return;
    }
    const pos = dir > 0 ? codeEditor.selectionEnd : codeEditor.selectionStart - 1;
    let pickIdx = 0;
    if (dir > 0) {
      pickIdx = matches.findIndex((m) => m >= pos);
      if (pickIdx === -1) pickIdx = 0;
    } else {
      pickIdx = -1;
      for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i] <= pos) {
          pickIdx = i;
          break;
        }
      }
      if (pickIdx === -1) pickIdx = matches.length - 1;
    }
    const start = matches[pickIdx];
    codeEditor.focus();
    codeEditor.setSelectionRange(start, start + q.length);
    updateCursorPosition();
    const countEl = el('fwCount');
    if (countEl) countEl.textContent = `${pickIdx + 1} of ${matches.length}`;
  }

  const tabActFind = el('tabActFindBtn');
  if (tabActFind) tabActFind.addEventListener('click', openFindWidget);
  const fwInput = el('fwInput');
  if (fwInput) {
    fwInput.addEventListener('input', () => stepFindMatch(1));
    fwInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepFindMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFindWidget();
      }
    });
  }
  const fwPrev = el('fwPrevBtn');
  if (fwPrev) fwPrev.addEventListener('click', () => stepFindMatch(-1));
  const fwNext = el('fwNextBtn');
  if (fwNext) fwNext.addEventListener('click', () => stepFindMatch(1));
  const fwClose = el('fwCloseBtn');
  if (fwClose) fwClose.addEventListener('click', closeFindWidget);

  el('paletteCloseBtn').addEventListener('click', () =>
    el('paletteOverlay').classList.add('hidden')
  );
  el('paletteOverlay').addEventListener('click', (e) => {
    if (e.target === el('paletteOverlay')) el('paletteOverlay').classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openQuickJumpPalette();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && appState.currentView === 'editor') {
      e.preventDefault();
      openFindWidget();
    }
  });

  // Records / Public links page: Check Record buttons & Settings form
  async function runDnsRecordCheck() {
    const topBtn = el('topCheckRecordBtn');
    const cardBtn = el('cardCheckRecordsBtn');
    topBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Checking...`;
    cardBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Checking...`;

    try {
      const res = await fetch('/api/dns/check', { method: 'POST' });
      const data = await res.json();
      if (data.config) appState.config = data.config;
      addNotification(`DNS check complete: ${data.dnsCheck?.message || ''}`);
      renderAll();
    } finally {
      topBtn.innerHTML = `<i class="fa-solid fa-rotate"></i> Check record`;
      cardBtn.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i> Check records`;
    }
  }

  el('topCheckRecordBtn').addEventListener('click', runDnsRecordCheck);
  el('cardCheckRecordsBtn').addEventListener('click', runDnsRecordCheck);

  el('generateTunnelIdBtn').addEventListener('click', () => {
    const uuid =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
    el('settingTunnelId').value = uuid;
  });

  el('tunnelSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      subdomain: el('settingSubdomain').value.trim(),
      rootDomain: el('settingRootDomain').value.trim(),
      tunnelId: el('settingTunnelId').value.trim(),
      tunnelToken: el('settingTunnelToken').value.trim(),
      localIp: el('settingLocalIp').value.trim(),
      networkCidrs: el('settingNetworkCidrs').value.trim()
    };

    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      appState.config = data.config;
      el('settingsSavedMsg').textContent = 'Settings saved and DNS checked';
      setTimeout(() => {
        el('settingsSavedMsg').textContent = '';
      }, 3000);
      addNotification(`Updated Tunnel settings`);
      renderAll();
    }
  });

  // Fetch live state from backend after all event listeners are attached
  try {
    await fetchAppState();
    await executeCurrentWorkerHttpRequest();
  } catch (err) {
    console.warn('Initial state sync warning:', err);
  }
});
