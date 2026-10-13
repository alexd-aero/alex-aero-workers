/* Alex-Aero dashboard.
 * Vanilla JS, no build step. Hash routes:
 *   #/                    workers
 *   #/w/<name>[/<tab>]    worker: overview | code | logs | deployments | settings
 *   #/logs  #/tunnel  #/system
 * Every number shown comes from the backend (per-hour/per-day buckets, the
 * invocation log, live host telemetry); nothing is made up. */
'use strict';

/* ================================================================ utilities */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const enc = encodeURIComponent;
const nf = new Intl.NumberFormat();
const num = (n) => nf.format(Number(n) || 0);
const plural = (n, word) => `${num(n)} ${word}${Number(n) === 1 ? '' : 's'}`;

function bytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function ms(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  v = Number(v);
  if (v < 1) return `${Math.round(v * 1000)} µs`;
  if (v < 1000) return `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function until(iso) {
  if (!iso) return 'never';
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}
// plain-English for the common cron shapes; anything else is shown as-is
// Schedules run on the server's clock, so show their times in its zone.
function serverTime(iso) {
  const tz = S.overview && S.overview.system && S.overview.system.timezone;
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const opts = { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  try {
    if (tz && tz !== mine) return `${new Date(iso).toLocaleString([], { ...opts, timeZone: tz })} ${tz} (server time)`;
  } catch (_) {}
  return new Date(iso).toLocaleString([], opts);
}
function describeCron(expr) {
  const e = String(expr).trim().toLowerCase();
  const alias = { '@hourly': 'Every hour', '@daily': 'Every day at midnight', '@midnight': 'Every day at midnight', '@weekly': 'Every Sunday at midnight', '@monthly': 'On the 1st of every month', '@yearly': 'Every 1 January', '@annually': 'Every 1 January' };
  if (alias[e]) return alias[e];
  const f = e.split(/\s+/);
  if (f.length !== 5) return expr;
  const [mi, h, dom, mo, dow] = f;
  const pad = (n) => String(n).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (dom === '*' && mo === '*') {
    if (mi === '*' && h === '*' && dow === '*') return 'Every minute';
    const step = mi.match(/^\*\/(\d+)$/);
    if (step && h === '*' && dow === '*') return `Every ${step[1]} minutes`;
    if (/^\d+$/.test(mi) && h === '*' && dow === '*') return mi === '0' ? 'Every hour' : `Every hour at :${pad(mi)}`;
    const hs = h.match(/^\*\/(\d+)$/);
    if (/^\d+$/.test(mi) && hs && dow === '*') return `Every ${hs[1]} hours at :${pad(mi)}`;
    if (/^\d+$/.test(mi) && /^\d+$/.test(h)) {
      const at = `${pad(h)}:${pad(mi)}`;
      if (dow === '*') return `Every day at ${at}`;
      if (dow === '1-5') return `Weekdays at ${at}`;
      if (/^\d$/.test(dow)) return `Every ${days[Number(dow)]} at ${at}`;
    }
  }
  return expr;
}
function clock(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '';
}
function duration(sec) {
  sec = Math.floor(Number(sec) || 0);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
const debounce = (fn, wait) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), wait);
  };
};
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch (_) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (_) {}
  }
};
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch (_) {
    toast('Copy failed (needs HTTPS or localhost)', 'err');
  }
}

/* ==================================================================== icons */
const P = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  external: '<path d="M14 4h6v6M20 4 10 14M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  thermo: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h8M7 21v-7h10v7"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevUp: '<path d="m18 15-6-6-6 6"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  disk: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="m10 17 5-5-5-5M15 12H3"/>',
  dots: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  folderPlus: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 10v6M9 13h6"/>',
  folderUp: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 16v-6M9.5 12.5 12 10l2.5 2.5"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>'
};
const icon = (name, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

/* ================================================================ languages */
const EXT_TO_MONACO = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell', bash: 'shell',
  json: 'json', jsonc: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml', sql: 'sql', txt: 'plaintext',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', lua: 'lua', c: 'c', cpp: 'cpp'
};
const EXT_TO_LANGID = {
  js: 'javascript', mjs: 'javascript', jsx: 'javascriptreact', ts: 'typescript', tsx: 'typescriptreact',
  py: 'python', sh: 'shellscript', json: 'json', html: 'html', htm: 'html', css: 'css', md: 'markdown',
  yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml', sql: 'sql', txt: 'plaintext'
};
const extOf = (f) => (String(f).split('.').pop() || '').toLowerCase();
const langOfFile = (f) => EXT_TO_LANGID[extOf(f)] || 'plaintext';
function langIcon(lang, cls = '') {
  const inner = typeof window.langIconHTML === 'function' ? window.langIconHTML(lang || 'javascript') : '';
  return `<span class="lang-ico ${cls}">${inner || icon('code')}</span>`;
}
function langName(lang) {
  return typeof window.langLabel === 'function' ? window.langLabel(lang) : lang;
}
const RUNTIME_OF = (lang) =>
  ({ python: 'Python', shellscript: 'Shell', shell: 'Shell', html: 'Static page', json: 'Template', yaml: 'Template', markdown: 'Template', css: 'Template', plaintext: 'Template' }[lang] ||
  'workerd');

const TEMPLATES = [
  { id: 'javascript', name: 'JavaScript', desc: 'A Workers-style fetch() handler on workerd' },
  { id: 'typescript', name: 'TypeScript', desc: 'Same, typed — types are stripped on run' },
  { id: 'python', name: 'Python', desc: 'A script; whatever it prints is the response' },
  { id: 'shellscript', name: 'Shell', desc: 'A bash script; stdout is the response' },
  { id: 'html', name: 'HTML page', desc: 'Static page with {{ip}}, {{url}} placeholders' },
  { id: 'json', name: 'JSON', desc: 'A static JSON document' }
];

/* ====================================================================== api */
class ApiError extends Error {}
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (_) {
    throw new ApiError("Can't reach the Pi. Is Alex-Aero running?");
  }
  if (res.status === 401 && !url.startsWith('/api/account')) {
    location.replace('/' + location.hash);
    throw new ApiError('Signed out');
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) throw new ApiError((data && (data.message || data.error)) || `HTTP ${res.status}`);
  return data || {};
}

/* =================================================================== toasts */
function toast(text, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kind === 'err' ? 'alert' : 'check')}<div>${esc(text)}</div>`;
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, kind === 'err' ? 6000 : 3000);
}
async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (err) {
    toast(err.message || String(err), 'err');
    return undefined;
  }
}

/* =================================================================== modals */
function modal({ title, body, foot = '', wide = false, onMount }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </div>`;
  const prevFocus = document.activeElement;
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) close();
  });
  ov.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(ov);
  const first = ov.querySelector('[autofocus]') || ov.querySelector('input, select, textarea, button.primary');
  if (first) setTimeout(() => first.focus(), 30);
  if (onMount) onMount(ov, close);
  return { el: ov, close };
}
function confirmDialog({ title, text, ok = 'Confirm', danger = false, typeToConfirm = '' }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p style="margin:0;color:var(--text-2)">${text}</p>${
        typeToConfirm
          ? `<div class="field"><label for="cfmIn">Type <b class="mono">${esc(typeToConfirm)}</b> to confirm</label><input id="cfmIn" class="input mono" autocomplete="off" autofocus></div>`
          : ''
      }`,
      foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cfmOk" ${typeToConfirm ? 'disabled' : ''}>${esc(ok)}</button>`,
      onMount(ov, close) {
        const okBtn = $('#cfmOk', ov);
        const inp = $('#cfmIn', ov);
        if (inp) inp.addEventListener('input', () => (okBtn.disabled = inp.value.trim() !== typeToConfirm));
        okBtn.addEventListener('click', () => {
          resolved = true;
          close();
          resolve(true);
        });
        if (!typeToConfirm) setTimeout(() => okBtn.focus(), 30);
      }
    });
    let resolved = false;
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.el)) {
        obs.disconnect();
        if (!resolved) resolve(false);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

/* ==================================================================== state */
const S = {
  overview: null,
  route: { page: 'workers' },
  pollers: [],
  ide: null,
  theme: document.documentElement.dataset.theme || 'dark'
};
function workersList() {
  return (S.overview && S.overview.workers) || [];
}
function findWorker(name) {
  return workersList().find((w) => w.name === name);
}
async function loadOverview() {
  S.overview = await api('GET', '/api/overview');
  renderSide();
  return S.overview;
}

function stopPollers() {
  S.pollers.forEach((p) => clearInterval(p));
  S.pollers = [];
}
function poll(fn, every) {
  const id = setInterval(() => {
    if (!document.hidden) fn();
  }, every);
  S.pollers.push(id);
  return id;
}

/* ============================================================ hour buckets */
function last24Hours() {
  const out = [];
  const now = Date.now();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now - i * 3600e3);
    out.push({ key: d.toISOString().slice(0, 13), label: d.toLocaleTimeString([], { hour: '2-digit', hour12: false }) });
  }
  return out;
}
function hourSeries(hourly) {
  return last24Hours().map(({ key, label }) => {
    const b = (hourly && hourly[key]) || null;
    return {
      key,
      label,
      requests: b ? b.requests : 0,
      errors: b ? b.errors : 0,
      avgMs: b && b.requests ? b.totalMs / b.requests : null,
      bytes: b ? b.bytes : 0
    };
  });
}
function mergeHourly(workers) {
  const merged = {};
  for (const w of workers) {
    for (const [k, b] of Object.entries(w.hourly || {})) {
      const m = merged[k] || (merged[k] = { requests: 0, errors: 0, totalMs: 0, bytes: 0 });
      m.requests += b.requests;
      m.errors += b.errors;
      m.totalMs += b.totalMs;
      m.bytes += b.bytes;
    }
  }
  return merged;
}

/* ================================================================== charts */
// 24 cells, one per hour; brightness = traffic relative to the busiest hour.
function sparkStrip(hourly) {
  const series = hourSeries(hourly);
  const max = Math.max(1, ...series.map((s) => s.requests));
  return `<div><div class="spark" role="img" aria-label="Requests per hour over the last 24 hours">${series
    .map((s) => {
      const tip = `${s.label}:00 · ${s.requests ? plural(s.requests, 'request') : 'no requests'}${s.errors ? `, ${s.errors} failed` : ''}`;
      if (!s.requests) return `<i class="zero" title="${esc(tip)}"></i>`;
      const o = (0.28 + 0.72 * Math.sqrt(s.requests / max)).toFixed(2);
      return `<i class="${s.errors > s.requests / 2 ? 'err' : ''}" style="--o:${o}" title="${esc(tip)}"></i>`;
    })
    .join('')}</div><div class="spark-axis"><span>24h ago</span><span>now</span></div></div>`;
}

let chartSeq = 0;
// Bars = requests (errors stacked in red), line = average response time.
function hourChart(hourly, { height = 190 } = {}) {
  const id = `ch${++chartSeq}`;
  const series = hourSeries(hourly);
  const W = 720;
  const H = height;
  const pad = { l: 34, r: 40, t: 12, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxR = Math.max(1, ...series.map((s) => s.requests));
  const lat = series.map((s) => s.avgMs).filter((v) => v !== null);
  const maxL = Math.max(1, ...lat);
  const bw = iw / series.length;
  const y = (v) => pad.t + ih - (v / maxR) * ih;
  const yl = (v) => pad.t + ih - (v / maxL) * ih;
  const ticks = [0, Math.ceil(maxR / 2), maxR];
  let bars = '';
  let pts = [];
  series.forEach((s, i) => {
    const x = pad.l + i * bw;
    if (s.requests) {
      const okH = ((s.requests - s.errors) / maxR) * ih;
      const errH = (s.errors / maxR) * ih;
      const bwid = Math.min(12, Math.max(2, bw - 8));
      const bx = x + (bw - bwid) / 2;
      bars += `<rect class="bar" x="${bx}" y="${pad.t + ih - okH - errH}" width="${bwid}" height="${Math.max(okH, 0)}" rx="${Math.min(4, bwid / 2)}"/>`;
      if (s.errors) bars += `<rect class="bar err" x="${bx}" y="${pad.t + ih - errH}" width="${bwid}" height="${errH}" rx="${Math.min(4, bwid / 2)}"/>`;
    }
    if (s.avgMs !== null) pts.push(`${x + bw / 2},${yl(s.avgMs)}`);
  });
  const xLabels = series
    .map((s, i) => (i % 4 === 0 ? `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(s.label)}</text>` : ''))
    .join('');
  const grid = ticks
    .map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`)
    .join('');
  const latAxis = lat.length ? `<text x="${W - pad.r + 6}" y="${pad.t + 8}">${esc(ms(maxL))}</text><text x="${W - pad.r + 6}" y="${pad.t + ih}">0</text>` : '';
  const hits = series
    .map((s, i) => `<rect x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent" data-i="${i}"/>`)
    .join('');
  setTimeout(() => {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    const tip = wrap.querySelector('.chart-tip');
    wrap.addEventListener('mousemove', (e) => {
      const r = e.target.closest('rect[data-i]');
      if (!r) return (tip.style.display = 'none');
      const s = series[Number(r.dataset.i)];
      tip.innerHTML = `<b>${esc(s.label)}:00</b> · ${plural(s.requests, 'request')}${s.errors ? ` · <span style="color:var(--err)">${s.errors} failed</span>` : ''}${s.avgMs !== null ? ` · avg ${esc(ms(s.avgMs))}` : ''}`;
      tip.style.display = 'block';
      const box = wrap.getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - tip.offsetWidth - 4, Math.max(4, e.clientX - box.left + 12))}px`;
      tip.style.top = `${e.clientY - box.top - 34}px`;
    });
    wrap.addEventListener('mouseleave', () => (tip.style.display = 'none'));
  });
  return `<div class="chart-wrap" id="${id}">
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Requests and average response time per hour, last 24 hours">
      ${grid}${bars}
      ${pts.length > 1 ? `<polyline class="line" points="${pts.join(' ')}"/>` : ''}
      ${pts.length === 1 ? `<circle cx="${pts[0].split(',')[0]}" cy="${pts[0].split(',')[1]}" r="3" fill="var(--violet)"/>` : ''}
      ${latAxis}${xLabels}${hits}
    </svg>
    <div class="chart-tip" style="display:none"></div>
  </div>`;
}

/* ======================================================= sliding indicator */
// One soft "pill" slides between the active items of a segmented group (nav,
// tabs, chips). Positions are remembered per group, so it still glides when
// the group is re-rendered on navigation.
const indPos = new Map();
function slideInd(container, key) {
  if (!container) return;
  key = key || container.id || container.dataset.seg;
  let ind = container.querySelector(':scope > .seg-ind');
  if (!ind) {
    ind = document.createElement('span');
    ind.className = 'seg-ind';
    container.prepend(ind);
  }
  const act = container.querySelector(':scope > .active');
  if (!act) {
    ind.style.opacity = '0';
    return;
  }
  const next = { x: act.offsetLeft, y: act.offsetTop, w: act.offsetWidth, h: act.offsetHeight };
  const apply = (q) => {
    ind.style.width = `${q.w}px`;
    ind.style.height = `${q.h}px`;
    ind.style.transform = `translate(${q.x}px, ${q.y}px)`;
  };
  const prev = indPos.get(key);
  if (!ind.dataset.placed) {
    ind.style.transition = 'none';
    apply(prev || next);
    void ind.offsetWidth;
    ind.style.transition = '';
    ind.dataset.placed = '1';
  }
  ind.style.opacity = '1';
  requestAnimationFrame(() => apply(next));
  indPos.set(key, next);
}

/* ================================================================= sidebar */
const NAV = [
  { id: 'workers', href: '#/', label: 'Workers', icon: 'grid' },
  { id: 'logs', href: '#/logs', label: 'Live logs', icon: 'logs' },
  { id: 'tunnel', href: '#/tunnel', label: 'Domain & tunnel', icon: 'globe' },
  { id: 'system', href: '#/system', label: 'System', icon: 'cpu' }
];
function renderSide() {
  const page = S.route.page === 'worker' ? 'workers' : S.route.page;
  $('#nav').className = 'seg';
  $('#nav').innerHTML = NAV.map(
    (n) =>
      `<a class="nav-item ${page === n.id ? 'active' : ''}" href="${n.href}">${icon(n.icon)}<span>${n.label}</span>${
        n.id === 'workers' && S.overview ? `<span class="count">${S.overview.workers.length}</span>` : ''
      }</a>`
  ).join('');
  slideInd($('#nav'));
  const ws = [...workersList()].sort((a, b) => a.name.localeCompare(b.name));
  const cur = S.route.page === 'worker' ? S.route.name : '';
  const hourNow = new Date().toISOString().slice(0, 13);
  $('#navWorkers').innerHTML = ws.length
    ? ws
        .map(
          (w) =>
            `<a class="nav-item nav-worker ${cur === w.name ? 'active' : ''}" href="#/w/${enc(w.name)}" title="${esc(w.name)}"><span class="dot ${
              w.hourly && w.hourly[hourNow] ? 'live' : ''
            }"></span><span class="nm">${esc(w.name)}</span>${
              w.requestsToday ? `<span class="count">${num(w.requestsToday)}</span>` : ''
            }</a>`
        )
        .join('')
    : `<div class="hint" style="padding:2px 11px">None yet</div>`;
  $('#navWorkers').className = 'seg';
  slideInd($('#navWorkers'));
  const cfg = S.overview ? S.overview.config : null;
  if (cfg) {
    const host = cfg.subdomain && cfg.rootDomain ? `${cfg.subdomain}.${cfg.rootDomain}` : cfg.rootDomain || location.host;
    $('#hostLabel').textContent = host;
  }
}

function setTopbar(crumbs, actions = '') {
  $('#crumbs').innerHTML = crumbs
    .map((c, i) =>
      i === crumbs.length - 1
        ? `<span class="cur">${c.html || esc(c.label)}</span>`
        : `<a href="${c.href}">${esc(c.label)}</a><span class="sep">/</span>`
    )
    .join('');
  $('#topActions').innerHTML = actions;
}

/* ================================================================== router */
function parseRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'w' && parts[1]) return { page: 'worker', name: parts[1], tab: parts[2] || 'overview' };
  if (['logs', 'tunnel', 'system'].includes(parts[0])) return { page: parts[0] };
  return { page: 'workers' };
}

let leaving = false;
async function route() {
  const next = parseRoute();
  const ide = S.ide;
  const leavingIde = ide && !(next.page === 'worker' && next.name === ide.name && next.tab === 'code');
  if (leavingIde && ide.dirtyCount() > 0 && !leaving) {
    leaving = true;
    const ok = await confirmDialog({
      title: 'Unsaved changes',
      text: `You have unsaved changes in <b>${esc(ide.name)}</b>. Leave without saving?`,
      ok: 'Leave',
      danger: true
    });
    leaving = false;
    if (!ok) {
      history.replaceState(null, '', `#/w/${enc(ide.name)}/code`);
      return;
    }
  }
  if (leavingIde) {
    ide.dispose();
    S.ide = null;
  }
  stopPollers();
  S.route = next;
  closeNav();
  const view = $('#view');
  view.className = '';
  renderSide();
  if (!S.overview) loadOverview().catch(() => {});
  try {
    if (next.page === 'workers') await viewWorkers(view);
    else if (next.page === 'worker') await viewWorker(view, next.name, next.tab);
    else if (next.page === 'logs') await viewLogs(view);
    else if (next.page === 'tunnel') await viewTunnel(view);
    else if (next.page === 'system') await viewSystem(view);
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="empty" style="padding-top:12vh"><h4>That didn't load</h4><p>${esc(err.message)}</p><button class="btn" onclick="route()">Try again</button></div></div>`;
  }
}

