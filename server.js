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

[STORAGE_DIR, WORKERS_DIR, RUNTIME_DIR, PUBLIC_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

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

function loadInitialPublicNetworkInfo() {
  let info = {
    ip: '',
    cf: {}
  };

  try {
    const rawWho = execSync('curl -fsSL --max-time 3 "https://ipwho.is/"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const who = JSON.parse(rawWho);
    if (who && who.ip && !isPrivateOrLocalIp(who.ip)) {
      info.ip = who.ip;
      info.cf = {
        country: who.country_code || null,
        region: who.region || null,
        regionCode: who.region_code || null,
        city: who.city || null,
        postalCode: who.postal || null,
        continent: who.continent_code || null,
        latitude: typeof who.latitude === 'number' ? who.latitude : null,
        longitude: typeof who.longitude === 'number' ? who.longitude : null,
        timezone: (who.timezone && who.timezone.id) || null,
        isEUCountry: Boolean(who.is_eu),
        asn: (who.connection && who.connection.asn) || null,
        asOrganization: (who.connection && (who.connection.org || who.connection.isp)) || null
      };
    }
  } catch (_) {}

  try {
    const traceRaw = execSync('curl -fsSL --max-time 3 "https://1.1.1.1/cdn-cgi/trace"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const traceMap = {};
    for (const line of traceRaw.split('\n')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        traceMap[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    if (!info.ip && traceMap.ip && !isPrivateOrLocalIp(traceMap.ip)) {
      info.ip = traceMap.ip;
    }
    if (traceMap.colo) info.cf.colo = traceMap.colo;
    if (!info.cf.country && traceMap.loc) info.cf.country = traceMap.loc;
    if (traceMap.http) info.cf.httpProtocol = traceMap.http.toUpperCase().replace('HTTP/2', 'HTTP/2');
    if (traceMap.tls) info.cf.tlsVersion = traceMap.tls;
  } catch (_) {}

  if (!info.ip) {
    try {
      const ipifyRaw = execSync('curl -fsSL --max-time 3 "https://api.ipify.org?format=json"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      const parsed = JSON.parse(ipifyRaw);
      if (parsed && parsed.ip && !isPrivateOrLocalIp(parsed.ip)) {
        info.ip = parsed.ip;
      }
    } catch (_) {}
  }

  return info;
}

let PUBLIC_NETWORK_INFO = loadInitialPublicNetworkInfo();

async function refreshPublicNetworkInfoAsync() {
  try {
    const nextInfo = {
      ip: PUBLIC_NETWORK_INFO.ip || '',
      cf: { ...(PUBLIC_NETWORK_INFO.cf || {}) }
    };
    try {
      const r1 = await fetch('https://ipwho.is/');
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
      const r2 = await fetch('https://1.1.1.1/cdn-cgi/trace');
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

setInterval(refreshPublicNetworkInfoAsync, 10 * 60 * 1000).unref();

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
    const reqFile = decodeURIComponent(url.pathname.replace(/^\\/+/, ""));

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
    const reqFile = decodeURIComponent(url.pathname.replace(/^\\/+/, ""));

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
  <p>Edit this HTML file in Robo Workers.</p>
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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(diskConfig, null, 2), 'utf8');
  return defaultConfig;
}

function saveConfig(cfg) {
  cfg.updatedAt = new Date().toISOString();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  syncCloudflareRecordsFile(cfg);
}

let config = loadConfig();

function loadState() {
  const defaultState = {
    activeWorker: '',
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

function saveState() {
  const diskState = {
    ...state,
    lastDashboardClient: null
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(diskState, null, 2), 'utf8');
  syncCloudflareRecordsFile(config);
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

    fs.writeFileSync(CF_RECORDS_FILE, JSON.stringify(recordsPayload, null, 2), 'utf8');
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

function sanitizeFileName(rawFile) {
  const base = path.basename(String(rawFile || '').trim());
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned === 'meta.json' || cleaned.startsWith('.')) {
    return null;
  }
  return cleaned.slice(0, 80);
}

function listWorkerFiles(workerName) {
  const workerDir = path.join(WORKERS_DIR, workerName);
  if (!fs.existsSync(workerDir)) return [];
  const entries = fs.readdirSync(workerDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === 'meta.json' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(workerDir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      files.push({
        name: entry.name,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        language: inferLanguageFromFilename(entry.name),
        content
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
        lastDurationMs: 1.4,
        lastCpuUs: 967,
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
      if (!meta.lastCpuUs) meta.lastCpuUs = Math.round((meta.lastDurationMs || 1.2) * 800);
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
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  }

  for (const existingName of Object.keys(state.workers)) {
    if (!foundNames.has(existingName)) {
      delete state.workers[existingName];
    }
  }

  if (!state.activeWorker || !state.workers[state.activeWorker]) {
    state.activeWorker = Object.keys(state.workers)[0] || '';
  }
  saveState();
}

function sanitizeWorkerName(rawName) {
  return String(rawName || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
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
    const files = fs
      .readdirSync(workerDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== 'meta.json' && !e.name.startsWith('.'))
      .map((e) => e.name);
    if (files.length > 0) {
      meta.filename = files[0];
      return fs.readFileSync(path.join(workerDir, files[0]), 'utf8');
    }
  }
  return '';
}

function invalidateWorkerRuntime(workerName) {
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
  if (!name) throw new Error('Invalid worker name');
  if (['api', 'public', 'assets', 'dashboard', 'editor', 'records'].includes(name.toLowerCase())) {
    throw new Error(`"${name}" is a reserved system path`);
  }

  const existing = state.workers[name] || {};
  const languageId = options.language || existing.language || 'javascript';
  const langSpec = getLangSpec(languageId);
  const workerDir = path.join(WORKERS_DIR, name);

  if (!fs.existsSync(workerDir)) {
    fs.mkdirSync(workerDir, { recursive: true });
  }

  const existingDiskFiles = fs
    .readdirSync(workerDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== 'meta.json' && !e.name.startsWith('.'))
    .map((e) => e.name);

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
  const newFilePath = path.join(workerDir, filename);
  const eol = options.eol || existing.eol || 'LF';
  const normalizeEol = (str) =>
    eol === 'CRLF' ? String(str || '').replace(/\r?\n/g, '\r\n') : String(str || '').replace(/\r\n/g, '\n');

  // If an array of multiple files is provided, persist every file in the worker directory
  if (Array.isArray(options.files)) {
    for (const f of options.files) {
      if (!f || typeof f.content !== 'string') continue;
      const safeSubName = sanitizeFileName(f.name);
      if (safeSubName) {
        fs.writeFileSync(path.join(workerDir, safeSubName), normalizeEol(f.content), 'utf8');
      }
    }
  }

  // If a specific file was edited, save it to its own file on disk
  if (safeTarget && typeof options.targetFileContent === 'string') {
    fs.writeFileSync(path.join(workerDir, safeTarget), normalizeEol(options.targetFileContent), 'utf8');
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
      codeSnapshot: codeToWrite
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
    lastDurationMs: existing.lastDurationMs || 1.4,
    lastCpuUs: existing.lastCpuUs || 967,
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

  fs.writeFileSync(path.join(workerDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  state.workers[name] = meta;
  saveState();

  return { meta, code: codeToWrite, files: listWorkerFiles(name) };
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
    message: String(message)
  });
  if (meta.logs.length > 100) {
    meta.logs = meta.logs.slice(-100);
  }
  const workerDir = path.join(WORKERS_DIR, name);
  if (fs.existsSync(workerDir)) {
    fs.writeFileSync(path.join(workerDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }
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
let nextWorkerdPort = 19100;

function stripBasicTypeScriptTypes(code) {
  return code
    .replace(/:\s*Promise<[^>]+>/g, '')
    .replace(/:\s*(Request|Response|any|string|number|boolean|unknown|void|Record<[^>]+>)\b/g, '')
    .replace(/\binterface\s+\w+\s*\{[^}]*\}/g, '');
}

function buildWorkerdWrappedScript(workerName, rawCode, language, bindings, filesMap, systemInfo, mountPrefixes) {
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
      if (typeof __CURRENT_LOGS__ !== 'undefined' && Array.isArray(__CURRENT_LOGS__) && __CURRENT_LOGS__.length > 0) {
        return new Response(__CURRENT_LOGS__.map((l) => l.message).join('\\n'), {
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

  return `
let __CURRENT_LOGS__ = [];
${userModuleCode}

function __normalizeToResponse(val) {
  if (val instanceof Response) return val;
  if (typeof val === 'string') {
    return new Response(val);
  }
  if (val instanceof ArrayBuffer || ArrayBuffer.isView(val) || (typeof ReadableStream !== 'undefined' && val instanceof ReadableStream)) {
    return new Response(val);
  }
  if (val !== null && typeof val === 'object') {
    return new Response(JSON.stringify(val, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
  return new Response(val !== undefined ? String(val) : '');
}

async function __invokeUserExport(req, env, ctx) {
  if (typeof __USER_DEFAULT_EXPORT__ === 'function') {
    return __normalizeToResponse(await __USER_DEFAULT_EXPORT__(req, env, ctx));
  }
  if (__USER_DEFAULT_EXPORT__ && typeof __USER_DEFAULT_EXPORT__.fetch === 'function') {
    return __normalizeToResponse(await __USER_DEFAULT_EXPORT__.fetch(req, env, ctx));
  }
  return __normalizeToResponse(__USER_DEFAULT_EXPORT__);
}

export default {
  async fetch(request, env, ctx) {
    const __logs = [];
    __CURRENT_LOGS__ = __logs;
    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;
    const fmt = (args) => args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');

    console.log = (...args) => { __logs.push({ level: 'log', message: fmt(args) }); origLog(...args); };
    console.info = (...args) => { __logs.push({ level: 'info', message: fmt(args) }); origInfo(...args); };
    console.warn = (...args) => { __logs.push({ level: 'warn', message: fmt(args) }); origWarn(...args); };
    console.error = (...args) => { __logs.push({ level: 'error', message: fmt(args) }); origError(...args); };

    try {
      let deviceInfo = {};
      try {
        const rawDeviceHeader = request.headers.get('x-internal-device');
        if (rawDeviceHeader) {
          deviceInfo = JSON.parse(rawDeviceHeader);
        }
      } catch (_) {}

      const cleanHeaders = new Headers(request.headers);
      cleanHeaders.delete('x-internal-device');

      const workerSlug = ${JSON.stringify(workerName)};
      const prefixes = ${JSON.stringify(mountPrefixes || [`/${workerName}`])};
      const origUrl = new URL(request.url);
      let strippedPath = origUrl.pathname;
      for (const prefix of prefixes) {
        if (!prefix || prefix === '/') continue;
        if (strippedPath === prefix || strippedPath === prefix + '/') {
          strippedPath = '/';
          break;
        } else if (strippedPath.startsWith(prefix + '/')) {
          strippedPath = strippedPath.slice(prefix.length);
          break;
        }
      }
      const jsFileNames = ${JSON.stringify(Object.keys(filesMap || {}).filter((k) => /\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(k)))};
      if (strippedPath.startsWith('/') && jsFileNames.includes(strippedPath.slice(1))) {
        strippedPath = '/';
      }

      const strippedUrl = new URL(origUrl.toString());
      strippedUrl.pathname = strippedPath;

      const reqBodyBuf = (request.method !== 'GET' && request.method !== 'HEAD')
        ? await request.arrayBuffer()
        : undefined;

      const liveSysInfo = ${JSON.stringify(systemInfo || {})};
      const cfProps = Object.assign(
        {
          clientIp: deviceInfo.ip || cleanHeaders.get('cf-connecting-ip') || '127.0.0.1',
          httpProtocol: 'HTTP/1.1',
          tlsVersion: deviceInfo.protocol === 'https' ? 'TLSv1.3' : '',
          clientTcpRtt: 1,
          timezone: liveSysInfo.timezone || 'America/New_York'
        },
        deviceInfo.cf || {}
      );

      const makeReq = (targetUrlStr) => {
        const r = new Request(targetUrlStr, {
          method: request.method,
          headers: cleanHeaders,
          body: reqBodyBuf ? reqBodyBuf.slice(0) : undefined,
          cf: cfProps
        });
        try {
          Object.defineProperty(r, 'cf', {
            value: cfProps,
            writable: false,
            enumerable: true,
            configurable: true
          });
        } catch (_) {}
        return r;
      };

      const customBindings = ${JSON.stringify(bindings || {})};
      const workerFilesMap = ${JSON.stringify(filesMap || {})};
      const enrichedEnv = Object.assign({}, customBindings, env || {}, {
        WORKER_NAME: workerSlug,
        CLIENT_IP: deviceInfo.ip || cleanHeaders.get('x-client-ip') || '127.0.0.1',
        CLIENT_DEVICE: deviceInfo,
        FILES: workerFilesMap,
        SYSTEM_INFO: liveSysInfo
      });

      const codeExpectsFullPrefix = ${JSON.stringify(Boolean(rawCode && rawCode.includes('/' + workerName)))};
      const isRootMountRequest = origUrl.pathname === '/' + workerSlug || origUrl.pathname === '/' + workerSlug + '/';
      const primaryUrlStr = (codeExpectsFullPrefix && isRootMountRequest) ? origUrl.toString() : strippedUrl.toString();
      const secondaryUrlStr = (codeExpectsFullPrefix && isRootMountRequest) ? strippedUrl.toString() : origUrl.toString();

      let resp = await __invokeUserExport(makeReq(primaryUrlStr), enrichedEnv, ctx);
      if (resp.status === 404 && primaryUrlStr !== secondaryUrlStr) {
        const fallbackResp = await __invokeUserExport(makeReq(secondaryUrlStr), enrichedEnv, ctx);
        if (fallbackResp.status !== 404) {
          resp = fallbackResp;
        }
      }

      const headers = new Headers(resp.headers);
      if (__logs.length > 0) {
        headers.set('x-internal-logs', encodeURIComponent(JSON.stringify(__logs)));
      }
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers
      });
    } catch (err) {
      __logs.push({ level: 'error', message: err && err.stack ? err.stack : String(err) });
      return new Response(err && err.stack ? err.stack : String(err), {
        status: 500,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-internal-logs': encodeURIComponent(JSON.stringify(__logs))
        }
      });
    } finally {
      console.log = origLog;
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
    }
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

    const srv = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(c => c, chunk);
      } catch (_) {}
    });
    srv.close();

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
        appendWorkerLog(workerName, 'error', `[Robo Workers] ${err.message}`);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    isolateSrv.on('error', () => resolve(null));
    isolateSrv.listen(port, '127.0.0.1', () => resolve(isolateSrv));
  });
}

async function ensureWorkerdInstance(workerName, rawCode, language, bindings) {
  const workerFiles = listWorkerFiles(workerName);
  const filesMap = {};
  for (const f of workerFiles) {
    filesMap[f.name] = f.content;
  }
  const sysInfo = getLiveSystemTelemetry();
  const meta = state.workers[workerName] || {};
  const wholeWorkerCode = buildWholeWorkerJsCode(workerName, rawCode, meta, workerFiles);
  const mountPrefixes = Array.from(
    new Set([
      `/${workerName}`,
      extractPublishingPath(meta.publishingLink || meta.publishingPath, workerName),
      ...(Array.isArray(meta.customRoutes)
        ? meta.customRoutes.map((r) => extractPublishingPath(r.pattern || r.path, workerName))
        : [])
    ])
  ).filter(Boolean);

  const codeHash = crypto
    .createHash('sha256')
    .update(
      `${language}:${wholeWorkerCode}:${JSON.stringify(bindings || {})}:${JSON.stringify(filesMap)}:${JSON.stringify(mountPrefixes)}`
    )
    .digest('hex');
  const existing = workerdPool.get(workerName);

  if (existing && existing.codeHash === codeHash) {
    if ((existing.proc && !existing.proc.killed) || existing.fallbackServer) {
      return existing.port;
    }
  }

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

  const port = nextWorkerdPort++;
  const runDir = path.join(RUNTIME_DIR, workerName);
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }
  fs.writeFileSync(path.join(runDir, 'package.json'), '{"type":"module"}\n', 'utf8');

  const primaryFile = meta.filename || 'worker.js';
  const extraModuleLines = [];

  for (const f of workerFiles) {
    if (f.name === primaryFile || f.name === 'entry.js' || f.name === 'config.capnp' || f.name === 'package.json') continue;
    const safeDiskPath = path.join(runDir, f.name);
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
    mountPrefixes
  );
  const compiledWorkerPath = path.join(runDir, 'entry.js');
  const capnpPath = path.join(runDir, 'config.capnp');

  fs.writeFileSync(compiledWorkerPath, wrappedScript, 'utf8');

  const capnpConfig = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
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
        appendWorkerLog(workerName, 'error', `[Robo Workers] ${msg}`);
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
          if (attempts > 25) return resolve(false);
          setTimeout(check, 25);
        });
      };
      setTimeout(check, 20);
    });
  }

  if (workerdListening) {
    workerdPool.set(workerName, { proc, port, codeHash, fallbackServer: null });
    return port;
  }

  if (proc) {
    try {
      proc.kill('SIGTERM');
    } catch (_) {}
  }

  const fallbackServer = await startNodeWorkerFallbackServer(port, compiledWorkerPath, workerName);
  workerdPool.set(workerName, { proc: null, port, codeHash, fallbackServer });
  return port;
}

function forwardToWorkerd(port, req, bodyBuffer, deviceInfo, targetPathWithQuery) {
  return new Promise((resolve, reject) => {
    const forwardHeaders = { ...req.headers };
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
        timeout: 8000
      },
      (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          resolve({
            status: proxyRes.statusCode || 200,
            headers: proxyRes.headers,
            body: Buffer.concat(chunks)
          });
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

function interpolateTemplate(templateStr, workerName, req, deviceInfo, queryObj) {
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
  return String(templateStr).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : ''
  );
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
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }, 8000);

    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode || 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });

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

  const rawCode = readWorkerCodeFromStorage(workerName);
  const deviceInfo = parseClientAndDevice(req, false);
  const parsedUrl = new URL(req.url || `/${workerName}`, `http://${deviceInfo.host}`);
  const queryObj = Object.fromEntries(parsedUrl.searchParams.entries());
  const fileInferredLang = inferLanguageFromFilename(meta.filename);
  const languageId =
    fileInferredLang && fileInferredLang !== 'plaintext' && meta.language === 'javascript' && !/\.(js|jsx|mjs|cjs)$/i.test(meta.filename || '')
      ? fileInferredLang
      : meta.language || fileInferredLang || 'javascript';
  const langSpec = getLangSpec(languageId);
  const codeFilePath = getWorkerCodePath(workerName);
  const workerFiles = listWorkerFiles(workerName);
  const totalWorkerBytes = workerFiles.reduce((acc, f) => acc + (f.sizeBytes || Buffer.byteLength(f.content || '')), 0) || Buffer.byteLength(rawCode);
  const hasExecutableJsWorker = workerFiles.some(
    (f) => /\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(f.name) && (/export\s+default\b/.test(f.content) || /addEventListener\s*\(\s*['"]fetch['"]/.test(f.content))
  );

  // If the worker is a multi-file HTML/CSS/JS frontend project without a Cloudflare Worker fetch export,
  // bundle the whole project (HTML + CSS + JS) together when previewing the worker root.
  const htmlEntryFile = !hasExecutableJsWorker && workerFiles.find((f) => /\.html?$/i.test(f.name));

  // Check if the request targets a static asset inside this worker's storage folder
  const workerPrefixes = Array.from(
    new Set([
      `/${workerName}`,
      extractPublishingPath(meta.publishingLink || meta.publishingPath, workerName),
      ...(Array.isArray(meta.customRoutes)
        ? meta.customRoutes.map((r) => extractPublishingPath(r.pattern || r.path, workerName))
        : [])
    ])
  ).filter((p) => p && p !== '/');

  let fallbackStaticAsset = null;
  for (const basePrefix of workerPrefixes) {
    const slashPrefix = `${basePrefix}/`;
    if (parsedUrl.pathname.startsWith(slashPrefix)) {
      const requestedSubFile = sanitizeFileName(decodeURIComponent(parsedUrl.pathname.slice(slashPrefix.length)));
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

  const bareTopSegment = sanitizeFileName(decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, '')));
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

  if (fallbackStaticAsset && !hasExecutableJsWorker) {
    const renderedContent = /\.(html|htm|css|svg|xml|csv|md|yaml|yml|txt|json)$/i.test(fallbackStaticAsset.name)
      ? interpolateTemplate(fallbackStaticAsset.content, workerName, req, deviceInfo, queryObj)
      : fallbackStaticAsset.content;
    const fileCt = detectDataFormatContentType(
      renderedContent,
      fallbackStaticAsset.name,
      fallbackStaticAsset.language,
      '',
      true
    );
    return {
      status: 200,
      headers: {
        'content-type': fileCt,
        'content-disposition': 'inline',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      },
      body: Buffer.from(renderedContent, 'utf8'),
      durationMs: 1,
      cpuUs: 120,
      deviceInfo
    };
  }

  if (htmlEntryFile && !fallbackStaticAsset) {
    let bundledHtml = interpolateTemplate(htmlEntryFile.content, workerName, req, deviceInfo, queryObj);
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
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': 'inline',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      },
      body: Buffer.from(bundledHtml, 'utf8'),
      durationMs: 1,
      cpuUs: 150,
      deviceInfo
    };
  }

  if (!meta.observabilityConfig || meta.observabilityConfig.logsEnabled !== false) {
    const filesLabel =
      workerFiles.length > 1
        ? workerFiles.map((f) => f.name).join(' + ')
        : meta.filename;
    appendWorkerLog(
      workerName,
      'info',
      `${req.method || 'GET'} http://${deviceInfo.host}${req.url || '/' + workerName} · Pulled ${filesLabel} (${totalWorkerBytes} B, ${workerFiles.length} file${workerFiles.length === 1 ? '' : 's'}) · Client IP ${deviceInfo.ip} (${deviceInfo.os} / ${deviceInfo.browser})`
    );
  }

  let status = 200;
  let resHeaders = {};
  let resBodyBuffer;
  let capturedErrorMessage = null;

  try {
    if (langSpec.runtime === 'workerd') {
      const port = await ensureWorkerdInstance(workerName, rawCode, languageId, meta.bindings);
      const execHrStart = process.hrtime.bigint();
      const workerdResp = await forwardToWorkerd(
        port,
        req,
        bodyBuffer,
        deviceInfo,
        subPathAndQuery || req.url || `/${workerName}`
      );
      const execUs = Math.max(120, Number((process.hrtime.bigint() - execHrStart) / 1000n));
      meta.lastCpuUs = execUs;
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
      resBodyBuffer = workerdResp.body;

      // If the worker returned 404 and the request matched a static asset file in the worker folder, serve it
      if (status === 404 && fallbackStaticAsset) {
        const renderedContent = /\.(html|htm|css|svg|xml|csv|md|yaml|yml|txt|json)$/i.test(fallbackStaticAsset.name)
          ? interpolateTemplate(fallbackStaticAsset.content, workerName, req, deviceInfo, queryObj)
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
      for (const f of workerFiles) filesMap[f.name] = f.content;
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
        REQUEST_HEADERS_JSON: JSON.stringify(req.headers || {})
      };

      const cmd = langSpec.runtime === 'python3' ? 'python3' : langSpec.runtime === 'bash' ? 'bash' : 'node';
      const extRegex = langSpec.runtime === 'python3' ? /\.py$/i : langSpec.runtime === 'bash' ? /\.(sh|bash)$/i : /\.(js|mjs|cjs)$/i;
      const runnableScripts = workerFiles.filter((f) => f && f.name && extRegex.test(f.name) && f.path && fs.existsSync(f.path));
      const scriptsToRun = runnableScripts.length > 0 ? runnableScripts.map((f) => f.path) : [codeFilePath];

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
      meta.lastCpuUs = Math.max(200, Number((process.hrtime.bigint() - execHrStart) / 1000n));

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
      const rendered = interpolateTemplate(rawCode, workerName, req, deviceInfo, queryObj);
      meta.lastCpuUs = Math.max(85, Number((process.hrtime.bigint() - hrStart) / 1000n));
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

  // If the caller explicitly requested user info from the reverse proxy via ?userInfo=1 / X-Request-User-Info: 1
  const explicitlyRequestedUserInfo =
    parsedUrl.searchParams.get('userInfo') === '1' ||
    parsedUrl.searchParams.get('userInfo') === 'true' ||
    parsedUrl.searchParams.get('user_info') === '1' ||
    req.headers['x-request-user-info'] === '1';

  if (explicitlyRequestedUserInfo) {
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

  const totalUs = Math.max(100, Number((process.hrtime.bigint() - hrStart) / 1000n));
  const durationMs = Number((totalUs / 1000).toFixed(2));
  const cpuUs = meta.lastCpuUs || Math.max(120, Math.round(totalUs * 0.65));
  const nowIso = new Date().toISOString();
  const sysMemMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1));
  const responseBytes = resBodyBuffer ? resBodyBuffer.length : 0;

  meta.requests = (meta.requests || 0) + 1;
  meta.totalBytesServed = (meta.totalBytesServed || 0) + responseBytes;
  if (status >= 500) {
    meta.errors = (meta.errors || 0) + 1;
  }
  meta.lastRunAt = nowIso;
  meta.lastDurationMs = durationMs;
  meta.lastCpuUs = cpuUs;
  meta.lastResponseBytes = responseBytes;

  if (!Array.isArray(meta.invocations)) meta.invocations = [];
  meta.invocations.push({
    id: crypto.randomBytes(4).toString('hex'),
    timestamp: nowIso,
    method: req.method || 'GET',
    path: parsedUrl.pathname,
    url: `http://${deviceInfo.host}${req.url || '/' + workerName}`,
    status,
    outcome: status >= 500 ? 'exception' : 'ok',
    durationMs,
    wallMs: durationMs,
    cpuUs,
    memoryMb: sysMemMb,
    responseBytes,
    clientIp: deviceInfo.ip,
    os: deviceInfo.os,
    browser: deviceInfo.browser,
    deviceType: deviceInfo.deviceType,
    versionId: meta.deployId || '00000000'
  });
  if (meta.invocations.length > 200) {
    meta.invocations = meta.invocations.slice(-200);
  }

  if (status >= 500 && meta.issueDetectionEnabled !== false) {
    if (!Array.isArray(meta.issues)) meta.issues = [];
    const issueMsg = capturedErrorMessage || `HTTP ${status} runtime exception in ${meta.filename}`;
    const existingIssue = meta.issues.find((iss) => iss.message === issueMsg && iss.status === 'active');
    if (existingIssue) {
      existingIssue.occurrences = (existingIssue.occurrences || 1) + 1;
      existingIssue.lastSeen = nowIso;
    } else {
      meta.issues.unshift({
        id: crypto.randomBytes(4).toString('hex'),
        title: issueMsg.split('\n')[0].slice(0, 120),
        message: issueMsg,
        filename: meta.filename,
        status: 'active',
        occurrences: 1,
        firstSeen: nowIso,
        lastSeen: nowIso
      });
    }
  }

  const workerDir = path.join(WORKERS_DIR, workerName);
  if (fs.existsSync(workerDir)) {
    fs.writeFileSync(path.join(workerDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }
  saveState();

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

function isConnectorInstalled() {
  try {
    execSync('command -v cloudflared', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function isConnectorRunning() {
  if (cloudflaredProc && !cloudflaredProc.killed) return true;
  try {
    const out = execSync('pgrep -f "[c]loudflared tunnel --no-autoupdate run --token" || true', { encoding: 'utf8' }).trim();
    return Boolean(out);
  } catch (_) {
    return false;
  }
}

function manageTunnelConnector() {
  if (config.tunnelToken && config.tunnelToken.trim()) {
    if (!isConnectorRunning() && isConnectorInstalled()) {
      try {
        cloudflaredProc = spawn(
          'cloudflared',
          ['tunnel', '--no-autoupdate', 'run', '--token', config.tunnelToken.trim()],
          { stdio: 'ignore', detached: true }
        );
        cloudflaredProc.unref();
      } catch (err) {
        console.error('Failed starting cloudflared tunnel:', err.message);
      }
    }
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
      preview = fs.readFileSync(absPath, 'utf8').slice(0, 1200);
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
      for (const f of fs.readdirSync(wDir)) {
        if (f.startsWith('.')) continue;
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
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
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

function loadAuthConfig() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (data && data.authEnabled && data.username && data.passwordHash && data.salt) {
      return data;
    }
  } catch (_) {}
  return null;
}

function checkBasicAuth(req) {
  const authCfg = loadAuthConfig();
  if (!authCfg) {
    return { authenticated: true, username: config.username || 'admin', authRequired: false };
  }
  const header = req.headers['authorization'] || '';
  if (!header.toLowerCase().startsWith('basic ')) {
    return { authenticated: false, authRequired: true };
  }
  try {
    const b64 = header.slice(6).trim();
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return { authenticated: false, authRequired: true };
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    if (user !== authCfg.username) {
      return { authenticated: false, authRequired: true };
    }
    const computedHash = crypto.scryptSync(pass, authCfg.salt, 64).toString('hex');
    const a = Buffer.from(computedHash, 'hex');
    const b = Buffer.from(authCfg.passwordHash, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { authenticated: true, username: user, authRequired: true };
    }
  } catch (_) {}
  return { authenticated: false, authRequired: true };
}

function sendBasicAuthChallenge(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Alex-Aero (ax.) - Robo Workers", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end('Sign-in required to access Alex-Aero (ax.).');
}

function isProtectedManagementPath(pathname) {
  if (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/editor' ||
    pathname === '/styles.css' ||
    pathname === '/lang-icons.js' ||
    pathname === '/app.js'
  ) {
    return true;
  }
  if (
    pathname === '/api/state' ||
    pathname === '/api/client-ip' ||
    pathname === '/api/workers' ||
    pathname.startsWith('/api/workers/') ||
    pathname === '/api/active-worker' ||
    pathname.startsWith('/api/logs/') ||
    pathname === '/api/config' ||
    pathname === '/api/dns/check'
  ) {
    return true;
  }
  return false;
}

discoverWorkersOnDisk();
syncCloudflareRecordsFile(config);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
        'access-control-allow-headers': '*',
        'access-control-max-age': '86400'
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Require native browser Basic Auth sign-in on homepage, editor, and dashboard API routes,
    // while keeping all worker viewer/executor routes (/example, etc.) unauthenticated.
    if (isProtectedManagementPath(pathname)) {
      const auth = checkBasicAuth(req);
      if (!auth.authenticated) {
        sendBasicAuthChallenge(res);
        return;
      }
      if (auth.username && config.username !== auth.username) {
        config.username = auth.username;
      }
    }

    // Dashboard-only client IP endpoint: determines client IP directly from incoming HTTP request
    if (pathname === '/api/client-ip' && req.method === 'GET') {
      await refreshPublicNetworkInfoAsync();
      const clientDevice = parseClientAndDevice(req, true);
      sendJson(res, 200, {
        ok: true,
        clientDevice
      });
      return;
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      // Determine client IP directly from the dashboard HTTP request
      const clientDevice = parseClientAndDevice(req, true);
      const sysTelemetry = getLiveSystemTelemetry();
      const todayPrefix = new Date().toISOString().slice(0, 10);
      let totalRequestsToday = 0;
      const workersList = Object.values(state.workers).map((w) => {
        const files = listWorkerFiles(w.name);
        const code = readWorkerCodeFromStorage(w.name) || '';
        const totalBytes = files.reduce((acc, f) => acc + (f.sizeBytes || 0), 0) || Buffer.byteLength(code);
        const invToday = Array.isArray(w.invocations)
          ? w.invocations.filter((i) => String(i.timestamp || '').startsWith(todayPrefix)).length
          : 0;
        const requestsToday = Math.max(invToday, w.requests || 0);
        totalRequestsToday += requestsToday;
        const publishingLink = w.publishingLink || `/${w.name}`;
        const publishingPath = extractPublishingPath(publishingLink, w.name);
        return {
          ...w,
          publishingLink,
          publishingPath,
          requestsToday,
          code,
          files,
          sizeBytes: totalBytes
        };
      });
      sendJson(res, 200, {
        config: {
          ...config,
          publicHostname: getConfiguredHostname(config),
          connectorInstalled: isConnectorInstalled(),
          connectorRunning: isConnectorRunning(),
          publicPort: PUBLIC_PORT
        },
        runtimeInfo: {
          ...RUNTIME_VERSIONS,
          ...sysTelemetry
        },
        systemTelemetry: sysTelemetry,
        activeWorker: state.activeWorker,
        editorPreferences: state.editorPreferences,
        workerCount: workersList.length,
        totalRequestsToday,
        workers: workersList,
        storageFiles: listLocalStorageFiles(),
        languages: Object.values(LANGUAGES).map(({ id, label, badge, ext, runtime, defaultFile }) => ({
          id,
          label,
          badge,
          ext,
          runtime,
          defaultFile
        })),
        clientDevice
      });
      return;
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
          files: listWorkerFiles(targetName)
        });
        return;
      }

      const bodyBuf = await readRequestBody(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}');

      if (req.method === 'POST') {
        const rawFilename = body.filename || 'new-file.js';
        const safeName = sanitizeFileName(rawFilename);
        if (!safeName) {
          sendJson(res, 400, { error: 'Invalid filename' });
          return;
        }
        const targetPath = path.join(workerDir, safeName);
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
        fs.writeFileSync(path.join(workerDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
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
          const renamedPath = path.join(workerDir, renamed);
          if (renamed !== safeName && fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, renamedPath);
          }
          if (meta.filename === safeName) {
            meta.filename = renamed;
            meta.language = inferLanguageFromFilename(renamed);
          }
          finalFileName = renamed;
        }

        const writePath = path.join(workerDir, finalFileName);
        if (typeof body.content === 'string') {
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
            source: body.deploySource || 'Manually deployed'
          });
          meta.deployments = meta.deployments.slice(0, 25);
          appendWorkerLog(targetName, 'info', `Deployed ${finalFileName} (rev ${newDeployId}) to Robo Workers storage.`);
        }

        invalidateWorkerRuntime(targetName);
        fs.writeFileSync(path.join(workerDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
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
        if (remaining.length === 0) {
          // Always keep at least one runnable file so the worker remains runnable
          const fallbackFile = 'worker.js';
          const fallbackCode = buildJsWorkerTemplate(targetName);
          fs.writeFileSync(path.join(workerDir, fallbackFile), fallbackCode, 'utf8');
          meta.filename = fallbackFile;
          meta.language = 'javascript';
          remaining = listWorkerFiles(targetName);
        } else if (meta.filename === safeName || !remaining.some((f) => f.name === meta.filename)) {
          meta.filename = remaining[0].name;
          meta.language = remaining[0].language || inferLanguageFromFilename(remaining[0].name);
        }

        invalidateWorkerRuntime(targetName);
        meta.updatedAt = new Date().toISOString();
        fs.writeFileSync(path.join(workerDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
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
    const subActionMatch = pathname.match(/^\/api\/workers\/([^/]+)\/(routes|issues|observability|deployments)$/);
    if (subActionMatch && req.method === 'POST') {
      const targetName = decodeURIComponent(subActionMatch[1]);
      const actionType = subActionMatch[2];
      const meta = state.workers[targetName];
      if (!meta) {
        sendJson(res, 404, { error: 'Worker not found' });
        return;
      }
      const bodyBuf = await readRequestBody(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}');

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
          if (targetDep) {
            if (typeof targetDep.codeSnapshot === 'string') {
              const entryFile = path.join(workerDir, targetDep.filename || meta.filename || 'worker.js');
              fs.writeFileSync(entryFile, targetDep.codeSnapshot, 'utf8');
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
            codeSnapshot: currentCode
          });
          meta.deployments = meta.deployments.slice(0, 25);
          appendWorkerLog(targetName, 'info', `Created new deployment version ${newDeployId} for ${targetName}`);
        }
      }

      const workerDir = path.join(WORKERS_DIR, targetName);
      if (fs.existsSync(workerDir)) {
        fs.writeFileSync(path.join(workerDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      }
      saveState();
      const files = listWorkerFiles(targetName);
      sendJson(res, 200, {
        ok: true,
        worker: { ...meta, code: readWorkerCodeFromStorage(targetName), files }
      });
      return;
    }

    if (pathname === '/api/workers' && req.method === 'POST') {
      const bodyBuf = await readRequestBody(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}');
      const name = sanitizeWorkerName(body.name || `worker-${Object.keys(state.workers).length + 1}`);
      if (!name) {
        sendJson(res, 400, { error: 'Worker name is required' });
        return;
      }
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
      saveState();
      appendWorkerLog(name, 'info', `Created worker "${name}" (${langSpec.label}) and saved to local storage.`);
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
      const bodyBuf = await readRequestBody(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}');

      let finalName = targetName;
      if (body.newName && sanitizeWorkerName(body.newName) && sanitizeWorkerName(body.newName) !== targetName) {
        const candidate = sanitizeWorkerName(body.newName);
        if (state.workers[candidate]) {
          sendJson(res, 400, { error: `Worker "${candidate}" already exists` });
          return;
        }
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
          `Deployed ${updated.meta.filename} (rev ${updated.meta.deployId}) to Robo Workers storage.`
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
      const running = workerdPool.get(targetName);
      if (running && running.proc) {
        try {
          running.proc.kill('SIGTERM');
        } catch (_) {}
        workerdPool.delete(targetName);
      }
      const workerDir = path.join(WORKERS_DIR, targetName);
      if (fs.existsSync(workerDir)) {
        fs.rmSync(workerDir, { recursive: true, force: true });
      }
      delete state.workers[targetName];
      if (!state.workers[state.activeWorker]) {
        state.activeWorker = Object.keys(state.workers)[0] || '';
      }
      saveState();
      sendJson(res, 200, {
        ok: true,
        activeWorker: state.activeWorker,
        workerCount: Object.keys(state.workers).length
      });
      return;
    }

    if (pathname === '/api/active-worker' && req.method === 'POST') {
      const bodyBuf = await readRequestBody(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}');
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
        }
        saveState();
      } else if (state.workers[targetName]) {
        state.workers[targetName].logs = [];
        saveState();
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/config' && req.method === 'PUT') {
      const bodyBuf = await readRequestBody(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}');
      config = {
        ...config,
        subdomain: String(body.subdomain ?? config.subdomain ?? '').trim(),
        rootDomain: String(body.rootDomain ?? config.rootDomain ?? '').trim(),
        localIp: String(body.localIp ?? config.localIp ?? '').trim() || detectLocalIp(),
        networkCidrs: String(body.networkCidrs ?? config.networkCidrs ?? '').trim(),
        tunnelId: String(body.tunnelId ?? config.tunnelId ?? '').trim(),
        tunnelToken: String(body.tunnelToken ?? config.tunnelToken ?? '').trim()
      };
      saveConfig(config);
      manageTunnelConnector();
      const dnsCheck = await checkCloudflareDnsRecord();
      sendJson(res, 200, {
        ok: true,
        config: {
          ...config,
          publicHostname: getConfiguredHostname(config),
          connectorInstalled: isConnectorInstalled(),
          connectorRunning: isConnectorRunning()
        },
        dnsCheck
      });
      return;
    }

    if (pathname === '/api/dns/check' && req.method === 'POST') {
      const dnsCheck = await checkCloudflareDnsRecord();
      sendJson(res, 200, {
        ok: true,
        dnsCheck,
        config: {
          ...config,
          publicHostname: getConfiguredHostname(config),
          connectorInstalled: isConnectorInstalled(),
          connectorRunning: isConnectorRunning()
        }
      });
      return;
    }

    if (
      pathname === '/' ||
      pathname === '/index.html' ||
      pathname === '/editor'
    ) {
      parseClientAndDevice(req, true);
      serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/styles.css') {
      serveStaticFile(res, path.join(PUBLIC_DIR, 'styles.css'), 'text/css; charset=utf-8');
      return;
    }
    if (pathname === '/lang-icons.js') {
      serveStaticFile(res, path.join(PUBLIC_DIR, 'lang-icons.js'), 'application/javascript; charset=utf-8');
      return;
    }
    if (pathname === '/app.js') {
      serveStaticFile(res, path.join(PUBLIC_DIR, 'app.js'), 'application/javascript; charset=utf-8');
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
        const candidateWorker = decodeURIComponent(pathSegments[0]);
        if (state.workers[candidateWorker]) {
          matchedWorker = candidateWorker;
        }
      }
    }

    // 3. Fallback to active worker for top-level subpaths (e.g. /ipdata, /health)
    if (!matchedWorker && state.activeWorker && state.workers[state.activeWorker]) {
      matchedWorker = state.activeWorker;
    }

    if (matchedWorker) {
      const bodyBuf = await readRequestBody(req);
      const result = await executeWorkerAction(matchedWorker, req, bodyBuf, req.url);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: 'Internal server error', message: err.message });
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
process.on('SIGINT', () => {
  cleanupPool();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupPool();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error('[workerd-runtime] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[workerd-runtime] Unhandled rejection:', err);
});

server.listen(BACKEND_PORT, '127.0.0.1', () => {
  console.log(`[workerd-runtime] Backend controller listening on http://127.0.0.1:${BACKEND_PORT}`);
});
