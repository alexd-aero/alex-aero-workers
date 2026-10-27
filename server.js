#!/usr/bin/env node
/**
 * Cloudflare workerd Runtime Controller & Local Storage Action Server
 * Listens on 127.0.0.1:17156 behind Nginx reverse proxy on 0.0.0.0:27715.
 * Pulls worker code directly from local disk storage (/home/user/storage/workers/<name>) on every run,
 * executes workers in Cloudflare `workerd` (plus Python, Shell, Node, and template runtimes),
 * determines the client IP from incoming HTTP requests (dashboard & worker endpoints),
 * and persists all edits and state automatically to disk.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const os = require('os');
const dns = require('dns');

const ROOT_DIR = __dirname;
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const WORKERS_DIR = path.join(STORAGE_DIR, 'workers');
const RUNTIME_DIR = path.join(STORAGE_DIR, 'runtime');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CONFIG_FILE = path.join(STORAGE_DIR, 'config.json');
const AUTH_FILE = path.join(STORAGE_DIR, 'auth.json');
const STATE_FILE = path.join(STORAGE_DIR, 'state.json');
const CF_RECORDS_FILE = path.join(ROOT_DIR, 'cloudflare-records.json');

const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '17156', 10);
const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || '27715', 10);
// 127.0.0.1 behind nginx (the default). Standalone/Docker: BIND_HOST=0.0.0.0 and
// BACKEND_PORT=PUBLIC_PORT, so Node serves the public port itself.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

[STORAGE_DIR, WORKERS_DIR, RUNTIME_DIR, PUBLIC_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Write JSON through a temp file + rename so a crash or power cut mid-write
// can never leave a half-written (unparseable) config/state/meta file behind.
function writeJsonAtomic(filePath, data, mode) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { encoding: 'utf8', mode } : 'utf8');
  fs.renameSync(tmp, filePath);
}

// Request-driven bookkeeping (logs, invocations, counters) changes on every hit.
// Writing meta.json + state.json synchronously per request hammered the SD card
// and blocked the event loop, so those writes are coalesced and flushed shortly after.
const pendingMetaWrites = new Set();
let pendingStateWrite = false;
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushPendingWrites, 750);
}
function persistWorkerSoon(name) {
  pendingMetaWrites.add(name);
  scheduleFlush();
}
function persistStateSoon() {
  pendingStateWrite = true;
  scheduleFlush();
}
function flushPendingWrites() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const name of pendingMetaWrites) {
    const meta = state.workers[name];
    const dir = path.join(WORKERS_DIR, name);
    if (meta && fs.existsSync(dir)) {
      try {
        writeJsonAtomic(path.join(dir, 'meta.json'), meta);
      } catch (err) {
        console.error(`Failed writing meta for ${name}:`, err.message);
      }
    }
  }
  pendingMetaWrites.clear();
  if (pendingStateWrite) {
    pendingStateWrite = false;
    try {
      saveState();
    } catch (err) {
      console.error('Failed writing state.json:', err.message);
    }
  }
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const hourKey = (d = new Date()) => d.toISOString().slice(0, 13);

function detectLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function isPrivateOrLocalIp(rawIp) {
  if (!rawIp) return true;
  const ip = String(rawIp).trim().replace(/^::ffff:/i, '');
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip.toLowerCase() === 'localhost') {
    return true;
  }
  if (/^(::1|fe80:|fc00:|fd[0-9a-f]{2}:)/i.test(ip)) {
    return true;
  }
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function getAllHostIpv4Addresses() {
  const ips = new Set();
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) {
        ips.add(iface.address);
      }
    }
  }
  return ips;
}

const NETWORK_IP_CACHE_FILE = path.join(RUNTIME_DIR, 'network-ip.json');
try {
  if (fs.existsSync(NETWORK_IP_CACHE_FILE)) fs.unlinkSync(NETWORK_IP_CACHE_FILE);
} catch (_) {}

// Filled in asynchronously right after boot. It used to be three blocking `curl`
// calls (up to 9 s) before the server could even listen.
let PUBLIC_NETWORK_INFO = { ip: '', cf: {} };
let publicNetworkInfoAt = 0;
let publicNetworkRefresh = null;

function refreshPublicNetworkInfoAsync(maxAgeMs = 0) {
  if (maxAgeMs && Date.now() - publicNetworkInfoAt < maxAgeMs) return Promise.resolve();
  if (!publicNetworkRefresh) {
    publicNetworkRefresh = doRefreshPublicNetworkInfo().finally(() => {
      publicNetworkInfoAt = Date.now();
      publicNetworkRefresh = null;
    });
  }
  return publicNetworkRefresh;
}

async function doRefreshPublicNetworkInfo() {
  const fetchT = (url) => fetch(url, { signal: AbortSignal.timeout(4000) });
  try {
    const nextInfo = {
      ip: PUBLIC_NETWORK_INFO.ip || '',
      cf: { ...(PUBLIC_NETWORK_INFO.cf || {}) }
    };
    try {
      const r1 = await fetchT('https://ipwho.is/');
      if (r1.ok) {
        const who = await r1.json();
        if (who && who.ip && !isPrivateOrLocalIp(who.ip)) {
          nextInfo.ip = who.ip;
          nextInfo.cf = {
            ...nextInfo.cf,
            country: who.country_code || nextInfo.cf.country || null,
            region: who.region || nextInfo.cf.region || null,
            regionCode: who.region_code || nextInfo.cf.regionCode || null,
            city: who.city || nextInfo.cf.city || null,
            postalCode: who.postal || nextInfo.cf.postalCode || null,
            continent: who.continent_code || nextInfo.cf.continent || null,
            latitude: typeof who.latitude === 'number' ? who.latitude : nextInfo.cf.latitude || null,
            longitude: typeof who.longitude === 'number' ? who.longitude : nextInfo.cf.longitude || null,
            timezone: (who.timezone && who.timezone.id) || nextInfo.cf.timezone || null,
            isEUCountry: Boolean(who.is_eu),
            asn: (who.connection && who.connection.asn) || nextInfo.cf.asn || null,
            asOrganization:
              (who.connection && (who.connection.org || who.connection.isp)) ||
              nextInfo.cf.asOrganization ||
              null
          };
        }
      }
    } catch (_) {}

    try {
      const r2 = await fetchT('https://1.1.1.1/cdn-cgi/trace');
      if (r2.ok) {
        const traceRaw = await r2.text();
        for (const line of traceRaw.split('\n')) {
          const idx = line.indexOf('=');
          if (idx !== -1) {
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            if (k === 'ip' && v && !isPrivateOrLocalIp(v) && !nextInfo.ip) nextInfo.ip = v;
            if (k === 'colo' && v) nextInfo.cf.colo = v;
            if (k === 'loc' && v && !nextInfo.cf.country) nextInfo.cf.country = v;
            if (k === 'http' && v) nextInfo.cf.httpProtocol = v.toUpperCase();
            if (k === 'tls' && v) nextInfo.cf.tlsVersion = v;
          }
        }
      }
    } catch (_) {}

    if (nextInfo.ip) {
      PUBLIC_NETWORK_INFO = nextInfo;
    }
  } catch (_) {}
}

setInterval(() => refreshPublicNetworkInfoAsync(), 10 * 60 * 1000).unref();
setImmediate(() => refreshPublicNetworkInfoAsync());

function getRuntimeVersions() {
  const safeExec = (cmd) => {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (_) {
      return 'installed';
    }
  };
  return {
    node: process.version,
    python: safeExec('python3 --version'),
    workerd: safeExec('workerd --version'),
    nginx: safeExec('/usr/sbin/nginx -v 2>&1 || nginx -v 2>&1'),
    cloudflared: safeExec('cloudflared --version'),
    arch: os.arch(),
    platform: os.platform(),
    hostname: os.hostname(),
    uptimeSeconds: Math.floor(os.uptime())
  };
}

const RUNTIME_VERSIONS = getRuntimeVersions();

// Minimal clean JS worker template that serves multi-file assets and any output format
function buildJsWorkerTemplate(name) {
  return `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const files = (env && env.FILES) || {};
    let reqFile = url.pathname.replace(/^\\/+/, "");
    try { reqFile = decodeURIComponent(reqFile); } catch (_) {}

    if (reqFile && files[reqFile] !== undefined) {
      return new Response(files[reqFile]);
    }
    if (!reqFile && files["index.html"] !== undefined) {
      return new Response(files["index.html"], {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    return new Response("Hello from ${name}");
  }
};
`;
}

// Language registry supporting all VS Code language modes
const LANGUAGES = {
  javascript: {
    id: 'javascript',
    label: 'JavaScript',
    badge: 'JS',
    ext: 'js',
    runtime: 'workerd',
    defaultFile: 'worker.js',
    template: buildJsWorkerTemplate
  },
  javascriptreact: {
    id: 'javascriptreact',
    label: 'JavaScript JSX',
    badge: 'JSX',
    ext: 'jsx',
    runtime: 'workerd',
    defaultFile: 'worker.jsx',
    template: buildJsWorkerTemplate
  },
  typescript: {
    id: 'typescript',
    label: 'TypeScript',
    badge: 'TS',
    ext: 'ts',
    runtime: 'workerd',
    defaultFile: 'worker.ts',
    template: (name) => `export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    const files = (env && env.FILES) || {};
    let reqFile = url.pathname.replace(/^\\/+/, "");
    try { reqFile = decodeURIComponent(reqFile); } catch (_) {}

    if (reqFile && files[reqFile] !== undefined) {
      return new Response(files[reqFile]);
    }
    if (!reqFile && files["index.html"] !== undefined) {
      return new Response(files["index.html"], {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    return new Response("Hello from ${name}");
  }
};
`
  },
  typescriptreact: {
    id: 'typescriptreact',
    label: 'TypeScript JSX',
    badge: 'TSX',
    ext: 'tsx',
    runtime: 'workerd',
    defaultFile: 'worker.tsx',
    template: buildJsWorkerTemplate
  },
  python: {
    id: 'python',
    label: 'Python',
    badge: 'PY',
    ext: 'py',
    runtime: 'python3',
    defaultFile: 'worker.py',
    template: (name) => `print("Hello from ${name}")\n`
  },
  shellscript: {
    id: 'shellscript',
    label: 'Shell Script',
    badge: 'SH',
    ext: 'sh',
    runtime: 'bash',
    defaultFile: 'worker.sh',
    template: (name) => `#!/usr/bin/env bash\necho "Hello from ${name}"\n`
  },
  shell: {
    id: 'shellscript',
    label: 'Shell Script',
    badge: 'SH',
    ext: 'sh',
    runtime: 'bash',
    defaultFile: 'worker.sh',
    template: (name) => LANGUAGES.shellscript.template(name)
  },
  json: {
    id: 'json',
    label: 'JSON',
    badge: 'JSON',
    ext: 'json',
    runtime: 'template-json',
    defaultFile: 'worker.json',
    template: (name) => `{\n  "worker": "${name}",\n  "status": "ok"\n}\n`
  },
  html: {
    id: 'html',
    label: 'HTML',
    badge: 'HTML',
    ext: 'html',
    runtime: 'template-html',
    defaultFile: 'worker.html',
    template: (name) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${name}</title>
  <style>
    body {
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      padding: 2rem;
      background: #ffffff;
      color: #111111;
    }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <p>Edit this page in Alex-Aero.</p>
</body>
</html>
`
  },
  css: {
    id: 'css',
    label: 'CSS',
    badge: 'CSS',
    ext: 'css',
    runtime: 'template-text',
    defaultFile: 'worker.css',
    template: (name) => `/* Stylesheet for ${name} */\nbody {\n  margin: 0;\n  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;\n}\n`
  },
  sql: {
    id: 'sql',
    label: 'SQL',
    badge: 'SQL',
    ext: 'sql',
    runtime: 'sql',
    defaultFile: 'worker.sql',
    template: (name) => `-- SQL Query (${name})\nSELECT '${name}' AS worker;\n`
  },
  yaml: {
    id: 'yaml',
    label: 'YAML',
    badge: 'YAML',
    ext: 'yaml',
    runtime: 'template-yaml',
    defaultFile: 'worker.yaml',
    template: (name) => `worker: ${name}\nstatus: ok\n`
  },
  markdown: {
    id: 'markdown',
    label: 'Markdown',
    badge: 'MD',
    ext: 'md',
    runtime: 'template-text',
    defaultFile: 'worker.md',
    template: (name) => `# ${name}\n\nHello from ${name}.\n`
  },
  go: {
    id: 'go',
    label: 'Go',
    badge: 'GO',
    ext: 'go',
    runtime: 'workerd',
    defaultFile: 'worker.go',
    template: (name) => `// Go Action (${name})\nexport default {\n  async fetch(request, env) {\n    return new Response("Hello from ${name} (Go)");\n  }\n};\n`
  },
  rust: {
    id: 'rust',
    label: 'Rust',
    badge: 'RS',
    ext: 'rs',
    runtime: 'workerd',
    defaultFile: 'worker.rs',
    template: (name) => `// Rust Action (${name})\nexport default {\n  async fetch(request, env) {\n    return new Response("Hello from ${name} (Rust)");\n  }\n};\n`
  },
  c: {
    id: 'c',
    label: 'C',
    badge: 'C',
    ext: 'c',
    runtime: 'workerd',
    defaultFile: 'worker.c',
    template: (name) => `// C Action (${name})\nexport default {\n  async fetch(request, env) {\n    return new Response("Hello from ${name} (C)");\n  }\n};\n`
  },
  cpp: {
    id: 'cpp',
    label: 'C++',
    badge: 'C++',
    ext: 'cpp',
    runtime: 'workerd',
    defaultFile: 'worker.cpp',
    template: (name) => `// C++ Action (${name})\nexport default {\n  async fetch(request, env) {\n    return new Response("Hello from ${name} (C++)");\n  }\n};\n`
  },
  php: {
    id: 'php',
    label: 'PHP',
    badge: 'PHP',
    ext: 'php',
    runtime: 'workerd',
    defaultFile: 'worker.php',
    template: (name) => `// PHP Action (${name})\nexport default {\n  async fetch(request, env) {\n    return new Response("Hello from ${name} (PHP)");\n  }\n};\n`
  },
  ruby: {
    id: 'ruby',
    label: 'Ruby',
    badge: 'RB',
    ext: 'rb',
    runtime: 'workerd',
    defaultFile: 'worker.rb',
    template: (name) => `# Ruby Action (${name})\nexport default {\n  async fetch(request, env) {\n    return new Response("Hello from ${name} (Ruby)");\n  }\n};\n`
  },
  lua: {
    id: 'lua',
    label: 'Lua',
    badge: 'LUA',
    ext: 'lua',
    runtime: 'workerd',
    defaultFile: 'worker.lua',
    template: (name) => `-- Lua Action (${name})\nexport default {\n  async fetch(request, env) {\n    return new Response("Hello from ${name} (Lua)");\n  }\n};\n`
  },
  plaintext: {
    id: 'plaintext',
    label: 'Plain Text',
    badge: 'TXT',
    ext: 'txt',
    runtime: 'template-text',
    defaultFile: 'worker.txt',
    template: (name) => `Hello from ${name}\n`
  }
};

// Map any of the 72 VS Code language IDs to a valid language spec
const EXT_BY_LANG = {
  bat: 'bat', bibtex: 'bib', binary: 'bin', c: 'c', csharp: 'cs', cpp: 'cpp',
  clojure: 'clj', snippets: 'code-snippets', coffeescript: 'coffee', dockercompose: 'yaml',
  css: 'css', 'cuda-cpp': 'cu', diff: 'diff', dockerfile: 'dockerfile', dotenv: 'env',
  fsharp: 'fs', 'git-commit': 'txt', 'git-rebase': 'txt', go: 'go', groovy: 'groovy',
  handlebars: 'hbs', hlsl: 'hlsl', html: 'html', ignore: 'gitignore', ini: 'ini',
  instructions: 'md', java: 'java', javascript: 'js', javascriptreact: 'jsx', json: 'json',
  jsonl: 'jsonl', jsonc: 'jsonc', julia: 'jl', juliamarkdown: 'jmd', kotlin: 'kt',
  latex: 'tex', less: 'less', log: 'log', lua: 'lua', makefile: 'mk', markdown: 'md',
  mssql: 'sql', sql: 'sql', 'objective-c': 'm', 'objective-cpp': 'mm', perl: 'pl',
  php: 'php', plaintext: 'txt', powershell: 'ps1', prompt: 'prompt', properties: 'properties',
  jade: 'pug', python: 'py', r: 'r', perl6: 'raku', razor: 'cshtml', restructuredtext: 'rst',
  ruby: 'rb', rust: 'rs', scss: 'scss', 'search-result': 'txt', shaderlab: 'shader',
  shellscript: 'sh', skill: 'md', swift: 'swift', tex: 'tex', typescript: 'ts',
  typescriptreact: 'tsx', vb: 'vb', xml: 'xml', xsl: 'xsl', yaml: 'yaml'
};

function getLangSpec(langId) {
  const normalized = String(langId || 'javascript').toLowerCase();
  if (LANGUAGES[normalized]) return LANGUAGES[normalized];
  const ext = EXT_BY_LANG[normalized] || 'js';
  return {
    id: normalized,
    label: normalized.toUpperCase(),
    badge: ext.toUpperCase().slice(0, 4),
    ext,
    runtime: 'workerd',
    defaultFile: `worker.${ext}`,
    template: (name) => buildJsWorkerTemplate(name)
  };
}

function getConfiguredHostname(cfg) {
  const sub = String(cfg?.subdomain || '').trim();
  const root = String(cfg?.rootDomain || '').trim();
  if (sub && root) return `${sub}.${root}`;
  if (root) return root;
  return `${cfg?.localIp || detectLocalIp()}:${PUBLIC_PORT}`;
}

function extractPublishingPath(rawLink, fallbackName) {
  const str = String(rawLink || '').trim();
  if (!str) return `/${fallbackName || ''}`;
  if (/^https?:\/\//i.test(str)) {
    try {
      const u = new URL(str);
      return u.pathname.replace(/\*+$/, '').replace(/\/+$/, '') || '/';
    } catch (_) {}
  }
  if (!str.startsWith('/')) {
    const slashIdx = str.indexOf('/');
    if (slashIdx !== -1 && (str.slice(0, slashIdx).includes('.') || str.slice(0, slashIdx).includes(':'))) {
      const p = str.slice(slashIdx).replace(/\*+$/, '').replace(/\/+$/, '');
      return p || '/';
    }
    return `/${str.replace(/^\/+/, '').replace(/\*+$/, '').replace(/\/+$/, '')}`;
  }
  return str.replace(/\*+$/, '').replace(/\/+$/, '') || '/';
}

function loadConfig() {
  const liveLocalIp = detectLocalIp();
  const hostIps = getAllHostIpv4Addresses();
  const defaultConfig = {
    username: 'admin',
    subdomain: '',
    rootDomain: '',
    localIp: liveLocalIp,
    publicPort: PUBLIC_PORT,
    backendPort: BACKEND_PORT,
    networkCidrs: '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    tunnelId: '',
    tunnelToken: '',
    dnsRecordStatus: 'unchecked',
    dnsLastChecked: null,
    dnsCheckMessage: 'No custom domain configured yet. Using local HTTP origin.',
    dnsResolvedTargets: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const savedIp = String(saved.localIp || '').trim();
      const validSavedIp = savedIp && hostIps.has(savedIp) ? savedIp : liveLocalIp;
      return {
        ...defaultConfig,
        ...saved,
        localIp: validSavedIp,
        publicPort: PUBLIC_PORT,
        backendPort: BACKEND_PORT
      };
    } catch (err) {
      console.error('Error reading config.json, using defaults:', err.message);
    }
  }
  const diskConfig = { ...defaultConfig, localIp: '' };
  writeJsonAtomic(CONFIG_FILE, diskConfig);
  return defaultConfig;
}

function saveConfig(cfg) {
  cfg.updatedAt = new Date().toISOString();
  writeJsonAtomic(CONFIG_FILE, cfg);
  syncCloudflareRecordsFile(cfg);
}

let config = loadConfig();

function loadState() {
  const defaultState = {
    activeWorker: '',
    // The worker that answers paths no other worker claims. It used to be
    // `activeWorker`, which changes whenever you click a worker in the
    // dashboard, so browsing silently re-pointed the public site.
    defaultWorker: null,
    lastDashboardClient: null,
    editorPreferences: {
      spaces: 2,
      indentUsingTabs: false,
      encoding: 'UTF-8',
      eol: 'LF',
      layout: 'Layout: US',
      language: 'javascript'
    },
    workers: {}
  };

  if (fs.existsSync(STATE_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      let normalizedWorkers = {};
      if (Array.isArray(saved.workers)) {
        for (const w of saved.workers) {
          if (w && w.name) normalizedWorkers[w.name] = w;
        }
      } else if (saved.workers && typeof saved.workers === 'object') {
        normalizedWorkers = saved.workers;
      }
      return {
        ...defaultState,
        ...saved,
        lastDashboardClient: null,
        editorPreferences: { ...defaultState.editorPreferences, ...(saved.editorPreferences || {}) },
        workers: normalizedWorkers
      };
    } catch (err) {
      console.error('Error reading state.json:', err.message);
    }
  }
  return defaultState;
}

let state = loadState();

let lastRecordsSignature = '';
function saveState() {
  // Each worker's meta.json is the source of truth; state.json only keeps the
  // UI/editor state. (It used to duplicate every worker's logs, invocations and
  // 25 code snapshots, rewritten on every single request.)
  const diskState = {
    activeWorker: state.activeWorker,
    defaultWorker: state.defaultWorker,
    editorPreferences: state.editorPreferences,
    workers: Object.fromEntries(Object.keys(state.workers).map((n) => [n, { name: n }]))
  };
  writeJsonAtomic(STATE_FILE, diskState);
  const signature = JSON.stringify([Object.keys(state.workers).sort(), config.subdomain, config.rootDomain, config.tunnelId, config.localIp]);
  if (signature !== lastRecordsSignature) {
    lastRecordsSignature = signature;
    syncCloudflareRecordsFile(config);
  }
}

function syncCloudflareRecordsFile(cfg) {
  try {
    const workerNames = Object.keys(state.workers || {}).sort();
    const localHost = `${cfg.localIp || detectLocalIp()}:${PUBLIC_PORT}`;
    const publicHostname = getConfiguredHostname(cfg, localHost);
    const cnameTarget = cfg.tunnelId
      ? `${cfg.tunnelId}.cfargotunnel.com`
      : '<tunnel-id>.cfargotunnel.com';

    const recordsPayload = {
      generatedAt: new Date().toISOString(),
      publicHostname,
      zone: cfg.rootDomain || null,
      subdomain: cfg.subdomain || null,
      tunnelId: cfg.tunnelId || null,
      dnsRecord: {
        type: 'CNAME',
        name: cfg.subdomain || '@',
        content: cnameTarget,
        proxied: true,
        ttl: 1
      },
      ingress: [
        {
          hostname: publicHostname,
          path: '/*',
          service: `http://127.0.0.1:${PUBLIC_PORT}`,
          lanTarget: `http://${localHost}`
        }
      ],
      actionPaths: workerNames.map((name) => ({
        worker: name,
        path: `/${name}`,
        localUrl: `http://${localHost}/${name}`,
        publicUrl: cfg.rootDomain ? `https://${publicHostname}/${name}` : `http://${localHost}/${name}`
      }))
    };

    writeJsonAtomic(CF_RECORDS_FILE, recordsPayload);
  } catch (err) {
    console.error('Failed syncing cloudflare-records.json:', err.message);
  }
}

function inferLanguageFromFilename(filename) {
  const ext = path.extname(String(filename || '')).slice(1).toLowerCase();
  if (!ext) return 'plaintext';
  const byExt = Object.values(LANGUAGES).find((l) => l.ext === ext);
  return byExt ? byExt.id : 'plaintext';
}