/* =========================================================== workers page */
function pageSkeleton(view) {
  view.innerHTML = `<div class="page"><div class="skel" style="height:28px;width:220px;margin-bottom:22px"></div><div class="stats">${'<div class="skel" style="height:92px"></div>'.repeat(5)}</div><div class="workers">${'<div class="skel" style="height:196px"></div>'.repeat(3)}</div></div>`;
}

async function viewWorkers(view) {
  setTopbar([{ label: 'Workers' }], `<button class="btn primary" id="newWorkerTop">New worker</button>`);
  $('#newWorkerTop').onclick = () => newWorkerDialog();
  if (!S.overview) pageSkeleton(view);
  await loadOverview();
  const sortBy = store.get('ax-sort', 'activity');
  view.innerHTML = `<div class="page">
    <div class="page-head">
      <div><h1 class="page-title">Workers</h1><p class="page-sub">Small programs running on ${esc(S.overview.system.hostname || 'this box')}. Save in the editor and they're live.</p></div>
    </div>
    ${S.overview.authEnabled ? '' : `<div class="card card-pad row" style="margin-bottom:18px"><span class="tag warn"><span class="d"></span>No login</span><span class="grow hint" style="color:var(--text-2)">Anyone who can reach this page can run code on ${esc(S.overview.system.hostname || 'this machine')}.</span><a class="btn sm primary" href="#/system">Set a login</a></div>`}
    <div class="figures" id="stats"></div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input class="input" id="wSearch" placeholder="Filter workers…" aria-label="Filter workers" value="${esc(store.get('ax-filter', ''))}"></div>
      <select class="select" id="wSort" style="width:auto" aria-label="Sort workers">
        <option value="activity" ${sortBy === 'activity' ? 'selected' : ''}>Most active today</option>
        <option value="updated" ${sortBy === 'updated' ? 'selected' : ''}>Recently edited</option>
        <option value="name" ${sortBy === 'name' ? 'selected' : ''}>Name</option>
      </select>
    </div>
    <div class="workers" id="wGrid"></div>
  </div>`;
  const paint = () => {
    renderStats();
    renderWorkerGrid();
  };
  $('#wSearch').addEventListener('input', (e) => {
    store.set('ax-filter', e.target.value);
    renderWorkerGrid();
  });
  $('#wSort').addEventListener('change', (e) => {
    store.set('ax-sort', e.target.value);
    renderWorkerGrid();
  });
  paint();
  poll(async () => {
    try {
      await loadOverview();
      if (S.route.page === 'workers') paint();
    } catch (_) {}
  }, 5000);
}

function renderStats() {
  const o = S.overview;
  const sys = o.system;
  const merged = mergeHourly(o.workers);
  const todayMs = o.workers.reduce((acc, w) => {
    const d = w.daily && w.daily[new Date().toISOString().slice(0, 10)];
    if (d) {
      acc.ms += d.totalMs;
      acc.n += d.requests;
    }
    return acc;
  }, { ms: 0, n: 0 });
  const memPct = sys.memoryTotalMb ? Math.round((sys.memoryUsedMb / sys.memoryTotalMb) * 100) : 0;
  const rate = o.totals.requestsToday ? (o.totals.errorsToday / o.totals.requestsToday) * 100 : 0;
  const errRate = rate > 0 && rate < 0.1 ? '<0.1' : rate.toFixed(1);
  const lastHour = merged[new Date().toISOString().slice(0, 13)];
  const temp = sys.cpuTempC !== null && sys.cpuTempC !== undefined;
  $('#stats').innerHTML = `
    <div class="fig"><div class="k">Workers</div><div class="v">${num(o.totals.workers)}</div><div class="f">${o.defaultWorker ? `${esc(o.defaultWorker)} is the default` : 'No default worker'}</div></div>
    <div class="fig"><div class="k">Requests today</div><div class="v">${num(o.totals.requestsToday)}</div><div class="f">${lastHour ? `${num(lastHour.requests)} in the last hour` : 'Quiet this hour'}</div></div>
    <div class="fig"><div class="k">Errors today</div><div class="v ${o.totals.errorsToday ? 'err' : ''}">${num(o.totals.errorsToday)}<small>${errRate}%</small></div><div class="f">Responses over 500</div></div>
    <div class="fig"><div class="k">Typical response</div><div class="v">${todayMs.n ? esc(ms(todayMs.ms / todayMs.n)) : '—'}</div><div class="f">Average across today</div></div>
    <div class="fig"><div class="k">${esc(sys.hostname || 'Host')}</div><div class="v">${temp ? `${sys.cpuTempC}<small>°C</small>` : `${(sys.loadAvg || [0])[0]}<small>load</small>`}</div><div class="f">Memory ${memPct}% · load ${(sys.loadAvg || [0])[0]}</div><div class="meter"><i style="width:${memPct}%"></i></div></div>`;
}

function renderWorkerGrid() {
  const q = ($('#wSearch')?.value || '').trim().toLowerCase();
  const sortBy = $('#wSort')?.value || 'activity';
  let ws = workersList().filter((w) => !q || `${w.name} ${w.language} ${w.publishingLink}`.toLowerCase().includes(q));
  ws.sort((a, b) =>
    sortBy === 'name'
      ? a.name.localeCompare(b.name)
      : sortBy === 'updated'
      ? new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
      : b.requestsToday - a.requestsToday || new Date(b.lastRunAt || 0) - new Date(a.lastRunAt || 0)
  );
  const def = S.overview.defaultWorker;
  const cards = ws
    .map((w) => {
      const status = w.activeIssues
        ? `<span class="tag err"><span class="d"></span>${plural(w.activeIssues, 'issue')}</span>`
        : w.productionUrlEnabled === false
        ? `<span class="tag warn"><span class="d"></span>Off</span>`
        : `<span class="tag ok"><span class="d"></span>Live</span>`;
      return `<a class="card wcard" href="#/w/${enc(w.name)}">
        <div class="wcard-top">${langIcon(w.language)}
          <div style="min-width:0"><div class="wname">${esc(w.name)}${def === w.name ? `<span class="def" title="Answers every path no other worker claims">default</span>` : ''}</div><div class="wlink">${esc(w.publishingPath)}</div></div>
          ${status}
        </div>
        ${sparkStrip(w.hourly)}
        <div class="wnums">
          <div><b>${num(w.requestsToday)}</b>today</div>
          <div><b class="${w.errorsToday ? 'err' : ''}">${num(w.errorsToday)}</b>errors</div>
          <div><b>${esc(ms(w.lastDurationMs))}</b>last run</div>
        </div>
        <div class="wfoot">
          <span>${esc(langName(w.language))} · ${plural(w.fileCount, 'file')} · edited ${esc(ago(w.updatedAt))}</span>
          <span class="acts">
            <button class="icon-btn sm" title="Edit code" data-act="code" data-w="${esc(w.name)}">${icon('code')}</button>
            <button class="icon-btn sm" title="Open ${esc(w.publishingPath)}" data-act="open" data-w="${esc(w.name)}">${icon('external')}</button>
          </span>
        </div>
      </a>`;
    })
    .join('');
  const grid = $('#wGrid');
  if (!grid) return;
  grid.innerHTML =
    cards +
    `<button class="new-card" id="newCard" type="button"><b>New worker</b><span class="hint">JavaScript, TypeScript, Python, Shell or a page</span></button>`;
  if (!ws.length && q) grid.insertAdjacentHTML('afterbegin', `<div class="empty" style="grid-column:1/-1"><h4>Nothing matches “${esc(q)}”</h4></div>`);
  $('#newCard').onclick = () => newWorkerDialog();
  grid.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    e.preventDefault();
    const w = findWorker(b.dataset.w);
    if (b.dataset.act === 'code') location.hash = `#/w/${enc(b.dataset.w)}/code`;
    if (b.dataset.act === 'open' && w) window.open(w.publishingPath, '_blank', 'noopener');
  };
}

/* ============================================================ new worker */
function newWorkerDialog() {
  let chosen = 'javascript';
  modal({
    title: 'New worker',
    body: `<div class="field"><label for="nwName">Name</label><input id="nwName" class="input mono" placeholder="my-worker" autocomplete="off" autofocus maxlength="64">
      <span class="hint" id="nwHint">Letters, numbers, dots, dashes. It'll answer at <b class="mono">/<span id="nwPath">my-worker</span></b></span></div>
      <div class="field"><span class="label">Start from</span><div class="tpl-grid" id="nwTpl">${TEMPLATES.map(
        (t) => `<button type="button" class="tpl ${t.id === chosen ? 'on' : ''}" data-t="${t.id}">${langIcon(t.id, 'sm')}<b>${esc(t.name)}</b><span>${esc(t.desc)}</span></button>`
      ).join('')}</div></div>`,
    foot: `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="nwGo">Create worker</button>`,
    onMount(ov, close) {
      const name = $('#nwName', ov);
      const clean = (v) => v.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 64);
      name.addEventListener('input', () => {
        const c = clean(name.value);
        $('#nwPath', ov).textContent = c || 'my-worker';
        const taken = findWorker(c);
        $('#nwHint', ov).style.color = taken ? 'var(--err)' : '';
        if (taken) $('#nwHint', ov).textContent = `"${c}" already exists`;
        else $('#nwHint', ov).innerHTML = `Letters, numbers, dots, dashes. It'll answer at <b class="mono">/${esc(c || 'my-worker')}</b>`;
      });
      $('#nwTpl', ov).addEventListener('click', (e) => {
        const b = e.target.closest('.tpl');
        if (!b) return;
        chosen = b.dataset.t;
        $$('.tpl', ov).forEach((x) => x.classList.toggle('on', x === b));
      });
      const go = async () => {
        const n = clean(name.value);
        if (!n) return name.focus();
        $('#nwGo', ov).disabled = true;
        const r = await attempt(() => api('POST', '/api/workers', { name: n, language: chosen }));
        $('#nwGo', ov).disabled = false;
        if (!r) return;
        close();
        toast(`Created ${n}`);
        await loadOverview();
        location.hash = `#/w/${enc(n)}/code`;
      };
      $('#nwGo', ov).onclick = go;
      name.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    }
  });
}

/* ============================================================ worker page */
const WTABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'code', label: 'Code' },
  { id: 'logs', label: 'Logs' },
  { id: 'deployments', label: 'Versions' },
  { id: 'kv', label: 'Storage' },
  { id: 'settings', label: 'Settings' }
];

async function viewWorker(view, name, tab) {
  if (!WTABS.some((t) => t.id === tab)) tab = 'overview';
  const data = await api('GET', `/api/workers/${enc(name)}`).catch((err) => {
    if (/not found/i.test(err.message)) {
      view.innerHTML = `<div class="page"><div class="empty" style="padding-top:12vh"><h4>No worker called “${esc(name)}”</h4><p>It may have been renamed or deleted.</p><a class="btn" href="#/">Back to workers</a></div></div>`;
      setTopbar([{ label: 'Workers', href: '#/' }, { label: name }]);
      return null;
    }
    throw err;
  });
  if (!data) return;
  if (!S.overview) loadOverview().catch(() => {});
  const w = data.worker;
  setTopbar(
    [{ label: 'Workers', href: '#/' }, { html: `<span class="row" style="gap:8px">${langIcon(w.language, 'sm')}${esc(w.name)}</span>` }],
    `<a class="btn ghost" href="${esc(w.summary.publishingPath)}" target="_blank" rel="noopener">Visit ${icon('external')}</a>
     ${tab !== 'code' ? `<a class="btn primary" href="#/w/${enc(w.name)}/code">Edit code</a>` : ''}`
  );
  const tabsHtml = `<div class="tabs" role="tablist" data-seg="wtabs">${WTABS.map(
    (t) =>
      `<a class="tab ${t.id === tab ? 'active' : ''}" role="tab" aria-selected="${t.id === tab}" href="#/w/${enc(w.name)}/${t.id}">${t.label}${
        t.id === 'deployments' && w.deployments.length ? `<span class="n">${w.deployments.length}</span>` : ''
      }${t.id === 'kv' && w.kv && w.kv.keys ? `<span class="n">${w.kv.keys}</span>` : ''}${t.id === 'overview' && w.summary.activeIssues ? `<span class="n err">${w.summary.activeIssues}</span>` : ''}</a>`
  ).join('')}</div>`;
  const head = `<div class="page-head" style="margin-bottom:18px"><div style="min-width:0"><h1 class="page-title">${esc(w.name)}</h1>
    <p class="page-sub"><span class="mono">${esc(w.summary.publishingPath)}</span> · ${esc(langName(w.language))} · ${esc(RUNTIME_OF(w.language))} · edited ${esc(ago(w.updatedAt))}</p></div></div>`;

  if (tab === 'code') {
    view.className = '';
    view.innerHTML = `<div class="ide-wrap"><div class="ide-top">${tabsHtml}<span class="grow"></span><span id="ideBar" class="row"></span></div><div id="ideRoot"></div></div>`;
    slideInd($('.tabs', view));
    await mountIde($('#ideRoot'), w);
    return;
  }
  view.innerHTML = `<div class="page">${head}<div style="margin-bottom:26px">${tabsHtml}</div><div id="tabBody"></div></div>`;
  slideInd($('.tabs', view));
  const body = $('#tabBody');
  if (tab === 'overview') renderWorkerOverview(body, w);
  if (tab === 'logs') renderWorkerLogs(body, w);
  if (tab === 'deployments') renderDeployments(body, w);
  if (tab === 'kv') renderKv(body, w);
  if (tab === 'settings') renderSettings(body, w);
}

/* ---------------------------------------------------------------- overview */
function statusClass(s) {
  return `s${String(s || 0)[0]}`;
}
function renderWorkerOverview(body, w) {
  const paint = (w) => {
    const sm = w.summary;
    const inv = (w.invocations || []).slice().reverse();
    const statusCounts = inv.reduce((acc, i) => {
      const k = `${String(i.status)[0]}xx`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const durations = inv.map((i) => i.durationMs).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const pct = (p) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))] : null);
    const issues = (w.issues || []).filter((i) => i.status === 'active');
    const links = [sm.publishingPath, ...(w.customRoutes || []).map((r) => r.path || r.pattern)];
    body.innerHTML = `
      <div class="figures four">
        <div class="fig"><div class="k">Requests today</div><div class="v">${num(sm.requestsToday)}</div><div class="f">${num(sm.requests)} all time</div></div>
        <div class="fig"><div class="k">Errors today</div><div class="v ${sm.errorsToday ? 'err' : ''}">${num(sm.errorsToday)}</div><div class="f">${num(w.errors || 0)} all time</div></div>
        <div class="fig"><div class="k">Response time</div><div class="v">${esc(ms(pct(50)))}<small>median</small></div><div class="f">95th percentile ${esc(ms(pct(95)))}</div></div>
        <div class="fig"><div class="k">Last request</div><div class="v">${esc(ago(sm.lastRunAt))}</div><div class="f">${bytes(sm.totalBytesServed)} served so far</div></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3>Last 24 hours</h3><div class="tools legend"><span><i style="background:var(--chart)"></i>requests</span><span><i style="background:var(--err)"></i>errors</span><span><i style="background:var(--chart-2);height:2px"></i>average response</span></div></div>
        <div class="card-body">${hourChart(w.hourly)}</div>
      </div>
      ${
        issues.length
          ? `<div class="card" style="margin-bottom:16px">
        <div class="card-head"><h3 style="color:var(--err)">${plural(issues.length, 'active issue')}</h3><span class="sub">Repeated errors are grouped</span></div>
        ${issues
          .map(
            (i) => `<div class="set-row"><div style="min-width:0"><h4 class="mono" style="font-size:12.5px;overflow-wrap:anywhere">${esc(i.title)}</h4><p>${plural(i.occurrences || 1, 'time')} · first ${esc(ago(i.firstSeen))} · last ${esc(ago(i.lastSeen))}${i.filename ? ` · ${esc(i.filename)}` : ''}</p></div>
            <div class="row"><button class="btn sm" data-issue-view="${esc(i.id)}">Details</button><button class="btn sm" data-resolve="${esc(i.id)}">${icon('check')} Resolve</button></div></div>`
          )
          .join('')}
      </div>`
          : ''
      }
      <div class="grid2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><h3>Where it answers</h3><a class="tools btn sm ghost" href="#/w/${enc(w.name)}/settings">${icon('edit')} Edit</a></div>
          <div class="card-body stack" style="gap:8px">
            ${links
              .map((l) => {
                const full = /^https?:/i.test(l) ? l : `${location.origin}${l}`;
                return `<div class="copy-line"><span>${esc(full)}</span><button class="icon-btn sm" data-copy="${esc(full)}" title="Copy">${icon('copy')}</button><a class="icon-btn sm" href="${esc(l)}" target="_blank" rel="noopener" title="Open">${icon('external')}</a></div>`;
              })
              .join('')}
            ${w.isDefault ? `<p class="hint" style="margin:4px 0 0">This is the default worker, so it also answers any path no other worker claims.</p>` : ''}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Status codes</h3><span class="sub">last ${inv.length} requests</span></div>
          <div class="card-body">${
            inv.length
              ? ['2xx', '3xx', '4xx', '5xx']
                  .map((k) => {
                    const n = statusCounts[k] || 0;
                    const p = Math.round((n / inv.length) * 100);
                    const col = { '2xx': 'var(--ok)', '3xx': 'var(--chart)', '4xx': 'var(--warn)', '5xx': 'var(--err)' }[k];
                    return `<div style="display:grid;grid-template-columns:38px 1fr 54px;gap:10px;align-items:center;margin:6px 0;font-size:12.5px"><span class="mono">${k}</span><div class="meter" style="margin:0;height:7px"><i style="width:${p}%;background:${col}"></i></div><span class="mono" style="text-align:right;color:var(--muted)">${num(n)}</span></div>`;
                  })
                  .join('')
              : `<div class="hint">No requests yet. Open it, or send one from the Code tab.</div>`
          }</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Recent requests</h3><span class="live">live</span><a class="tools btn sm ghost" href="#/w/${enc(w.name)}/logs">All logs</a></div>
        ${
          inv.length
            ? `<div class="table-scroll"><table class="table"><thead><tr><th>Time</th><th>Request</th><th>Status</th><th class="num">Duration</th><th class="num">Size</th><th>Client</th></tr></thead><tbody>${inv
                .slice(0, 15)
                .map(
                  (i) => `<tr><td class="mono" style="color:var(--muted)" title="${esc(i.timestamp)}">${esc(clock(i.timestamp))}</td><td class="mono" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b style="font-weight:600">${esc(i.method)}</b> ${esc(i.path)}</td><td><span class="status ${statusClass(i.status)}">${esc(i.status)}</span></td><td class="num">${esc(ms(i.durationMs))}</td><td class="num">${bytes(i.responseBytes)}</td><td style="color:var(--muted);font-size:12.5px;white-space:nowrap">${esc(i.clientIp)} · ${esc(i.browser)}</td></tr>`
                )
                .join('')}</tbody></table></div>`
            : `<div class="empty"><h4>No requests yet</h4><p>They'll appear here as they happen.</p></div>`
        }
      </div>`;
  };
  paint(w);
  body.onclick = async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copy(c.dataset.copy);
    const r = e.target.closest('[data-resolve]');
    if (r) {
      await attempt(() => api('POST', `/api/workers/${enc(w.name)}/issues`, { resolveIssueId: r.dataset.resolve }), 'Issue resolved');
      return refresh();
    }
    const iv = e.target.closest('[data-issue-view]');
    if (iv) {
      const iss = (w.issues || []).find((i) => i.id === iv.dataset.issueView);
      if (iss) modal({ title: 'Issue details', wide: true, body: `<pre class="code-view">${esc(iss.message)}</pre>` });
    }
  };
  const refresh = async () => {
    try {
      const d = await api('GET', `/api/workers/${enc(w.name)}`);
      w = d.worker;
      if (S.route.page === 'worker' && S.route.tab === 'overview') paint(w);
    } catch (_) {}
  };
  poll(refresh, 4000);
}

/* -------------------------------------------------------------------- logs */
function logLineHtml(entry, fresh, workerName) {
  if (entry._req) {
    const i = entry;
    return `<div class="logline ${fresh ? 'new' : ''}" data-lv="req"><span class="t">${esc(clock(i.timestamp))}</span><span class="lv req">${esc(i.method)}</span><span class="m">${workerName ? `<span class="w">${esc(workerName)}</span>` : ''}<span class="status ${statusClass(i.status)}">${esc(i.status)}</span> ${esc(i.path)} · ${esc(ms(i.durationMs))} · ${bytes(i.responseBytes)} · ${esc(i.clientIp)}</span></div>`;
  }
  const lv = String(entry.level || 'log').toLowerCase();
  return `<div class="logline ${fresh ? 'new' : ''}" data-lv="${esc(lv)}"><span class="t">${esc(clock(entry.timestamp))}</span><span class="lv ${esc(lv)}">${esc(lv)}</span><span class="m">${workerName ? `<span class="w">${esc(workerName)}</span>` : ''}${esc(entry.message)}</span></div>`;
}

// Live tail of one or more workers: merges logs and requests by timestamp.
function createTail({ box, workers, filter, onCount, showWorker = false, max = 800 }) {
  const since = {};
  let entries = [];
  let paused = false;
  let first = true;
  const render = (freshIds = new Set()) => {
    const f = filter();
    const shown = entries.filter((e) => {
      const lv = e._req ? 'req' : String(e.level || 'log').toLowerCase();
      if (!f.levels.has(lv === 'log' ? 'info' : lv)) return false;
      if (f.q) {
        const hay = e._req ? `${e.method} ${e.path} ${e.status} ${e.clientIp}` : String(e.message);
        if (!hay.toLowerCase().includes(f.q)) return false;
      }
      return true;
    });
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = shown.length
      ? shown.map((e) => logLineHtml(e, freshIds.has(e._id), showWorker ? e._w : '')).join('')
      : `<div class="empty"><h4>${entries.length ? 'Nothing matches the filter' : 'Quiet so far'}</h4><p>${entries.length ? '' : 'Requests, console.log() output and errors appear here as they happen.'}</p></div>`;
    if (nearBottom || first) box.scrollTop = box.scrollHeight;
    first = false;
    if (onCount) onCount(shown.length, entries.length);
  };
  const fetchOnce = async () => {
    if (paused) return;
    const fresh = new Set();
    for (const name of workers()) {
      try {
        const d = await api('GET', `/api/workers/${enc(name)}/activity${since[name] ? `?since=${enc(since[name])}` : ''}`);
        const add = [
          ...d.logs.map((l) => ({ ...l, _w: name, _id: `l${name}${l.id}` })),
          ...d.invocations.map((i) => ({ ...i, _req: true, _w: name, _id: `i${name}${i.id}` }))
        ];
        if (since[name]) add.forEach((a) => fresh.add(a._id));
        since[name] = d.now;
        entries.push(...add);
      } catch (_) {}
    }
    entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    if (entries.length > max) entries = entries.slice(-max);
    render(fresh);
  };
  return {
    start() {
      fetchOnce();
      poll(fetchOnce, 2000);
    },
    render: () => render(),
    clear() {
      entries = [];
      render();
    },
    setPaused(v) {
      paused = v;
    },
    refetch: fetchOnce
  };
}

function logsToolbar(id) {
  return `<div class="toolbar" style="margin:0;padding:14px 16px 8px">
    <div class="search" style="max-width:280px">${icon('search')}<input class="input" id="${id}Q" placeholder="Filter…" aria-label="Filter logs"></div>
    <div class="chips" id="${id}Lv">${['req', 'info', 'warn', 'error']
      .map((l) => `<button type="button" class="chip on" data-lv="${l}">${{ req: 'Requests', info: 'Info', warn: 'Warnings', error: 'Errors' }[l]}</button>`)
      .join('')}</div>
    <span class="hint" id="${id}Count" style="margin-left:auto"></span>
    <button class="btn sm" id="${id}Pause">${icon('pause')} Pause</button>
  </div>`;
}
function wireLogsToolbar(id, tail) {
  const levels = new Set(['req', 'info', 'warn', 'error']);
  $(`#${id}Q`).addEventListener('input', debounce(() => tail.render(), 120));
  $(`#${id}Lv`).addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    c.classList.toggle('on');
    c.classList.contains('on') ? levels.add(c.dataset.lv) : levels.delete(c.dataset.lv);
    tail.render();
  });
  let paused = false;
  $(`#${id}Pause`).onclick = (e) => {
    paused = !paused;
    tail.setPaused(paused);
    e.currentTarget.innerHTML = paused ? `${icon('play')} Resume` : `${icon('pause')} Pause`;
    if (!paused) tail.refetch();
  };
  return () => ({ levels, q: ($(`#${id}Q`).value || '').trim().toLowerCase() });
}

function renderWorkerLogs(body, w) {
  body.innerHTML = `<div class="card">
    ${logsToolbar('wl')}
    <div class="logbox" id="wlBox" style="height:calc(100vh - 290px);min-height:320px"></div>
    <div class="card-head" style="padding-bottom:16px"><span class="live">Live, every 2 seconds</span>
      <div class="tools"><button class="btn sm danger" id="wlClear">Clear logs</button></div></div>
  </div>`;
  let getFilter = () => ({ levels: new Set(['req', 'info', 'warn', 'error']), q: '' });
  const tail = createTail({
    box: $('#wlBox'),
    workers: () => [w.name],
    filter: () => getFilter(),
    onCount: (shown, total) => ($('#wlCount').textContent = `${num(shown)} of ${num(total)} lines`)
  });
  getFilter = wireLogsToolbar('wl', tail);
  tail.start();
  $('#wlClear').onclick = async () => {
    if (!(await confirmDialog({ title: 'Clear logs', text: `Delete all stored logs and the request history of <b>${esc(w.name)}</b>?`, ok: 'Clear', danger: true }))) return;
    await attempt(() => api('DELETE', `/api/workers/${enc(w.name)}/logs?invocations=1`), 'Logs cleared');
    tail.clear();
  };
}