// A file's name inside its worker folder, as a relative path: "a/b/c.js".
// Each segment is cleaned on its own, so ".." and dotfiles can never get through.
const MAX_FILE_DEPTH = 8;
function sanitizeFileName(rawFile) {
  const parts = String(rawFile || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.');
  if (!parts.length || parts.length > MAX_FILE_DEPTH) return null;
  const clean = [];
  for (const part of parts) {
    const seg = part.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    if (!seg || seg.startsWith('.')) return null;
    clean.push(seg);
  }
  const rel = clean.join('/');
  return rel === 'meta.json' ? null : rel;
}

// Path of a sanitized file inside a worker folder, with its parent folders made.
function workerFilePath(workerDir, safeName, makeParents = false) {
  const full = path.join(workerDir, safeName);
  if (makeParents) fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

// Text vs binary: a NUL byte in the first 8 KB, like git.
const UPLOAD_IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp'
};
// Content types for binary files a worker serves from its folder.
const BINARY_TYPES = {
  ...UPLOAD_IMAGE_TYPES,
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
  wasm: 'application/wasm'
};

function looksBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__']);
const MAX_LISTED_FILES = 2000;
// Every file (recursively) and every folder in a worker's directory.
function walkWorkerDir(workerDir) {
  const files = [];
  const dirs = [];
  const walk = (abs, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= MAX_FILE_DEPTH - 1) continue;
        dirs.push(r);
        walk(path.join(abs, entry.name), r, depth + 1);
      } else if (entry.isFile() && r !== 'meta.json' && files.length < MAX_LISTED_FILES) {
        files.push(r);
      }
    }
  };
  walk(workerDir, '', 0);
  return { files, dirs };
}

function listWorkerFolders(workerName) {
  const workerDir = path.join(WORKERS_DIR, workerName);
  if (!fs.existsSync(workerDir)) return [];
  return walkWorkerDir(workerDir).dirs.sort();
}

function listWorkerFiles(workerName) {
  const workerDir = path.join(WORKERS_DIR, workerName);
  if (!fs.existsSync(workerDir)) return [];
  const files = [];
  for (const rel of walkWorkerDir(workerDir).files) {
    const fullPath = path.join(workerDir, rel);
    try {
      const stat = fs.statSync(fullPath);
      const buf = fs.readFileSync(fullPath);
      const binary = looksBinary(buf);
      files.push({
        name: rel,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        language: binary ? 'binary' : inferLanguageFromFilename(rel),
        binary,
        // binary files are served straight from disk and never edited as text
        content: binary ? '' : buf.toString('utf8')
      });
    } catch (_) {}
  }
  const meta = state.workers[workerName];
  const primary = meta && meta.filename;
  files.sort((a, b) => {
    if (a.name === primary) return -1;
    if (b.name === primary) return 1;
    return a.name.localeCompare(b.name);
  });
  return files;
}

function getLiveSystemTelemetry() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const rss = process.memoryUsage().rss;
  const cpus = os.cpus() || [];
  const load = os.loadavg ? os.loadavg() : [0, 0, 0];
  let timezone = 'America/New_York';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch (_) {}
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: cpus.length || 1,
    cpuModel: cpus[0] ? cpus[0].model.trim() : 'ARM / x64 Processor',
    loadAvg1m: Number((load[0] || 0).toFixed(2)),
    memoryUsedMb: Math.round(usedMem / (1024 * 1024)),
    memoryTotalMb: Math.round(totalMem / (1024 * 1024)),
    workerMemoryMb: Number((rss / (1024 * 1024)).toFixed(1)),
    uptimeSeconds: Math.floor(os.uptime()),
    timezone
  };
}

function discoverWorkersOnDisk() {
  if (!fs.existsSync(WORKERS_DIR)) return;
  const entries = fs.readdirSync(WORKERS_DIR, { withFileTypes: true });
  const foundNames = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    foundNames.add(name);
    const workerDir = path.join(WORKERS_DIR, name);
    const metaPath = path.join(workerDir, 'meta.json');
    let meta = state.workers[name] || null;
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_) {}
    }

    const files = fs
      .readdirSync(workerDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== 'meta.json' && !e.name.startsWith('.'))
      .map((e) => e.name);
    if (!meta) {
      const codeFile = files[0] || 'worker.js';
      const ext = path.extname(codeFile).slice(1).toLowerCase();
      const langEntry = Object.values(LANGUAGES).find((l) => l.ext === ext) || LANGUAGES.javascript;
      const now = new Date().toISOString();
      const deployId = crypto.randomBytes(4).toString('hex');
      meta = {
        name,
        language: langEntry.id,
        filename: codeFile,
        createdAt: now,
        updatedAt: now,
        deployId,
        status: 'Active',
        requests: 0,
        errors: 0,
        subrequests: 0,
        lastRunAt: null,
        lastDurationMs: null,
        lastCpuUs: null,
        spaces: 2,
        encoding: 'UTF-8',
        eol: 'LF',
        layout: 'Layout: US',
        issueDetectionEnabled: true,
        productionUrlEnabled: true,
        previewUrlEnabled: true,
        observabilityConfig: {
          logsEnabled: true,
          includeInvocationLogs: true,
          persistLogs: true,
          tracesEnabled: false,
          samplingRate: 100
        },
        customRoutes: [],
        publishingLink: `/${name}`,
        publishingPath: `/${name}`,
        issues: [],
        invocations: [],
        bindings: {},
        deployments: [
          {
            id: deployId,
            timestamp: now,
            language: langEntry.id,
            filename: codeFile,
            author: config.username || 'admin',
            source: 'Manually deployed'
          }
        ],
        logs: []
      };
    } else {
      meta.name = name;
      if (!meta.filename || (files.length > 0 && !files.includes(meta.filename))) {
        meta.filename = files[0] || 'worker.js';
      }
      if (!meta.language) {
        meta.language = inferLanguageFromFilename(meta.filename);
      }
      if (!Array.isArray(meta.logs)) {
        meta.logs = [];
      }
      if (!meta.bindings || typeof meta.bindings !== 'object') {
        meta.bindings = {};
      }
      if (meta.bindings.ENVIRONMENT === 'production' && meta.bindings.STORAGE_MODE === 'local-auto-save') {
        delete meta.bindings.ENVIRONMENT;
        delete meta.bindings.STORAGE_MODE;
      }
      if (!meta.publishingLink) {
        meta.publishingLink = `/${name}`;
      }
      meta.publishingPath = extractPublishingPath(meta.publishingLink, name);
      if (meta.issueDetectionEnabled === undefined) meta.issueDetectionEnabled = true;
      if (meta.productionUrlEnabled === undefined) meta.productionUrlEnabled = true;
      if (meta.previewUrlEnabled === undefined) meta.previewUrlEnabled = true;
      if (!meta.observabilityConfig) {
        meta.observabilityConfig = {
          logsEnabled: true,
          includeInvocationLogs: true,
          persistLogs: true,
          tracesEnabled: false,
          samplingRate: 100
        };
      }
      if (!Array.isArray(meta.customRoutes)) meta.customRoutes = [];
      meta.customRoutes = meta.customRoutes.map((r) => ({
        ...r,
        path: extractPublishingPath(r.pattern || r.path, name)
      }));
      if (!Array.isArray(meta.issues)) meta.issues = [];
      if (!Array.isArray(meta.invocations)) meta.invocations = [];
      if (!Array.isArray(meta.deployments) || meta.deployments.length === 0) {
        meta.deployments = [
          {
            id: meta.deployId || '00000000',
            timestamp: meta.updatedAt || new Date().toISOString(),
            language: meta.language || 'javascript',
            filename: meta.filename || 'worker.js',
            author: config.username || 'admin',
            source: 'Manually deployed'
          }
        ];
      }
    }

    state.workers[name] = meta;
    writeJsonAtomic(metaPath, meta);
  }

  for (const existingName of Object.keys(state.workers)) {
    if (!foundNames.has(existingName)) {
      delete state.workers[existingName];
    }
  }

  if (!state.activeWorker || !state.workers[state.activeWorker]) {
    state.activeWorker = Object.keys(state.workers)[0] || '';
  }
  // Older installs used the selected worker as the catch-all; keep serving the
  // same one, but from now on it only changes when you pick it on purpose.
  if (state.defaultWorker === null || state.defaultWorker === undefined) {
    state.defaultWorker = state.activeWorker || '';
  }
  if (state.defaultWorker && !state.workers[state.defaultWorker]) {
    state.defaultWorker = '';
  }
  saveState();
}

function sanitizeWorkerName(rawName) {
  // No leading dots: "." and ".." used to resolve to storage/ itself, letting a
  // worker overwrite auth.json / config.json.
  return String(rawName || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 64);
}

const RESERVED_WORKER_NAMES = new Set([
  'api', 'public', 'assets', 'dashboard', 'editor', 'records', 'vendor',
  'index.html', 'app.js', 'styles.css', 'lang-icons.js', 'favicon.ico', 'favicon.svg', 'robots.txt'
]);

function validateWorkerName(name) {
  if (!name) return 'Worker name is required';
  if (RESERVED_WORKER_NAMES.has(name.toLowerCase())) return `"${name}" is a reserved system path`;
  return null;
}

function getWorkerCodePath(name, targetFile) {
  const meta = state.workers[name];
  const filename = sanitizeFileName(targetFile) || (meta && meta.filename) || 'worker.js';
  return path.join(WORKERS_DIR, name, filename);
}

function readWorkerCodeFromStorage(name, targetFile) {
  const meta = state.workers[name];
  if (!meta) return '';
  const workerDir = path.join(WORKERS_DIR, name);
  const chosenFile = sanitizeFileName(targetFile) || meta.filename || 'worker.js';
  const filePath = path.join(workerDir, chosenFile);
  if (fs.existsSync(filePath)) {
    try {
      if (fs.statSync(filePath).isFile()) {
        return fs.readFileSync(filePath, 'utf8');
      }
    } catch (_) {}
  }
  if (fs.existsSync(workerDir)) {
    const files = listWorkerFiles(name)
      .filter((f) => !f.binary)
      .map((f) => f.name);
    if (files.length > 0) {
      meta.filename = files[0];
      return fs.readFileSync(path.join(workerDir, files[0]), 'utf8');
    }
  }
  return '';
}

// ---- hot-path cache: a worker's files, entry code and routing facts are read
// from disk once and reused until a file in its folder changes (fs.watch) or
// the API edits it. (Was: every request re-read and re-hashed every file.)
const bundleCache = new Map();
const bundleWatchers = new Map();
function watchWorkerDir(name) {
  if (bundleWatchers.has(name)) return;
  try {
    const w = fs.watch(path.join(WORKERS_DIR, name), { recursive: true }, (_evt, file) => {
      if (file === 'meta.json' || String(file || '').endsWith('.tmp')) return;
      bundleCache.delete(name);
    });
    w.on('error', () => {
      w.close();
      bundleWatchers.delete(name);
      bundleCache.delete(name);
    });
    bundleWatchers.set(name, w);
  } catch (_) {}
}
function unwatchWorkerDir(name) {
  const w = bundleWatchers.get(name);
  if (w) w.close();
  bundleWatchers.delete(name);
}
const JS_FILE_RE = /\.(js|mjs|cjs|ts|tsx|jsx)$/i;
function getWorkerBundle(name) {
  let b = bundleCache.get(name);
  if (b) return b;
  const meta = state.workers[name] || {};
  const files = listWorkerFiles(name);
  const entry = files.find((f) => f.name === meta.filename) || files[0];
  const hasExecutableJsWorker = files.some(
    (f) => JS_FILE_RE.test(f.name) && (/export\s+default\b/.test(f.content) || /addEventListener\s*\(\s*['"]fetch['"]/.test(f.content))
  );
  b = {
    files,
    filesMap: Object.fromEntries(files.filter((f) => !f.binary).map((f) => [f.name, f.content])),
    rawCode: entry ? entry.content : '',
    totalBytes: files.reduce((n, f) => n + (f.sizeBytes || 0), 0),
    hasExecutableJsWorker,
    htmlEntryFile: !hasExecutableJsWorker && files.find((f) => /\.html?$/i.test(f.name)),
    mountPrefixes: Array.from(
      new Set([
        `/${name}`,
        extractPublishingPath(meta.publishingLink || meta.publishingPath, name),
        ...(Array.isArray(meta.customRoutes) ? meta.customRoutes.map((r) => extractPublishingPath(r.pattern || r.path, name)) : [])
      ])
    ).filter(Boolean)
  };
  bundleCache.set(name, b);
  watchWorkerDir(name);
  return b;
}
function workerLanguage(meta) {
  const fileInferredLang = inferLanguageFromFilename(meta.filename);
  return fileInferredLang && fileInferredLang !== 'plaintext' && meta.language === 'javascript' && !/\.(js|jsx|mjs|cjs)$/i.test(meta.filename || '')
    ? fileInferredLang
    : meta.language || fileInferredLang || 'javascript';
}
function isWorkerdWorker(name) {
  const meta = state.workers[name];
  return Boolean(meta) && getLangSpec(workerLanguage(meta)).runtime === 'workerd';
}
// Start the new version in the background right after a save, so the next
// visitor doesn't pay for the cold start.
function prewarmSoon(name) {
  setTimeout(() => {
    if (isWorkerdWorker(name)) ensureWorkerdInstance(name).catch(() => {});
  }, 60).unref();
}

function invalidateWorkerRuntime(workerName, removeRunDir = false) {
  bundleCache.delete(workerName);
  if (!removeRunDir && state.workers[workerName]) prewarmSoon(workerName);
  else unwatchWorkerDir(workerName);
  if (removeRunDir && workerName) {
    try {
      fs.rmSync(path.join(RUNTIME_DIR, workerName), { recursive: true, force: true });
    } catch (_) {}
  }
  if (!workerName || !workerdPool.has(workerName)) return;
  const running = workerdPool.get(workerName);
  if (running) {
    if (running.proc) {
      try {
        running.proc.kill('SIGTERM');
      } catch (_) {}
    }
    if (running.fallbackServer) {
      try {
        running.fallbackServer.close();
      } catch (_) {}
    }
  }
  workerdPool.delete(workerName);
}

function createOrUpdateWorker(rawName, options = {}) {
  const name = sanitizeWorkerName(rawName);
  const invalid = validateWorkerName(name);
  if (invalid) throw Object.assign(new Error(invalid), { statusCode: 400 });

  const existing = state.workers[name] || {};
  const languageId = options.language || existing.language || 'javascript';
  const langSpec = getLangSpec(languageId);
  const workerDir = path.join(WORKERS_DIR, name);

  if (!fs.existsSync(workerDir)) {
    fs.mkdirSync(workerDir, { recursive: true });
  }

  const existingDiskFiles = walkWorkerDir(workerDir).files;

  const safeOptionFilename = sanitizeFileName(options.filename);
  const safeTarget = options.targetFilename ? sanitizeFileName(options.targetFilename) : '';
  let filename = safeOptionFilename;
  if (!filename) {
    if (existing.filename && existingDiskFiles.includes(existing.filename)) {
      filename = existing.filename;
    } else if (safeTarget) {
      filename = safeTarget;
    } else if (existingDiskFiles.includes('index.js')) {
      filename = 'index.js';
    } else if (existingDiskFiles.length > 0) {
      filename = existingDiskFiles[0];
    } else {
      filename = existing.filename || `worker.${langSpec.ext}`;
    }
  }

  const oldFilename = existing.filename;
  const newFilePath = workerFilePath(workerDir, filename, true);
  const eol = options.eol || existing.eol || 'LF';
  const normalizeEol = (str) =>
    eol === 'CRLF' ? String(str || '').replace(/\r?\n/g, '\r\n') : String(str || '').replace(/\r\n/g, '\n');

  // If an array of multiple files is provided, persist every file in the worker directory
  if (Array.isArray(options.files)) {
    for (const f of options.files) {
      if (!f || typeof f.content !== 'string') continue;
      const safeSubName = sanitizeFileName(f.name);
      if (safeSubName) {
        fs.writeFileSync(workerFilePath(workerDir, safeSubName, true), normalizeEol(f.content), 'utf8');
      }
    }
  }

  // If a specific file was edited, save it to its own file on disk
  if (safeTarget && typeof options.targetFileContent === 'string') {
    fs.writeFileSync(workerFilePath(workerDir, safeTarget, true), normalizeEol(options.targetFileContent), 'utf8');
  }

  let codeToWrite = options.code;
  if (safeTarget === filename && typeof options.targetFileContent === 'string' && !options.useLanguageTemplate) {
    codeToWrite = options.targetFileContent;
  }
  if (typeof codeToWrite !== 'string') {
    if (fs.existsSync(newFilePath)) {
      codeToWrite = fs.readFileSync(newFilePath, 'utf8');
    } else if (oldFilename && fs.existsSync(path.join(workerDir, oldFilename))) {
      codeToWrite = fs.readFileSync(path.join(workerDir, oldFilename), 'utf8');
    } else if (safeTarget && fs.existsSync(path.join(workerDir, safeTarget))) {
      codeToWrite = fs.readFileSync(path.join(workerDir, safeTarget), 'utf8');
    } else {
      codeToWrite = langSpec.template(name);
    }
  }

  codeToWrite = normalizeEol(codeToWrite);
  if (!safeTarget || safeTarget === filename || fs.existsSync(newFilePath) || existingDiskFiles.length === 0) {
    fs.writeFileSync(newFilePath, codeToWrite, 'utf8');
  }

  invalidateWorkerRuntime(name);

  const now = new Date().toISOString();
  const newDeployId = options.deploy
    ? crypto.createHash('sha1').update(codeToWrite + now).digest('hex').slice(0, 8)
    : existing.deployId || '00000000';

  const deployments = Array.isArray(existing.deployments) ? [...existing.deployments] : [];
  if (options.deploy || deployments.length === 0) {
    deployments.unshift({
      id: newDeployId,
      timestamp: now,
      language: langSpec.id,
      filename,
      sizeBytes: Buffer.byteLength(codeToWrite),
      author: config.username || 'admin',
      source: options.deploySource || 'Manually deployed',
      codeSnapshot: codeToWrite,
      filesSnapshot: snapshotWorkerFiles(name)
    });
  }

  const meta = {
    name,
    language: langSpec.id,
    filename,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    deployId: newDeployId,
    status: 'Active',
    requests: existing.requests || 0,
    errors: existing.errors || 0,
    subrequests: existing.subrequests || 0,
    lastRunAt: existing.lastRunAt || null,
    lastDurationMs: existing.lastDurationMs ?? null,
    lastCpuUs: existing.lastCpuUs ?? null,
    lastResponseBytes: existing.lastResponseBytes ?? null,
    totalBytesServed: existing.totalBytesServed || 0,
    daily: existing.daily || {},
    hourly: existing.hourly || {},
    spaces: options.spaces !== undefined ? options.spaces : existing.spaces || 2,
    indentUsingTabs:
      options.indentUsingTabs !== undefined ? options.indentUsingTabs : existing.indentUsingTabs || false,
    encoding: options.encoding || existing.encoding || 'UTF-8',
    eol,
    layout: options.layout || existing.layout || 'Layout: US',
    issueDetectionEnabled:
      options.issueDetectionEnabled !== undefined
        ? Boolean(options.issueDetectionEnabled)
        : existing.issueDetectionEnabled !== false,
    productionUrlEnabled:
      options.productionUrlEnabled !== undefined
        ? Boolean(options.productionUrlEnabled)
        : existing.productionUrlEnabled !== false,
    previewUrlEnabled:
      options.previewUrlEnabled !== undefined
        ? Boolean(options.previewUrlEnabled)
        : existing.previewUrlEnabled !== false,
    observabilityConfig: options.observabilityConfig ||
      existing.observabilityConfig || {
        logsEnabled: true,
        includeInvocationLogs: true,
        persistLogs: true,
        tracesEnabled: false,
        samplingRate: 100
      },
    customRoutes: Array.isArray(options.customRoutes)
      ? options.customRoutes
      : Array.isArray(existing.customRoutes)
      ? existing.customRoutes
      : [],
    publishingLink:
      options.publishingLink !== undefined
        ? String(options.publishingLink || `/${name}`).trim() || `/${name}`
        : existing.publishingLink || `/${name}`,
    publishingPath: extractPublishingPath(
      options.publishingLink !== undefined ? options.publishingLink : existing.publishingLink || `/${name}`,
      name
    ),
    issues: Array.isArray(existing.issues) ? existing.issues : [],
    invocations: Array.isArray(existing.invocations) ? existing.invocations.slice(-200) : [],
    bindings: options.bindings !== undefined ? options.bindings : existing.bindings || {},
    deployments: deployments.slice(0, 25),
    logs: Array.isArray(existing.logs) ? existing.logs.slice(-150) : []
  };

  writeJsonAtomic(path.join(workerDir, 'meta.json'), meta);
  state.workers[name] = meta;
  saveState();

  return { meta, code: codeToWrite, files: listWorkerFiles(name) };
}

// Every text file of a worker, for deployment history. Capped so a worker
// with big assets doesn't balloon meta.json; past the cap only the entry
// file is kept (the old behaviour).
const SNAPSHOT_LIMIT_BYTES = 512 * 1024;
// Binary files are kept as { b64 } so a rollback restores uploads too.
function snapshotWorkerFiles(name) {
  const files = listWorkerFiles(name);
  const dir = path.join(WORKERS_DIR, name);
  let total = 0;
  const snap = {};
  for (const f of files) {
    if (f.binary) {
      const b64 = fs.readFileSync(path.join(dir, f.name)).toString('base64');
      total += b64.length;
      snap[f.name] = { b64 };
    } else {
      total += Buffer.byteLength(f.content || '');
      snap[f.name] = f.content;
    }
    if (total > SNAPSHOT_LIMIT_BYTES) return null;
  }
  return snap;
}

function appendWorkerLog(name, level, message) {
  const meta = state.workers[name];
  if (!meta) return;
  if (!Array.isArray(meta.logs)) meta.logs = [];
  meta.logs.push({
    id: crypto.randomBytes(4).toString('hex'),
    worker: name,
    timestamp: new Date().toISOString(),
    level: level || 'log',
    message: String(message).slice(0, 8000)
  });
  if (meta.logs.length > 200) {
    meta.logs = meta.logs.slice(-200);
  }
  persistWorkerSoon(name);
}

/**
 * Determines the client IP and device details from incoming HTTP requests.
 * When accessed via the dashboard, records the dashboard HTTP client IP so that
 * dashboard-initiated actions also reflect the HTTP client IP.
 */
function parseClientAndDevice(req, isDashboardHttp = false) {
  const headers = req.headers || {};

  const candidates = [];
  const pushIp = (raw) => {
    if (!raw) return;
    for (const part of String(raw).split(',')) {
      const cleaned = part.trim().replace(/^::ffff:/i, '');
      if (cleaned) candidates.push(cleaned);
    }
  };

  pushIp(headers['cf-connecting-ip']);
  pushIp(headers['true-client-ip']);
  pushIp(headers['x-client-ip']);
  pushIp(headers['x-forwarded-for']);
  pushIp(headers['x-real-ip']);
  pushIp(req.socket?.remoteAddress);

  // 1. Prefer any public (non-private, non-local) network IP from the request headers
  let publicCandidate = candidates.find((c) => !isPrivateOrLocalIp(c));

  // 2. If all request IPs are local/private LAN IPs (e.g. 10.x.x.x, 192.168.x.x, 127.0.0.1),
  // use the network's public WAN IP instead of the device's local LAN IP on the network.
  if (!publicCandidate && PUBLIC_NETWORK_INFO && PUBLIC_NETWORK_INFO.ip && !isPrivateOrLocalIp(PUBLIC_NETWORK_INFO.ip)) {
    publicCandidate = PUBLIC_NETWORK_INFO.ip;
  }

  const ip = publicCandidate || candidates[0] || '127.0.0.1';

  const ua = String(headers['user-agent'] || state.lastDashboardClient?.userAgent || '');
  let osName = 'Unknown OS';
  if (/Windows NT 10\.0/i.test(ua)) osName = 'Windows 10/11';
  else if (/Windows NT/i.test(ua)) osName = 'Windows';
  else if (/Android/i.test(ua)) {
    const m = ua.match(/Android\s+([0-9.]+)/i);
    osName = m ? `Android ${m[1]}` : 'Android';
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    const m = ua.match(/OS\s+([0-9_]+)/i);
    osName = m ? `iOS ${m[1].replace(/_/g, '.')}` : 'iOS';
  } else if (/Mac OS X/i.test(ua)) {
    const m = ua.match(/Mac OS X\s+([0-9_]+)/i);
    osName = m ? `macOS ${m[1].replace(/_/g, '.')}` : 'macOS';
  } else if (/CrOS/i.test(ua)) osName = 'ChromeOS';
  else if (/Raspberry|aarch64|armv7l/i.test(ua)) osName = 'Linux (Raspberry Pi / ARM)';
  else if (/Linux/i.test(ua)) osName = 'Linux';

  let browser = 'Unknown Client';
  if (/Edg\//i.test(ua)) browser = 'Microsoft Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Google Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Mozilla Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Apple Safari';
  else if (/curl\//i.test(ua)) browser = ua.split(' ')[0];
  else if (/python-requests|aiohttp|httpx/i.test(ua)) browser = 'Python HTTP Client';
  else if (/node|undici/i.test(ua)) browser = 'Node.js Fetch';

  let deviceType = 'Desktop';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) deviceType = 'Mobile';
  else if (/iPad|Tablet/i.test(ua)) deviceType = 'Tablet';
  else if (/curl|wget|python|node|Postman|Insomnia/i.test(ua)) deviceType = 'CLI / API Client';
  else if (/bot|crawler|spider/i.test(ua)) deviceType = 'Bot';

  const info = {
    ip,
    source: 'http-request',
    forwardedFor: ip,
    realIp: ip,
    cf: PUBLIC_NETWORK_INFO?.cf || {},
    userAgent: ua,
    os: osName,
    browser,
    deviceType,
    language: headers['accept-language'] || 'en-US',
    protocol: headers['x-forwarded-proto'] || 'http',
    host: headers['host'] || `localhost:${PUBLIC_PORT}`,
    detectedAt: new Date().toISOString()
  };

  if (isDashboardHttp && ip && !isPrivateOrLocalIp(ip)) {
    state.lastDashboardClient = info;
  } else if (isDashboardHttp && !state.lastDashboardClient) {
    state.lastDashboardClient = info;
  }

  return info;
}

// ============================================================================
// Cloudflare `workerd` Process Pool & On-Run Code Loader
// ============================================================================
const workerdPool = new Map();

// Secret shared with this boot's worker processes (KV calls, cron triggers).
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');

// ============================================================================
// KV: a Workers-KV-style key/value store per worker, persisted under storage/kv
// ============================================================================
const KV_DIR = path.join(STORAGE_DIR, 'kv');
const KV_LIMITS = { keyBytes: 512, valueBytes: 4 * 1024 * 1024, workerBytes: 128 * 1024 * 1024, listMax: 1000 };
const kvStores = new Map(); // worker -> { map: Map(key -> { v: base64, e: expiresAtMs }), bytes }
const kvDirty = new Set();
let kvFlushTimer = null;
const kvFile = (name) => path.join(KV_DIR, `${name}.json`);
function kvStore(name) {
  let st = kvStores.get(name);
  if (st) return st;
  st = { map: new Map(), bytes: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(kvFile(name), 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) {
      if (v && typeof v.v === 'string' && (!v.e || v.e > Date.now())) {
        st.map.set(k, v);
        st.bytes += Buffer.byteLength(k) + Buffer.byteLength(v.v, 'base64');
      }
    }
  } catch (_) {}
  kvStores.set(name, st);
  return st;
}
function kvPersistSoon(name) {
  kvDirty.add(name);
  if (kvFlushTimer) return;
  kvFlushTimer = setTimeout(kvFlush, 400);
}
function kvFlush() {
  if (kvFlushTimer) clearTimeout(kvFlushTimer);
  kvFlushTimer = null;
  if (!kvDirty.size) return;
  fs.mkdirSync(KV_DIR, { recursive: true });
  for (const name of kvDirty) {
    const st = kvStores.get(name);
    if (!st) continue;
    try {
      writeJsonAtomic(kvFile(name), Object.fromEntries(st.map));
    } catch (err) {
      console.error(`KV write failed for ${name}:`, err.message);
    }
  }
  kvDirty.clear();
}
function kvGetEntry(name, key) {
  const st = kvStore(name);
  const v = st.map.get(key);
  if (!v) return null;
  if (v.e && v.e <= Date.now()) {
    st.map.delete(key);
    st.bytes -= Buffer.byteLength(key) + Buffer.byteLength(v.v, 'base64');
    kvPersistSoon(name);
    return null;
  }
  return v;
}
function kvPut(name, key, buf, ttlSec) {
  const st = kvStore(name);
  if (Buffer.byteLength(key) > KV_LIMITS.keyBytes) throw new HttpError(413, `Key longer than ${KV_LIMITS.keyBytes} bytes`);
  if (buf.length > KV_LIMITS.valueBytes) throw new HttpError(413, 'Value larger than 4 MB');
  const old = st.map.get(key);
  const oldBytes = old ? Buffer.byteLength(key) + Buffer.byteLength(old.v, 'base64') : 0;
  const newBytes = Buffer.byteLength(key) + buf.length;
  if (st.bytes - oldBytes + newBytes > KV_LIMITS.workerBytes) throw new HttpError(507, 'KV store full (128 MB per worker)');
  st.map.set(key, { v: buf.toString('base64'), e: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  st.bytes += newBytes - oldBytes;
  kvPersistSoon(name);
}
function kvDelete(name, key) {
  const st = kvStore(name);
  const old = st.map.get(key);
  if (!old) return false;
  st.map.delete(key);
  st.bytes -= Buffer.byteLength(key) + Buffer.byteLength(old.v, 'base64');
  kvPersistSoon(name);
  return true;
}
function kvList(name, prefix = '', limit = 1000, cursor = '') {
  const st = kvStore(name);
  const now = Date.now();
  const keys = [...st.map.keys()].filter((k) => k.startsWith(prefix) && (!st.map.get(k).e || st.map.get(k).e > now)).sort();
  const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
  const page = start < 0 ? [] : keys.slice(start, start + limit);
  const complete = start < 0 || start + limit >= keys.length;
  return {
    keys: page.map((k) => {
      const v = st.map.get(k);
      return v.e ? { name: k, expiration: Math.floor(v.e / 1000) } : { name: k };
    }),
    list_complete: complete,
    cursor: complete ? '' : page[page.length - 1]
  };
}
function kvRename(oldName, newName) {
  kvFlush();
  const st = kvStores.get(oldName);
  kvStores.delete(oldName);
  if (st) kvStores.set(newName, st);
  try {
    if (fs.existsSync(kvFile(oldName))) fs.renameSync(kvFile(oldName), kvFile(newName));
  } catch (_) {}
}
function kvDrop(name) {
  kvStores.delete(name);
  kvDirty.delete(name);
  try {
    fs.rmSync(kvFile(name), { force: true });
  } catch (_) {}
}

async function handleKvRequest(req, res, parsedUrl) {
  const token = String(req.headers['x-ax-token'] || '');
  const ok = token.length === INTERNAL_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(INTERNAL_TOKEN));
  const parts = parsedUrl.pathname.split('/').slice(3); // ['', '__ax', 'kv', worker, key]
  let worker = '';
  let key;
  try {
    worker = decodeURIComponent(parts[0] || '');
    key = parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : undefined;
  } catch (_) {}
  if (!ok || !state.workers[worker]) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  try {
    if (key === undefined && req.method === 'GET') {
      const q = parsedUrl.searchParams;
      const limit = Math.min(KV_LIMITS.listMax, Math.max(1, Number(q.get('limit')) || KV_LIMITS.listMax));
      sendJson(res, 200, kvList(worker, q.get('prefix') || '', limit, q.get('cursor') || ''));
      return;
    }
    if (key === undefined || key === '') throw new HttpError(400, 'Key required');
    if (req.method === 'GET') {
      const v = kvGetEntry(worker, key);
      if (!v) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('');
        return;
      }
      const buf = Buffer.from(v.v, 'base64');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
      res.end(buf);
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const buf = await readRequestBody(req);
      const ttl = Math.max(0, Math.floor(Number(parsedUrl.searchParams.get('ttl')) || 0));
      kvPut(worker, key, buf, ttl ? Math.max(60, ttl) : 0);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE') {
      kvDelete(worker, key);
      sendJson(res, 200, { ok: true });
      return;
    }
    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: err.message });
  }
}

// Ask the kernel for a free port. The old counter started at 19100 and only
// ever went up, so a second instance (or anything else on 191xx) collided.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let nodeStripTypes = null;
try {
  const mod = require('module');
  if (typeof mod.stripTypeScriptTypes === 'function') nodeStripTypes = mod.stripTypeScriptTypes;
} catch (_) {}

function stripBasicTypeScriptTypes(code) {
  // Node 22.13+/23.2+ ships a proper type stripper; the regexes below mangled
  // anything beyond the simplest annotations (object types, generics, `as`).
  if (nodeStripTypes) {
    try {
      const prevEmit = process.emitWarning;
      process.emitWarning = () => {};
      try {
        return nodeStripTypes(code, { mode: 'strip' });
      } finally {
        process.emitWarning = prevEmit;
      }
    } catch (_) {
      // not valid erasable TS (e.g. enums): fall through to the old best-effort pass
    }
  }
  return code
    .replace(/:\s*Promise<[^>]+>/g, '')
    .replace(/:\s*(Request|Response|any|string|number|boolean|unknown|void|Record<[^>]+>)\b/g, '')
    .replace(/\binterface\s+\w+\s*\{[^}]*\}/g, '');
}

function buildWorkerdWrappedScript(workerName, rawCode, language, bindings, filesMap, systemInfo, mountPrefixes, opts = {}) {
  let code = String(rawCode || '');
  if (language === 'typescript' || language === 'typescriptreact') {
    code = stripBasicTypeScriptTypes(code);
  }

  const trimmed = code.trim();
  const hasExportDefault = /export\s+default\b/.test(code);
  const hasAddEventListener = /addEventListener\s*\(\s*['"]fetch['"]/.test(code);

  let userModuleCode;
  if (hasExportDefault) {
    userModuleCode = code.replace(/export\s+default\b/, 'const __USER_DEFAULT_EXPORT__ =');
  } else if (hasAddEventListener) {
    userModuleCode = `
let __SW_HANDLER__ = null;
function addEventListener(type, listener) {
  if (type === 'fetch') __SW_HANDLER__ = listener;
}
${code}
const __USER_DEFAULT_EXPORT__ = {
  async fetch(request, env, ctx) {
    if (!__SW_HANDLER__) {
      return new Response("No fetch listener registered", { status: 500 });
    }
    let responsePromise = null;
    const event = {
      request,
      respondWith(p) { responsePromise = Promise.resolve(p); },
      waitUntil(p) { if (ctx && ctx.waitUntil) ctx.waitUntil(p); }
    };
    __SW_HANDLER__(event);
    if (responsePromise) return await responsePromise;
    return new Response("Fetch listener did not call respondWith()", { status: 500 });
  }
};
`;
  } else {
    const escapedText = JSON.stringify(trimmed);
    userModuleCode = `
const __RAW_SOURCE__ = ${escapedText};
const __USER_DEFAULT_EXPORT__ = {
  async fetch(request, env, ctx) {
    const client = env.CLIENT_DEVICE || {};
    try {
      const parsedJson = JSON.parse(__RAW_SOURCE__);
      if (parsedJson !== null && typeof parsedJson === 'object') {
        return new Response(JSON.stringify(parsedJson, null, 2), {
          headers: { 'content-type': 'application/json; charset=utf-8' }
        });
      }
    } catch (_) {}

    if (/^\\s*</.test(__RAW_SOURCE__)) {
      const isSvg = /^\\s*<svg\\b/i.test(__RAW_SOURCE__);
      const isXml = /^\\s*<\\?xml\\b/i.test(__RAW_SOURCE__);
      const ct = isSvg ? 'image/svg+xml; charset=utf-8' : isXml ? 'application/xml; charset=utf-8' : 'text/html; charset=utf-8';
      return new Response(__RAW_SOURCE__, { headers: { 'content-type': ct } });
    }

    try {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = new AsyncFunction('request', 'env', 'ctx', 'client', 'ip', 'device', 'files', __RAW_SOURCE__);
      const result = await fn(request, env, ctx, client, client.ip, client, env.FILES || {});
      if (result instanceof Response) return result;
      if (result !== undefined) {
        const body = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
        const ct = typeof result === 'object' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
        return new Response(body, { headers: { 'content-type': ct } });
      }
      const __st = __als.getStore();
      if (__st && __st.logs.length > 0) {
        return new Response(__st.logs.map((l) => l.message).join('\\n'), {
          headers: { 'content-type': 'text/plain; charset=utf-8' }
        });
      }
    } catch (_) {}

    return new Response(__RAW_SOURCE__, {
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
};
`;
  }

  const jsFiles = Object.keys(filesMap || {}).filter((k) => /\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(k));
  return `import { AsyncLocalStorage as __ALS } from 'node:async_hooks';
// Per-request log capture. (Was: console.* swapped globally on every request,
// so overlapping requests mixed up or lost each other's logs.)
const __als = new __ALS();
const __fmt = (args) => args.map((a) => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || String(a);
  try { return JSON.stringify(a); } catch (_) { return String(a); }
}).join(' ');
for (const __lvl of ['log', 'info', 'warn', 'error', 'debug']) {
  const __orig = typeof console[__lvl] === 'function' ? console[__lvl].bind(console) : () => {};
  console[__lvl] = (...args) => {
    const store = __als.getStore();
    if (!store) return __orig(...args);
    if (store.logs.length < 200) store.logs.push({ level: __lvl === 'debug' ? 'log' : __lvl, message: __fmt(args) });
  };
}

${userModuleCode}

// Built once when the worker starts, not on every request.
const __WORKER = ${JSON.stringify(workerName)};
const __PREFIXES = ${JSON.stringify(mountPrefixes || [`/${workerName}`])};
const __JS_FILES = new Set(${JSON.stringify(jsFiles)});
const __BINDINGS = ${JSON.stringify(bindings || {})};
const __FILES = Object.freeze(${JSON.stringify(filesMap || {})});
const __SYS = Object.freeze(${JSON.stringify(systemInfo || {})});
const __EXPECTS_PREFIX = ${JSON.stringify(Boolean(rawCode && rawCode.includes('/' + workerName)))};
const __TOKEN = ${JSON.stringify(opts.token || '')};
const __BACKEND_PORT = ${Number(opts.backendPort) || 0};

function __normalizeToResponse(val) {
  if (val instanceof Response) return val;
  if (typeof val === 'string') return new Response(val);
  if (val instanceof ArrayBuffer || ArrayBuffer.isView(val) || (typeof ReadableStream !== 'undefined' && val instanceof ReadableStream)) {
    return new Response(val);
  }
  if (val !== null && typeof val === 'object') {
    return new Response(JSON.stringify(val, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return new Response(val !== undefined ? String(val) : '');
}

function __packLogs(logs) {
  let list = logs.slice(-40).map((l) => ({ level: l.level, message: String(l.message).slice(0, 1500) }));
  let packed = encodeURIComponent(JSON.stringify(list));
  while (packed.length > 9000 && list.length > 1) {
    list = list.slice(Math.ceil(list.length / 2));
    packed = encodeURIComponent(JSON.stringify(list));
  }
  if (packed.length > 9000) packed = encodeURIComponent(JSON.stringify([{ level: 'warn', message: '(log output too large to show)' }]));
  return packed;
}

async function __invokeUserExport(req, env, ctx) {
  if (typeof __USER_DEFAULT_EXPORT__ === 'function') return __normalizeToResponse(await __USER_DEFAULT_EXPORT__(req, env, ctx));
  if (__USER_DEFAULT_EXPORT__ && typeof __USER_DEFAULT_EXPORT__.fetch === 'function') {
    return __normalizeToResponse(await __USER_DEFAULT_EXPORT__.fetch(req, env, ctx));
  }
  return __normalizeToResponse(__USER_DEFAULT_EXPORT__);
}

// env.KV: a Workers-KV-style store kept on this machine.
function __kv(env) {
  const call = (method, key, body, query) => {
    const path = '/__ax/kv/' + encodeURIComponent(__WORKER) + (key !== undefined ? '/' + encodeURIComponent(key) : '') + (query || '');
    const init = { method, headers: { 'x-ax-token': __TOKEN }, body };
    return env && env.__AXKV ? env.__AXKV.fetch('http://kv' + path, init) : fetch('http://127.0.0.1:' + __BACKEND_PORT + path, init);
  };
  return {
    async get(key, opt) {
      const type = typeof opt === 'string' ? opt : (opt && opt.type) || 'text';
      const r = await call('GET', String(key));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('KV get failed: ' + (await r.text()));
      if (type === 'json') return r.json();
      if (type === 'arrayBuffer') return r.arrayBuffer();
      if (type === 'stream') return r.body;
      return r.text();
    },
    async put(key, value, opt) {
      let ttl = 0;
      if (opt && opt.expirationTtl) ttl = opt.expirationTtl;
      else if (opt && opt.expiration) ttl = opt.expiration - Math.floor(Date.now() / 1000);
      const body = typeof value === 'string' || value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? value : JSON.stringify(value);
      const r = await call('PUT', String(key), body, ttl ? '?ttl=' + Math.max(1, Math.floor(ttl)) : '');
      if (!r.ok) throw new Error('KV put failed: ' + (await r.text()));
    },
    async delete(key) {
      await call('DELETE', String(key));
    },
    async list(opt) {
      const q = new URLSearchParams();
      if (opt && opt.prefix) q.set('prefix', opt.prefix);
      if (opt && opt.limit) q.set('limit', String(opt.limit));
      if (opt && opt.cursor) q.set('cursor', opt.cursor);
      const r = await call('GET', undefined, undefined, '?' + q);
      return r.json();
    }
  };
}

function __env(env, deviceInfo, clientIp) {
  return Object.assign({ KV: __kv(env) }, __BINDINGS, env || {}, {
    WORKER_NAME: __WORKER,
    CLIENT_IP: clientIp,
    CLIENT_DEVICE: deviceInfo,
    FILES: __FILES,
    SYSTEM_INFO: __SYS
  });
}

async function __scheduled(request, env, ctx, store) {
  const cron = request.headers.get('x-ax-cron') || '';
  const scheduledTime = Number(request.headers.get('x-ax-time')) || Date.now();
  const mod = __USER_DEFAULT_EXPORT__;
  const e = __env(env, {}, '127.0.0.1');
  let status = 200;
  let note = '';
  if (mod && typeof mod.scheduled === 'function') {
    const waits = [];
    await mod.scheduled(
      { cron, scheduledTime, type: 'scheduled', noRetry() {} },
      e,
      { waitUntil: (p) => waits.push(p), passThroughOnException() {} }
    );
    await Promise.allSettled(waits);
    note = 'scheduled() ran';
  } else if (mod && (typeof mod.fetch === 'function' || typeof mod === 'function')) {
    const r = await __invokeUserExport(new Request('http://localhost/', { headers: { 'x-ax-cron': cron } }), e, ctx);
    status = r.status;
    note = 'no scheduled() export, ran fetch() instead';
  } else {
    status = 501;
    note = 'this worker has no scheduled() or fetch() handler';
  }
  return new Response(note, { status, headers: { 'x-internal-logs': __packLogs(store.logs) } });
}

async function __handle(request, env, ctx, store) {
  try {
    let deviceInfo = {};
    const rawDevice = request.headers.get('x-internal-device');
    if (rawDevice) {
      try { deviceInfo = JSON.parse(rawDevice); } catch (_) {}
    }
    const origUrl = new URL(request.url);
    if (origUrl.pathname === '/__ax/scheduled' && __TOKEN && request.headers.get('x-ax-token') === __TOKEN) {
      return await __scheduled(request, env, ctx, store);
    }
    const headers = new Headers(request.headers);
    headers.delete('x-internal-device');
    headers.delete('x-ax-token');

    let strippedPath = origUrl.pathname;
    for (const prefix of __PREFIXES) {
      if (!prefix || prefix === '/') continue;
      if (strippedPath === prefix || strippedPath === prefix + '/') { strippedPath = '/'; break; }
      if (strippedPath.startsWith(prefix + '/')) { strippedPath = strippedPath.slice(prefix.length); break; }
    }
    if (__JS_FILES.has(strippedPath.slice(1))) strippedPath = '/';
    const strippedUrl = new URL(origUrl);
    strippedUrl.pathname = strippedPath;

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const bodyBuf = hasBody ? await request.arrayBuffer() : null;
    const clientIp = deviceInfo.ip || headers.get('cf-connecting-ip') || '127.0.0.1';
    const cfProps = Object.assign(
      { clientIp, httpProtocol: 'HTTP/1.1', tlsVersion: deviceInfo.protocol === 'https' ? 'TLSv1.3' : '', clientTcpRtt: 1, timezone: __SYS.timezone || 'UTC' },
      deviceInfo.cf || {}
    );
    const makeReq = (u) => {
      const r = new Request(u, { method: request.method, headers, body: bodyBuf ? bodyBuf.slice(0) : undefined });
      try { Object.defineProperty(r, 'cf', { value: cfProps, enumerable: true, configurable: true }); } catch (_) {}
      return r;
    };
    const e = __env(env, deviceInfo, clientIp);
    const isRootMount = origUrl.pathname === '/' + __WORKER || origUrl.pathname === '/' + __WORKER + '/';
    const first = __EXPECTS_PREFIX && isRootMount ? origUrl : strippedUrl;
    let resp = await __invokeUserExport(makeReq(first.toString()), e, ctx);
    // Retry with the other URL only when the code visibly routes on its full
    // path. (Was: every 404 ran the handler twice, side effects and all.)
    if (resp.status === 404 && __EXPECTS_PREFIX) {
      const second = first === origUrl ? strippedUrl : origUrl;
      if (second.toString() !== first.toString()) {
        const alt = await __invokeUserExport(makeReq(second.toString()), e, ctx);
        if (alt.status !== 404) resp = alt;
      }
    }
    if (!store.logs.length) return resp;
    const out = new Headers(resp.headers);
    out.set('x-internal-logs', __packLogs(store.logs));
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
  } catch (err) {
    store.logs.push({ level: 'error', message: err && err.stack ? err.stack : String(err) });
    return new Response(err && err.stack ? err.stack : String(err), {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-internal-logs': __packLogs(store.logs) }
    });
  }
}

export default {
  fetch(request, env, ctx) {
    const store = { logs: [] };
    return __als.run(store, () => __handle(request, env, ctx, store));
  }
};
`;
}

function resolveWorkerdBinary() {
  const candidates = [
    path.join(ROOT_DIR, '.workerd-local', 'node_modules', '.bin', 'workerd'),
    path.join(ROOT_DIR, 'node_modules', '.bin', 'workerd'),
    '/usr/local/bin/workerd',
    '/usr/bin/workerd'
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return 'workerd';
}

let workerdBinaryUnsupportedOnHost = false;

function buildWholeWorkerJsCode(workerName, rawCode, meta, workerFiles) {
  const vm = require('vm');
  const primaryFile = (meta && meta.filename) || 'worker.js';
  const jsFiles = (Array.isArray(workerFiles) ? workerFiles : []).filter(
    (f) => f && f.name && /\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(f.name) && String(f.content || '').trim()
  );

  if (jsFiles.length <= 1) {
    return jsFiles.length === 1 ? jsFiles[0].content : rawCode;
  }

  // Filter out an untouched default "Hello from <worker>" boilerplate file when other real JS files exist
  const isUntouchedBoilerplate = (f) => {
    const c = String(f.content || '').trim();
    return c.length < 700 && c.includes(`Hello from ${workerName}`) && c.includes('new Response(');
  };
  const nonBoilerplate = jsFiles.filter((f) => !isUntouchedBoilerplate(f));
  const candidates = nonBoilerplate.length > 0 ? nonBoilerplate : jsFiles;

  if (candidates.length === 1) {
    return candidates[0].content;
  }

  // Drop any candidate whose trimmed content is already completely contained in another file
  const deduplicatedFiles = candidates.filter((f, idx) => {
    const trimmed = String(f.content || '').trim();
    return !candidates.some((other, oIdx) => oIdx !== idx && String(other.content || '').includes(trimmed));
  });

  const activeList = deduplicatedFiles.length > 0 ? deduplicatedFiles : [candidates[0]];
  if (activeList.length === 1) {
    return activeList[0].content;
  }

  // Check if one file explicitly imports the other files via ES module import
  const entryObj = activeList.find((f) => f.name === primaryFile) || activeList[0];
  const hasExplicitImports = activeList.some(
    (f) =>
      f.name !== entryObj.name &&
      new RegExp(`from\\s+['"]\\.?\\/?${f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(entryObj.content)
  );
  if (hasExplicitImports) {
    return entryObj.content;
  }

  const normalizeChunk = (f) => {
    let chunk = f.name.endsWith('.ts') || f.name.endsWith('.tsx')
      ? stripBasicTypeScriptTypes(f.content)
      : String(f.content || '');
    return chunk.replace(/^\s*export\s+(async\s+function|function|const|let|var|class)\b/gm, '$1');
  };

  const helperFiles = activeList.filter(
    (f) => !/export\s+default\b/.test(f.content) && !/addEventListener\s*\(\s*['"]fetch['"]/.test(f.content)
  );
  const handlerFiles = activeList
    .filter((f) => /export\s+default\b/.test(f.content) || /addEventListener\s*\(\s*['"]fetch['"]/.test(f.content))
    .sort((a, b) => {
      if (a.name === 'index.js' && b.name !== 'index.js') return -1;
      if (b.name === 'index.js' && a.name !== 'index.js') return 1;
      return 0;
    });

  // When multiple files each define their own Worker handler (e.g. both worker.js and index.js have `export default`),
  // wrap every file in its own isolated closure so top-level identifiers never collide and EVERY file runs on each request.
  if (handlerFiles.length >= 2) {
    const sharedHelpersCode = helperFiles.map((f) => `// === Helper File: ${f.name} ===\n${normalizeChunk(f)}`).join('\n\n');
    const factories = handlerFiles.map((f, idx) => {
      const cleaned = normalizeChunk(f);
      let bodyCode;
      if (/export\s+default\b/.test(cleaned)) {
        bodyCode = cleaned.replace(/export\s+default\b/, 'const __FILE_DEFAULT_EXPORT__ =') + '\nreturn __FILE_DEFAULT_EXPORT__;';
      } else {
        bodyCode = `
let __SW_LISTENER__ = null;
function addEventListener(type, listener) { if (type === 'fetch') __SW_LISTENER__ = listener; }
${cleaned}
return {
  async fetch(request, env, ctx) {
    if (!__SW_LISTENER__) return new Response('', { status: 404 });
    let p = null;
    __SW_LISTENER__({ request, respondWith(r) { p = Promise.resolve(r); }, waitUntil(w) { if (ctx && ctx.waitUntil) ctx.waitUntil(w); } });
    return p ? await p : new Response('', { status: 404 });
  }
};`;
      }
      return `const __HANDLER_MOD_${idx}__ = (() => {\n${sharedHelpersCode}\n// === Handler File: ${f.name} ===\n${bodyCode}\n})();`;
    });

    const handlersArrayExpr = handlerFiles
      .map((f, idx) => `{ name: ${JSON.stringify(f.name)}, mod: __HANDLER_MOD_${idx}__ }`)
      .join(', ');

    return `${factories.join('\n\n')}

export default {
  async fetch(request, env, ctx) {
    const __handlers = [${handlersArrayExpr}];
    const __reqBody = (request.method !== 'GET' && request.method !== 'HEAD') ? await request.arrayBuffer() : undefined;
    const __cloneReq = () => {
      const r = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: __reqBody ? __reqBody.slice(0) : undefined
      });
      if (request.cf) {
        try { Object.defineProperty(r, 'cf', { value: request.cf, enumerable: true, configurable: true }); } catch (_) {}
      }
      return r;
    };
    const __results = [];
    for (const __h of __handlers) {
      try {
        const __fn = typeof __h.mod === 'function' ? __h.mod : (__h.mod && typeof __h.mod.fetch === 'function' ? __h.mod.fetch.bind(__h.mod) : null);
        if (!__fn) continue;
        const __res = await __fn(__cloneReq(), env, ctx);
        if (__res instanceof Response) {
          const __buf = await __res.clone().arrayBuffer();
          __results.push({ name: __h.name, res: __res, status: __res.status, len: __buf.byteLength });
        }
      } catch (__err) {
        console.error('[' + __h.name + ']', __err && __err.stack ? __err.stack : String(__err));
      }
    }
    const __auth = __results.find((r) => r.status === 401 || r.status === 403);
    if (/__auth/ && __auth) return __auth.res;
    const __nonEmptyOk = __results.find((r) => r.status < 400 && r.len > 0);
    if (__nonEmptyOk) return __nonEmptyOk.res;
    const __anyOk = __results.find((r) => r.status < 400);
    if (__anyOk) return __anyOk.res;
    return __results[0] ? __results[0].res : new Response('Not found', { status: 404 });
  }
};`;
  }

  // Sort files so helper/header files without `export default` come BEFORE the file with `export default`
  const sorted = [...activeList].sort((a, b) => {
    const aHasExport = /export\s+default\b/.test(a.content);
    const bHasExport = /export\s+default\b/.test(b.content);
    if (aHasExport !== bHasExport) return aHasExport ? 1 : -1;
    const aHasConstTop = /^\s*(\/\/[^\n]*\n|\s)*const\s+/m.test(a.content);
    const bHasConstTop = /^\s*(\/\/[^\n]*\n|\s)*const\s+/m.test(b.content);
    if (aHasConstTop !== bHasConstTop) return aHasConstTop ? -1 : 1;
    return 0;
  });

  const checkSyntax = (src) => {
    try {
      const sanitized = src
        .replace(/export\s+default\b/g, 'const __TMP_DEFAULT_EXPORT__ =')
        .replace(/^\s*export\s+(async\s+function|function|const|let|var|class)\b/gm, '$1');
      new vm.Script(sanitized);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || '' };
    }
  };

  let combined = '';
  for (const f of sorted) {
    let chunk = normalizeChunk(f);

    if (!combined) {
      combined = `// === File: ${f.name} ===\n${chunk}`;
      continue;
    }

    let candidateCombined = `${combined}\n\n// === File: ${f.name} ===\n${chunk}`;
    for (let guard = 0; guard < 40; guard++) {
      const check = checkSyntax(candidateCombined);
      if (check.ok) break;
      const dupMatch = check.message.match(/Identifier '([^']+)' has already been declared/);
      if (!dupMatch) break;
      const dupId = dupMatch[1];
      const escapedId = dupId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const fnRegex = new RegExp(`\\b(async\\s+)?function\\s+${escapedId}\\s*\\([\\s\\S]*?\\n\\}`, 'm');
      const varRegex = new RegExp(`^\\s*(const|let|var)\\s+${escapedId}\\s*=[^;]+;`, 'm');
      if (fnRegex.test(chunk)) {
        chunk = chunk.replace(fnRegex, `/* deduplicated ${dupId} */`);
      } else if (varRegex.test(chunk)) {
        chunk = chunk.replace(varRegex, `/* deduplicated ${dupId} */`);
      } else {
        break;
      }
      candidateCombined = `${combined}\n\n// === File: ${f.name} ===\n${chunk}`;
    }

    if (checkSyntax(candidateCombined).ok) {
      combined = candidateCombined;
    } else if (/export\s+default\b/.test(f.content)) {
      combined = f.content;
    }
  }

  return combined || rawCode;
}

function startNodeWorkerFallbackServer(port, compiledWorkerPath, workerName) {
  return new Promise((resolve) => {
    const { pathToFileURL } = require('url');
    const moduleVersion = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let cachedWorkerModPromise = null;

    const isolateSrv = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyBuf = Buffer.concat(chunks);

        if (!cachedWorkerModPromise) {
          const modUrl = `${pathToFileURL(compiledWorkerPath).href}?v=${moduleVersion}`;
          cachedWorkerModPromise = import(modUrl);
        }
        const workerMod = await cachedWorkerModPromise;
        const handler = workerMod.default || workerMod;
        if (!handler || typeof handler.fetch !== 'function') {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Worker module does not export default { async fetch(request, env, ctx) }');
          return;
        }

        const hostHeader = req.headers.host || `127.0.0.1:${port}`;
        const fullUrl = new URL(req.url || '/', `http://${hostHeader}`).toString();
        const reqHeaders = new Headers();
        for (const [k, v] of Object.entries(req.headers || {})) {
          if (Array.isArray(v)) reqHeaders.set(k, v.join(', '));
          else if (v !== undefined) reqHeaders.set(k, String(v));
        }

        const method = (req.method || 'GET').toUpperCase();
        const fetchInit = {
          method,
          headers: reqHeaders
        };
        if (method !== 'GET' && method !== 'HEAD' && bodyBuf.length > 0) {
          fetchInit.body = bodyBuf;
        }

        const webReq = new Request(fullUrl, fetchInit);
        const ctx = {
          waitUntil(p) {
            Promise.resolve(p).catch(() => {});
          },
          passThroughOnException() {}
        };
        const webRes = await handler.fetch(webReq, {}, ctx);
        const outHeaders = {};
        if (webRes.headers && typeof webRes.headers.forEach === 'function') {
          webRes.headers.forEach((val, key) => {
            outHeaders[key] = val;
          });
        }
        const arrayBuf = await webRes.arrayBuffer();
        res.writeHead(webRes.status || 200, outHeaders);
        res.end(Buffer.from(arrayBuf));
      } catch (err) {
        appendWorkerLog(workerName, 'error', `[node fallback] ${err.message}`);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    isolateSrv.on('error', () => resolve(null));
    isolateSrv.listen(port, '127.0.0.1', () => resolve(isolateSrv));
  });
}

const startingWorkers = new Map();
async function ensureWorkerdInstance(workerName) {
  const meta = state.workers[workerName] || {};
  const bundle = getWorkerBundle(workerName);
  if (!bundle.codeHash) {
    bundle.wholeWorkerCode = buildWholeWorkerJsCode(workerName, bundle.rawCode, meta, bundle.files);
    bundle.codeHash = crypto
      .createHash('sha256')
      .update(`${workerLanguage(meta)}:${bundle.wholeWorkerCode}:${JSON.stringify(meta.bindings || {})}:${JSON.stringify(bundle.filesMap)}:${JSON.stringify(bundle.mountPrefixes)}`)
      .digest('hex');
  }
  const existing = workerdPool.get(workerName);
  if (existing && existing.codeHash === bundle.codeHash && ((existing.proc && !existing.proc.killed) || existing.fallbackServer)) {
    existing.lastUsed = Date.now();
    return existing.port;
  }
  // single flight: concurrent first requests share one start (was: each
  // spawned its own workerd and all but one were orphaned)
  const key = `${workerName}:${bundle.codeHash}`;
  if (!startingWorkers.has(key)) {
    startingWorkers.set(key, startWorkerd(workerName, meta, bundle).finally(() => startingWorkers.delete(key)));
  }
  return startingWorkers.get(key);
}

async function startWorkerd(workerName, meta, bundle) {
  const language = workerLanguage(meta);
  const bindings = meta.bindings;
  const workerFiles = bundle.files;
  const filesMap = bundle.filesMap;
  const wholeWorkerCode = bundle.wholeWorkerCode;
  const mountPrefixes = bundle.mountPrefixes;
  const codeHash = bundle.codeHash;
  const sysInfo = getLiveSystemTelemetry();
  const existing = workerdPool.get(workerName);
  if (existing) {
    if (existing.proc) {
      try {
        existing.proc.kill('SIGTERM');
      } catch (_) {}
    }
    if (existing.fallbackServer) {
      try {
        existing.fallbackServer.close();
      } catch (_) {}
    }
    workerdPool.delete(workerName);
  }

  const port = await getFreePort();
  const runDir = path.join(RUNTIME_DIR, workerName);
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }
  fs.writeFileSync(path.join(runDir, 'package.json'), '{"type":"module"}\n', 'utf8');

  const primaryFile = meta.filename || 'worker.js';
  const extraModuleLines = [];

  for (const f of workerFiles) {
    if (f.binary || f.name === primaryFile || f.name === 'entry.js' || f.name === 'config.capnp' || f.name === 'package.json') continue;
    const safeDiskPath = workerFilePath(runDir, f.name, true);
    let modContent = f.content;
    if (f.name.endsWith('.ts') || f.name.endsWith('.tsx')) {
      modContent = stripBasicTypeScriptTypes(modContent);
    }
    fs.writeFileSync(safeDiskPath, modContent, 'utf8');
    if (f.name.endsWith('.js') || f.name.endsWith('.mjs') || f.name.endsWith('.ts')) {
      extraModuleLines.push(`    (name = ${JSON.stringify(f.name)}, esModule = embed ${JSON.stringify(f.name)}),`);
    } else if (f.name.endsWith('.json')) {
      extraModuleLines.push(`    (name = ${JSON.stringify(f.name)}, json = embed ${JSON.stringify(f.name)}),`);
    } else {
      extraModuleLines.push(`    (name = ${JSON.stringify(f.name)}, text = embed ${JSON.stringify(f.name)}),`);
    }
  }

  const wrappedScript = buildWorkerdWrappedScript(
    workerName,
    wholeWorkerCode,
    language,
    bindings,
    filesMap,
    sysInfo,
    mountPrefixes,
    { token: INTERNAL_TOKEN, backendPort: BACKEND_PORT }
  );
  const compiledWorkerPath = path.join(runDir, 'entry.js');
  const capnpPath = path.join(runDir, 'config.capnp');

  fs.writeFileSync(compiledWorkerPath, wrappedScript, 'utf8');

  const capnpConfig = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "axkv", external = (address = "127.0.0.1:${BACKEND_PORT}", http = ())),
  ],
  sockets = [
    ( name = "http",
      address = "127.0.0.1:${port}",
      http = (),
      service = "main"
    ),
  ]
);

const mainWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "entry.js"),
${extraModuleLines.join('\n')}
  ],
  compatibilityDate = "2025-01-01",
  compatibilityFlags = ["nodejs_als"],
  bindings = [ (name = "__AXKV", service = "axkv") ],
);
`;
  fs.writeFileSync(capnpPath, capnpConfig, 'utf8');

  let proc = null;
  let spawnFailed = workerdBinaryUnsupportedOnHost;
  if (!workerdBinaryUnsupportedOnHost) {
    try {
      proc = spawn(resolveWorkerdBinary(), ['serve', capnpPath], {
        cwd: runDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      // Must be read: a full, unread stdout pipe blocks workerd mid-request.
      proc.stdout.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) appendWorkerLog(workerName, 'log', msg);
      });

      proc.on('error', () => {
        spawnFailed = true;
      });

      proc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (!msg) return;
        if (/MmapAligned\(\)\s*failed|TCMALLOC_ADDRESS_BITS|tcmalloc|Exec format error/i.test(msg)) {
          workerdBinaryUnsupportedOnHost = true;
          spawnFailed = true;
          return;
        }
        appendWorkerLog(workerName, /warning/i.test(msg) ? 'warn' : 'error', `[workerd] ${msg}`);
      });

      proc.on('exit', (code) => {
        if (code !== 0) spawnFailed = true;
        const current = workerdPool.get(workerName);
        if (current && current.proc === proc && !current.fallbackServer) {
          workerdPool.delete(workerName);
        }
      });
    } catch (_) {
      spawnFailed = true;
    }
  }

  let workerdListening = false;
  if (!spawnFailed && proc) {
    workerdListening = await new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        if (spawnFailed) return resolve(false);
        attempts++;
        const sock = require('net').createConnection({ host: '127.0.0.1', port }, () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => {
          sock.destroy();
          // ~6 s: a cold workerd on a Raspberry Pi can need well over the old 0.7 s
          if (attempts > 120) return resolve(false);
          setTimeout(check, 50);
        });
      };
      setTimeout(check, 20);
    });
  }

  if (workerdListening) {
    workerdPool.set(workerName, { proc, port, codeHash, fallbackServer: null, lastUsed: Date.now() });
    return port;
  }

  if (proc) {
    try {
      proc.kill('SIGTERM');
    } catch (_) {}
  }

  const fallbackServer = await startNodeWorkerFallbackServer(port, compiledWorkerPath, workerName);
  workerdPool.set(workerName, { proc: null, port, codeHash, fallbackServer, lastUsed: Date.now() });
  return port;
}

// ============================================================================
// Cron triggers: standard 5-field schedules (plus @hourly, @daily, …).
// JS workers get scheduled(controller, env, ctx) like on Cloudflare; other
// runtimes are simply requested at their main path.
// ============================================================================
const CRON_ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
};
function parseCronField(field, min, max) {
  const out = new Set();
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo;
    let hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      [lo, hi] = range.split('-').map(Number);
    } else {
      lo = Number(range);
      hi = stepStr === undefined ? lo : max;
    }
    if (![lo, hi].every(Number.isInteger) || lo < min || hi > max || lo > hi) throw new Error(`"${part}" isn't within ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
function parseCron(expr) {
  const raw = String(expr || '').trim().toLowerCase();
  const fields = (CRON_ALIASES[raw] || raw).split(/\s+/);
  if (fields.length !== 5) throw new HttpError(400, 'A schedule has 5 fields: minute hour day month weekday, e.g. */5 * * * *');
  try {
    const dow = parseCronField(fields[4], 0, 7);
    if (dow.has(7)) dow.add(0);
    return {
      expr: String(expr).trim(),
      minute: parseCronField(fields[0], 0, 59),
      hour: parseCronField(fields[1], 0, 23),
      dom: parseCronField(fields[2], 1, 31),
      month: parseCronField(fields[3], 1, 12),
      dow,
      domStar: fields[2] === '*',
      dowStar: fields[4] === '*'
    };
  } catch (err) {
    throw new HttpError(400, `Invalid schedule: ${err.message}`);
  }
}
function cronMatches(c, d) {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk; // classic cron: either day field may match
}
function cronNext(c, from = new Date()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

async function runCron(name, job, manual = false) {
  const meta = state.workers[name];
  if (!meta) return null;
  const url = isWorkerdWorker(name) ? '/__ax/scheduled' : extractPublishingPath(meta.publishingLink || meta.publishingPath, name);
  const req = {
    method: 'GET',
    url,
    headers: {
      host: 'localhost',
      'user-agent': 'alex-aero-cron',
      'x-ax-token': INTERNAL_TOKEN,
      'x-ax-cron': job.expr,
      'x-ax-time': String(Date.now())
    },
    socket: { remoteAddress: '127.0.0.1' },
    _cron: job.expr
  };
  const t0 = Date.now();
  let status = 0;
  try {
    const r = await executeWorkerAction(name, req, Buffer.alloc(0), url);
    status = r.status;
    if (r.stream) {
      let bytes = 0;
      r.stream.on('data', (c) => (bytes += c.length));
      await new Promise((done) => r.stream.on('end', done).on('error', done));
      r.onEnd(bytes);
    }
  } catch (err) {
    status = 500;
    appendWorkerLog(name, 'error', `[cron ${job.expr}] ${err.message}`);
  }
  job.lastRunAt = new Date().toISOString();
  job.lastStatus = status;
  job.lastMs = Date.now() - t0;
  appendWorkerLog(name, status && status < 400 ? 'info' : 'error', `${manual ? 'Ran' : 'Schedule'} ${job.expr} → ${status} in ${job.lastMs} ms`);
  persistWorkerSoon(name);
  return { status, ms: job.lastMs };
}

function scheduleTick() {
  const now = new Date();
  setTimeout(scheduleTick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 30).unref();
  const slot = new Date(now);
  slot.setSeconds(0, 0);
  for (const [name, meta] of Object.entries(state.workers)) {
    for (const job of Array.isArray(meta.crons) ? meta.crons : []) {
      let c;
      try {
        c = parseCron(job.expr);
      } catch (_) {
        continue;
      }
      if (cronMatches(c, slot) && job.lastSlot !== slot.getTime()) {
        job.lastSlot = slot.getTime();
        runCron(name, job).catch(() => {});
      }
    }
  }
}

function hasSchedules(name) {
  const m = state.workers[name];
  return Boolean(m && Array.isArray(m.crons) && m.crons.length);
}

// Idle workers give their memory back; the next request starts them again.
const IDLE_REAP_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [name, e] of workerdPool.entries()) {
    if (now - (e.lastUsed || now) < IDLE_REAP_MS || hasSchedules(name)) continue;
    try {
      if (e.proc) e.proc.kill('SIGTERM');
      if (e.fallbackServer) e.fallbackServer.close();
    } catch (_) {}
    workerdPool.delete(name);
  }
}, 60 * 1000).unref();

// Reused connections to the worker processes (was: a new TCP connection per request).
const workerdAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 512, maxFreeSockets: 64 });
function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Resolves as soon as the worker's headers arrive; the body is a stream.
function forwardToWorkerd(port, req, bodyBuffer, deviceInfo, targetPathWithQuery) {
  return new Promise((resolve, reject) => {
    const forwardHeaders = { ...req.headers };
    for (const h of ['connection', 'upgrade', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding']) {
      delete forwardHeaders[h];
    }
    forwardHeaders['x-client-ip'] = deviceInfo.ip;
    forwardHeaders['x-real-ip'] = deviceInfo.ip;
    forwardHeaders['true-client-ip'] = deviceInfo.ip;
    forwardHeaders['cf-connecting-ip'] = deviceInfo.ip;
    forwardHeaders['x-forwarded-for'] = deviceInfo.ip;
    if (deviceInfo.cf) {
      if (!forwardHeaders['cf-ipcountry'] && deviceInfo.cf.country) {
        forwardHeaders['cf-ipcountry'] = String(deviceInfo.cf.country);
      }
      if (!forwardHeaders['cf-ipcity'] && deviceInfo.cf.city) {
        forwardHeaders['cf-ipcity'] = String(deviceInfo.cf.city);
      }
      if (!forwardHeaders['cf-ipcontinent'] && deviceInfo.cf.continent) {
        forwardHeaders['cf-ipcontinent'] = String(deviceInfo.cf.continent);
      }
      if (!forwardHeaders['cf-iplatitude'] && deviceInfo.cf.latitude !== undefined) {
        forwardHeaders['cf-iplatitude'] = String(deviceInfo.cf.latitude);
      }
      if (!forwardHeaders['cf-iplongitude'] && deviceInfo.cf.longitude !== undefined) {
        forwardHeaders['cf-iplongitude'] = String(deviceInfo.cf.longitude);
      }
      if (!forwardHeaders['cf-region'] && deviceInfo.cf.region) {
        forwardHeaders['cf-region'] = String(deviceInfo.cf.region);
      }
      if (!forwardHeaders['cf-region-code'] && deviceInfo.cf.regionCode) {
        forwardHeaders['cf-region-code'] = String(deviceInfo.cf.regionCode);
      }
      if (!forwardHeaders['cf-postal-code'] && deviceInfo.cf.postalCode) {
        forwardHeaders['cf-postal-code'] = String(deviceInfo.cf.postalCode);
      }
      if (!forwardHeaders['cf-timezone'] && deviceInfo.cf.timezone) {
        forwardHeaders['cf-timezone'] = String(deviceInfo.cf.timezone);
      }
      if (!forwardHeaders['cf-ray']) {
        forwardHeaders['cf-ray'] = `${crypto.randomBytes(8).toString('hex')}-${deviceInfo.cf.colo || 'IAD'}`;
      }
      if (!forwardHeaders['cf-visitor']) {
        forwardHeaders['cf-visitor'] = JSON.stringify({ scheme: deviceInfo.protocol || 'http' });
      }
    }
    forwardHeaders['x-internal-device'] = JSON.stringify(deviceInfo);
    if (bodyBuffer && bodyBuffer.length > 0) {
      forwardHeaders['content-length'] = Buffer.byteLength(bodyBuffer);
    } else {
      delete forwardHeaders['content-length'];
    }

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: targetPathWithQuery,
        method: req.method,
        headers: forwardHeaders,
        agent: workerdAgent,
        timeout: 30000
      },
      (proxyRes) => {
        resolve({
          status: proxyRes.statusCode || 200,
          headers: proxyRes.headers,
          stream: proxyRes
        });
      }
    );

    proxyReq.on('error', (err) => reject(err));
    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('workerd request timed out'));
    });

    if (bodyBuffer && bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });
}