/* ------------------------------------------------------------- versions */
function renderDeployments(body, w) {
  const deps = w.deployments || [];
  body.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="card-body row">
      <div class="grow"><b style="font-weight:600">A version is a snapshot of every file.</b><div class="hint">Saving in the editor goes live straight away. Make a version first when you want something to roll back to.</div></div>
      <button class="btn primary" id="depNew">Make a version now</button>
    </div></div>
    <div class="card">
      <div class="card-head"><h3>History</h3><span class="sub">${plural(deps.length, 'version')} · newest first · keeps 25</span></div>
      ${
        deps.length
          ? `<ul class="timeline">${deps
              .map(
                (d) => `<li class="${d.id === w.deployId ? 'current' : ''}">
              <span class="node"></span>
              <div style="min-width:0">
                <div class="row" style="gap:8px"><span class="id">${esc(d.id)}</span>${d.id === w.deployId ? '<span class="tag ok"><span class="d"></span>Current</span>' : ''}<span style="color:var(--text-2)">${esc(d.source || 'Saved')}</span></div>
                <div class="meta">${esc(ago(d.timestamp))} · ${esc(new Date(d.timestamp).toLocaleString())} · by ${esc(d.author || 'admin')} · ${esc((d.fileNames || [d.filename]).join(', '))}</div>
              </div>
              <div class="row" style="gap:6px">
                ${d.hasSnapshot ? `<button class="btn sm" data-view="${esc(d.id)}">${icon('eye')} View</button>` : ''}
                ${d.id !== w.deployId && d.hasSnapshot ? `<button class="btn sm" data-rollback="${esc(d.id)}">${icon('undo')} Roll back</button>` : ''}
              </div>
            </li>`
              )
              .join('')}</ul>`
          : `<div class="empty"><h4>No versions yet</h4></div>`
      }
    </div>`;
  $('#depNew').onclick = async () => {
    const r = await attempt(() => api('POST', `/api/workers/${enc(w.name)}/deployments`, { source: 'Created from dashboard' }));
    if (r) {
      toast(`Version ${r.worker.deployId} created`);
      route();
    }
  };
  body.onclick = async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) {
      const snap = await attempt(() => api('GET', `/api/workers/${enc(w.name)}/deployments/${v.dataset.view}`));
      if (!snap) return;
      const names = Object.keys(snap.files);
      modal({
        title: `Version ${snap.id}`,
        wide: true,
        body: `<div class="chips" id="snapFiles">${names.map((n, i) => `<button class="chip ${i ? '' : 'on'}" data-f="${esc(n)}">${esc(n)}</button>`).join('')}</div><pre class="code-view" id="snapCode"></pre>`,
        onMount(ov) {
          const show = (n) => {
            $('#snapCode', ov).innerHTML =
              typeof window.vscodeHighlight === 'function' ? window.vscodeHighlight(snap.files[n], langOfFile(n)) : esc(snap.files[n]);
            $$('#snapFiles .chip', ov).forEach((c) => c.classList.toggle('on', c.dataset.f === n));
          };
          $('#snapFiles', ov).onclick = (ev) => {
            const c = ev.target.closest('.chip');
            if (c) show(c.dataset.f);
          };
          if (names[0]) show(names[0]);
        }
      });
    }
    const rb = e.target.closest('[data-rollback]');
    if (rb) {
      const ok = await confirmDialog({
        title: `Roll back to ${rb.dataset.rollback}?`,
        text: `Every file of <b>${esc(w.name)}</b> is replaced with that version and goes live immediately. Files that version didn't have are removed.`,
        ok: 'Roll back',
        danger: true
      });
      if (!ok) return;
      const r = await attempt(() => api('POST', `/api/workers/${enc(w.name)}/deployments`, { action: 'rollback', versionId: rb.dataset.rollback }));
      if (r) {
        toast(`Rolled back to ${rb.dataset.rollback}`);
        route();
      }
    }
  };
}

/* ------------------------------------------------------------------ storage */
function renderKv(body, w) {
  const base = `/api/workers/${enc(w.name)}/kv`;
  body.innerHTML = `
    <div class="figures three" id="kvFigs"></div>
    <div class="grid2" style="align-items:start;margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>Use it from your code</h3></div>
        <div class="card-body"><pre class="code-view" style="max-height:none;background:var(--card)">${esc(`await env.KV.put('visits', String(n), { expirationTtl: 3600 });
const visits = await env.KV.get('visits');            // string or null
const prefs  = await env.KV.get('prefs', 'json');      // parsed JSON
const { keys } = await env.KV.list({ prefix: 'user:' });
await env.KV.delete('visits');`)}</pre>
          <p class="hint" style="margin:10px 0 0">Python and Shell workers get <span class="mono">AX_KV_URL</span> and <span class="mono">AX_KV_TOKEN</span>: GET / PUT / DELETE <span class="mono">$AX_KV_URL/&lt;key&gt;</span> with header <span class="mono">x-ax-token</span>.</p></div>
      </div>
      <form class="card" id="kvAdd">
        <div class="card-head"><h3>Add or change a key</h3></div>
        <div class="card-body stack">
          <div class="field"><label for="kvK">Key</label><input class="input mono" id="kvK" placeholder="user:42" required></div>
          <div class="field"><label for="kvV">Value</label><textarea class="textarea mono" id="kvV" rows="3" placeholder='{"theme":"cream"}'></textarea></div>
          <div class="row"><div class="field" style="width:160px"><label for="kvT">Expires after</label><select class="select" id="kvT"><option value="0">Never</option><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">1 week</option></select></div><span class="grow"></span><button class="btn primary" style="align-self:flex-end">Save key</button></div>
        </div>
      </form>
    </div>
    <div class="card">
      <div class="toolbar" style="margin:0;padding:14px 16px 8px"><div class="search">${icon('search')}<input class="input" id="kvQ" placeholder="Filter by prefix…" aria-label="Filter keys by prefix"></div><span class="grow"></span><button class="btn sm danger" id="kvClear" type="button">Delete all keys</button></div>
      <div id="kvList"></div>
    </div>`;
  const load = async () => {
    const d = await attempt(() => api('GET', `${base}?prefix=${enc($('#kvQ').value.trim())}&limit=100`));
    if (!d) return;
    $('#kvFigs').innerHTML = `
      <div class="fig"><div class="k">Keys</div><div class="v">${num(d.totalKeys)}</div><div class="f">${d.list_complete ? 'All shown below' : 'First 100 shown'}</div></div>
      <div class="fig"><div class="k">Size</div><div class="v">${bytes(d.totalBytes)}</div><div class="f">of 128 MB for this worker</div><div class="meter"><i style="width:${Math.min(100, (d.totalBytes / (128 * 1024 * 1024)) * 100)}%"></i></div></div>
      <div class="fig"><div class="k">Stored at</div><div class="v" style="font-size:15px;padding-top:10px" class="mono">storage/kv/${esc(w.name)}.json</div><div class="f">Survives restarts and updates</div></div>`;
    $('#kvList').innerHTML = d.keys.length
      ? `<div class="table-scroll"><table class="table"><thead><tr><th>Key</th><th>Value</th><th class="num">Size</th><th>Expires</th><th></th></tr></thead><tbody>${d.keys
          .map(
            (k) => `<tr><td class="mono">${esc(k.name)}</td><td class="mono" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-2)">${k.preview === null ? '<span class="hint">binary</span>' : esc(k.preview)}</td><td class="num">${bytes(k.size)}</td><td style="color:var(--muted)">${k.expiration ? esc(until(new Date(k.expiration * 1000).toISOString())) : 'never'}</td><td style="text-align:right;white-space:nowrap"><button class="icon-btn sm" data-edit="${esc(k.name)}" title="Edit">${icon('edit')}</button><button class="icon-btn sm" data-del="${esc(k.name)}" title="Delete">${icon('trash')}</button></td></tr>`
          )
          .join('')}</tbody></table></div>`
      : `<div class="empty"><h4>No keys${$('#kvQ').value ? ' with that prefix' : ' yet'}</h4><p>Write some with <span class="mono">env.KV.put()</span> or the form above.</p></div>`;
    body.__keys = d.keys;
  };
  $('#kvQ').addEventListener('input', debounce(load, 200));
  $('#kvAdd').onsubmit = async (e) => {
    e.preventDefault();
    const r = await attempt(() => api('PUT', base, { key: $('#kvK').value.trim(), value: $('#kvV').value, ttl: Number($('#kvT').value) }), 'Key saved');
    if (r) {
      $('#kvV').value = '';
      load();
    }
  };
  $('#kvClear').onclick = async () => {
    if (!(await confirmDialog({ title: 'Delete every key?', text: `This empties the KV store of <b>${esc(w.name)}</b>.`, ok: 'Delete all', danger: true, typeToConfirm: w.name }))) return;
    if (await attempt(() => api('DELETE', `${base}?all=1`), 'All keys deleted')) load();
  };
  $('#kvList').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      if (await attempt(() => api('DELETE', `${base}?key=${enc(del.dataset.del)}`), 'Key deleted')) load();
      return;
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const k = (body.__keys || []).find((x) => x.name === ed.dataset.edit);
      $('#kvK').value = ed.dataset.edit;
      $('#kvV').value = k && k.preview !== null ? k.preview : '';
      $('#kvV').focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
  load();
}

/* ---------------------------------------------------------------- settings */
function renderSettings(body, w) {
  const files = (w.files || []).map((f) => f.name);
  const obs = w.observabilityConfig || {};
  const envs = Object.entries(w.bindings || {});
  const crons = w.crons || [];
  body.innerHTML = `
    <div class="stack" style="gap:16px">
    <div class="card">
      <div class="card-head"><h3>Schedules</h3><span class="sub">Run this worker on a timer${RUNTIME_OF(w.language) === 'workerd' ? ' (calls <span class="mono">scheduled()</span>)' : ''}</span>
        <span class="tools"><button class="btn sm ghost" type="button" id="cronTest">Run once now</button></span></div>
      ${crons
        .map(
          (j) => `<div class="set-row"><div style="min-width:0"><h4>${esc(describeCron(j.expr))} <span class="mono hint" style="font-weight:400;margin-left:6px">${esc(j.expr)}</span></h4>
          <p>Next ${esc(j.next ? `${until(j.next)} · ${serverTime(j.next)}` : 'never (check the fields)')}${j.lastRunAt ? ` · last ran ${esc(ago(j.lastRunAt))}, <span class="status ${statusClass(j.lastStatus)}">${esc(j.lastStatus)}</span> in ${esc(ms(j.lastMs))}` : ''}</p></div>
          <div class="row"><button class="btn sm" type="button" data-cron-run="${esc(j.id)}">Run now</button><button class="icon-btn" type="button" data-cron-del="${esc(j.id)}" title="Remove schedule">${icon('x')}</button></div></div>`
        )
        .join('')}
      <form class="card-body row" id="cronAdd" style="${crons.length ? 'border-top:1px solid var(--line);padding-top:16px' : ''}">
        <select class="select" id="cronPreset" style="width:210px" aria-label="Schedule preset">
          <option value="">Pick a schedule…</option><option>*/5 * * * *</option><option>*/15 * * * *</option><option>@hourly</option><option>0 9 * * *</option><option>0 9 * * 1-5</option><option>@daily</option><option>@weekly</option>
        </select>
        <input class="input mono grow" id="cronExpr" placeholder="or type one: minute hour day month weekday" aria-label="Cron expression">
        <button class="btn">Add schedule</button>
        <span class="hint" id="cronHint" style="width:100%"></span>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h3>General</h3></div>
      <div class="set-row"><div><h4>Name</h4><p>Renaming also moves its default URL from /${esc(w.name)}.</p></div>
        <form class="row" id="fRename"><input class="input mono" style="width:220px" id="sName" value="${esc(w.name)}" aria-label="Worker name" maxlength="64"><button class="btn">Rename</button></form></div>
      <div class="set-row"><div><h4>Entry file</h4><p>The file that runs on each request. Its type decides the runtime (${esc(RUNTIME_OF(w.language))} now).</p></div>
        <select class="select" id="sEntry" style="width:220px" aria-label="Entry file">${files.map((f) => `<option ${f === w.filename ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
      <div class="set-row"><div><h4>Default worker</h4><p>Answer every path that no other worker claims (e.g. <span class="mono">/</span>, <span class="mono">/anything</span>). Only one worker can be the default.</p></div>
        <label class="switch"><input type="checkbox" id="sDefault" ${w.isDefault ? 'checked' : ''}><span></span></label></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Routes</h3><span class="sub">Paths that reach this worker</span></div>
      <div class="set-row"><div><h4>Main path</h4><p>A path like <span class="mono">/api</span>, or a full URL on your domain.</p></div>
        <form class="row" id="fMain"><input class="input mono" style="width:260px" id="sMain" value="${esc(w.publishingLink || '/' + w.name)}" aria-label="Main path"><button class="btn">Save</button></form></div>
      <div class="card-body">
        <div class="label" style="margin-bottom:8px">Extra paths</div>
        <div class="stack" style="gap:6px" id="routeList">${
          (w.customRoutes || []).length
            ? w.customRoutes
                .map(
                  (r) => `<div class="copy-line"><span>${esc(r.pattern)}</span><a class="icon-btn sm" href="${esc(r.path || r.pattern)}" target="_blank" rel="noopener" title="Open">${icon('external')}</a><button class="icon-btn sm" data-del-route="${esc(r.id)}" title="Remove">${icon('x')}</button></div>`
                )
                .join('')
            : '<div class="hint">None. The worker also always answers at its name.</div>'
        }</div>
        <form class="row" id="fRoute" style="margin-top:10px"><input class="input mono grow" id="sRoute" placeholder="/another-path" aria-label="New path"><button class="btn">Add path</button></form>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Environment variables</h3><span class="sub">Available as <span class="mono">env.NAME</span> in JS, and as environment variables in Python/Shell</span></div>
      <div class="card-body">
        <div id="envRows">${envs.map(([k, v]) => envRow(k, v)).join('')}</div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="envAdd" type="button">Add a variable</button><span class="grow"></span><button class="btn primary sm" id="envSave" type="button">Save variables</button></div>
        <p class="hint" style="margin:10px 0 0">Stored as plain text in this worker's folder on the Pi.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Logging</h3></div>
      <div class="set-row"><div><h4>Keep logs</h4><p>Store console output and errors (last 200 lines).</p></div><label class="switch"><input type="checkbox" id="sLogs" ${obs.logsEnabled !== false ? 'checked' : ''}><span></span></label></div>
      <div class="set-row"><div><h4>Issue tracking</h4><p>Group repeated 5xx errors into issues on the overview.</p></div><label class="switch"><input type="checkbox" id="sIssues" ${w.issueDetectionEnabled !== false ? 'checked' : ''}><span></span></label></div>
    </div>

    <div class="card danger-zone">
      <div class="set-row"><div><h4>Delete worker</h4><p>Removes its code, versions and logs from the Pi. This can't be undone.</p></div><button class="btn danger" id="sDelete">Delete ${esc(w.name)}</button></div>
    </div>
    </div>`;

  const base = `/api/workers/${enc(w.name)}`;
  const cronApi = (payload, msg) => attempt(() => api('POST', `${base}/schedules`, payload), msg);
  $('#cronPreset').onchange = (e) => {
    $('#cronExpr').value = e.target.value;
    $('#cronHint').textContent = e.target.value ? describeCron(e.target.value) : '';
  };
  $('#cronExpr').addEventListener('input', (e) => ($('#cronHint').textContent = e.target.value.trim() ? describeCron(e.target.value) : ''));
  $('#cronAdd').onsubmit = async (e) => {
    e.preventDefault();
    const expr = $('#cronExpr').value.trim();
    if (!expr) return $('#cronExpr').focus();
    if (await cronApi({ add: expr }, `Scheduled: ${describeCron(expr)}`)) route();
  };
  $('#cronTest').onclick = async () => {
    const r = await cronApi({ run: 'manual' });
    if (r) toast('Ran once. See the Logs tab for output');
  };
  body.addEventListener('click', async (e) => {
    const run = e.target.closest('[data-cron-run]');
    if (run) {
      run.disabled = true;
      if (await cronApi({ run: run.dataset.cronRun }, 'Ran it')) route();
      run.disabled = false;
    }
    const del = e.target.closest('[data-cron-del]');
    if (del && (await cronApi({ remove: del.dataset.cronDel }, 'Schedule removed'))) route();
  });
  $('#fRename').onsubmit = async (e) => {
    e.preventDefault();
    const n = $('#sName').value.trim();
    if (!n || n === w.name) return;
    const r = await attempt(() => api('PUT', base, { newName: n }));
    if (r) {
      toast(`Renamed to ${r.worker.name}`);
      await loadOverview();
      location.hash = `#/w/${enc(r.worker.name)}/settings`;
    }
  };
  $('#sEntry').onchange = async (e) => {
    const r = await attempt(() => api('PUT', `${base}/files`, { filename: e.target.value, setAsEntrypoint: true }), `Entry file is now ${e.target.value}`);
    if (r) route();
  };
  $('#sDefault').onchange = async (e) => {
    const r = await attempt(() => api('POST', '/api/default-worker', { name: e.target.checked ? w.name : '' }));
    if (r) {
      toast(e.target.checked ? `${w.name} is now the default worker` : 'No default worker');
      loadOverview();
    } else e.target.checked = !e.target.checked;
  };
  $('#fMain').onsubmit = async (e) => {
    e.preventDefault();
    const r = await attempt(() => api('POST', `${base}/routes`, { publishingLink: $('#sMain').value.trim() || `/${w.name}` }), 'Main path saved');
    if (r) route();
  };
  $('#fRoute').onsubmit = async (e) => {
    e.preventDefault();
    const p = $('#sRoute').value.trim();
    if (!p) return;
    const r = await attempt(() => api('POST', `${base}/routes`, { addRoute: { pattern: p, type: 'Route' } }), `Added ${p}`);
    if (r) route();
  };
  $('#routeList').onclick = async (e) => {
    const b = e.target.closest('[data-del-route]');
    if (!b) return;
    const r = await attempt(() => api('POST', `${base}/routes`, { removeRouteId: b.dataset.delRoute }), 'Path removed');
    if (r) route();
  };
  $('#envAdd').onclick = () => {
    $('#envRows').insertAdjacentHTML('beforeend', envRow('', ''));
    $$('#envRows .env-row input')[$$('#envRows .env-row input').length - 2].focus();
  };
  $('#envRows').onclick = (e) => {
    const b = e.target.closest('[data-del-env]');
    if (b) b.closest('.env-row').remove();
  };
  $('#envSave').onclick = async () => {
    const out = {};
    for (const row of $$('#envRows .env-row')) {
      const [k, v] = $$('input', row).map((i) => i.value);
      const key = k.trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return toast(`"${key}" isn't a valid variable name (letters, digits, _)`, 'err');
      out[key] = v;
    }
    await attempt(() => api('PUT', base, { bindings: out }), `Saved ${plural(Object.keys(out).length, 'variable')}`);
  };
  const obsSave = (patch) => attempt(() => api('POST', `${base}/observability`, { observabilityConfig: patch }), 'Saved');
  $('#sLogs').onchange = (e) => obsSave({ logsEnabled: e.target.checked });
  $('#sIssues').onchange = (e) => attempt(() => api('POST', `${base}/issues`, { enabled: e.target.checked }), 'Saved');
  $('#sDelete').onclick = async () => {
    const ok = await confirmDialog({
      title: `Delete ${w.name}?`,
      text: `This deletes every file, version and log of this worker from the Pi.`,
      ok: 'Delete forever',
      danger: true,
      typeToConfirm: w.name
    });
    if (!ok) return;
    const r = await attempt(() => api('DELETE', base));
    if (r) {
      toast(`Deleted ${w.name}`);
      await loadOverview();
      location.hash = '#/';
    }
  };
}
function envRow(k, v) {
  return `<div class="env-row"><input class="input mono" placeholder="NAME" value="${esc(k)}" aria-label="Variable name" spellcheck="false"><input class="input mono" placeholder="value" value="${esc(v)}" aria-label="Variable value" spellcheck="false"><button class="icon-btn" type="button" data-del-env title="Remove">${icon('x')}</button></div>`;
}

/* ===================================================================== IDE */
const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';
let monacoPromise = null;
function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (store.get('ax-editor', 'monaco') === 'basic') return Promise.reject(new Error('basic editor chosen'));
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Monaco took too long to load')), 9000);
    const s = document.createElement('script');
    s.src = `${MONACO_BASE}/vs/loader.js`;
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Monaco could not be loaded (offline?)'));
    };
    s.onload = () => {
      // workers from a CDN need a same-origin data: shim
      window.MonacoEnvironment = {
        getWorkerUrl() {
          return `data:text/javascript;charset=utf-8,${encodeURIComponent(
            `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}/'};importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`
          )}`;
        }
      };
      window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
      window.require(
        ['vs/editor/editor.main'],
        () => {
          clearTimeout(timer);
          defineMonacoThemes(window.monaco);
          resolve(window.monaco);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    };
    document.head.appendChild(s);
  }).catch((err) => {
    monacoPromise = null;
    throw err;
  });
  return monacoPromise;
}
function defineMonacoThemes(monaco) {
  monaco.editor.defineTheme('ax-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e9e3d8' },
      { token: 'comment', foreground: '6f695f', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'd9c3a0' },
      { token: 'string', foreground: 'b7c99f' },
      { token: 'number', foreground: 'e6b98a' },
      { token: 'regexp', foreground: 'e6b98a' },
      { token: 'type', foreground: 'c9b6e0' },
      { token: 'delimiter', foreground: '9a9286' }
    ],
    colors: {
      'editor.background': '#1a1917',
      'editor.foreground': '#e9e3d8',
      'editor.lineHighlightBackground': '#211f1d',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#4f4a43',
      'editorLineNumber.activeForeground': '#b9b1a4',
      'editor.selectionBackground': '#ecdcbf33',
      'editor.inactiveSelectionBackground': '#ecdcbf1c',
      'editorCursor.foreground': '#ecdcbf',
      'editorIndentGuide.background1': '#2a2826',
      'editorIndentGuide.activeBackground1': '#3a3734',
      'editorWidget.background': '#211f1d',
      'editorWidget.border': '#33302c',
      'editorSuggestWidget.selectedBackground': '#2c2a27',
      'scrollbarSlider.background': '#ecdcbf1a',
      'scrollbarSlider.hoverBackground': '#ecdcbf2e'
    }
  });
  monaco.editor.defineTheme('ax-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '2a251e' },
      { token: 'comment', foreground: 'a0968a', fontStyle: 'italic' },
      { token: 'keyword', foreground: '8a5a2b' },
      { token: 'string', foreground: '4f7a3f' },
      { token: 'number', foreground: 'a3601f' },
      { token: 'type', foreground: '6b4f8a' }
    ],
    colors: {
      'editor.background': '#f9f6f1',
      'editor.lineHighlightBackground': '#f1ece4',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#c4baab',
      'editorLineNumber.activeForeground': '#6d6355',
      'editor.selectionBackground': '#2a251e1f',
      'editorCursor.foreground': '#2a251e',
      'editorIndentGuide.background1': '#e8e1d6'
    }
  });
}

// Editor backends share one tiny interface: open(file), value(), dispose(), layout(), setTheme()
function monacoBackend(monaco, host, ide) {
  const models = new Map();
  const viewStates = new Map();
  let current = null;
  const editor = monaco.editor.create(host, {
    theme: S.theme === 'light' ? 'ax-light' : 'ax-dark',
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    fontSize: 13,
    lineHeight: 21,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    automaticLayout: true,
    tabSize: 2,
    padding: { top: 12 },
    renderLineHighlight: 'all',
    fixedOverflowWidgets: true
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => ide.save());
  editor.onDidChangeModelContent(() => {
    if (current) ide.onEdit(current, editor.getValue());
  });
  const uri = (f) => monaco.Uri.parse(`file:///${enc(ide.name)}/${enc(f)}`);
  return {
    kind: 'monaco',
    open(f) {
      if (current) viewStates.set(current, editor.saveViewState());
      let m = models.get(f);
      if (!m) {
        m = monaco.editor.createModel(ide.files.get(f).current, EXT_TO_MONACO[extOf(f)] || 'plaintext', uri(f));
        models.set(f, m);
      }
      current = f;
      editor.setModel(m);
      if (viewStates.get(f)) editor.restoreViewState(viewStates.get(f));
      editor.focus();
    },
    drop(f) {
      const m = models.get(f);
      if (m) m.dispose();
      models.delete(f);
      viewStates.delete(f);
      if (current === f) current = null;
    },
    value: () => editor.getValue(),
    layout: () => editor.layout(),
    setTheme: (t) => monaco.editor.setTheme(t === 'light' ? 'ax-light' : 'ax-dark'),
    dispose() {
      editor.dispose();
      models.forEach((m) => m.dispose());
    }
  };
}