function interpolateTemplate(templateStr, workerName, req, deviceInfo, queryObj, markup = false) {
  const vars = {
    worker: workerName,
    ip: deviceInfo.ip,
    clientIp: deviceInfo.ip,
    userAgent: deviceInfo.userAgent,
    os: deviceInfo.os,
    browser: deviceInfo.browser,
    deviceType: deviceInfo.deviceType,
    language: deviceInfo.language,
    method: req.method || 'GET',
    url: req.url || `/${workerName}`,
    path: (req.url || `/${workerName}`).split('?')[0],
    host: deviceInfo.host,
    timestamp: new Date().toISOString(),
    query: JSON.stringify(queryObj || {})
  };
  // In HTML/XML/SVG the values (URL, query, User-Agent) are attacker-controlled,
  // so they're escaped there; otherwise ?q=<script> was reflected verbatim.
  return String(templateStr).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (vars[key] === undefined) return '';
    return markup ? escapeHtmlText(vars[key]) : String(vars[key]);
  });
}

function executeProcessCommand(cmd, args, codeFilePath, envVars, stdinBuffer) {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args, codeFilePath], {
      cwd: path.dirname(codeFilePath),
      env: { ...process.env, ...envVars },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    const LIMIT = 8 * 1024 * 1024;
    let outBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }, 15000);

    child.stdout.on('data', (c) => {
      outBytes += c.length;
      if (outBytes <= LIMIT) stdoutChunks.push(c);
    });
    child.stderr.on('data', (c) => {
      if (stderrChunks.reduce((n, x) => n + x.length, 0) < 256 * 1024) stderrChunks.push(c);
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      let stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) stderr += `${stderr ? '\n' : ''}Timed out after 15 s and was stopped.`;
      else if (signal) stderr += `${stderr ? '\n' : ''}Killed by ${signal}.`;
      resolve({
        exitCode: timedOut ? 124 : exitCode === null ? 1 : exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr
      });
    });

    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err.message
      });
    });

    if (stdinBuffer && stdinBuffer.length > 0) {
      child.stdin.write(stdinBuffer);
    }
    child.stdin.end();
  });
}

function detectDataFormatContentType(bodyStr, filename, languageId, currentContentType, isStaticSubFile = false) {
  const existing = String(currentContentType || '').trim();
  const existingLower = existing.toLowerCase();

  // If the worker explicitly returned a specific non-plain-text Content-Type, honor it
  if (
    existing &&
    !existingLower.startsWith('text/plain') &&
    !existingLower.startsWith('application/octet-stream')
  ) {
    return existing;
  }

  const trimmed = String(bodyStr || '').trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'application/json; charset=utf-8';
    } catch (_) {}
  }

  if (
    /^<!doctype\s+html\b/i.test(trimmed) ||
    /^<!--[\s\S]*?-->\s*<[a-zA-Z]/i.test(trimmed) ||
    /^<(html|head|body|div|span|h[1-6]|p|a|ul|ol|li|main|section|article|header|footer|nav|aside|table|thead|tbody|tr|td|th|form|input|button|select|textarea|label|script|style|link|meta|title|canvas|img|video|audio|iframe|figure|figcaption|details|summary|pre|code|blockquote|hr|br)\b/i.test(trimmed)
  ) {
    return 'text/html; charset=utf-8';
  }
  if (/^<svg\b/i.test(trimmed)) {
    return 'image/svg+xml; charset=utf-8';
  }
  if (/^(<\?xml\b|<rss\b|<feed\b)/i.test(trimmed)) {
    return 'application/xml; charset=utf-8';
  }

  const ext = path.extname(String(filename || '')).slice(1).toLowerCase();
  const mimeByExt = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    svg: 'image/svg+xml; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    css: 'text/css; charset=utf-8',
    scss: 'text/css; charset=utf-8',
    less: 'text/css; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    yaml: 'text/yaml; charset=utf-8',
    yml: 'text/yaml; charset=utf-8'
  };
  if (isStaticSubFile) {
    mimeByExt.js = 'application/javascript; charset=utf-8';
    mimeByExt.mjs = 'application/javascript; charset=utf-8';
  }
  if (mimeByExt[ext]) return mimeByExt[ext];

  if (languageId === 'html' || languageId === 'handlebars' || languageId === 'razor' || languageId === 'pug') {
    return 'text/html; charset=utf-8';
  }
  if (languageId === 'xml') return 'application/xml; charset=utf-8';
  if (languageId === 'css' || languageId === 'scss' || languageId === 'less') return 'text/css; charset=utf-8';

  return existing || 'text/plain; charset=utf-8';
}

// Counters, per-day/per-hour buckets (for real charts), the invocation list and
// issue tracking. Persisted in the background (see persistWorkerSoon).
function recordInvocation(workerName, meta, req, parsedUrl, deviceInfo, status, hrStart, responseBytes, errorMessage) {
  const totalUs = Math.max(1, Number((process.hrtime.bigint() - hrStart) / 1000n));
  const durationMs = Number((totalUs / 1000).toFixed(2));
  // time spent inside the runtime itself, when the branch measured it
  const cpuUs = meta._execUs || totalUs;
  delete meta._execUs;
  const now = new Date();
  const nowIso = now.toISOString();
  const isError = status >= 500;

  meta.requests = (meta.requests || 0) + 1;
  meta.totalBytesServed = (meta.totalBytesServed || 0) + responseBytes;
  if (isError) meta.errors = (meta.errors || 0) + 1;
  meta.lastRunAt = nowIso;
  meta.lastDurationMs = durationMs;
  meta.lastCpuUs = cpuUs;
  meta.lastResponseBytes = responseBytes;

  const bump = (bucket, key, keep) => {
    if (!meta[bucket] || typeof meta[bucket] !== 'object') meta[bucket] = {};
    const b = meta[bucket][key] || (meta[bucket][key] = { requests: 0, errors: 0, totalMs: 0, bytes: 0 });
    b.requests += 1;
    if (isError) b.errors += 1;
    b.totalMs = Number((b.totalMs + durationMs).toFixed(2));
    b.bytes += responseBytes;
    const keys = Object.keys(meta[bucket]).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - keep))) delete meta[bucket][old];
  };
  bump('daily', dayKey(now), 30);
  bump('hourly', hourKey(now), 48);

  if (!Array.isArray(meta.invocations)) meta.invocations = [];
  meta.invocations.push({
    id: crypto.randomBytes(4).toString('hex'),
    timestamp: nowIso,
    method: req._cron ? 'CRON' : req.method || 'GET',
    path: req._cron ? req._cron : parsedUrl.pathname,
    url: `${deviceInfo.protocol || 'http'}://${deviceInfo.host}${req.url || '/' + workerName}`,
    status,
    outcome: isError ? 'exception' : 'ok',
    durationMs,
    wallMs: durationMs,
    cpuUs,
    memoryMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
    responseBytes,
    clientIp: deviceInfo.ip,
    os: deviceInfo.os,
    browser: deviceInfo.browser,
    deviceType: deviceInfo.deviceType,
    versionId: meta.deployId || '00000000'
  });
  if (meta.invocations.length > 200) meta.invocations = meta.invocations.slice(-200);

  if (isError && meta.issueDetectionEnabled !== false) {
    if (!Array.isArray(meta.issues)) meta.issues = [];
    const issueMsg = errorMessage || `HTTP ${status} from ${meta.filename}`;
    const existingIssue = meta.issues.find((iss) => iss.message === issueMsg && iss.status === 'active');
    if (existingIssue) {
      existingIssue.occurrences = (existingIssue.occurrences || 1) + 1;
      existingIssue.lastSeen = nowIso;
    } else {
      meta.issues.unshift({
        id: crypto.randomBytes(4).toString('hex'),
        title: issueMsg.split('\n')[0].slice(0, 160),
        message: issueMsg.slice(0, 8000),
        filename: meta.filename,
        status: 'active',
        occurrences: 1,
        firstSeen: nowIso,
        lastSeen: nowIso
      });
      meta.issues = meta.issues.slice(0, 100);
    }
  }
  persistWorkerSoon(workerName);
  return { durationMs, cpuUs };
}

async function executeWorkerAction(workerName, req, bodyBuffer, subPathAndQuery) {
  const hrStart = process.hrtime.bigint();
  const meta = state.workers[workerName];
  if (!meta) {
    return {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from('Not found', 'utf8'),
      durationMs: 0
    };
  }

  const bundle = getWorkerBundle(workerName);
  const rawCode = bundle.rawCode;
  const deviceInfo = parseClientAndDevice(req, false);
  const parsedUrl = new URL(req.url || `/${workerName}`, `http://${deviceInfo.host}`);
  const queryObj = Object.fromEntries(parsedUrl.searchParams.entries());
  const languageId = workerLanguage(meta);
  const langSpec = getLangSpec(languageId);
  const codeFilePath = getWorkerCodePath(workerName);
  const workerFiles = bundle.files;
  const hasExecutableJsWorker = bundle.hasExecutableJsWorker;
  // A multi-file HTML/CSS/JS project without a fetch() export is served as one bundled page.
  const htmlEntryFile = bundle.htmlEntryFile;
  // Static asset paths inside this worker's folder
  const workerPrefixes = bundle.mountPrefixes.filter((p) => p && p !== '/');
  const wantsUserInfo =
    parsedUrl.searchParams.get('userInfo') === '1' ||
    parsedUrl.searchParams.get('userInfo') === 'true' ||
    parsedUrl.searchParams.get('user_info') === '1' ||
    req.headers['x-request-user-info'] === '1';

  let fallbackStaticAsset = null;
  for (const basePrefix of workerPrefixes) {
    const slashPrefix = `${basePrefix}/`;
    if (parsedUrl.pathname.startsWith(slashPrefix)) {
      let sub = parsedUrl.pathname.slice(slashPrefix.length);
      try {
        sub = decodeURIComponent(sub);
      } catch (_) {}
      const requestedSubFile = sanitizeFileName(sub);
      const matchingFile =
        requestedSubFile &&
        workerFiles.find(
          (f) =>
            f.name === requestedSubFile &&
            (!hasExecutableJsWorker || !/\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(f.name) || parsedUrl.searchParams.get('raw') === '1')
        );
      if (matchingFile) {
        fallbackStaticAsset = matchingFile;
        break;
      }
    }
  }

  let topSeg = parsedUrl.pathname.replace(/^\/+/, '');
  try {
    topSeg = decodeURIComponent(topSeg);
  } catch (_) {}
  const bareTopSegment = sanitizeFileName(topSeg);
  if (!fallbackStaticAsset && bareTopSegment && !parsedUrl.pathname.slice(1).includes('/')) {
    const directAsset = workerFiles.find(
      (f) =>
        f.name === bareTopSegment &&
        f.name !== meta.filename &&
        (!hasExecutableJsWorker || !/\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(f.name))
    );
    if (directAsset) {
      fallbackStaticAsset = directAsset;
    }
  }

  // Uploaded binary files (images, fonts, ...) come straight off the disk for
  // every kind of worker: they can't be code, and the runtimes only see text.
  if (fallbackStaticAsset && fallbackStaticAsset.binary) {
    let body;
    try {
      body = fs.readFileSync(path.join(WORKERS_DIR, workerName, fallbackStaticAsset.name));
    } catch (_) {
      body = Buffer.alloc(0);
    }
    const ext = path.extname(fallbackStaticAsset.name).slice(1).toLowerCase();
    recordInvocation(workerName, meta, req, parsedUrl, deviceInfo, 200, hrStart, body.length, null);
    return {
      status: 200,
      headers: {
        'content-type': BINARY_TYPES[ext] || 'application/octet-stream',
        'content-disposition': 'inline',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      },
      body,
      deviceInfo
    };
  }

  if (fallbackStaticAsset && !hasExecutableJsWorker) {
    const renderedContent = /\.(html|htm|css|svg|xml|csv|md|yaml|yml|txt|json)$/i.test(fallbackStaticAsset.name)
      ? interpolateTemplate(fallbackStaticAsset.content, workerName, req, deviceInfo, queryObj, /\.(html?|svg|xml|xsl)$/i.test(fallbackStaticAsset.name))
      : fallbackStaticAsset.content;
    const fileCt = detectDataFormatContentType(
      renderedContent,
      fallbackStaticAsset.name,
      fallbackStaticAsset.language,
      '',
      true
    );
    const body = Buffer.from(renderedContent, 'utf8');
    recordInvocation(workerName, meta, req, parsedUrl, deviceInfo, 200, hrStart, body.length, null);
    return {
      status: 200,
      headers: {
        'content-type': fileCt,
        'content-disposition': 'inline',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      },
      body,
      deviceInfo
    };
  }

  if (htmlEntryFile && !fallbackStaticAsset) {
    let bundledHtml = interpolateTemplate(htmlEntryFile.content, workerName, req, deviceInfo, queryObj, true);
    const cssBlocks = workerFiles
      .filter((f) => /\.(css|scss|less)$/i.test(f.name))
      .map((f) => `<style data-file="${f.name}">\n${f.content}\n</style>`)
      .join('\n');
    const jsBlocks = workerFiles
      .filter((f) => /\.(js|mjs)$/i.test(f.name) && !(f.content.includes(`Hello from ${workerName}`) && f.content.length < 700))
      .map((f) => `<script data-file="${f.name}">\n${f.content}\n</script>`)
      .join('\n');
    if (cssBlocks) {
      bundledHtml = /<\/head>/i.test(bundledHtml)
        ? bundledHtml.replace(/<\/head>/i, `${cssBlocks}\n</head>`)
        : `${cssBlocks}\n${bundledHtml}`;
    }
    if (jsBlocks) {
      bundledHtml = /<\/body>/i.test(bundledHtml)
        ? bundledHtml.replace(/<\/body>/i, `${jsBlocks}\n</body>`)
        : `${bundledHtml}\n${jsBlocks}`;
    }
    const body = Buffer.from(bundledHtml, 'utf8');
    recordInvocation(workerName, meta, req, parsedUrl, deviceInfo, 200, hrStart, body.length, null);
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': 'inline',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      },
      body,
      deviceInfo
    };
  }

  let status = 200;
  let resHeaders = {};
  let resBodyBuffer;
  let capturedErrorMessage = null;

  try {
    if (langSpec.runtime === 'workerd') {
      const port = await ensureWorkerdInstance(workerName);
      const execHrStart = process.hrtime.bigint();
      const workerdResp = await forwardToWorkerd(
        port,
        req,
        bodyBuffer,
        deviceInfo,
        subPathAndQuery || req.url || `/${workerName}`
      );
      const execUs = Math.max(120, Number((process.hrtime.bigint() - execHrStart) / 1000n));
      meta._execUs = execUs;
      status = workerdResp.status;
      resHeaders = { ...workerdResp.headers };

      if (resHeaders['x-internal-logs']) {
        try {
          const logs = JSON.parse(decodeURIComponent(resHeaders['x-internal-logs']));
          for (const entry of logs) {
            if (!meta.observabilityConfig || meta.observabilityConfig.logsEnabled !== false) {
              appendWorkerLog(workerName, entry.level, entry.message);
            }
            if (entry.level === 'error') {
              capturedErrorMessage = entry.message;
            }
          }
        } catch (_) {}
        delete resHeaders['x-internal-logs'];
      }

      // Stream straight through when the worker set a real content type:
      // nothing needs sniffing, so nothing needs buffering.
      const ct = String(resHeaders['content-type'] || '').toLowerCase();
      if (ct && !ct.startsWith('text/plain') && !ct.startsWith('application/octet-stream') && !(status === 404 && fallbackStaticAsset) && !wantsUserInfo) {
        delete resHeaders['transfer-encoding'];
        delete resHeaders['connection'];
        delete resHeaders['keep-alive'];
        for (const hk of Object.keys(resHeaders)) {
          const l = hk.toLowerCase();
          if (l === 'x-frame-options' || l === 'content-security-policy') delete resHeaders[hk];
        }
        resHeaders['content-disposition'] = resHeaders['content-disposition'] || 'inline';
        resHeaders['cache-control'] = resHeaders['cache-control'] || 'no-store';
        resHeaders['access-control-allow-origin'] = resHeaders['access-control-allow-origin'] || '*';
        const finalStatus = status;
        const errMsg = capturedErrorMessage;
        return {
          status: finalStatus,
          headers: resHeaders,
          stream: workerdResp.stream,
          onEnd: (bytes) => recordInvocation(workerName, meta, req, parsedUrl, deviceInfo, finalStatus, hrStart, bytes, errMsg),
          deviceInfo
        };
      }
      resBodyBuffer = await readAll(workerdResp.stream);

      // If the worker returned 404 and the request matched a static asset file in the worker folder, serve it
      if (status === 404 && fallbackStaticAsset) {
        const renderedContent = /\.(html|htm|css|svg|xml|csv|md|yaml|yml|txt|json)$/i.test(fallbackStaticAsset.name)
          ? interpolateTemplate(fallbackStaticAsset.content, workerName, req, deviceInfo, queryObj, /\.(html?|svg|xml|xsl)$/i.test(fallbackStaticAsset.name))
          : fallbackStaticAsset.content;
        const fileCt = detectDataFormatContentType(
          renderedContent,
          fallbackStaticAsset.name,
          fallbackStaticAsset.language,
          '',
          true
        );
        status = 200;
        resHeaders = { 'content-type': fileCt };
        resBodyBuffer = Buffer.from(renderedContent, 'utf8');
      }
    } else if (langSpec.runtime === 'python3' || langSpec.runtime === 'bash' || langSpec.runtime === 'node') {
      const filesMap = {};
      for (const f of workerFiles) if (!f.binary) filesMap[f.name] = f.content;
      const envVars = {
        ...(meta.bindings || {}),
        WORKER_NAME: workerName,
        CLIENT_IP: deviceInfo.ip,
        USER_AGENT: deviceInfo.userAgent,
        DEVICE_OS: deviceInfo.os,
        DEVICE_BROWSER: deviceInfo.browser,
        DEVICE_TYPE: deviceInfo.deviceType,
        DEVICE_INFO_JSON: JSON.stringify(deviceInfo),
        WORKER_FILES_JSON: JSON.stringify(filesMap),
        REQUEST_METHOD: req.method || 'GET',
        REQUEST_PATH: parsedUrl.pathname,
        REQUEST_URL: req.url || `/${workerName}`,
        REQUEST_QUERY_JSON: JSON.stringify(queryObj),
        REQUEST_HEADERS_JSON: JSON.stringify(req.headers || {}),
        AX_KV_URL: `http://127.0.0.1:${BACKEND_PORT}/__ax/kv/${encodeURIComponent(workerName)}`,
        AX_KV_TOKEN: INTERNAL_TOKEN
      };

      const cmd = langSpec.runtime === 'python3' ? 'python3' : langSpec.runtime === 'bash' ? 'bash' : 'node';
      const scriptsToRun = [codeFilePath];

      const execHrStart = process.hrtime.bigint();
      let combinedStdout = '';
      let combinedStderr = '';
      let lastExitCode = 0;
      for (const scriptPath of scriptsToRun) {
        if (!fs.existsSync(scriptPath)) continue;
        const r = await executeProcessCommand(cmd, [], scriptPath, envVars, bodyBuffer);
        if (r.stdout) combinedStdout += (combinedStdout && !combinedStdout.endsWith('\n') ? '\n' : '') + r.stdout;
        if (r.stderr) combinedStderr += (combinedStderr && !combinedStderr.endsWith('\n') ? '\n' : '') + r.stderr;
        if (r.exitCode !== 0) lastExitCode = r.exitCode;
      }
      const procResult = { stdout: combinedStdout, stderr: combinedStderr, exitCode: lastExitCode };
      meta._execUs = Math.max(200, Number((process.hrtime.bigint() - execHrStart) / 1000n));

      if (procResult.stderr.trim()) {
        appendWorkerLog(workerName, procResult.exitCode === 0 ? 'warn' : 'error', procResult.stderr.trim());
        if (procResult.exitCode !== 0) capturedErrorMessage = procResult.stderr.trim();
      }
      if (procResult.stdout.trim()) {
        appendWorkerLog(workerName, 'log', procResult.stdout.trim().slice(0, 500));
      }

      if (procResult.exitCode !== 0 && !procResult.stdout.trim()) {
        status = 500;
        resBodyBuffer = Buffer.from(procResult.stderr.trim() || `Process exited with code ${procResult.exitCode}`, 'utf8');
      } else {
        resBodyBuffer = Buffer.from(procResult.stdout, 'utf8');
      }
    } else {
      const isMarkup = ['html', 'xml', 'svg', 'handlebars', 'razor'].includes(languageId) || /\.(html?|svg|xml|xsl)$/i.test(meta.filename || '');
      const rendered = interpolateTemplate(rawCode, workerName, req, deviceInfo, queryObj, isMarkup);
      meta._execUs = Math.max(85, Number((process.hrtime.bigint() - hrStart) / 1000n));
      resBodyBuffer = Buffer.from(rendered, 'utf8');
    }
  } catch (err) {
    status = 500;
    capturedErrorMessage = err.message || String(err);
    appendWorkerLog(workerName, 'error', capturedErrorMessage);
    resBodyBuffer = Buffer.from(
      JSON.stringify(
        {
          error: true,
          message: capturedErrorMessage
        },
        null,
        2
      ),
      'utf8'
    );
    resHeaders['content-type'] = 'application/json; charset=utf-8';
  }

  let bodyStr = resBodyBuffer.toString('utf8');

  // ?userInfo=1 / X-Request-User-Info: 1 appends the caller's details to a JSON body
  if (wantsUserInfo) {
    try {
      const parsed = JSON.parse(bodyStr);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.ip && !parsed.client) {
        parsed.userInfo = {
          ip: deviceInfo.ip,
          userAgent: deviceInfo.userAgent,
          os: deviceInfo.os,
          browser: deviceInfo.browser,
          deviceType: deviceInfo.deviceType,
          language: deviceInfo.language
        };
        bodyStr = JSON.stringify(parsed, null, 2);
        resBodyBuffer = Buffer.from(bodyStr, 'utf8');
      }
    } catch (_) {}
  }

  resHeaders['content-type'] = detectDataFormatContentType(
    bodyStr,
    meta.filename,
    languageId,
    resHeaders['content-type']
  );
  resHeaders['content-disposition'] = 'inline';
  resHeaders['cache-control'] = resHeaders['cache-control'] || 'no-store';
  resHeaders['access-control-allow-origin'] = resHeaders['access-control-allow-origin'] || '*';
  resHeaders['access-control-allow-methods'] =
    resHeaders['access-control-allow-methods'] || 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD';
  resHeaders['access-control-allow-headers'] =
    resHeaders['access-control-allow-headers'] || 'Accept, Content-Type, Authorization, X-Requested-With';
  delete resHeaders['content-length'];
  delete resHeaders['transfer-encoding'];
  for (const hk of Object.keys(resHeaders)) {
    const lowerHk = hk.toLowerCase();
    if (lowerHk === 'x-frame-options') {
      delete resHeaders[hk];
    } else if (lowerHk === 'content-security-policy') {
      delete resHeaders[hk];
    }
  }

  const responseBytes = resBodyBuffer ? resBodyBuffer.length : 0;
  const { durationMs, cpuUs } = recordInvocation(workerName, meta, req, parsedUrl, deviceInfo, status, hrStart, responseBytes, capturedErrorMessage);

  return {
    status,
    headers: resHeaders,
    body: resBodyBuffer,
    durationMs,
    cpuUs,
    deviceInfo
  };
}