function basicBackend(host, ide) {
  host.innerHTML = `<div class="fallback-editor"><div class="gutter" aria-hidden="true"></div><div class="stage"><pre aria-hidden="true"></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Code editor"></textarea></div></div>`;
  const ta = $('textarea', host);
  const pre = $('pre', host);
  const gutter = $('.gutter', host);
  let current = null;
  const paint = () => {
    const code = ta.value;
    const lang = langOfFile(current || '');
    pre.innerHTML = (typeof window.vscodeHighlight === 'function' ? window.vscodeHighlight(code, lang) : esc(code)) + '\n';
    const lines = code.split('\n').length;
    gutter.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join('<br>');
    ta.style.height = `${pre.scrollHeight}px`;
    ta.style.width = `${pre.scrollWidth}px`;
  };
  ta.addEventListener('input', () => {
    paint();
    if (current) ide.onEdit(current, ta.value);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText('  ', s, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  return {
    kind: 'basic',
    open(f) {
      current = f;
      ta.value = ide.files.get(f).current;
      paint();
      ta.focus();
    },
    drop(f) {
      if (current === f) current = null;
    },
    value: () => ta.value,
    layout() {},
    setTheme() {},
    dispose() {
      host.innerHTML = '';
    }
  };
}

// Walk dropped FileSystemEntries (files and folders) into [{ file, path }].
async function collectEntries(entries) {
  const out = [];
  const readAll = (reader) =>
    new Promise((resolve) => {
      const all = [];
      const next = () =>
        reader.readEntries(
          (batch) => {
            if (!batch.length) return resolve(all);
            all.push(...batch);
            next();
          },
          () => resolve(all)
        );
      next();
    });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject)).catch(() => null);
      if (file) out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

class Ide {
  constructor(root, w) {
    this.root = root;
    this.name = w.name;
    this.worker = w;
    this.entry = w.filename;
    this.files = new Map((w.files || []).map((f) => [f.name, { saved: f.content, current: f.content, size: f.sizeBytes, binary: Boolean(f.binary) }]));
    // folders: every parent of a file, plus empty ones (loaded in init)
    this.folders = new Set();
    this.files.forEach((_, f) => this.addParents(f));
    this.collapsed = new Set(store.get(`ax-collapsed-${w.name}`, []));
    this.tabs = [];
    this.active = null;
    this.autosave = store.get('ax-autosave', true);
    this.panel = store.get('ax-panel', 'preview');
    this.saving = false;
    this.saveError = '';
    this.consoleOpen = store.get('ax-console', true);
    this.autosaveSoon = debounce(() => this.autosave && this.save(true), 1200);
    this.onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.save();
      }
    };
  }
  dirtyCount() {
    let n = 0;
    this.files.forEach((f) => (n += f.current !== f.saved ? 1 : 0));
    return n;
  }
  async init() {
    const sm = this.worker.summary;
    $('#ideBar').innerHTML = `
        <span class="save-state" id="ideState"></span>
        <label class="row hint" style="gap:8px;margin-left:8px" title="Save shortly after you stop typing. Saved code is live immediately."><label class="switch"><input type="checkbox" id="ideAuto" ${this.autosave ? 'checked' : ''}><span></span></label><span class="hide-sm">Auto-save</span></label>
        <button class="btn sm" id="ideVersion" title="Snapshot every file so you can roll back to it later"><span class="hide-sm">Make a version</span><span class="hide-lg">Version</span></button>
        <button class="btn sm primary" id="ideSave" title="Save (Ctrl+S)">Save</button>`;
    this.root.innerHTML = `<div class="ide">
      <aside class="files" aria-label="Files">
        <div class="files-head">Files<span class="tools">
          <button class="icon-btn sm" id="ideNewFile" title="New file" aria-label="New file">${icon('plus')}</button>
          <button class="icon-btn sm" id="ideNewFolder" title="New folder" aria-label="New folder">${icon('folderPlus')}</button>
          <button class="icon-btn sm" id="ideUpload" title="Upload files" aria-label="Upload files">${icon('upload')}</button>
          <button class="icon-btn sm" id="ideUploadDir" title="Upload a folder" aria-label="Upload a folder">${icon('folderUp')}</button>
        </span></div>
        <input type="file" id="ideUploadInput" multiple hidden>
        <input type="file" id="ideUploadDirInput" webkitdirectory multiple hidden>
        <div class="files-list" id="ideFiles"></div>
        <div class="upload-progress" id="ideUploadState" hidden></div>
      </aside>
      <section class="editor-col">
        <div class="editor-tabs" id="ideTabs" role="tablist" aria-label="Open files"></div>
        <div class="editor-host" id="ideHost"><div class="empty" style="padding-top:18vh"><p>Loading the editor…</p></div></div>
        <div class="console ${this.consoleOpen ? '' : 'collapsed'}" id="ideConsole">
          <div class="console-head"><b>Console</b><span class="live"></span><span class="hint" id="ideConsoleCount"></span>
            <span class="tools"><button class="icon-btn sm" id="ideConsoleClear" title="Clear view">${icon('trash')}</button><button class="icon-btn sm" id="ideConsoleToggle" title="Show / hide console">${icon(this.consoleOpen ? 'chevDown' : 'chevUp')}</button></span></div>
          <div class="logbox" id="ideLog"></div>
        </div>
      </section>
      <section class="side-panel" aria-label="Preview and request tester">
        <div class="panel-tabs"><div class="tabs" role="tablist" data-seg="ptabs">
          <button class="tab ${this.panel === 'preview' ? 'active' : ''}" data-panel="preview" role="tab">Preview</button>
          <button class="tab ${this.panel === 'request' ? 'active' : ''}" data-panel="request" role="tab">Request</button>
        </div></div>
        <div class="panel-body" id="idePanel"></div>
      </section>
    </div>`;
    // tabs: entry first, then the rest
    this.tabs = [this.entry, ...[...this.files.keys()].filter((f) => f !== this.entry)].filter((f) => this.files.has(f) && !this.files.get(f).binary).slice(0, 6);
    this.renderFiles();
    api('GET', `/api/workers/${enc(this.name)}/files`)
      .then((r) => {
        (r.folders || []).forEach((d) => this.folders.add(d));
        if (this.root.isConnected) this.renderFiles();
      })
      .catch(() => {});
    this.renderPanel();
    this.wire();
    slideInd($('.side-panel .tabs', this.root));

    try {
      const monaco = await loadMonaco();
      $('#ideHost').innerHTML = '';
      this.ed = monacoBackend(monaco, $('#ideHost'), this);
    } catch (err) {
      this.ed = basicBackend($('#ideHost'), this);
      if (store.get('ax-editor', 'monaco') !== 'basic') toast(`Using the basic editor: ${err.message}`, 'err');
    }
    if (!this.root.isConnected) return this.ed.dispose(); // navigated away while loading
    this.open(this.entry && this.files.has(this.entry) ? this.entry : [...this.files.keys()].find((f) => !this.files.get(f).binary));

    this.tail = createTail({
      box: $('#ideLog'),
      workers: () => [this.name],
      filter: () => ({ levels: new Set(['req', 'info', 'warn', 'error']), q: '' }),
      onCount: (n) => ($('#ideConsoleCount').textContent = n ? `${plural(n, 'line')}` : ''),
      max: 300
    });
    this.tail.start();
    this.renderState();
    document.addEventListener('keydown', this.onKey);
    this.unload = (e) => {
      if (this.dirtyCount()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', this.unload);
  }
  wire() {
    $('#ideSave').onclick = () => this.save();
    $('#ideAuto').onchange = (e) => {
      this.autosave = e.target.checked;
      store.set('ax-autosave', this.autosave);
      if (this.autosave && this.dirtyCount()) this.save(true);
    };
    $('#ideVersion').onclick = async () => {
      if (this.dirtyCount()) await this.save();
      const r = await attempt(() => api('POST', `/api/workers/${enc(this.name)}/deployments`, { source: 'Created from editor' }));
      if (r) toast(`Version ${r.worker.deployId} created. Roll back to it any time from Versions`);
    };
    $('#ideNewFile').onclick = () => this.newFileInput('');
    $('#ideNewFolder').onclick = () => this.newFileInput('', true);
    $('#ideUpload').onclick = () => {
      this.uploadTarget = '';
      $('#ideUploadInput').click();
    };
    $('#ideUploadDir').onclick = () => {
      this.uploadTarget = '';
      $('#ideUploadDirInput').click();
    };
    $('#ideUploadInput').onchange = (e) => {
      const list = [...e.target.files].map((file) => ({ file, path: file.name }));
      e.target.value = '';
      this.upload(list, this.uploadTarget);
    };
    $('#ideUploadDirInput').onchange = (e) => {
      const list = [...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
      e.target.value = '';
      this.upload(list, this.uploadTarget);
    };
    $('#ideFiles').onclick = (e) => {
      const act = e.target.closest('[data-fact]');
      const dirRow = e.target.closest('[data-folder]');
      if (dirRow) {
        const d = dirRow.dataset.folder;
        if (act) {
          e.stopPropagation();
          if (act.dataset.fact === 'new') return this.newFileInput(d, false, dirRow);
          if (act.dataset.fact === 'upload') {
            this.uploadTarget = d;
            return $('#ideUploadInput').click();
          }
          if (act.dataset.fact === 'rename') return this.renameFolderInput(d, dirRow);
          if (act.dataset.fact === 'delete') return this.deleteFolder(d);
        }
        return this.toggleFolder(d);
      }
      const row = e.target.closest('[data-file]');
      if (!row) return;
      const f = row.dataset.file;
      if (act) {
        e.stopPropagation();
        if (act.dataset.fact === 'rename') return this.renameInput(f, row);
        if (act.dataset.fact === 'delete') return this.deleteFile(f);
        if (act.dataset.fact === 'entry') return this.setEntry(f);
      }
      this.open(f);
    };
    $('#ideFiles').onkeydown = (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-file], [data-folder]')) {
        e.preventDefault();
        e.target.click();
      }
    };
    this.wireDrop();
    $('#ideTabs').onclick = (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) this.open(t.dataset.tab);
    };
    $('#ideConsoleToggle').onclick = () => {
      this.consoleOpen = !this.consoleOpen;
      store.set('ax-console', this.consoleOpen);
      $('#ideConsole').classList.toggle('collapsed', !this.consoleOpen);
      $('#ideConsoleToggle').innerHTML = icon(this.consoleOpen ? 'chevDown' : 'chevUp');
    };
    $('#ideConsoleClear').onclick = () => this.tail && this.tail.clear();
    $$('.side-panel [data-panel]', this.root).forEach((b) =>
      b.addEventListener('click', () => {
        this.panel = b.dataset.panel;
        store.set('ax-panel', this.panel);
        $$('.side-panel [data-panel]', this.root).forEach((x) => x.classList.toggle('active', x === b));
        slideInd($('.side-panel .tabs', this.root));
        this.renderPanel();
      })
    );
  }
  open(f) {
    if (!f || !this.files.has(f)) return;
    if (this.files.get(f).binary) return this.showBinary(f);
    this.active = f;
    if (!this.tabs.includes(f)) this.tabs.push(f);
    if (this.tabs.length > 8) this.tabs = this.tabs.filter((t) => t === f || t !== this.tabs[0]).slice(-8);
    if (this.ed) this.ed.open(f);
    this.renderFiles();
  }
  onEdit(f, value) {
    const file = this.files.get(f);
    if (!file) return;
    file.current = value;
    this.renderFiles();
    this.renderState();
    this.autosaveSoon();
  }
  addParents(f) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }
  toggleFolder(d) {
    if (this.collapsed.has(d)) this.collapsed.delete(d);
    else this.collapsed.add(d);
    store.set(`ax-collapsed-${this.name}`, [...this.collapsed]);
    this.renderFiles();
  }
  renderFiles() {
    // Build the tree: folders first at each level, the entry file on top.
    const root = { dirs: new Map(), files: [] };
    const nodeOf = (p) => {
      let n = root;
      if (p) for (const seg of p.split('/')) {
        if (!n.dirs.has(seg)) n.dirs.set(seg, { dirs: new Map(), files: [] });
        n = n.dirs.get(seg);
      }
      return n;
    };
    this.folders.forEach((d) => nodeOf(d));
    for (const f of this.files.keys()) {
      const i = f.lastIndexOf('/');
      nodeOf(i < 0 ? '' : f.slice(0, i)).files.push(f);
    }
    // file rows skip the chevron's width so their icons line up with folder icons
    const pad = (depth, file = false) => `style="padding-left:${8 + depth * 14 + (file ? 18 : 0)}px"`;
    const fileRow = (f, depth) => {
      const file = this.files.get(f);
      const dirty = file.current !== file.saved;
      const base = f.slice(f.lastIndexOf('/') + 1);
      return `<div class="file ${f === this.active ? 'active' : ''}" data-file="${esc(f)}" role="button" tabindex="0" title="${esc(f)}" ${pad(depth, true)}>
          ${file.binary ? `<svg class="ficon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P.file}</svg>` : langIcon(langOfFile(f), 'sm')}<span class="nm">${esc(base)}</span>
          ${dirty ? '<span class="dirty" title="Unsaved"></span>' : f === this.entry ? '<span class="entry" title="Runs on each request">ENTRY</span>' : file.binary ? `<span class="bin">${bytes(file.size || 0)}</span>` : ''}
          <span class="acts">
            ${f !== this.entry && !file.binary ? `<button class="icon-btn sm" data-fact="entry" title="Make this the entry file">${icon('star')}</button>` : ''}
            <button class="icon-btn sm" data-fact="rename" title="Rename or move">${icon('edit')}</button>
            ${this.files.size > 1 ? `<button class="icon-btn sm" data-fact="delete" title="Delete">${icon('trash')}</button>` : ''}
          </span></div>`;
    };
    const rows = [];
    const walk = (n, prefix, depth) => {
      const files = n.files.sort((a, b) => (a === this.entry ? -1 : b === this.entry ? 1 : a.localeCompare(b)));
      if (!prefix && files[0] === this.entry) rows.push(fileRow(files.shift(), depth));
      for (const name of [...n.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
        const d = prefix ? `${prefix}/${name}` : name;
        const open = !this.collapsed.has(d);
        rows.push(`<div class="file folder ${open ? '' : 'closed'}" data-folder="${esc(d)}" role="button" tabindex="0" aria-expanded="${open}" title="${esc(d)}/" ${pad(depth)}>
          ${icon('chevDown', 'chev')}${icon('folder', 'ficon')}<span class="nm">${esc(name)}</span>
          <span class="acts">
            <button class="icon-btn sm" data-fact="new" title="New file in ${esc(name)}">${icon('plus')}</button>
            <button class="icon-btn sm" data-fact="upload" title="Upload into ${esc(name)}">${icon('upload')}</button>
            <button class="icon-btn sm" data-fact="rename" title="Rename or move">${icon('edit')}</button>
            <button class="icon-btn sm" data-fact="delete" title="Delete folder">${icon('trash')}</button>
          </span></div>`);
        if (open) walk(n.dirs.get(name), d, depth + 1);
      }
      files.forEach((f) => rows.push(fileRow(f, depth)));
    };
    walk(root, '', 0);
    $('#ideFiles').innerHTML = rows.join('') + `<div class="files-hint">Drop files or folders here to upload</div>`;
    $('#ideTabs').innerHTML = this.tabs
      .filter((f) => this.files.has(f))
      .map((f) => {
        const file = this.files.get(f);
        return `<button class="etab ${f === this.active ? 'active' : ''}" data-tab="${esc(f)}" role="tab" aria-selected="${f === this.active}">${langIcon(langOfFile(f), 'sm')}${esc(f)}${file.current !== file.saved ? '<span class="dirty"></span>' : ''}</button>`;
      })
      .join('');
  }
  renderState() {
    const el = $('#ideState');
    if (!el) return;
    const d = this.dirtyCount();
    el.className = `save-state ${this.saveError ? 'err' : d ? 'dirty' : ''}`;
    el.innerHTML = this.saving
      ? `${icon('refresh')} Saving…`
      : this.saveError
      ? `${icon('alert')} ${esc(this.saveError)}`
      : d
      ? `● ${plural(d, 'unsaved file')}`
      : `${icon('check')} <span class="hide-sm">Saved and live at</span> <a class="mono" href="${esc(this.worker.summary.publishingPath)}" target="_blank" rel="noopener">${esc(this.worker.summary.publishingPath)}</a>`;
    const btn = $('#ideSave');
    if (btn) btn.disabled = !d || this.saving;
  }
  async save(quiet = false) {
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    const dirty = [...this.files.entries()].filter(([, f]) => f.current !== f.saved);
    if (!dirty.length) return;
    this.saving = true;
    this.saveError = '';
    this.renderState();
    try {
      for (const [name, f] of dirty) {
        const content = f.current;
        await api('PUT', `/api/workers/${enc(this.name)}/files`, { filename: name, content });
        f.saved = content;
      }
      if (!quiet) toast(`Saved ${dirty.length === 1 ? dirty[0][0] : plural(dirty.length, 'file')}`);
      this.reloadPreview();
    } catch (err) {
      this.saveError = `Not saved: ${err.message}`;
      if (!quiet) toast(this.saveError, 'err');
    } finally {
      this.saving = false;
      this.renderFiles();
      this.renderState();
      if (this.saveAgain) {
        this.saveAgain = false;
        this.save(true);
      }
    }
  }
  // New file (or folder) inside `folder` ('' = top level). Names may contain
  // slashes: "lib/util.js" makes the lib folder too.
  newFileInput(folder, isFolder = false, afterRow = null) {
    const list = $('#ideFiles');
    if ($('.file-input', list)) return $('.file-input', list).focus();
    if (folder && this.collapsed.has(folder)) {
      this.toggleFolder(folder);
      afterRow = $(`[data-folder="${CSS.escape(folder)}"]`, list);
    }
    const html = `<input class="input mono file-input" placeholder="${isFolder ? 'folder-name' : 'name.js'}" aria-label="New ${isFolder ? 'folder' : 'file'} name${folder ? ` in ${esc(folder)}` : ''}">`;
    if (afterRow) afterRow.insertAdjacentHTML('afterend', html);
    else list.insertAdjacentHTML('afterbegin', html);
    const inp = $('.file-input', list);
    inp.focus();
    let finished = false;
    const done = async (commit) => {
      if (finished) return;
      finished = true;
      const n = inp.value.trim().replace(/^\/+|\/+$/g, '');
      inp.remove();
      if (!commit || !n) return;
      const full = folder ? `${folder}/${n}` : n;
      if (isFolder) {
        const r = await attempt(() => api('POST', `/api/workers/${enc(this.name)}/files`, { folder: full }));
        if (!r) return;
        (r.folders || []).forEach((d) => this.folders.add(d));
        return this.renderFiles();
      }
      const r = await attempt(() => api('POST', `/api/workers/${enc(this.name)}/files`, { filename: full, content: '' }));
      if (!r || !r.file) return;
      this.files.set(r.file.name, { saved: r.file.content, current: r.file.content, size: r.file.sizeBytes, binary: false });
      this.addParents(r.file.name);
      this.open(r.file.name);
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => done(Boolean(inp.value.trim())));
  }
  renameFolderInput(d, row) {
    row.outerHTML = `<input class="input mono file-input" value="${esc(d)}" aria-label="New name for folder ${esc(d)}">`;
    const inp = $('.file-input', $('#ideFiles'));
    inp.focus();
    inp.setSelectionRange(d.lastIndexOf('/') + 1, d.length);
    let finished = false;
    const done = async (commit) => {
      if (finished) return;
      finished = true;
      const n = inp.value.trim().replace(/^\/+|\/+$/g, '');
      if (!commit || !n || n === d) return this.renderFiles();
      const r = await attempt(() => api('PUT', `/api/workers/${enc(this.name)}/files`, { folder: d, newFolder: n }));
      if (!r) return this.renderFiles();
      // move open files (unsaved edits included) to their new paths
      const moved = new Map();
      for (const [f, file] of [...this.files.entries()]) {
        if (!f.startsWith(`${d}/`)) continue;
        const nf = n + f.slice(d.length);
        this.files.delete(f);
        this.files.set(nf, file);
        moved.set(f, nf);
        if (this.ed) this.ed.drop(f);
      }
      this.tabs = this.tabs.map((t) => moved.get(t) || t);
      if (moved.has(this.entry)) this.entry = moved.get(this.entry);
      this.folders = new Set(r.folders || []);
      this.files.forEach((_, f) => this.addParents(f));
      const active = moved.get(this.active) || this.active;
      this.active = null;
      this.open(active);
      this.renderState();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => done(true));
  }
  async deleteFolder(d) {
    const inside = [...this.files.keys()].filter((f) => f.startsWith(`${d}/`));
    if (
      !(await confirmDialog({
        title: `Delete ${d}/?`,
        text: `The folder${inside.length ? ` and the ${plural(inside.length, 'file')} in it are` : ' is'} removed from <b>${esc(this.name)}</b> right away. Older versions keep their copy.`,
        ok: 'Delete',
        danger: true
      }))
    )
      return;
    const r = await attempt(() => api('DELETE', `/api/workers/${enc(this.name)}/files?folder=${enc(d)}`));
    if (!r) return;
    for (const f of inside) {
      this.files.delete(f);
      if (this.ed) this.ed.drop(f);
    }
    this.tabs = this.tabs.filter((t) => this.files.has(t));
    this.entry = r.worker.filename;
    for (const nf of r.files || []) if (!this.files.has(nf.name)) this.files.set(nf.name, { saved: nf.content, current: nf.content, size: nf.sizeBytes, binary: Boolean(nf.binary) });
    this.folders = new Set(r.folders || []);
    this.files.forEach((_, f) => this.addParents(f));
    if (!this.files.has(this.active)) this.open(this.entry);
    else this.renderFiles();
    this.reloadPreview();
  }
  showBinary(f) {
    const file = this.files.get(f);
    const raw = `/api/workers/${enc(this.name)}/raw?path=${enc(f)}`;
    const live = `${this.worker.summary.publishingPath.replace(/\/$/, '')}/${f.split('/').map(enc).join('/')}`;
    const image = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i.test(f);
    modal({
      title: f,
      wide: image,
      body: `<div class="bin-preview">
        ${image ? `<img src="${esc(raw)}" alt="${esc(f)}">` : `<p class="hint">Binary file · ${bytes(file.size || 0)}. It can't be edited here, but your worker serves it as is.</p>`}
        <div class="row" style="gap:8px">
          <a class="btn sm" href="${esc(live)}" target="_blank" rel="noopener">${icon('external')} Open live URL</a>
          <a class="btn sm" href="${esc(raw)}" download="${esc(f.split('/').pop())}">${icon('download')} Download</a>
        </div>
        <p class="hint mono">${esc(live)}</p>
      </div>`
    });
  }
  // [{ file: File, path: 'relative/path' }] into `folder`
  async upload(list, folder = '') {
    if (!list.length) return;
    const targets = list.map((x) => ({ ...x, target: folder ? `${folder}/${x.path}` : x.path }));
    const clashes = targets.filter((t) => this.files.has(t.target));
    if (
      clashes.length &&
      !(await confirmDialog({
        title: `Replace ${plural(clashes.length, 'file')}?`,
        text: `${clashes
          .slice(0, 5)
          .map((c) => `<b>${esc(c.target)}</b>`)
          .join(', ')}${clashes.length > 5 ? ` and ${clashes.length - 5} more` : ''} already exist${clashes.length === 1 ? 's' : ''}. Uploading replaces ${clashes.length === 1 ? 'it' : 'them'} and goes live straight away.`,
        ok: 'Replace'
      }))
    )
      return;
    const state = $('#ideUploadState');
    const failed = [];
    const uploaded = [];
    let i = 0;
    for (const t of targets) {
      i++;
      if (state) {
        state.hidden = false;
        state.textContent = `Uploading ${i} of ${targets.length}: ${t.target}`;
      }
      try {
        const res = await fetch(`/api/workers/${enc(this.name)}/upload?path=${enc(t.target)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: t.file
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
        uploaded.push(data.file);
      } catch (err) {
        failed.push(`${t.target}: ${err.message}`);
      }
    }
    if (state) state.hidden = true;
    for (const nf of uploaded) {
      if (!nf) continue;
      // an upload replaces whatever was open, unsaved edits included
      if (this.ed) this.ed.drop(nf.name);
      this.files.set(nf.name, { saved: nf.content, current: nf.content, size: nf.sizeBytes, binary: Boolean(nf.binary) });
      this.addParents(nf.name);
      if (folder) this.collapsed.delete(folder);
    }
    if (this.active && uploaded.some((nf) => nf && nf.name === this.active)) {
      const a = this.active;
      this.active = null;
      this.open(a);
    }
    this.renderFiles();
    this.renderState();
    this.reloadPreview();
    if (failed.length) toast(`${plural(failed.length, 'upload')} failed: ${failed[0]}`, 'err');
    else toast(`Uploaded ${uploaded.length === 1 ? uploaded[0].name : plural(uploaded.length, 'file')}`);
  }
  // Drag files or whole folders from the desktop onto the list or onto a folder.
  wireDrop() {
    const pane = $('.ide .files', this.root);
    const targetOf = (e) => {
      const dirRow = e.target.closest && e.target.closest('[data-folder]');
      if (dirRow) return dirRow;
      return null;
    };
    let mark = null;
    const clear = () => {
      pane.classList.remove('drop');
      if (mark) mark.classList.remove('drop-target');
      mark = null;
    };
    pane.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer.types || [])].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const row = targetOf(e);
      if (row !== mark) {
        if (mark) mark.classList.remove('drop-target');
        mark = row;
        if (mark) mark.classList.add('drop-target');
      }
      pane.classList.toggle('drop', !row);
    });
    pane.addEventListener('dragleave', (e) => {
      if (!pane.contains(e.relatedTarget)) clear();
    });
    pane.addEventListener('drop', async (e) => {
      if (![...(e.dataTransfer.types || [])].includes('Files')) return;
      e.preventDefault();
      const row = targetOf(e);
      const folder = row ? row.dataset.folder : '';
      clear();
      // entries must be taken synchronously, before any await
      const entries = [...(e.dataTransfer.items || [])].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
      const plain = [...e.dataTransfer.files];
      const list = entries.length ? await collectEntries(entries) : plain.map((file) => ({ file, path: file.name }));
      this.upload(list, folder);
    });
  }
  renameInput(f, row) {
    row.outerHTML = `<input class="input mono file-input" value="${esc(f)}" aria-label="New name for ${esc(f)}">`;
    const inp = $('.file-input', $('#ideFiles'));
    inp.focus();
    const baseStart = f.lastIndexOf('/') + 1;
    inp.setSelectionRange(baseStart, f.lastIndexOf('.') > baseStart ? f.lastIndexOf('.') : f.length);
    let finished = false;
    const done = async (commit) => {
      if (finished) return;
      finished = true;
      const n = inp.value.trim();
      if (!commit || !n || n === f) return this.renderFiles();
      const file = this.files.get(f);
      const r = await attempt(() =>
        api('PUT', `/api/workers/${enc(this.name)}/files`, file.binary ? { filename: f, newFilename: n } : { filename: f, newFilename: n, content: file.current })
      );
      if (!r) return this.renderFiles();
      const newName = r.filename;
      this.files.delete(f);
      this.files.set(newName, { saved: file.current, current: file.current, size: file.size, binary: file.binary });
      this.addParents(newName);
      if (file.binary) return this.renderFiles();
      if (this.entry === f) this.entry = newName;
      this.tabs = this.tabs.map((t) => (t === f ? newName : t));
      if (this.ed) this.ed.drop(f);
      this.open(newName);
      this.renderState();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => done(true));
  }
  async deleteFile(f) {
    if (!(await confirmDialog({ title: `Delete ${f}?`, text: `It's removed from <b>${esc(this.name)}</b> right away. Older versions keep their copy.`, ok: 'Delete', danger: true }))) return;
    const r = await attempt(() => api('DELETE', `/api/workers/${enc(this.name)}/files?filename=${enc(f)}`));
    if (!r) return;
    this.files.delete(f);
    this.tabs = this.tabs.filter((t) => t !== f);
    if (this.ed) this.ed.drop(f);
    this.entry = r.worker.filename;
    // the server keeps at least one file (it may have created worker.js)
    for (const nf of r.files || []) if (!this.files.has(nf.name)) this.files.set(nf.name, { saved: nf.content, current: nf.content, size: nf.sizeBytes, binary: Boolean(nf.binary) });
    if (this.active === f) this.open(this.entry);
    else this.renderFiles();
    this.reloadPreview();
  }
  async setEntry(f) {
    const r = await attempt(() => api('PUT', `/api/workers/${enc(this.name)}/files`, { filename: f, setAsEntrypoint: true }), `${f} now runs on each request`);
    if (!r) return;
    this.entry = f;
    this.renderFiles();
    this.reloadPreview();
  }

  /* ------- right panel */
  renderPanel() {
    const box = $('#idePanel');
    const path = this.worker.summary.publishingPath;
    if (this.panel === 'preview') {
      box.innerHTML = `<div class="urlbar"><input class="input" id="pvUrl" value="${esc(path)}" aria-label="Preview path"><button class="icon-btn" id="pvGo" title="Reload">${icon('refresh')}</button><a class="icon-btn" id="pvOpen" href="${esc(path)}" target="_blank" rel="noopener" title="Open in new tab">${icon('external')}</a></div>
        <iframe class="preview-frame" id="pvFrame" title="Worker preview" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"></iframe>`;
      const go = () => {
        const p = $('#pvUrl').value.trim() || path;
        $('#pvOpen').href = p;
        $('#pvFrame').src = `${p}${p.includes('?') ? '&' : '?'}_preview=${Date.now()}`;
      };
      $('#pvGo').onclick = go;
      $('#pvUrl').addEventListener('keydown', (e) => e.key === 'Enter' && go());
      go();
      return;
    }
    const st = store.get(`ax-req-${this.name}`, { method: 'GET', url: path, headers: [['', '']], body: '' });
    box.innerHTML = `<div class="urlbar"><select class="select" id="rqM" aria-label="Method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
      .map((m) => `<option ${m === st.method ? 'selected' : ''}>${m}</option>`)
      .join('')}</select><input class="input" id="rqU" value="${esc(st.url)}" aria-label="Request path"><button class="btn sm primary" id="rqSend">Send</button></div>
      <div class="req-section"><div class="label">Headers</div><div id="rqH">${st.headers.map(([k, v]) => this.hdrRow(k, v)).join('')}</div>
        <button class="btn sm ghost" id="rqAddH" style="align-self:flex-start">${icon('plus')} Header</button></div>
      <div class="req-section" id="rqBodyWrap"><div class="label">Body</div><textarea class="textarea mono" id="rqB" rows="4" placeholder='{"hello": "world"}'>${esc(st.body)}</textarea></div>
      <div id="rqOut" class="resp"><div class="empty"><h4>Send a request</h4><p>It reaches your worker exactly like a browser or curl would.</p></div></div>`;
    const syncBody = () => ($('#rqBodyWrap').style.display = ['GET', 'HEAD'].includes($('#rqM').value) ? 'none' : '');
    syncBody();
    $('#rqM').onchange = syncBody;
    $('#rqAddH').onclick = () => $('#rqH').insertAdjacentHTML('beforeend', this.hdrRow('', ''));
    $('#rqH').onclick = (e) => e.target.closest('[data-del-h]') && e.target.closest('.kv-edit').remove();
    $('#rqU').addEventListener('keydown', (e) => e.key === 'Enter' && this.sendRequest());
    $('#rqSend').onclick = () => this.sendRequest();
  }
  hdrRow(k, v) {
    return `<div class="kv-edit"><input class="input" placeholder="Header" value="${esc(k)}" aria-label="Header name"><input class="input" placeholder="value" value="${esc(v)}" aria-label="Header value"><button class="icon-btn sm" data-del-h title="Remove">${icon('x')}</button></div>`;
  }
  async sendRequest() {
    const method = $('#rqM').value;
    const url = $('#rqU').value.trim() || '/';
    const headers = $$('#rqH .kv-edit').map((r) => $$('input', r).map((i) => i.value));
    const body = $('#rqB').value;
    store.set(`ax-req-${this.name}`, { method, url, headers: headers.length ? headers : [['', '']], body });
    const h = new Headers();
    for (const [k, v] of headers) if (k.trim()) h.set(k.trim(), v);
    const out = $('#rqOut');
    out.innerHTML = `<div class="empty"><p>Sending…</p></div>`;
    const t0 = performance.now();
    try {
      const res = await fetch(url, { method, headers: h, body: ['GET', 'HEAD'].includes(method) ? undefined : body, redirect: 'manual' });
      const text = method === 'HEAD' ? '' : await res.text();
      const dt = performance.now() - t0;
      let pretty = text;
      const ct = res.headers.get('content-type') || '';
      if (/json/.test(ct)) {
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch (_) {}
      }
      const hdrs = [...res.headers.entries()].map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v)}</div>`).join('');
      out.innerHTML = `<div class="resp-meta"><span class="status ${statusClass(res.status)}">${res.status || 'opaque'} ${esc(res.statusText)}</span><span>${esc(ms(dt))}</span><span>${bytes(new Blob([text]).size)}</span><span class="grow"></span><button class="btn sm ghost" id="rqCopy">${icon('copy')} Copy</button></div>
        <details class="resp-headers"><summary>${plural([...res.headers.keys()].length, 'header')}</summary>${hdrs}</details>
        <pre class="resp-body">${esc(pretty) || '<span style="color:var(--muted)">(empty body)</span>'}</pre>`;
      $('#rqCopy').onclick = () => copy(text);
    } catch (err) {
      out.innerHTML = `<div class="empty"><h4>Request failed</h4><p>${esc(err.message)}</p></div>`;
    }
  }
  reloadPreview() {
    if (this.panel === 'preview' && $('#pvFrame')) $('#pvGo').click();
  }
  setTheme(t) {
    if (this.ed) this.ed.setTheme(t);
  }
  dispose() {
    document.removeEventListener('keydown', this.onKey);
    if (this.unload) window.removeEventListener('beforeunload', this.unload);
    if (this.ed) this.ed.dispose();
  }
}

async function mountIde(root, w) {
  const ide = new Ide(root, w);
  S.ide = ide;
  await ide.init();
}

/* ============================================================= logs page */
async function viewLogs(view) {
  setTopbar([{ label: 'Live logs' }]);
  if (!S.overview) await loadOverview();
  view.innerHTML = `<div class="page">
    <div class="page-head"><div><h1 class="page-title">Live logs</h1><p class="page-sub">Requests, console output and errors from every worker, as they happen.</p></div></div>
    <div class="card">${logsToolbar('gl')}<div class="logbox" id="glBox" style="height:calc(100vh - 290px);min-height:320px"></div></div>
  </div>`;
  let getFilter = () => ({ levels: new Set(['req', 'info', 'warn', 'error']), q: '' });
  const tail = createTail({
    box: $('#glBox'),
    workers: () => workersList().map((w) => w.name),
    filter: () => getFilter(),
    showWorker: true,
    onCount: (shown, total) => ($('#glCount').textContent = `${num(shown)} of ${num(total)} lines`)
  });
  getFilter = wireLogsToolbar('gl', tail);
  tail.start();
  poll(() => loadOverview().catch(() => {}), 15000);
}

/* =========================================================== tunnel page */
async function viewTunnel(view) {
  setTopbar([{ label: 'Domain & tunnel' }]);
  await loadOverview();
  const c = S.overview.config;
  const host = c.subdomain && c.rootDomain ? `${c.subdomain}.${c.rootDomain}` : c.rootDomain || '';
  const dnsPill =
    c.dnsRecordStatus === 'verified'
      ? '<span class="tag ok"><span class="d"></span>Verified</span>'
      : c.dnsRecordStatus === 'pending'
      ? '<span class="tag warn"><span class="d"></span>Pending</span>'
      : '<span class="tag"><span class="d"></span>Not checked</span>';
  const connPill = !c.tunnelTokenSet
    ? '<span class="tag"><span class="d"></span>No token yet</span>'
    : c.connectorRunning
    ? '<span class="tag ok"><span class="d"></span>Connected</span>'
    : c.connectorInstalled
    ? '<span class="tag err"><span class="d"></span>Not running</span>'
    : '<span class="tag err"><span class="d"></span>cloudflared missing</span>';
  const svc = `http://localhost:${c.publicPort}`;
  view.innerHTML = `<div class="page">
    <div class="page-head"><div><h1 class="page-title">Domain & tunnel</h1><p class="page-sub">Put your workers on your own domain through a Cloudflare Tunnel. No port forwarding.</p></div></div>
    <div class="figures three">
      <div class="fig"><div class="k">Public address</div><div class="v" style="font-size:24px">${host ? esc(host) : '<span style="color:var(--muted)">Not set</span>'}</div><div class="f">${host ? `<a href="https://${esc(host)}" target="_blank" rel="noopener">Open in a new tab</a>` : 'Reachable on your network only'}</div></div>
      <div class="fig"><div class="k">Tunnel connector</div><div class="v" style="font-size:15px;padding-top:12px">${connPill}</div><div class="f">Restarts itself if it crashes</div></div>
      <div class="fig"><div class="k">DNS record</div><div class="v" style="font-size:15px;padding-top:12px">${dnsPill}</div><div class="f" title="${esc(c.dnsCheckMessage || '')}">${c.dnsLastChecked ? `Checked ${esc(ago(c.dnsLastChecked))}` : 'Never checked'}</div></div>
    </div>
    <div class="grid2" style="align-items:start">
      <form class="card" id="tunForm">
        <div class="card-head"><h3>Connection</h3></div>
        <div class="card-body stack">
          <div class="grid2"><div class="field"><label for="tSub">Subdomain</label><input class="input mono" id="tSub" value="${esc(c.subdomain || '')}" placeholder="workers"></div>
          <div class="field"><label for="tRoot">Root domain</label><input class="input mono" id="tRoot" value="${esc(c.rootDomain || '')}" placeholder="example.com"></div></div>
          <div class="field"><label for="tId">Tunnel ID</label><input class="input mono" id="tId" value="${esc(c.tunnelId || '')}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"><span class="hint">Used to show the exact DNS record to create.</span></div>
          <div class="field"><label for="tTok">Tunnel token</label><input class="input mono" id="tTok" type="password" autocomplete="off" placeholder="${c.tunnelTokenSet ? '•••••••• saved. Leave blank to keep it' : 'Paste the token or the whole install command'}">
            <span class="hint">${c.tunnelTokenSet ? `Saved on the Pi and never sent back to the browser. <button type="button" class="btn sm ghost" id="tClear" style="height:22px;padding:0 6px">Remove token</button>` : 'From “Install and run a connector”. The whole <span class="mono">cloudflared service install …</span> line works too.'}</span></div>
          <div class="grid2"><div class="field"><label for="tIp">This Pi's LAN IP</label><input class="input mono" id="tIp" value="${esc(c.localIp || '')}"></div>
          <div class="field"><label for="tCidr">Local networks</label><input class="input mono" id="tCidr" value="${esc(c.networkCidrs || '')}"></div></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn" id="tCheck">Check DNS</button><button class="btn primary">Save and connect</button></div>
      </form>
      <div class="card">
        <div class="card-head"><h3>Set it up in Cloudflare</h3></div>
        <div class="card-body">
          <ol class="steps">
            <li><div>In <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener">Zero Trust</a> → Networks → Tunnels, create a <b>Cloudflared</b> tunnel.</div></li>
            <li><div>Copy its token into <b>Tunnel token</b> here and save. Alex-Aero runs the connector and keeps it running.</div></li>
            <li><div>Add a public hostname ${host ? `<b class="mono">${esc(host)}</b>` : ''} pointing to this service:<div class="copy-line" style="margin-top:6px"><span>${esc(svc)}</span><button type="button" class="icon-btn sm" data-copy="${esc(svc)}">${icon('copy')}</button></div></div></li>
            <li><div>Cloudflare usually creates the DNS record for you. If not, add a proxied CNAME:<div class="copy-line" style="margin-top:6px"><span>${esc(c.subdomain || '@')} → ${esc(c.tunnelId ? `${c.tunnelId}.cfargotunnel.com` : '<tunnel-id>.cfargotunnel.com')}</span><button type="button" class="icon-btn sm" data-copy="${esc(c.tunnelId ? `${c.tunnelId}.cfargotunnel.com` : '')}">${icon('copy')}</button></div></div></li>
          </ol>
          <p class="hint" style="margin:14px 0 0">${esc(c.dnsCheckMessage || '')}</p>
        </div>
      </div>
    </div>
  </div>`;
  view.onclick = (e) => {
    const b = e.target.closest('[data-copy]');
    if (b && b.dataset.copy) copy(b.dataset.copy);
  };
  const payload = () => ({
    subdomain: $('#tSub').value,
    rootDomain: $('#tRoot').value,
    tunnelId: $('#tId').value,
    tunnelToken: $('#tTok').value,
    localIp: $('#tIp').value,
    networkCidrs: $('#tCidr').value
  });
  $('#tunForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await attempt(() => api('PUT', '/api/config', payload()));
    if (r) {
      toast(r.dnsCheck && r.dnsCheck.status === 'verified' ? 'Saved. DNS is verified' : 'Saved');
      route();
    }
  };
  $('#tCheck').onclick = async () => {
    const r = await attempt(() => api('POST', '/api/dns/check'));
    if (r) {
      toast(r.dnsCheck.message, r.dnsCheck.status === 'verified' ? 'ok' : 'err');
      route();
    }
  };
  const clr = $('#tClear');
  if (clr)
    clr.onclick = async () => {
      if (!(await confirmDialog({ title: 'Remove tunnel token?', text: 'The connector stops and your domain stops reaching this Pi.', ok: 'Remove', danger: true }))) return;
      const r = await attempt(() => api('PUT', '/api/config', { clearTunnelToken: true }), 'Token removed');
      if (r) route();
    };
}