// ============================================================================
// Cloudflare Tunnel & DNS Record Verification
// ============================================================================
let cloudflaredProc = null;

let connectorInstalledCache = { at: 0, value: false };
function isConnectorInstalled() {
  if (Date.now() - connectorInstalledCache.at < 60000) return connectorInstalledCache.value;
  let value = false;
  try {
    execSync('command -v cloudflared', { stdio: 'ignore' });
    value = true;
  } catch (_) {}
  connectorInstalledCache = { at: Date.now(), value };
  return value;
}

// Only connectors started for *this* token count. The old check was "is any
// cloudflared running", so with any other tunnel on the box (Termix, mail…)
// Alex-Aero's own tunnel never started.
const OWN_TUNNEL_PATTERN = '[c]loudflared tunnel --no-autoupdate run --token';
function ownConnectorPids(token) {
  let out = '';
  try {
    out = execSync(`pgrep -af "${OWN_TUNNEL_PATTERN}" || true`, { encoding: 'utf8' });
  } catch (_) {}
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ pid: Number(line.split(' ')[0]), token: line.split('--token ')[1] || '' }))
    .filter((p) => p.pid && (token === undefined || p.token.trim() === token));
}

function isConnectorRunning() {
  const token = String(config.tunnelToken || '').trim();
  if (!token) return false;
  return ownConnectorPids(token).length > 0;
}

let tunnelRestartTimer = null;
function manageTunnelConnector() {
  const token = String(config.tunnelToken || '').trim();
  // stop connectors still running an old/cleared token
  for (const p of ownConnectorPids()) {
    if (p.token.trim() !== token) {
      try {
        process.kill(p.pid, 'SIGTERM');
      } catch (_) {}
    }
  }
  if (!token || !isConnectorInstalled() || isConnectorRunning()) return;
  try {
    cloudflaredProc = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--token', token], {
      stdio: 'ignore',
      detached: true
    });
    cloudflaredProc.on('error', (err) => console.error('cloudflared failed to start:', err.message));
    cloudflaredProc.on('exit', (code) => {
      // crashed or was killed: bring it back if it's still wanted
      if (tunnelRestartTimer) clearTimeout(tunnelRestartTimer);
      tunnelRestartTimer = setTimeout(manageTunnelConnector, 5000);
      tunnelRestartTimer.unref();
      if (code) console.error(`cloudflared exited with code ${code}; restarting in 5 s`);
    });
    cloudflaredProc.unref();
  } catch (err) {
    console.error('Failed starting cloudflared tunnel:', err.message);
  }
}

async function checkCloudflareDnsRecord() {
  const subdomain = String(config.subdomain || '').trim();
  const rootDomain = String(config.rootDomain || '').trim();
  const hostname = subdomain && rootDomain ? `${subdomain}.${rootDomain}` : rootDomain;
  const expectedTunnelTarget = config.tunnelId
    ? `${config.tunnelId.trim()}.cfargotunnel.com`
    : null;

  const now = new Date().toISOString();
  config.dnsLastChecked = now;

  if (!hostname) {
    config.dnsRecordStatus = 'unchecked';
    config.dnsResolvedTargets = [];
    config.dnsCheckMessage = 'No custom domain configured yet. Enter a domain in Settings to check DNS records.';
    saveConfig(config);
    return {
      hostname: `${config.localIp || detectLocalIp()}:${PUBLIC_PORT}`,
      status: config.dnsRecordStatus,
      message: config.dnsCheckMessage,
      lastChecked: config.dnsLastChecked,
      resolvedTargets: [],
      expectedCname: expectedTunnelTarget || '<tunnel-id>.cfargotunnel.com',
      connectorInstalled: isConnectorInstalled(),
      connectorRunning: isConnectorRunning()
    };
  }

  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  const resolvePromise = (fn) =>
    new Promise((resolve) => {
      fn((err, records) => resolve(err ? [] : records || []));
    });

  const [cnames, ipv4s, ipv6s] = await Promise.all([
    resolvePromise((cb) => resolver.resolveCname(hostname, cb)),
    resolvePromise((cb) => resolver.resolve4(hostname, cb)),
    resolvePromise((cb) => resolver.resolve6(hostname, cb))
  ]);

  config.dnsResolvedTargets = [...cnames, ...ipv4s, ...ipv6s];

  if (cnames.length > 0 || ipv4s.length > 0 || ipv6s.length > 0) {
    config.dnsRecordStatus = 'verified';
    const targetInfo = cnames.length > 0 ? `CNAME -> ${cnames.join(', ')}` : `Proxied IP (${[...ipv4s, ...ipv6s].slice(0, 2).join(', ')})`;
    config.dnsCheckMessage = `DNS record verified for ${hostname}: ${targetInfo}`;
  } else if (expectedTunnelTarget) {
    config.dnsRecordStatus = 'pending';
    config.dnsCheckMessage = `No live DNS response yet for ${hostname}. Add CNAME "${subdomain || '@'}" -> "${expectedTunnelTarget}" (Proxied) in Cloudflare DNS.`;
  } else {
    config.dnsRecordStatus = 'unchecked';
    config.dnsCheckMessage = `No tunnel record is configured yet for ${hostname}. Enter a Tunnel ID in Settings.`;
  }

  saveConfig(config);
  return {
    hostname,
    status: config.dnsRecordStatus,
    message: config.dnsCheckMessage,
    lastChecked: config.dnsLastChecked,
    resolvedTargets: config.dnsResolvedTargets,
    expectedCname: expectedTunnelTarget || '<tunnel-id>.cfargotunnel.com',
    connectorInstalled: isConnectorInstalled(),
    connectorRunning: isConnectorRunning()
  };
}

function listLocalStorageFiles() {
  const results = [];
  const addFile = (relPath, absPath, category) => {
    if (!fs.existsSync(absPath)) return;
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return;
    let preview = '';
    try {
      const buf = fs.readFileSync(absPath);
      preview = looksBinary(buf) ? '(binary file)' : buf.toString('utf8').slice(0, 1200);
    } catch (_) {}
    results.push({
      path: relPath,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      category,
      preview
    });
  };

  addFile('cloudflare-records.json', CF_RECORDS_FILE, 'Cloudflare DNS & Tunnel Config');
  addFile('storage/config.json', CONFIG_FILE, 'Platform Settings');
  addFile('storage/state.json', STATE_FILE, 'Worker & Editor State');

  if (fs.existsSync(WORKERS_DIR)) {
    for (const entry of fs.readdirSync(WORKERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const wDir = path.join(WORKERS_DIR, entry.name);
      addFile(`storage/workers/${entry.name}/meta.json`, path.join(wDir, 'meta.json'), `Worker (${entry.name})`);
      for (const f of walkWorkerDir(wDir).files) {
        addFile(`storage/workers/${entry.name}/${f}`, path.join(wDir, f), `Worker (${entry.name})`);
      }
    }
  }
  return results;
}

// ============================================================================
// HTTP Server & API Router
// ============================================================================
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}

function serveStaticFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  res.end(content);
}

// ============================================================================
// Sign-in: a real login page + session cookies. HTTP Basic still works for
// scripts (curl -u), but browsers never see the native popup any more (it
// autofilled junk usernames and locked people out).
// ============================================================================
let authCfgCache = { mtimeMs: -1, data: null };
const basicOkCache = new Map(); // Authorization header -> expiry
const loginFailures = new Map(); // client ip -> { attempts:Set, first, lockedUntil }
const LOCK_AFTER = 8; // distinct wrong passwords
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_FOR_MS = 10 * 60 * 1000;
const SESSION_COOKIE = 'ax_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SESSIONS_FILE = path.join(STORAGE_DIR, 'sessions.json');

function loadAuthConfig() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(AUTH_FILE).mtimeMs;
  } catch (_) {
    authCfgCache = { mtimeMs: 0, data: null };
    basicOkCache.clear();
    return null;
  }
  if (mtimeMs !== authCfgCache.mtimeMs) {
    let data = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (parsed && parsed.authEnabled && parsed.username && parsed.passwordHash && parsed.salt) data = parsed;
    } catch (_) {}
    authCfgCache = { mtimeMs, data };
    basicOkCache.clear();
  }
  return authCfgCache.data;
}
// Changes whenever the password does, which invalidates every session.
const passwordStamp = (cfg) => crypto.createHash('sha256').update(`${cfg.username}:${cfg.passwordHash}`).digest('hex').slice(0, 16);

function scryptAsync(pass, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pass, salt, 64, (err, key) => (err ? reject(err) : resolve(key)))
  );
}
async function verifyPassword(cfg, user, pass) {
  try {
    const a = await scryptAsync(String(pass), cfg.salt);
    const b = Buffer.from(cfg.passwordHash, 'hex');
    const userOk = crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(user)).digest(),
      crypto.createHash('sha256').update(cfg.username).digest()
    );
    return userOk && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}
async function writeAuthFile(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = (await scryptAsync(password, salt)).toString('hex');
  writeJsonAtomic(AUTH_FILE, { authEnabled: true, username, salt, passwordHash, updatedAt: new Date().toISOString() }, 0o600);
  loadAuthConfig();
}

// ---- lockout: the same wrong password retried over and over counts once
function lockRemaining(ip) {
  const f = loginFailures.get(ip);
  return f && f.lockedUntil > Date.now() ? Math.ceil((f.lockedUntil - Date.now()) / 1000) : 0;
}
function recordFailure(ip, user, pass) {
  const now = Date.now();
  let f = loginFailures.get(ip);
  if (!f || now - f.first > LOCK_WINDOW_MS) f = { attempts: new Set(), first: now, lockedUntil: 0 };
  f.attempts.add(crypto.createHash('sha256').update(`${user}\u0000${pass}`).digest('hex').slice(0, 16));
  if (f.attempts.size >= LOCK_AFTER) f.lockedUntil = now + LOCK_FOR_MS;
  loginFailures.set(ip, f);
  if (loginFailures.size > 5000) loginFailures.clear();
  return LOCK_AFTER - f.attempts.size;
}

// ---- sessions (only a hash of each token is stored)
let sessions = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw || {})) if (v && v.expires > Date.now()) sessions.set(k, v);
} catch (_) {}
const saveSessionsSoon = (() => {
  let t = null;
  return () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      try {
        writeJsonAtomic(SESSIONS_FILE, Object.fromEntries(sessions), 0o600);
      } catch (_) {}
    }, 500);
  };
})();
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function sessionCookie(req, token, maxAgeSec) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}
function createSession(req, cfg) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(tokenHash(token), {
    user: cfg.username,
    stamp: passwordStamp(cfg),
    created: Date.now(),
    expires: Date.now() + SESSION_TTL_MS,
    ua: String(req.headers['user-agent'] || '').slice(0, 160)
  });
  if (sessions.size > 200) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].created - b[1].created).slice(0, sessions.size - 200);
    oldest.forEach(([k]) => sessions.delete(k));
  }
  saveSessionsSoon();
  return token;
}
function sessionFor(req, cfg) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const h = tokenHash(token);
  const s = sessions.get(h);
  if (!s) return null;
  if (s.expires < Date.now() || s.stamp !== passwordStamp(cfg)) {
    sessions.delete(h);
    saveSessionsSoon();
    return null;
  }
  return s;
}

// { ok, user, open } | { ok:false, locked:seconds }
async function authenticate(req, clientIp) {
  const cfg = loadAuthConfig();
  if (!cfg) return { ok: true, user: config.username || 'admin', open: true };
  const s = sessionFor(req, cfg);
  if (s) return { ok: true, user: s.user };
  const header = String(req.headers['authorization'] || '');
  if (!header.toLowerCase().startsWith('basic ')) return { ok: false };
  const cached = basicOkCache.get(header);
  if (cached && cached > Date.now()) return { ok: true, user: cfg.username };
  const locked = lockRemaining(clientIp);
  if (locked) return { ok: false, locked };
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  const user = i === -1 ? decoded : decoded.slice(0, i);
  const pass = i === -1 ? '' : decoded.slice(i + 1);
  if (await verifyPassword(cfg, user, pass)) {
    loginFailures.delete(clientIp);
    if (basicOkCache.size > 500) basicOkCache.clear();
    basicOkCache.set(header, Date.now() + 10 * 60 * 1000);
    return { ok: true, user: cfg.username };
  }
  recordFailure(clientIp, user, pass);
  await new Promise((r) => setTimeout(r, 400));
  return { ok: false };
}

const DASHBOARD_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/editor': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8', true],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8', true],
  '/lang-icons.js': ['lang-icons.js', 'application/javascript; charset=utf-8', true],
  '/login': ['login.html', 'text/html; charset=utf-8', true]
};
const PUBLIC_API = new Set(['/api/health', '/api/login', '/api/logout', '/api/session']);

function isProtectedManagementPath(pathname) {
  // The dashboard page and every /api/* route except the sign-in ones.
  if (DASHBOARD_FILES[pathname]) return !DASHBOARD_FILES[pathname][2];
  return pathname.startsWith('/api/') && !PUBLIC_API.has(pathname);
}

// The dashboard uses HTTP Basic auth, which the browser attaches to *any*
// request to this host, including ones a malicious page fires cross-site.
// Without this check a random website could create a Python worker = run
// code on the Pi. Browsers send Sec-Fetch-Site and/or Origin; curl sends neither.
function isCrossSiteRequest(req) {
  // Browsers say where a request comes from themselves (Sec-Fetch-Site), and
  // pages can't fake it: trust that when it's there. A proxy in front (Aegis ×
  // Burrow, nginx, Cloudflare) may rewrite Origin to the address it reaches
  // this server on while X-Forwarded-Host keeps the public name, so comparing
  // the two would turn away every sign-in.
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site) return site !== 'same-origin' && site !== 'none';
  // No Sec-Fetch-Site (an older browser): Origin must be one of the names we're reached by.
  const origin = req.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return true;
  let oh;
  try { oh = new URL(origin).host.toLowerCase(); } catch (_) { return true; }
  const names = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')]
    .map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
  return !names.includes(oh);
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readJsonBody(req) {
  const buf = await readRequestBody(req);
  const text = buf.toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}
  throw new HttpError(400, 'Request body must be JSON');
}

// Forwarding headers are only believed from a local proxy (nginx, cloudflared).
// Otherwise anyone could send X-Real-IP and dodge the sign-in lockout.
function isLoopback(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}
function clientIpOf(req) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!isLoopback(peer)) return peer;
  const fwd = String(req.headers['x-real-ip'] || req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
  return fwd || peer;
}

// What the dashboard needs about a worker, without file contents, logs or the
// 25 code snapshots (/api/state used to ship all of that every few seconds).
function workerSummary(w) {
  const today = w.daily && w.daily[dayKey()];
  const files = listWorkerFiles(w.name);
  return {
    name: w.name,
    language: w.language,
    filename: w.filename,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    deployId: w.deployId,
    status: w.status,
    requests: w.requests || 0,
    errors: w.errors || 0,
    requestsToday: today ? today.requests : 0,
    errorsToday: today ? today.errors : 0,
    lastRunAt: w.lastRunAt,
    lastDurationMs: w.lastDurationMs,
    lastResponseBytes: w.lastResponseBytes,
    totalBytesServed: w.totalBytesServed || 0,
    hourly: w.hourly || {},
    daily: w.daily || {},
    publishingLink: w.publishingLink || `/${w.name}`,
    publishingPath: extractPublishingPath(w.publishingLink || w.publishingPath, w.name),
    customRoutes: w.customRoutes || [],
    productionUrlEnabled: w.productionUrlEnabled !== false,
    issueDetectionEnabled: w.issueDetectionEnabled !== false,
    activeIssues: (w.issues || []).filter((i) => i.status === 'active').length,
    fileCount: files.length,
    sizeBytes: files.reduce((n, f) => n + (f.sizeBytes || 0), 0),
    deploymentCount: (w.deployments || []).length
  };
}

function workerDetail(w) {
  return {
    ...w,
    files: listWorkerFiles(w.name),
    deployments: (w.deployments || []).map(({ codeSnapshot, filesSnapshot, ...d }) => ({
      ...d,
      hasSnapshot: Boolean(filesSnapshot || typeof codeSnapshot === 'string'),
      fileNames: filesSnapshot ? Object.keys(filesSnapshot) : [d.filename]
    })),
    summary: workerSummary(w),
    isDefault: state.defaultWorker === w.name,
    crons: (w.crons || []).map((j) => {
      let next = null;
      try {
        const n = cronNext(parseCron(j.expr));
        next = n ? n.toISOString() : null;
      } catch (_) {}
      return { ...j, next };
    }),
    kv: (() => {
      const st = kvStore(w.name);
      return { keys: st.map.size, bytes: st.bytes };
    })()
  };
}

function publicConfig() {
  const { tunnelToken, ...rest } = config;
  return {
    ...rest,
    tunnelTokenSet: Boolean(String(tunnelToken || '').trim()),
    publicHostname: getConfiguredHostname(config),
    connectorInstalled: isConnectorInstalled(),
    connectorRunning: isConnectorRunning(),
    publicPort: PUBLIC_PORT,
    backendPort: BACKEND_PORT
  };
}

function readCpuTempC() {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
    const v = Number(raw) / 1000;
    return Number.isFinite(v) ? Number(v.toFixed(1)) : null;
  } catch (_) {
    return null;
  }
}

function readDiskUsage() {
  try {
    const st = fs.statfsSync(STORAGE_DIR);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { totalGb: Number((total / 1e9).toFixed(1)), freeGb: Number((free / 1e9).toFixed(1)) };
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------- updates
 * The newest Alex-Aero on GitHub, checked every 6 hours (and on demand).
 * Installing runs `bin/ax update --yes` outside this process, since the
 * update restarts it; that script reports in storage/runtime/update.json. */
const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version || '0.0.0'; } catch (_) { return '0.0.0'; } })();
const UPDATE_REPO = /^[\w.-]+\/[\w.-]+$/.test(process.env.AX_UPDATE_REPO || '') ? process.env.AX_UPDATE_REPO : 'alexd-aero/alex-aero-workers';
const UPDATE_BRANCH = /^[\w./-]+$/.test(process.env.AX_UPDATE_BRANCH || '') ? process.env.AX_UPDATE_BRANCH : 'master';
const UPDATE_STATUS_FILE = path.join(RUNTIME_DIR, 'update.json');
const IN_DOCKER = fs.existsSync('/.dockerenv');
const updateInfo = { latest: null, notes: [], checkedAt: null, error: null };
let updateChecking = null;

function versionNewer(a, b) {  // is a newer than b (1.2.10 > 1.2.9)
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0), pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
function readUpdateStatus() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8')); } catch (_) { return null; }
  // an update that restarted us into its new version is done, whatever the script got to write
  if (st && ['installing', 'restarting'].includes(st.state) && st.to && st.to === APP_VERSION) st = { ...st, state: 'done', message: `Updated to v${APP_VERSION}` };
  // one that stopped answering long ago didn't finish
  if (st && ['checking', 'downloading', 'installing', 'restarting'].includes(st.state) && Date.now() - new Date(st.at).getTime() > 15 * 60e3) st = { ...st, state: 'failed', message: 'The update stopped without finishing. Try again, or run: ax update' };
  return st;
}
function checkForUpdate(force) {
  if (!force && updateInfo.checkedAt && Date.now() - updateInfo.checkedAt < 6 * 3600e3) return Promise.resolve(updateInfo);
  if (updateChecking) return updateChecking;
  const ua = { 'user-agent': `alex-aero/${APP_VERSION}`, 'cache-control': 'no-cache' };
  updateChecking = (async () => {
    try {
      // the branch's newest commit first: raw.githubusercontent.com caches a branch's files for minutes
      let ref = UPDATE_BRANCH;
      try {
        const h = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits/${encodeURIComponent(UPDATE_BRANCH)}`, { headers: { ...ua, accept: 'application/vnd.github.sha' }, signal: AbortSignal.timeout(10000) });
        const sha = h.ok ? (await h.text()).trim() : '';
        if (/^[0-9a-f]{40}$/.test(sha)) ref = sha;
      } catch (_) { /* the branch it is */ }
      const r = await fetch(`https://raw.githubusercontent.com/${UPDATE_REPO}/${ref}/package.json`, { headers: ua, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const latest = String((await r.json()).version || '');
      if (!/^\d+(\.\d+){0,3}$/.test(latest)) throw new Error("GitHub's copy has no version");
      let notes = [];
      if (versionNewer(latest, APP_VERSION)) {
        // what changed: the release commits ("2.3.0: title") newer than this one
        try {
          const c = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits?sha=${encodeURIComponent(UPDATE_BRANCH)}&per_page=30`, { headers: { ...ua, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
          if (c.ok) {
            for (const x of await c.json()) {
              const msg = String(x?.commit?.message || '');
              const m = /^(\d+\.\d+\.\d+):\s*(.+)/.exec(msg.split('\n')[0]);
              if (!m || !versionNewer(m[1], APP_VERSION)) continue;
              // git wraps at ~72 columns: join the lines of a paragraph back up (list items stay their own)
              const body = msg.split('\n').slice(1).filter((l) => !/^Co-Authored-By:/i.test(l)).join('\n').trim()
                .split(/\n{2,}/).map((par) => par.replace(/\n(?!\s*[-*•] )\s*/g, ' ')).join('\n\n');
              notes.push({ version: m[1], title: m[2].slice(0, 160), body: body.slice(0, 1500), date: x.commit?.author?.date || null });
            }
          }
        } catch (_) { /* the notes are a nicety */ }
      }
      Object.assign(updateInfo, { latest, notes: notes.slice(0, 15), checkedAt: Date.now(), error: null });
    } catch (err) {
      Object.assign(updateInfo, { checkedAt: Date.now(), error: err.name === 'TimeoutError' ? "GitHub didn't answer" : err.message });
    } finally {
      updateChecking = null;
    }
    return updateInfo;
  })();
  return updateChecking;
}
function updateView() {
  return {
    current: APP_VERSION, latest: updateInfo.latest, available: Boolean(updateInfo.latest && versionNewer(updateInfo.latest, APP_VERSION)),
    notes: updateInfo.notes, checkedAt: updateInfo.checkedAt, error: updateInfo.error, repo: UPDATE_REPO, branch: UPDATE_BRANCH,
    docker: IN_DOCKER, job: readUpdateStatus()
  };
}
function startUpdate() {
  const job = readUpdateStatus();
  if (job && ['checking', 'downloading', 'installing', 'restarting'].includes(job.state)) throw new HttpError(409, 'An update is already running.');
  if (IN_DOCKER) throw new HttpError(409, 'This copy runs in Docker: update it on the host with  git pull && docker compose up -d --build');
  const ax = path.join(ROOT_DIR, 'bin', 'ax');
  if (!fs.existsSync(ax)) throw new HttpError(500, 'bin/ax is missing, so this copy can\'t update itself.');
  fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: 'checking', from: APP_VERSION, at: new Date().toISOString(), message: 'Starting the update', log: ['Starting the update'] }));
  const pass = ['PATH', 'HOME', 'USER', 'LANG', 'AX_NODE', 'AX_PROXY', 'PUBLIC_PORT', 'BACKEND_PORT', 'AX_UPDATE_REPO', 'AX_UPDATE_BRANCH', 'TZ'];
  const env = { AX_NONINTERACTIVE: '1', AX_NODE: process.env.AX_NODE || process.execPath };
  for (const k of pass) if (process.env[k] && !env[k]) env[k] = process.env[k];
  let cmd = 'bash', args = [ax, 'update', '--yes'];
  // Under the autostart service the restart ends everything in the service's
  // own group, the updater too: it runs as a unit of its own instead.
  if (process.env.AX_FROM_SYSTEMD === '1') {
    try {
      execSync('sudo -n true', { stdio: 'ignore', timeout: 4000 });
      args = ['-n', 'systemd-run', '--quiet', '--collect', `--unit=alex-aero-update-${Date.now()}`, `--uid=${process.getuid()}`, `--gid=${process.getgid()}`,
        `--working-directory=${ROOT_DIR}`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), '/bin/bash', ax, 'update', '--yes'];
      cmd = 'sudo';
    } catch (_) { /* no sudo: run it directly and hope the restart lets it finish */ }
  }
  const log = fs.openSync(path.join(RUNTIME_DIR, 'update.log'), 'a');
  const child = spawn(cmd, args, { cwd: ROOT_DIR, env, detached: true, stdio: ['ignore', log, log] });
  child.on('error', (err) => { try { fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: 'failed', from: APP_VERSION, at: new Date().toISOString(), message: `Couldn't start the updater: ${err.message}` })); } catch (_) {} });
  child.unref();
  fs.closeSync(log);
}

function systemSnapshot() {
  return {
    ...RUNTIME_VERSIONS,
    ...getLiveSystemTelemetry(),
    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
    cpuTempC: readCpuTempC(),
    disk: readDiskUsage(),
    storageDir: STORAGE_DIR,
    backendUptimeSeconds: Math.floor(process.uptime()),
    runningWorkers: [...workerdPool.entries()].map(([name, e]) => ({
      name,
      port: e.port,
      engine: e.proc ? 'workerd' : e.fallbackServer ? 'node-fallback' : 'stopped'
    }))
  };
}

function restoreDeployment(name, meta, dep) {
  const dir = path.join(WORKERS_DIR, name);
  if (dep.filesSnapshot && typeof dep.filesSnapshot === 'object') {
    const keep = new Set();
    for (const [fname, content] of Object.entries(dep.filesSnapshot)) {
      const safe = sanitizeFileName(fname);
      if (!safe) continue;
      keep.add(safe);
      const target = workerFilePath(dir, safe, true);
      if (content && typeof content === 'object' && typeof content.b64 === 'string') fs.writeFileSync(target, Buffer.from(content.b64, 'base64'));
      else fs.writeFileSync(target, String(content), 'utf8');
    }
    for (const f of listWorkerFiles(name)) {
      if (!keep.has(f.name)) fs.rmSync(path.join(dir, f.name), { force: true });
    }
  } else if (typeof dep.codeSnapshot === 'string') {
    fs.writeFileSync(path.join(dir, sanitizeFileName(dep.filename) || meta.filename || 'worker.js'), dep.codeSnapshot, 'utf8');
  } else {
    return false;
  }
  if (dep.filename && fs.existsSync(path.join(dir, dep.filename))) meta.filename = dep.filename;
  invalidateWorkerRuntime(name);
  return true;
}

discoverWorkersOnDisk();
syncCloudflareRecordsFile(config);

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // KV calls from worker processes (secret per-boot token; 404 to anyone else)
    if (pathname.startsWith('/__ax/kv/') && isLoopback(req.socket?.remoteAddress) && !req.headers['x-real-ip'] && !req.headers['cf-connecting-ip']) {
      await handleKvRequest(req, res, parsedUrl);
      return;
    }

    const isManagement = isProtectedManagementPath(pathname);

    if (req.method === 'OPTIONS') {
      // CORS preflight only for workers; the management API stays same-origin.
      res.writeHead(204, isManagement ? {} : {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
        'access-control-allow-headers': '*',
        'access-control-max-age': '86400'
      });
      res.end();
      return;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const clientIp = clientIpOf(req);

    // ---- sign-in endpoints (public, but same-origin only)
    if (PUBLIC_API.has(pathname) && pathname !== '/api/health') {
      if (req.method !== 'GET' && isCrossSiteRequest(req)) throw new HttpError(403, 'Cross-site request blocked');
      const cfg = loadAuthConfig();
      if (pathname === '/api/session' && req.method === 'GET') {
        const auth = await authenticate(req, clientIp);
        sendJson(res, 200, { authEnabled: Boolean(cfg), signedIn: auth.ok, username: auth.ok ? auth.user : null, lockedFor: lockRemaining(clientIp) });
        return;
      }
      if (pathname === '/api/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!cfg) {
          sendJson(res, 200, { ok: true, open: true });
          return;
        }
        const locked = lockRemaining(clientIp);
        if (locked) throw Object.assign(new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil(locked / 60)} min.`), { retryAfter: locked });
        const user = String(body.username || '').trim();
        const pass = String(body.password || '');
        if (await verifyPassword(cfg, user, pass)) {
          loginFailures.delete(clientIp);
          const token = createSession(req, cfg);
          res.setHeader('Set-Cookie', sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)));
          sendJson(res, 200, { ok: true, username: cfg.username });
          return;
        }
        const left = recordFailure(clientIp, user, pass);
        await new Promise((r) => setTimeout(r, 400));
        const lockedNow = lockRemaining(clientIp);
        if (lockedNow) throw Object.assign(new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil(lockedNow / 60)} min.`), { retryAfter: lockedNow });
        throw new HttpError(401, left <= 3 ? `Wrong username or password. ${left} more ${left === 1 ? 'try' : 'tries'} before a 10-minute pause.` : 'Wrong username or password.');
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) {
          sessions.delete(tokenHash(token));
          saveSessionsSoon();
        }
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    // Sign-in on the dashboard and every management API route; worker routes
    // (/example, …) stay public.
    if (isManagement) {
      const auth = await authenticate(req, clientIp);
      if (!auth.ok) {
        if (DASHBOARD_FILES[pathname] && req.method === 'GET') {
          serveStaticFile(res, path.join(PUBLIC_DIR, 'login.html'), 'text/html; charset=utf-8');
        } else if (auth.locked) {
          res.setHeader('Retry-After', String(auth.locked));
          sendJson(res, 429, { error: 'Too many wrong passwords', retryAfter: auth.locked });
        } else {
          sendJson(res, 401, { error: 'Sign in required' });
        }
        return;
      }
      if (auth.user && config.username !== auth.user) config.username = auth.user;
      if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossSiteRequest(req)) {
        sendJson(res, 403, { error: 'Cross-site request blocked' });
        return;
      }
    }

    if (DASHBOARD_FILES[pathname] && req.method === 'GET') {
      const [file, type] = DASHBOARD_FILES[pathname];
      if (file === 'index.html') parseClientAndDevice(req, true);
      serveStaticFile(res, path.join(PUBLIC_DIR, file), type);
      return;
    }

    // ---- account: set / change the login from the dashboard
    if (pathname === '/api/account' && req.method === 'GET') {
      const cfg = loadAuthConfig();
      sendJson(res, 200, { authEnabled: Boolean(cfg), username: cfg ? cfg.username : null, sessions: cfg ? [...sessions.values()].filter((x) => x.stamp === passwordStamp(cfg)).length : 0 });
      return;
    }
    if (pathname === '/api/account' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const cfg = loadAuthConfig();
      const username = String(body.username || (cfg && cfg.username) || 'admin').trim();
      const password = String(body.newPassword || '');
      if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) throw new HttpError(400, 'Username: letters, digits, . _ @ - only');
      if (password.length < 8) throw new HttpError(400, 'Use at least 8 characters for the password');
      if (cfg && !(await verifyPassword(cfg, cfg.username, body.currentPassword || ''))) {
        recordFailure(clientIp, cfg.username, String(body.currentPassword || ''));
        throw new HttpError(401, 'Current password is wrong');
      }
      await writeAuthFile(username, password);
      const fresh = loadAuthConfig();
      sessions.clear(); // everyone else is signed out
      const token = createSession(req, fresh);
      res.setHeader('Set-Cookie', sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)));
      sendJson(res, 200, { ok: true, username });
      return;
    }
    if (pathname === '/api/account/sessions' && req.method === 'DELETE') {
      const keep = parseCookies(req)[SESSION_COOKIE];
      const mine = keep && sessions.get(tokenHash(keep));
      sessions.clear();
      if (mine) sessions.set(tokenHash(keep), mine);
      saveSessionsSoon();
      sendJson(res, 200, { ok: true });
      return;
    }

    // Dashboard-only client IP endpoint: determines client IP directly from incoming HTTP request
    if (pathname === '/api/client-ip' && req.method === 'GET') {
      await refreshPublicNetworkInfoAsync(10 * 60 * 1000);
      sendJson(res, 200, { ok: true, clientDevice: parseClientAndDevice(req, true) });
      return;
    }

    // ---- lightweight dashboard endpoints
    if (pathname === '/api/overview' && req.method === 'GET') {
      const workers = Object.values(state.workers).map(workerSummary);
      sendJson(res, 200, {
        config: publicConfig(),
        system: systemSnapshot(),
        version: APP_VERSION,
        update: updateInfo.latest && versionNewer(updateInfo.latest, APP_VERSION) ? { latest: updateInfo.latest } : null,
        activeWorker: state.activeWorker,
        defaultWorker: state.defaultWorker || '',
        editorPreferences: state.editorPreferences,
        workers,
        totals: {
          workers: workers.length,
          requestsToday: workers.reduce((n, w) => n + w.requestsToday, 0),
          errorsToday: workers.reduce((n, w) => n + w.errorsToday, 0),
          requests: workers.reduce((n, w) => n + w.requests, 0)
        },
        languages: Object.values(LANGUAGES).map(({ id, label, badge, ext, runtime, defaultFile }) => ({
          id, label, badge, ext, runtime, defaultFile
        })),
        clientDevice: parseClientAndDevice(req, true),
        authEnabled: Boolean(loadAuthConfig())
      });
      return;
    }

    if (pathname === '/api/update' && req.method === 'GET') {
      if (!updateInfo.checkedAt) await checkForUpdate(false);
      sendJson(res, 200, updateView());
      return;
    }
    if (pathname === '/api/update/check' && req.method === 'POST') {
      await checkForUpdate(true);
      sendJson(res, 200, updateView());
      return;
    }
    if (pathname === '/api/update/apply' && req.method === 'POST') {
      startUpdate();
      sendJson(res, 202, updateView());
      return;
    }

    if (pathname === '/api/system' && req.method === 'GET') {
      sendJson(res, 200, { system: systemSnapshot(), storageFiles: listLocalStorageFiles().filter((f) => !f.path.startsWith('storage/workers/')) });
      return;
    }

    if (pathname === '/api/default-worker' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.name || '');
      if (name && !state.workers[name]) throw new HttpError(404, 'Worker not found');
      state.defaultWorker = name;
      saveState();
      sendJson(res, 200, { ok: true, defaultWorker: state.defaultWorker });
      return;
    }

    const detailMatch = pathname.match(/^\/api\/workers\/([^/]+)$/);
    if (detailMatch && req.method === 'GET') {
      const w = state.workers[decodeURIComponent(detailMatch[1])];
      if (!w) throw new HttpError(404, 'Worker not found');
      sendJson(res, 200, { ok: true, worker: workerDetail(w) });
      return;
    }

    // live tail: logs + invocations newer than ?since=
    const activityMatch = pathname.match(/^\/api\/workers\/([^/]+)\/activity$/);
    if (activityMatch && req.method === 'GET') {
      const w = state.workers[decodeURIComponent(activityMatch[1])];
      if (!w) throw new HttpError(404, 'Worker not found');
      const since = parsedUrl.searchParams.get('since') || '';
      const newer = (list) => (Array.isArray(list) ? list.filter((x) => !since || String(x.timestamp) > since) : []);
      sendJson(res, 200, {
        ok: true,
        logs: newer(w.logs),
        invocations: newer(w.invocations),
        summary: workerSummary(w),
        issues: w.issues || [],
        now: new Date().toISOString()
      });
      return;
    }

    const logsMatch = pathname.match(/^\/api\/workers\/([^/]+)\/logs$/);
    if (logsMatch && req.method === 'DELETE') {
      const name = decodeURIComponent(logsMatch[1]);
      const w = state.workers[name];
      if (!w) throw new HttpError(404, 'Worker not found');
      w.logs = [];
      if (parsedUrl.searchParams.get('invocations') === '1') w.invocations = [];
      persistWorkerSoon(name);
      sendJson(res, 200, { ok: true });
      return;
    }

    const snapMatch = pathname.match(/^\/api\/workers\/([^/]+)\/deployments\/([0-9a-f]+)$/);
    if (snapMatch && req.method === 'GET') {
      const w = state.workers[decodeURIComponent(snapMatch[1])];
      const dep = w && (w.deployments || []).find((d) => d.id === snapMatch[2]);
      if (!dep) throw new HttpError(404, 'Deployment not found');
      sendJson(res, 200, {
        ok: true,
        id: dep.id,
        files: dep.filesSnapshot
          ? Object.fromEntries(
              Object.entries(dep.filesSnapshot).map(([n, c]) =>
                c && typeof c === 'object' ? [n, `(binary file, ${Math.floor((String(c.b64 || '').length * 3) / 4)} bytes)`] : [n, c]
              )
            )
          : typeof dep.codeSnapshot === 'string'
          ? { [dep.filename]: dep.codeSnapshot }
          : {}
      });
      return;
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      // Kept for older dashboards / scripts.
      const clientDevice = parseClientAndDevice(req, true);
      const sysTelemetry = getLiveSystemTelemetry();
      let totalRequestsToday = 0;
      const workersList = Object.values(state.workers).map((w) => {
        const summary = workerSummary(w);
        totalRequestsToday += summary.requestsToday;
        return {
          ...workerDetail(w),
          code: readWorkerCodeFromStorage(w.name) || '',
          requestsToday: summary.requestsToday,
          sizeBytes: summary.sizeBytes
        };
      });
      sendJson(res, 200, {
        config: publicConfig(),
        runtimeInfo: { ...RUNTIME_VERSIONS, ...sysTelemetry },
        systemTelemetry: sysTelemetry,
        activeWorker: state.activeWorker,
        defaultWorker: state.defaultWorker || '',
        editorPreferences: state.editorPreferences,
        workerCount: workersList.length,
        totalRequestsToday,
        workers: workersList,
        storageFiles: listLocalStorageFiles(),
        languages: Object.values(LANGUAGES).map(({ id, label, badge, ext, runtime, defaultFile }) => ({
          id, label, badge, ext, runtime, defaultFile
        })),
        clientDevice
      });
      return;
    }

    // Upload one file as raw bytes: POST /api/workers/:name/upload?path=dir/file.png
    // Download one: GET /api/workers/:name/raw?path=dir/file.png
    const fileIoMatch = pathname.match(/^\/api\/workers\/([^/]+)\/(upload|raw)$/);
    if (fileIoMatch) {
      const targetName = decodeURIComponent(fileIoMatch[1]);
      const meta = state.workers[targetName];
      if (!meta) throw new HttpError(404, 'Worker not found');
      const workerDir = path.join(WORKERS_DIR, targetName);
      const safeName = sanitizeFileName(parsedUrl.searchParams.get('path'));
      if (!safeName) throw new HttpError(400, 'Invalid file path');

      if (fileIoMatch[2] === 'raw' && req.method === 'GET') {
        const filePath = path.join(workerDir, safeName);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new HttpError(404, 'File not found');
        const ext = path.extname(safeName).slice(1).toLowerCase();
        const image = UPLOAD_IMAGE_TYPES[ext];
        res.writeHead(200, {
          'content-type': image || 'application/octet-stream',
          'content-disposition': `${image ? 'inline' : 'attachment'}; filename="${path.basename(safeName)}"`,
          'content-security-policy': 'sandbox',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store'
        });
        res.end(fs.readFileSync(filePath));
        return;
      }

      if (fileIoMatch[2] === 'upload' && req.method === 'POST') {
        const buf = await readRequestBody(req);
        if (safeName === meta.filename && looksBinary(buf)) throw new HttpError(400, `${safeName} is the entry file and can't be replaced by a binary file`);
        const targetPath = workerFilePath(workerDir, safeName, true);
        const existed = fs.existsSync(targetPath);
        if (existed && fs.statSync(targetPath).isDirectory()) throw new HttpError(400, `"${safeName}" is a folder`);
        fs.writeFileSync(targetPath, buf);
        invalidateWorkerRuntime(targetName);
        meta.updatedAt = new Date().toISOString();
        writeJsonAtomic(path.join(workerDir, 'meta.json'), meta);
        saveState();
        appendWorkerLog(targetName, 'info', `${existed ? 'Replaced' : 'Uploaded'} "${safeName}" (${buf.length} B)`);
        const files = listWorkerFiles(targetName);
        sendJson(res, 200, { ok: true, file: files.find((f) => f.name === safeName), replaced: existed });
        return;
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // Worker File Explorer CRUD Endpoints: /api/workers/:name/files
    const filesRouteMatch = pathname.match(/^\/api\/workers\/([^/]+)\/files$/);
    if (filesRouteMatch) {
      const targetName = decodeURIComponent(filesRouteMatch[1]);
      const meta = state.workers[targetName];
      if (!meta) {
        sendJson(res, 404, { error: 'Worker not found' });
        return;
      }
      const workerDir = path.join(WORKERS_DIR, targetName);
      if (!fs.existsSync(workerDir)) {
        fs.mkdirSync(workerDir, { recursive: true });
      }

      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          worker: targetName,
          primaryFile: meta.filename,
          files: listWorkerFiles(targetName),
          folders: listWorkerFolders(targetName)
        });
        return;
      }

      const body = await readJsonBody(req);

      // Folders: create, rename/move, delete (with everything inside)
      if (body.folder || parsedUrl.searchParams.get('folder')) {
        const safeFolder = sanitizeFileName(body.folder || parsedUrl.searchParams.get('folder'));
        if (!safeFolder) throw new HttpError(400, 'Invalid folder name');
        const folderPath = path.join(workerDir, safeFolder);
        const inFolder = (f) => f === safeFolder || String(f || '').startsWith(`${safeFolder}/`);
        if (req.method === 'POST') {
          if (fs.existsSync(folderPath)) throw new HttpError(400, `"${safeFolder}" already exists in ${targetName}`);
          fs.mkdirSync(folderPath, { recursive: true });
          appendWorkerLog(targetName, 'info', `Created folder "${safeFolder}/" in ${targetName}`);
        } else if (req.method === 'PUT') {
          const renamed = sanitizeFileName(body.newFolder);
          if (!renamed) throw new HttpError(400, 'Invalid new folder name');
          if (renamed === safeFolder || renamed.startsWith(`${safeFolder}/`)) throw new HttpError(400, "A folder can't move inside itself");
          const renamedPath = path.join(workerDir, renamed);
          if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) throw new HttpError(404, `No folder "${safeFolder}"`);
          if (fs.existsSync(renamedPath)) throw new HttpError(400, `"${renamed}" already exists in ${targetName}`);
          fs.mkdirSync(path.dirname(renamedPath), { recursive: true });
          fs.renameSync(folderPath, renamedPath);
          if (inFolder(meta.filename)) meta.filename = renamed + meta.filename.slice(safeFolder.length);
          appendWorkerLog(targetName, 'info', `Moved folder "${safeFolder}/" to "${renamed}/"`);
        } else if (req.method === 'DELETE') {
          fs.rmSync(folderPath, { recursive: true, force: true });
          appendWorkerLog(targetName, 'warn', `Deleted folder "${safeFolder}/" from ${targetName}`);
        } else {
          throw new HttpError(405, 'Method not allowed');
        }
        let remaining = listWorkerFiles(targetName);
        if (!remaining.some((f) => !f.binary)) {
          // keep the worker runnable
          fs.writeFileSync(path.join(workerDir, 'worker.js'), buildJsWorkerTemplate(targetName), 'utf8');
          meta.filename = 'worker.js';
          meta.language = 'javascript';
          remaining = listWorkerFiles(targetName);
        } else if (!remaining.some((f) => f.name === meta.filename && !f.binary)) {
          const next = remaining.find((f) => !f.binary);
          meta.filename = next.name;
          meta.language = next.language;
        }
        invalidateWorkerRuntime(targetName);
        meta.updatedAt = new Date().toISOString();
        writeJsonAtomic(path.join(workerDir, 'meta.json'), meta);
        saveState();
        sendJson(res, 200, {
          ok: true,
          files: remaining,
          folders: listWorkerFolders(targetName),
          worker: { ...meta, code: readWorkerCodeFromStorage(targetName), files: remaining }
        });
        return;
      }

      if (req.method === 'POST') {
        const rawFilename = body.filename || 'new-file.js';
        const safeName = sanitizeFileName(rawFilename);
        if (!safeName) {
          sendJson(res, 400, { error: 'Invalid filename' });
          return;
        }
        const targetPath = workerFilePath(workerDir, safeName, true);
        if (fs.existsSync(targetPath) && !body.overwrite) {
          sendJson(res, 400, { error: `File "${safeName}" already exists in ${targetName}` });
          return;
        }

        const langId = body.language || inferLanguageFromFilename(safeName);
        let initialContent = typeof body.content === 'string' ? body.content : '';
        if (!initialContent && body.useTemplate) {
          const spec = getLangSpec(langId);
          initialContent = spec.template(targetName);
        } else if (!initialContent) {
          if (safeName.endsWith('.json')) {
            initialContent = `{\n  "name": "${safeName}"\n}\n`;
          } else if (safeName.endsWith('.js') || safeName.endsWith('.mjs') || safeName.endsWith('.ts')) {
            initialContent = `// ${safeName}\nexport const fileInfo = {\n  name: "${safeName}"\n};\n`;
          } else if (safeName.endsWith('.py')) {
            initialContent = `# ${safeName}\nprint("Hello from ${safeName}")\n`;
          } else if (safeName.endsWith('.sh')) {
            initialContent = `#!/usr/bin/env bash\necho "Hello from ${safeName}"\n`;
          } else if (safeName.endsWith('.html') || safeName.endsWith('.htm')) {
            initialContent = `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <title>${targetName} — ${safeName}</title>\n</head>\n<body>\n  <h1>${targetName}</h1>\n  <p>${safeName}</p>\n</body>\n</html>\n`;
          } else if (safeName.endsWith('.css') || safeName.endsWith('.scss') || safeName.endsWith('.less')) {
            initialContent = `/* ${safeName} */\nbody {\n  margin: 0;\n  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;\n}\n`;
          } else if (safeName.endsWith('.svg')) {
            initialContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" width="200" height="80">\n  <rect width="200" height="80" rx="12" fill="#111111" />\n  <text x="100" y="45" fill="#ffffff" font-family="Helvetica, Arial, sans-serif" font-size="16" text-anchor="middle">${targetName}</text>\n</svg>\n`;
          } else if (safeName.endsWith('.xml')) {
            initialContent = `<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <worker>${targetName}</worker>\n  <file>${safeName}</file>\n</root>\n`;
          } else if (safeName.endsWith('.csv')) {
            initialContent = `id,name,value\n1,${targetName},active\n`;
          } else if (safeName.endsWith('.yaml') || safeName.endsWith('.yml')) {
            initialContent = `worker: ${targetName}\nfile: ${safeName}\n`;
          } else if (safeName.endsWith('.md')) {
            initialContent = `# ${safeName}\n\nFile in worker **${targetName}**.\n`;
          } else {
            initialContent = `${safeName}\n`;
          }
        }

        fs.writeFileSync(targetPath, initialContent, 'utf8');
        meta.updatedAt = new Date().toISOString();
        if (body.setAsEntrypoint) {
          meta.filename = safeName;
          meta.language = langId;
        }
        invalidateWorkerRuntime(targetName);
        writeJsonAtomic(path.join(workerDir, 'meta.json'), meta);
        saveState();
        appendWorkerLog(targetName, 'info', `Created file "${safeName}" (${Buffer.byteLength(initialContent)} B) in ${targetName}`);

        const files = listWorkerFiles(targetName);
        sendJson(res, 200, {
          ok: true,
          file: files.find((f) => f.name === safeName),
          files,
          worker: { ...meta, code: readWorkerCodeFromStorage(targetName), files }
        });
        return;
      }

      if (req.method === 'PUT') {
        const safeName = sanitizeFileName(body.filename || meta.filename);
        if (!safeName) {
          sendJson(res, 400, { error: 'Invalid filename' });
          return;
        }
        let finalFileName = safeName;
        const oldPath = path.join(workerDir, safeName);

        if (body.newFilename) {
          const renamed = sanitizeFileName(body.newFilename);
          if (!renamed) {
            sendJson(res, 400, { error: 'Invalid new filename' });
            return;
          }
          const renamedPath = workerFilePath(workerDir, renamed, true);
          if (renamed !== safeName && fs.existsSync(renamedPath)) {
            sendJson(res, 400, { error: `"${renamed}" already exists in ${targetName}` });
            return;
          }
          if (renamed !== safeName && fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, renamedPath);
          }
          if (meta.filename === safeName) {
            meta.filename = renamed;
            meta.language = inferLanguageFromFilename(renamed);
          }
          finalFileName = renamed;
        }

        const writePath = workerFilePath(workerDir, finalFileName, true);
        // binary files (uploads) are never overwritten by a text save or rename
        let isBinaryOnDisk = false;
        try {
          isBinaryOnDisk = fs.statSync(writePath).isFile() && looksBinary(fs.readFileSync(writePath));
        } catch (_) {}
        if (body.setAsEntrypoint && isBinaryOnDisk) throw new HttpError(400, "A binary file can't be the entry file");
        if (typeof body.content === 'string' && !isBinaryOnDisk) {
          const eol = body.eol || meta.eol || 'LF';
          const normalized = eol === 'CRLF' ? body.content.replace(/\r?\n/g, '\r\n') : body.content.replace(/\r\n/g, '\n');
          fs.writeFileSync(writePath, normalized, 'utf8');
        }

        if (body.setAsEntrypoint) {
          meta.filename = finalFileName;
          meta.language = body.language || inferLanguageFromFilename(finalFileName);
        }

        const now = new Date().toISOString();
        meta.updatedAt = now;
        if (body.deploy) {
          const currentContent = fs.existsSync(writePath) ? fs.readFileSync(writePath, 'utf8') : '';
          const newDeployId = crypto.createHash('sha1').update(currentContent + now).digest('hex').slice(0, 8);
          meta.deployId = newDeployId;
          if (!Array.isArray(meta.deployments)) meta.deployments = [];
          meta.deployments.unshift({
            id: newDeployId,
            timestamp: now,
            language: meta.language || inferLanguageFromFilename(finalFileName),
            filename: finalFileName,
            sizeBytes: Buffer.byteLength(currentContent),
            author: config.username || 'admin',
            source: body.deploySource || 'Manually deployed',
            codeSnapshot: currentContent,
            filesSnapshot: snapshotWorkerFiles(targetName)
          });
          meta.deployments = meta.deployments.slice(0, 25);
          appendWorkerLog(targetName, 'info', `Deployed ${finalFileName} (rev ${newDeployId}) to local storage.`);
        }

        invalidateWorkerRuntime(targetName);
        writeJsonAtomic(path.join(workerDir, 'meta.json'), meta);
        saveState();

        const files = listWorkerFiles(targetName);
        sendJson(res, 200, {
          ok: true,
          filename: finalFileName,
          files,
          worker: { ...meta, code: readWorkerCodeFromStorage(targetName), files }
        });
        return;
      }

      if (req.method === 'DELETE') {
        const safeName = sanitizeFileName(body.filename || parsedUrl.searchParams.get('filename'));
        if (!safeName) {
          sendJson(res, 400, { error: 'Filename required to delete' });
          return;
        }
        const targetPath = path.join(workerDir, safeName);
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }

        let remaining = listWorkerFiles(targetName);
        if (!remaining.some((f) => !f.binary)) {
          // Always keep at least one runnable file so the worker remains runnable
          const fallbackFile = 'worker.js';
          const fallbackCode = buildJsWorkerTemplate(targetName);
          fs.writeFileSync(path.join(workerDir, fallbackFile), fallbackCode, 'utf8');
          meta.filename = fallbackFile;
          meta.language = 'javascript';
          remaining = listWorkerFiles(targetName);
        } else if (meta.filename === safeName || !remaining.some((f) => f.name === meta.filename)) {
          const next = remaining.find((f) => !f.binary);
          meta.filename = next.name;
          meta.language = next.language || inferLanguageFromFilename(next.name);
        }

        invalidateWorkerRuntime(targetName);
        meta.updatedAt = new Date().toISOString();
        writeJsonAtomic(path.join(workerDir, 'meta.json'), meta);
        saveState();
        appendWorkerLog(targetName, 'warn', `Deleted file "${safeName}" from ${targetName}`);

        sendJson(res, 200, {
          ok: true,
          deleted: safeName,
          files: remaining,
          worker: { ...meta, code: readWorkerCodeFromStorage(targetName), files: remaining }
        });
        return;
      }
    }

    // Worker Routes, Issues, Observability, and Deployments Endpoints
    // KV browser for the dashboard
    const kvMatch = pathname.match(/^\/api\/workers\/([^/]+)\/kv$/);
    if (kvMatch) {
      const name = decodeURIComponent(kvMatch[1]);
      if (!state.workers[name]) throw new HttpError(404, 'Worker not found');
      if (req.method === 'GET') {
        const q = parsedUrl.searchParams;
        const page = kvList(name, q.get('prefix') || '', Math.min(200, Number(q.get('limit')) || 100), q.get('cursor') || '');
        const st = kvStore(name);
        sendJson(res, 200, {
          ...page,
          totalKeys: st.map.size,
          totalBytes: st.bytes,
          keys: page.keys.map((k) => {
            const buf = Buffer.from(st.map.get(k.name).v, 'base64');
            const text = buf.toString('utf8');
            const printable = !text.includes('�');
            return { ...k, size: buf.length, preview: printable ? text.slice(0, 300) : null };
          })
        });
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (!body.key) throw new HttpError(400, 'Key required');
        kvPut(name, String(body.key), Buffer.from(String(body.value ?? ''), 'utf8'), Number(body.ttl) || 0);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE') {
        if (parsedUrl.searchParams.get('all') === '1') {
          for (const k of [...kvStore(name).map.keys()]) kvDelete(name, k);
        } else {
          kvDelete(name, String(parsedUrl.searchParams.get('key') || ''));
        }
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    const subActionMatch = pathname.match(/^\/api\/workers\/([^/]+)\/(routes|issues|observability|deployments|schedules)$/);
    if (subActionMatch && req.method === 'POST') {
      const targetName = decodeURIComponent(subActionMatch[1]);
      const actionType = subActionMatch[2];
      const meta = state.workers[targetName];
      if (!meta) {
        sendJson(res, 404, { error: 'Worker not found' });
        return;
      }
      const body = await readJsonBody(req);

      if (actionType === 'routes') {
        if (body.productionUrlEnabled !== undefined) meta.productionUrlEnabled = Boolean(body.productionUrlEnabled);
        if (body.previewUrlEnabled !== undefined) meta.previewUrlEnabled = Boolean(body.previewUrlEnabled);
        if (body.publishingLink !== undefined) {
          const cleanLink = String(body.publishingLink || `/${targetName}`).trim() || `/${targetName}`;
          meta.publishingLink = cleanLink;
          meta.publishingPath = extractPublishingPath(cleanLink, targetName);
        }
        if (body.addRoute) {
          if (!Array.isArray(meta.customRoutes)) meta.customRoutes = [];
          const pattern = String(body.addRoute.pattern || '').trim();
          if (pattern) {
            meta.customRoutes.push({
              id: crypto.randomBytes(4).toString('hex'),
              pattern,
              path: extractPublishingPath(pattern, targetName),
              type: body.addRoute.type || 'Publishing Link',
              createdAt: new Date().toISOString()
            });
          }
        }
        if (body.updateRoute && Array.isArray(meta.customRoutes)) {
          const found = meta.customRoutes.find((r) => r.id === body.updateRoute.id);
          if (found && body.updateRoute.pattern) {
            found.pattern = String(body.updateRoute.pattern).trim();
            found.path = extractPublishingPath(found.pattern, targetName);
          }
        }
        if (body.removeRouteId && Array.isArray(meta.customRoutes)) {
          meta.customRoutes = meta.customRoutes.filter((r) => r.id !== body.removeRouteId);
        }
      } else if (actionType === 'issues') {
        if (body.enabled !== undefined) {
          meta.issueDetectionEnabled = Boolean(body.enabled);
        }
        if (body.resolveIssueId && Array.isArray(meta.issues)) {
          const iss = meta.issues.find((i) => i.id === body.resolveIssueId);
          if (iss) iss.status = 'resolved';
        }
        if (body.clearResolved && Array.isArray(meta.issues)) {
          meta.issues = meta.issues.filter((i) => i.status !== 'resolved');
        }
      } else if (actionType === 'schedules') {
        if (!Array.isArray(meta.crons)) meta.crons = [];
        if (body.add) {
          const c = parseCron(body.add);
          if (meta.crons.length >= 20) throw new HttpError(400, 'Up to 20 schedules per worker');
          if (meta.crons.some((j) => j.expr === c.expr)) throw new HttpError(409, 'That schedule already exists');
          meta.crons.push({ id: crypto.randomBytes(4).toString('hex'), expr: c.expr, createdAt: new Date().toISOString() });
        }
        if (body.remove) meta.crons = meta.crons.filter((j) => j.id !== body.remove);
        if (body.run) {
          const job = meta.crons.find((j) => j.id === body.run) || { id: 'manual', expr: 'manual run' };
          await runCron(targetName, job, true);
        }
      } else if (actionType === 'observability') {
        meta.observabilityConfig = {
          ...(meta.observabilityConfig || {}),
          ...(body.observabilityConfig || {})
        };
      } else if (actionType === 'deployments') {
        const now = new Date().toISOString();
        const workerDir = path.join(WORKERS_DIR, targetName);
        if (body.action === 'rollback' && body.versionId) {
          const targetDep = (meta.deployments || []).find((d) => d.id === body.versionId);
          if (!targetDep) throw new HttpError(404, 'Deployment not found');
          if (targetDep) {
            if (!restoreDeployment(targetName, meta, targetDep)) {
              throw new HttpError(409, `Version ${targetDep.id} has no stored code to roll back to`);
            }
            meta.deployId = targetDep.id;
            meta.updatedAt = now;
            appendWorkerLog(targetName, 'info', `Rolled back ${targetName} to deployment version ${targetDep.id}`);
          }
        } else {
          // Create a new deployment version snapshot from current disk storage
          const currentCode = readWorkerCodeFromStorage(targetName) || '';
          const newDeployId = crypto.createHash('sha1').update(currentCode + now).digest('hex').slice(0, 8);
          meta.deployId = newDeployId;
          meta.updatedAt = now;
          if (!Array.isArray(meta.deployments)) meta.deployments = [];
          meta.deployments.unshift({
            id: newDeployId,
            timestamp: now,
            language: meta.language || 'javascript',
            filename: meta.filename || 'worker.js',
            sizeBytes: Buffer.byteLength(currentCode),
            author: config.username || 'admin',
            source: body.source || 'Deployed from Dashboard',
            codeSnapshot: currentCode,
            filesSnapshot: snapshotWorkerFiles(targetName)
          });
          meta.deployments = meta.deployments.slice(0, 25);
          appendWorkerLog(targetName, 'info', `Created new deployment version ${newDeployId} for ${targetName}`);
        }
      }

      const workerDir = path.join(WORKERS_DIR, targetName);
      if (fs.existsSync(workerDir)) {
        writeJsonAtomic(path.join(workerDir, 'meta.json'), meta);
      }
      if (actionType === 'routes') invalidateWorkerRuntime(targetName);
      saveState();
      const files = listWorkerFiles(targetName);
      sendJson(res, 200, {
        ok: true,
        worker: { ...meta, code: readWorkerCodeFromStorage(targetName), files }
      });
      return;
    }

    if (pathname === '/api/workers' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = sanitizeWorkerName(body.name || `worker-${Object.keys(state.workers).length + 1}`);
      const invalid = validateWorkerName(name);
      if (invalid) throw new HttpError(400, invalid);
      if (state.workers[name] && !body.overwrite) throw new HttpError(409, `Worker "${name}" already exists`);
      const language = body.language || state.editorPreferences.language || 'javascript';
      const langSpec = getLangSpec(language);
      const created = createOrUpdateWorker(name, {
        language: langSpec.id,
        publishingLink: body.publishingLink || `/${name}`,
        code: typeof body.code === 'string' ? body.code : langSpec.template(name),
        deploy: true,
        deploySource: 'Created Worker'
      });
      state.activeWorker = name;
      if (!state.defaultWorker) state.defaultWorker = name;
      saveState();
      appendWorkerLog(name, 'info', `Created worker "${name}" (${langSpec.label}).`);
      sendJson(res, 200, {
        ok: true,
        worker: { ...created.meta, code: created.code, files: created.files },
        workerCount: Object.keys(state.workers).length
      });
      return;
    }

    if (pathname.startsWith('/api/workers/') && req.method === 'PUT') {
      const targetName = decodeURIComponent(pathname.slice('/api/workers/'.length));
      if (!state.workers[targetName]) {
        sendJson(res, 404, { error: 'Worker not found' });
        return;
      }
      const body = await readJsonBody(req);

      let finalName = targetName;
      if (body.newName && sanitizeWorkerName(body.newName) && sanitizeWorkerName(body.newName) !== targetName) {
        const candidate = sanitizeWorkerName(body.newName);
        const invalid = validateWorkerName(candidate);
        if (invalid) throw new HttpError(400, invalid);
        if (state.workers[candidate]) throw new HttpError(409, `Worker "${candidate}" already exists`);
        invalidateWorkerRuntime(targetName, true);
        kvRename(targetName, candidate);
        if (state.defaultWorker === targetName) state.defaultWorker = candidate;
        const oldDir = path.join(WORKERS_DIR, targetName);
        const newDir = path.join(WORKERS_DIR, candidate);
        if (fs.existsSync(oldDir)) {
          fs.renameSync(oldDir, newDir);
        }
        state.workers[candidate] = { ...state.workers[targetName], name: candidate };
        delete state.workers[targetName];
        if (state.activeWorker === targetName) state.activeWorker = candidate;
        finalName = candidate;
      }

      let nextCode = body.code;
      const prevLang = state.workers[finalName].language || 'javascript';
      const nextLang = body.language || prevLang;
      const langSpec = getLangSpec(nextLang);
      if (body.useLanguageTemplate) {
        if (body.targetFilename && body.targetFilename !== state.workers[finalName].filename) {
          body.targetFileContent = langSpec.template(finalName);
        } else {
          nextCode = langSpec.template(finalName);
        }
      }

      const updated = createOrUpdateWorker(finalName, {
        language: langSpec.id,
        code: nextCode,
        files: body.files,
        targetFilename: body.targetFilename,
        targetFileContent: body.targetFileContent,
        publishingLink: body.publishingLink,
        spaces: body.spaces,
        indentUsingTabs: body.indentUsingTabs,
        encoding: body.encoding,
        eol: body.eol,
        layout: body.layout,
        bindings: body.bindings,
        deploy: Boolean(body.deploy),
        deploySource: body.deploySource
      });

      if (body.deploy) {
        appendWorkerLog(
          finalName,
          'info',
          `Deployed ${updated.meta.filename} (rev ${updated.meta.deployId}) to local storage.`
        );
      }

      sendJson(res, 200, {
        ok: true,
        worker: { ...updated.meta, code: updated.code, files: updated.files }
      });
      return;
    }

    if (pathname.startsWith('/api/workers/') && req.method === 'DELETE') {
      const targetName = decodeURIComponent(pathname.slice('/api/workers/'.length));
      if (!state.workers[targetName]) {
        sendJson(res, 404, { error: 'Worker not found' });
        return;
      }
      invalidateWorkerRuntime(targetName, true);
      kvDrop(targetName);
      const workerDir = path.join(WORKERS_DIR, targetName);
      if (fs.existsSync(workerDir)) {
        fs.rmSync(workerDir, { recursive: true, force: true });
      }
      delete state.workers[targetName];
      pendingMetaWrites.delete(targetName);
      if (!state.workers[state.activeWorker]) {
        state.activeWorker = Object.keys(state.workers)[0] || '';
      }
      if (state.defaultWorker === targetName) state.defaultWorker = '';
      saveState();
      sendJson(res, 200, {
        ok: true,
        activeWorker: state.activeWorker,
        workerCount: Object.keys(state.workers).length
      });
      return;
    }

    if (pathname === '/api/active-worker' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.name && state.workers[body.name]) {
        state.activeWorker = body.name;
      }
      if (body.editorPreferences) {
        state.editorPreferences = { ...state.editorPreferences, ...body.editorPreferences };
      }
      saveState();
      sendJson(res, 200, { ok: true, activeWorker: state.activeWorker, editorPreferences: state.editorPreferences });
      return;
    }

    if (pathname.startsWith('/api/logs/') && req.method === 'DELETE') {
      const targetName = decodeURIComponent(pathname.slice('/api/logs/'.length));
      if (targetName === '_all') {
        for (const w of Object.values(state.workers)) {
          w.logs = [];
          persistWorkerSoon(w.name);
        }
      } else if (state.workers[targetName]) {
        state.workers[targetName].logs = [];
        persistWorkerSoon(targetName);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/config' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      // A blank token field means "keep the saved one"; clearing is explicit.
      let nextToken = config.tunnelToken || '';
      if (body.clearTunnelToken) nextToken = '';
      else if (typeof body.tunnelToken === 'string' && body.tunnelToken.trim()) {
        const m = body.tunnelToken.match(/[A-Za-z0-9_=-]{80,}/);
        if (!m) throw new HttpError(400, "That doesn't look like a Cloudflare tunnel token");
        nextToken = m[0];
      }
      config = {
        ...config,
        subdomain: String(body.subdomain ?? config.subdomain ?? '').trim(),
        rootDomain: String(body.rootDomain ?? config.rootDomain ?? '').trim(),
        localIp: String(body.localIp ?? config.localIp ?? '').trim() || detectLocalIp(),
        networkCidrs: String(body.networkCidrs ?? config.networkCidrs ?? '').trim(),
        tunnelId: String(body.tunnelId ?? config.tunnelId ?? '').trim(),
        tunnelToken: nextToken
      };
      saveConfig(config);
      manageTunnelConnector();
      const dnsCheck = await checkCloudflareDnsRecord();
      sendJson(res, 200, { ok: true, config: publicConfig(), dnsCheck });
      return;
    }

    if (pathname === '/api/dns/check' && req.method === 'POST') {
      const dnsCheck = await checkCloudflareDnsRecord();
      sendJson(res, 200, { ok: true, dnsCheck, config: publicConfig() });
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. Check Worker Publishing Links & Custom Routes first
    let matchedWorker = null;
    for (const [wName, wMeta] of Object.entries(state.workers)) {
      const pubPath = extractPublishingPath(wMeta.publishingLink || wMeta.publishingPath, wName);
      if (pubPath && pubPath !== '/' && (pathname === pubPath || pathname.startsWith(pubPath + '/'))) {
        matchedWorker = wName;
        break;
      }
      if (Array.isArray(wMeta.customRoutes)) {
        for (const r of wMeta.customRoutes) {
          const rPath = extractPublishingPath(r.pattern || r.path, wName);
          if (rPath && rPath !== '/' && (pathname === rPath || pathname.startsWith(rPath + '/'))) {
            matchedWorker = wName;
            break;
          }
        }
      }
      if (matchedWorker) break;
    }

    // 2. Check /<WorkerName> and /<WorkerName>/*
    if (!matchedWorker) {
      const pathSegments = pathname.split('/').filter(Boolean);
      if (pathSegments.length >= 1) {
        let candidateWorker = pathSegments[0];
        try {
          candidateWorker = decodeURIComponent(candidateWorker);
        } catch (_) {}
        if (state.workers[candidateWorker]) {
          matchedWorker = candidateWorker;
        }
      }
    }

    // 3. Fallback to the default worker for unclaimed paths (e.g. /ipdata, /health)
    if (!matchedWorker && pathname !== '/favicon.ico' && state.defaultWorker && state.workers[state.defaultWorker]) {
      matchedWorker = state.defaultWorker;
    }

    if (matchedWorker) {
      const bodyBuf = await readRequestBody(req);
      const result = await executeWorkerAction(matchedWorker, req, bodyBuf, req.url);
      if (result.stream) {
        res.writeHead(result.status, result.headers);
        let bytes = 0;
        result.stream.on('data', (c) => (bytes += c.length));
        result.stream.on('end', () => result.onEnd(bytes));
        result.stream.on('error', () => res.destroy());
        res.on('close', () => {
          if (!result.stream.complete) result.stream.destroy();
        });
        result.stream.pipe(res);
        return;
      }
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('Server error:', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    sendJson(res, status, { error: status >= 500 ? 'Internal server error' : err.message, message: err.message, retryAfter: err.retryAfter });
  }
});

function cleanupPool() {
  for (const [, entry] of workerdPool.entries()) {
    if (entry && entry.proc) {
      try {
        entry.proc.kill('SIGTERM');
      } catch (_) {}
    }
    if (entry && entry.fallbackServer) {
      try {
        entry.fallbackServer.close();
      } catch (_) {}
    }
  }
}
function shutdown() {
  try {
    flushPendingWrites();
    kvFlush();
  } catch (_) {}
  cleanupPool();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[workerd-runtime] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[workerd-runtime] Unhandled rejection:', err);
});

server.keepAliveTimeout = 65000; // longer than nginx's upstream keep-alive
server.headersTimeout = 66000;
server.on('error', (err) => {
  console.error(`[alex-aero] cannot listen on 127.0.0.1:${BACKEND_PORT}: ${err.message}`);
  process.exit(1);
});
// First boot in Docker etc.: create the login from the environment.
if (!fs.existsSync(AUTH_FILE) && process.env.AX_ADMIN_PASSWORD) {
  writeAuthFile(process.env.AX_ADMIN_USER || 'admin', process.env.AX_ADMIN_PASSWORD)
    .then(() => console.log(`[alex-aero] login created for ${process.env.AX_ADMIN_USER || 'admin'}`))
    .catch((err) => console.error('[alex-aero] could not create the login:', err.message));
}

server.listen(BACKEND_PORT, BIND_HOST, () => {
  console.log(`[alex-aero] listening on http://${BIND_HOST}:${BACKEND_PORT}`);
  manageTunnelConnector(); // used to start only after saving settings, never at boot
  scheduleTick();
  // zero cold starts for anything used this week
  const recent = Object.values(state.workers)
    .filter((w) => w.lastRunAt && Date.now() - new Date(w.lastRunAt).getTime() < 7 * 86400e3)
    .sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)))
    .slice(0, 8);
  recent.forEach((w, i) => setTimeout(() => isWorkerdWorker(w.name) && ensureWorkerdInstance(w.name).catch(() => {}), 500 + i * 400).unref());
  setInterval(manageTunnelConnector, 60 * 1000).unref();
  // is there a newer Alex-Aero? (shown on the System page; never installed by itself)
  setTimeout(() => checkForUpdate(true).catch(() => {}), 20 * 1000).unref();
  setInterval(() => checkForUpdate(true).catch(() => {}), 6 * 3600e3).unref();
});