/* =========================================================== system page */
async function viewSystem(view) {
  setTopbar([{ label: 'System' }]);
  const paint = (d) => {
    const s = d.system;
    const memPct = s.memoryTotalMb ? Math.round((s.memoryUsedMb / s.memoryTotalMb) * 100) : 0;
    const diskPct = s.disk ? Math.round(((s.disk.totalGb - s.disk.freeGb) / s.disk.totalGb) * 100) : 0;
    const tempCol = s.cpuTempC >= 75 ? 'var(--err)' : s.cpuTempC >= 65 ? 'var(--warn)' : 'inherit';
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1 class="page-title">System</h1><p class="page-sub">${esc(s.hostname)} · ${esc(s.cpuModel)} · ${esc(s.platform)}/${esc(s.arch)}</p></div><div class="tools"><span class="live">live</span></div></div>
      <div class="figures">
        <div class="fig"><div class="k">CPU temperature</div><div class="v" style="color:${tempCol}">${s.cpuTempC ?? '—'}<small>°C</small></div><div class="f">${s.cpuTempC >= 80 ? 'Hot, likely throttling' : s.cpuTempC >= 65 ? 'Warm' : 'Cool'}</div></div>
        <div class="fig"><div class="k">Load</div><div class="v">${(s.loadAvg || [])[0] ?? '—'}</div><div class="f">${(s.loadAvg || [])[1] ?? '—'} · ${(s.loadAvg || [])[2] ?? '—'} over 5 / 15 min</div><div class="meter"><i style="width:${Math.min(100, Math.round((((s.loadAvg || [0])[0] || 0) / (s.cpus || 1)) * 100))}%"></i></div></div>
        <div class="fig"><div class="k">Memory</div><div class="v">${memPct}<small>%</small></div><div class="f">${num(s.memoryUsedMb)} of ${num(s.memoryTotalMb)} MB</div><div class="meter"><i style="width:${memPct}%"></i></div></div>
        <div class="fig"><div class="k">Disk</div><div class="v">${s.disk ? `${s.disk.freeGb}<small>GB free</small>` : '—'}</div><div class="f">${s.disk ? `of ${s.disk.totalGb} GB` : ''}</div><div class="meter"><i style="width:${diskPct}%"></i></div></div>
        <div class="fig"><div class="k">Uptime</div><div class="v">${esc(duration(s.uptimeSeconds))}</div><div class="f">Alex-Aero for ${esc(duration(s.backendUptimeSeconds))}</div></div>
      </div>
      <div class="grid2" style="align-items:start">
        <div class="card"><div class="card-head"><h3>Runtimes</h3></div><div class="card-body"><dl class="kv">
          <dt>Node.js</dt><dd>${esc(s.node)}</dd><dt>workerd</dt><dd>${esc(s.workerd)}</dd><dt>Python</dt><dd>${esc(s.python)}</dd>
          <dt>nginx</dt><dd>${esc(s.nginx)}</dd><dt>cloudflared</dt><dd>${esc(s.cloudflared)}</dd><dt>Storage</dt><dd>${esc(s.storageDir)}</dd>
        </dl></div></div>
        <div class="card"><div class="card-head"><h3>Running workers</h3><span class="sub">start on first request</span></div>
          ${
            s.runningWorkers.length
              ? `<table class="table"><thead><tr><th>Worker</th><th>Engine</th><th class="num">Port</th></tr></thead><tbody>${s.runningWorkers
                  .map((r) => `<tr><td><a href="#/w/${enc(r.name)}">${esc(r.name)}</a></td><td>${r.engine === 'workerd' ? '<span class="tag ok"><span class="d"></span>workerd</span>' : `<span class="tag warn" title="workerd failed to start, so the code runs inside Node instead"><span class="d"></span>${esc(r.engine)}</span>`}</td><td class="num">${r.port}</td></tr>`)
                  .join('')}</tbody></table>`
              : `<div class="empty"><h4>Nothing running</h4><p>JavaScript workers start on their first request.</p></div>`
          }
        </div>
      </div>
      <div class="card" style="margin-top:16px" id="account"></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h3>Command line</h3><span class="sub">on the Pi</span></div><div class="card-body stack" style="gap:8px">
        ${[['ax', 'menu: status, logs, restart, login, domain'], ['ax status', 'what’s running'], ['ax logs -f', 'follow the backend log'], ['ax passwd', 'change the dashboard login'], ['ax autostart on', 'start at boot, restart on crash']]
          .map(([c, d]) => `<div class="copy-line"><span>${esc(c)} <span style="color:var(--muted)"># ${esc(d)}</span></span><button class="icon-btn sm" data-copy="${esc(c)}">${icon('copy')}</button></div>`)
          .join('')}
      </div></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h3>Storage files</h3></div>
        <table class="table"><thead><tr><th>File</th><th>Holds</th><th class="num">Size</th><th>Saved</th><th></th></tr></thead><tbody>${d.storageFiles
          .map((f, i) => `<tr><td class="mono">${esc(f.path)}</td><td style="color:var(--muted)">${esc(f.category)}</td><td class="num">${bytes(f.sizeBytes)}</td><td style="color:var(--muted)">${esc(ago(f.updatedAt))}</td><td><button class="btn sm ghost" data-peek="${i}">${icon('eye')}</button></td></tr>`)
          .join('')}</tbody></table></div>
    </div>`;
  };
  let data = await api('GET', '/api/system');
  paint(data);
  renderAccount();
  view.onclick = (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copy(c.dataset.copy);
    const p = e.target.closest('[data-peek]');
    if (p) {
      const f = data.storageFiles[Number(p.dataset.peek)];
      modal({ title: f.path, wide: true, body: `<pre class="code-view">${esc(f.preview)}${f.sizeBytes > 1200 ? '\n…' : ''}</pre>` });
    }
  };
  poll(async () => {
    try {
      data = await api('GET', '/api/system');
      if (S.route.page === 'system' && !document.querySelector('.overlay') && !$('#account')?.contains(document.activeElement)) {
        paint(data);
        renderAccount();
      }
    } catch (_) {}
  }, 5000);
}

/* ============================================================ account */
let accountCache = null;
async function renderAccount() {
  const box = $('#account');
  if (!box) return;
  if (!accountCache) accountCache = await api('GET', '/api/account').catch(() => null);
  const a = accountCache;
  if (!a) return;
  box.innerHTML = `<div class="card-head"><h3>Login</h3><span class="sub">${a.authEnabled ? `Signed in as <b class="mono">${esc(a.username)}</b> · ${plural(a.sessions, 'signed-in device')}` : 'Not set: the dashboard is open to anyone who can reach it'}</span>
      ${a.authEnabled ? `<span class="tools"><button class="btn sm ghost" id="accOthers">Sign out other devices</button></span>` : ''}</div>
    <form class="card-body stack" id="accForm" autocomplete="off">
      <div class="grid2">
        <div class="field"><label for="accUser">Username</label><input class="input mono" id="accUser" value="${esc(a.username || 'admin')}" autocomplete="username"></div>
        ${a.authEnabled ? `<div class="field"><label for="accCur">Current password</label><input class="input" id="accCur" type="password" autocomplete="current-password"></div>` : '<div></div>'}
      </div>
      <div class="grid2">
        <div class="field"><label for="accNew">New password</label><input class="input" id="accNew" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
        <div class="field"><label for="accNew2">New password again</label><input class="input" id="accNew2" type="password" autocomplete="new-password"></div>
      </div>
      <div class="row"><span class="grow hint">${a.authEnabled ? 'Changing it signs out every other device.' : 'Once set, the dashboard asks for this login.'}</span><button class="btn primary">${a.authEnabled ? 'Change login' : 'Set login'}</button></div>
    </form>`;
  $('#accForm').onsubmit = async (e) => {
    e.preventDefault();
    if ($('#accNew').value !== $('#accNew2').value) return toast("The new passwords don't match", 'err');
    const r = await attempt(() =>
      api('POST', '/api/account', { username: $('#accUser').value.trim(), currentPassword: $('#accCur') ? $('#accCur').value : '', newPassword: $('#accNew').value })
    );
    if (r) {
      toast(a.authEnabled ? 'Login changed' : 'Login set. You are signed in');
      accountCache = null;
      loadOverview().catch(() => {});
      renderAccount();
    }
  };
  const others = $('#accOthers');
  if (others)
    others.onclick = async () => {
      if (await attempt(() => api('DELETE', '/api/account/sessions'), 'Other devices signed out')) {
        accountCache = null;
        renderAccount();
      }
    };
}
async function signOut() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/');
}

/* ============================================================ palette */
function openPalette() {
  if ($('.overlay .palette')) return;
  const items = [
    ...NAV.map((n) => ({ label: n.label, sec: 'Page', ico: icon(n.icon), go: () => (location.hash = n.href) })),
    { label: 'New worker', sec: 'Action', ico: icon('plus'), go: () => newWorkerDialog() },
    { label: 'Sign out', sec: 'Action', ico: icon('logout'), go: signOut },
    { label: `Switch to ${S.theme === 'dark' ? 'light' : 'dark'} theme`, sec: 'Action', ico: icon(S.theme === 'dark' ? 'sun' : 'moon'), go: toggleTheme },
    {
      label: `Use the ${store.get('ax-editor', 'monaco') === 'basic' ? 'full (Monaco)' : 'basic, offline'} editor`,
      sec: 'Action',
      ico: icon('code'),
      go: () => {
        store.set('ax-editor', store.get('ax-editor', 'monaco') === 'basic' ? 'monaco' : 'basic');
        toast('Editor changed. Reopen a worker’s code to use it');
      }
    },
    ...workersList().flatMap((w) => [
      { label: w.name, sec: 'Overview', ico: langIcon(w.language), go: () => (location.hash = `#/w/${enc(w.name)}`) },
      { label: `${w.name}: edit code`, sec: 'Code', ico: icon('code'), go: () => (location.hash = `#/w/${enc(w.name)}/code`) },
      { label: `${w.name}: logs`, sec: 'Logs', ico: icon('logs'), go: () => (location.hash = `#/w/${enc(w.name)}/logs`) }
    ])
  ];
  let sel = 0;
  let shown = items;
  modal({
    title: 'Go to',
    body: `<input class="input" id="palQ" placeholder="Type a worker, page or action…" autocomplete="off" autofocus aria-label="Search"><div class="palette-list" id="palL" role="listbox"></div>`,
    onMount(ov, close) {
      $('.modal', ov).classList.add('palette');
      $('.modal-head', ov).remove();
      $('.modal-body', ov).style.padding = '0';
      $('.modal-body', ov).style.gap = '0';
      const paint = () => {
        $('#palL', ov).innerHTML = shown.length
          ? shown.map((it, i) => `<div class="pitem ${i === sel ? 'sel' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">${it.ico}<span>${esc(it.label)}</span><span class="sec">${esc(it.sec)}</span></div>`).join('')
          : '<div class="empty">No matches</div>';
        const s = $('.pitem.sel', ov);
        if (s) s.scrollIntoView({ block: 'nearest' });
      };
      const run = (it) => {
        close();
        it.go();
      };
      $('#palQ', ov).addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        shown = !q ? items : items.filter((it) => `${it.label} ${it.sec}`.toLowerCase().includes(q));
        sel = 0;
        paint();
      });
      $('#palQ', ov).addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') sel = Math.min(shown.length - 1, sel + 1);
        else if (e.key === 'ArrowUp') sel = Math.max(0, sel - 1);
        else if (e.key === 'Enter' && shown[sel]) return run(shown[sel]);
        else return;
        e.preventDefault();
        paint();
      });
      $('#palL', ov).addEventListener('click', (e) => {
        const it = e.target.closest('[data-i]');
        if (it) run(shown[Number(it.dataset.i)]);
      });
      paint();
    }
  });
}

/* ============================================================== chrome */
function toggleTheme() {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = S.theme;
  try {
    localStorage.setItem('ax-theme', S.theme);
  } catch (_) {}
  paintThemeBtn();
  if (S.ide) S.ide.setTheme(S.theme);
}
function paintThemeBtn() {
  $('#themeBtn').innerHTML = icon(S.theme === 'dark' ? 'sun' : 'moon');
}
function openNav() {
  $('#side').classList.add('open');
  $('#scrim').classList.remove('hidden');
}
function closeNav() {
  $('#side').classList.remove('open');
  $('#scrim').classList.add('hidden');
}

function boot() {
  paintThemeBtn();
  $('#themeBtn').onclick = toggleTheme;
  $('#menuBtn').innerHTML = icon('menu');
  $('#menuBtn').onclick = openNav;
  $('#scrim').onclick = closeNav;
  $('#paletteBtn').onclick = openPalette;
  $('#signOutBtn').innerHTML = icon('logout');
  $('#signOutBtn').onclick = signOut;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
    }
  });
  window.addEventListener('hashchange', route);
  route();
}
boot();
