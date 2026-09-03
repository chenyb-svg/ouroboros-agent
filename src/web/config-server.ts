// =============================================================================
// Model Configuration Server — web UI for switching providers and models
// =============================================================================

import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "node:child_process";

const CONFIG_PATH = resolve(process.cwd(), ".ouroboros", "config.yaml");
const PORT = parseInt(process.env["SWITCH_PORT"] || "0") || 0;

async function readConfig(): Promise<any> {
  try {
    const yaml = await import("js-yaml");
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return yaml.load(raw) || {};
  } catch {
    return { version: 1, providers: [], modelOverrides: {} };
  }
}

async function writeConfig(config: any): Promise<void> {
  const yaml = await import("js-yaml");
  const output = yaml.dump(config, { indent: 2, lineWidth: 120, quotingType: "\"", forceQuotes: false });
  writeFileSync(CONFIG_PATH, output, "utf-8");
}

function saveEnvVars(vars: Record<string, string>): void {
  const envPath = resolve(process.cwd(), ".env");
  let existing: Record<string, string> = {};
  try {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.+)/);
      if (m) existing[m[1]] = m[2].trim();
    }
  } catch {}
  // Merge new vars (don't overwrite existing)
  for (const [k, v] of Object.entries(vars)) {
    if (!existing[k]) existing[k] = v;
  }
  // Rebuild .env
  let content = "";
  for (const [k, v] of Object.entries(existing)) {
    content += `${k}=${v}\n`;
  }
  writeFileSync(envPath, content, "utf-8");
}

// Provider presets — connection templates, user fills in their own model names
const PRESETS: Record<string, any> = {
  deepseek: {
    name: "deepseek", type: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKey: "${DEEPSEEK_API_KEY}",
    models: [],
  },
  openai: {
    name: "openai", type: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "${OPENAI_API_KEY}",
    models: [],
  },
  siliconflow: {
    name: "siliconflow", type: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "${SILICONFLOW_API_KEY}",
    models: [],
  },
  qwen: {
    name: "qwen", type: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "${DASHSCOPE_API_KEY}",
    models: [],
  },
  zhipu: {
    name: "zhipu", type: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "${ZHIPU_API_KEY}",
    models: [],
  },
  moonshot: {
    name: "moonshot", type: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: "${MOONSHOT_API_KEY}",
    models: [],
  },
};

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ouroboros — Model Configuration</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
.header h1{font-size:18px;color:#58a6ff}
.header .ver{color:#8b949e;font-size:13px}
.container{max-width:900px;margin:0 auto;padding:24px}
.section{margin-bottom:24px}
.section-title{font-size:14px;font-weight:600;color:#58a6ff;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:12px}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.card-title{font-size:15px;font-weight:600}
.card-actions{display:flex;gap:8px}
.row{display:flex;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.field{flex:1;min-width:180px}
.field label{display:block;font-size:12px;color:#8b949e;margin-bottom:4px}
.field input,.field select{width:100%;padding:6px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px}
.field input:focus,.field select:focus{outline:none;border-color:#58a6ff}
.btn{padding:6px 14px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;cursor:pointer;font-size:13px;transition:all .15s}
.btn:hover{background:#30363d}
.btn-primary{background:#238636;border-color:#238636;color:#fff}
.btn-primary:hover{background:#2ea043}
.btn-danger{color:#f85149}
.btn-danger:hover{background:#da3633;color:#fff;border-color:#da3633}
.btn-sm{padding:3px 10px;font-size:12px}
.models-input{width:100%;min-height:60px;padding:8px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;font-family:monospace;resize:vertical}
.status{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:8px;font-size:13px;animation:fadeIn .3s}
.status-ok{background:#238636;color:#fff}
.status-err{background:#da3633;color:#fff}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:12px}
.preset-btn{padding:8px 12px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;cursor:pointer;font-size:13px;text-align:left}
.preset-btn:hover{background:#30363d;border-color:#58a6ff}
.preset-btn .name{font-weight:600;color:#58a6ff}
.preset-btn .url{font-size:11px;color:#8b949e;display:block;margin-top:2px}
.tabs{display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid #30363d}
.tab{padding:8px 16px;cursor:pointer;color:#8b949e;font-size:13px;border-bottom:2px solid transparent}
.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}
.tab:hover{color:#c9d1d9}
.json-editor{width:100%;min-height:300px;padding:12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-family:'Cascadia Code','Fira Code',monospace;font-size:13px;resize:vertical}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#21262d;color:#8b949e;margin-left:6px}
.badge-active{background:#238636;color:#fff}
.agent-row{display:flex;gap:12px;align-items:end;padding:8px 0;border-bottom:1px solid #21262d}
.agent-row .agent-name{width:120px;font-size:13px;font-weight:600;color:#c9d1d9}
.agent-row .field{flex:1;min-width:120px}
</style>
</head>
<body>
<div class="header">
  <span style="font-size:20px">◎</span>
  <h1>Ouroboros Model Configuration</h1>
  <span class="ver">/switch</span>
</div>

<div class="container">
  <div class="tabs">
    <div class="tab active" onclick="switchTab('providers')">Providers</div>
    <div class="tab" onclick="switchTab('agents')">Agent Models</div>
    <div class="tab" onclick="switchTab('json')">JSON Config</div>
  </div>

  <!-- Providers Tab -->
  <div id="tab-providers">
    <div class="section">
      <div class="section-title">Quick Add Preset</div>
      <div class="preset-grid" id="presets"></div>
    </div>

    <div class="section">
      <div class="section-title">Configured Providers</div>
      <div id="providers-list"></div>
      <button class="btn" onclick="addProvider()" style="margin-top:8px">+ Add Provider</button>
    </div>

    <div class="section">
      <button class="btn btn-primary" onclick="saveConfig()">Save & Apply</button>
      <span style="font-size:12px;color:#8b949e;margin-left:8px">Restart Ouroboros after saving to apply changes</span>
    </div>
  </div>

  <!-- Agents Tab -->
  <div id="tab-agents" style="display:none">
    <div class="section">
      <div class="section-title">Agent Model Mapping</div>
      <p style="font-size:12px;color:#8b949e;margin-bottom:12px">Assign each agent role to a provider + model combination</p>
      <div id="agents-list"></div>
    </div>
    <button class="btn btn-primary" onclick="saveConfig()">Save & Apply</button>
  </div>

  <!-- JSON Tab -->
  <div id="tab-json" style="display:none">
    <div class="section">
      <div class="section-title">Direct JSON/YAML Config</div>
      <textarea id="json-editor" class="json-editor" placeholder="Loading..."></textarea>
      <div style="margin-top:12px">
        <button class="btn btn-primary" onclick="saveJsonConfig()">Save JSON Config</button>
        <button class="btn" onclick="loadJson()" style="margin-left:8px">Reload</button>
      </div>
    </div>
  </div>
</div>
<div id="status"></div>

<script>
let config = {};
let currentTab = 'providers';

const PRESETS = ${JSON.stringify(PRESETS)};

async function init() {
  // Load .env values for validation
  try { const r = await fetch('/api/env'); envValues = await r.json(); } catch(e) {}
  renderPresets();
  await loadConfig();
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    config = await r.json();
    renderProviders();
    renderAgents();
    document.getElementById('json-editor').value = JSON.stringify(config, null, 2);
  } catch(e) {
    showStatus('Failed to load config: ' + e.message, 'err');
  }
}

function renderPresets() {
  const el = document.getElementById('presets');
  el.innerHTML = Object.entries(PRESETS).map(([id, p]) =>
    '<button class="preset-btn" onclick="addPreset(\\'' + id + '\\')">' +
    '<span class="name">' + p.name + '</span>' +
    '<span class="url">' + p.baseUrl + '</span></button>'
  ).join('');
}

function addPreset(id) {
  const p = PRESETS[id];
  if (!p) return;
  if (!config.providers) config.providers = [];
  // Don't duplicate
  if (config.providers.some(pr => pr.name === p.name)) {
    showStatus('Provider "' + p.name + '" already exists', 'err');
    return;
  }
  config.providers.push({...p, models: [...p.models]});
  renderProviders();
  showStatus('Added: ' + p.name, 'ok');
}

function addProvider(copy) {
  if (!config.providers) config.providers = [];
  const base = copy || { name: 'new-provider', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: '$' + '{API_KEY}', models: ['model-name'] };
  config.providers.push({...base});
  renderProviders();
}

function removeProvider(idx) {
  config.providers.splice(idx, 1);
  renderProviders();
}

function renderProviders() {
  const el = document.getElementById('providers-list');
  if (!config.providers || config.providers.length === 0) {
    el.innerHTML = '<div class="card" style="color:#8b949e;text-align:center">No providers configured. Add one below or click a preset.</div>';
    return;
  }
  el.innerHTML = config.providers.map((p, i) =>
    '<div class="card">' +
    '<div class="card-header">' +
    '<span class="card-title">' + esc(p.name) + ' <span class="badge">' + esc(p.type) + '</span></span>' +
    '<div class="card-actions">' +
    '<button class="btn btn-sm" onclick="copyProvider(' + i + ')">Copy</button>' +
    '<button class="btn btn-sm btn-danger" onclick="removeProvider(' + i + ')">Remove</button>' +
    '</div></div>' +
    '<div class="row">' +
    '<div class="field"><label>Name</label><input value="' + esc(p.name) + '" onchange="config.providers[' + i + '].name=this.value"></div>' +
    '<div class="field"><label>Type</label><select onchange="config.providers[' + i + '].type=this.value"><option ' + (p.type==="openai"?"selected":"") + '>openai</option></select></div>' +
    '</div>' +
    '<div class="row">' +
    '<div class="field"><label>Base URL</label><input value="' + esc(p.baseUrl||'') + '" onchange="config.providers[' + i + '].baseUrl=this.value"></div>' +
    '<div class="field"><label>API Key</label><input value="' + esc(p.apiKey||'') + '" onchange="config.providers[' + i + '].apiKey=this.value" placeholder="$' + '{ENV_VAR} or plain key"></div>' +
    '</div>' +
    '<div class="field"><label>Models (one per line)</label><textarea class="models-input" onchange="config.providers[' + i + '].models=this.value.split(String.fromCharCode(10)).filter(Boolean)">' + esc((p.models||[]).join('\\n')) + '</textarea></div>' +
    '</div>'
  ).join('');
}

function copyProvider(idx) {
  const p = config.providers[idx];
  addProvider({...p, name: p.name + '-copy', models: [...(p.models||[])]});
}

function renderAgents() {
  const el = document.getElementById('agents-list');
  const agents = {
    'builtin:coordinator': 'Coordinator — main reasoning engine',
    'Worker': 'Worker — tool execution',
    'Specialist': 'Specialist — skill-specific tasks',
  };

  if (!config.modelOverrides) config.modelOverrides = {};
  const providers = config.providers || [];
  const providerOpts = providers.map(p =>
    '<optgroup label="' + esc(p.name) + '">' +
    (p.models || []).map(m => '<option>' + p.name + '/' + m + '</option>').join('') +
    '</optgroup>'
  ).join('');

  el.innerHTML = Object.entries(agents).map(([id, desc]) => {
    const override = config.modelOverrides[id] || {};
    const current = (override.provider && override.model) ? override.provider + '/' + override.model : '';
    return '<div class="agent-row">' +
      '<div class="agent-name">' + esc(id) + '<br><span style="font-size:11px;color:#8b949e;font-weight:normal">' + desc + '</span></div>' +
      '<div class="field"><label>Model</label><select onchange="setAgentModel(\\'' + id + '\\', this.value)"><option value="">— Default —</option>' + providerOpts + '</select></div>' +
      '<div class="field"><label>Temperature</label><input type="number" step="0.1" min="0" max="2" value="' + (override.temperature || 0.7) + '" onchange="setAgentField(\\'' + id + '\\',\\'temperature\\',parseFloat(this.value))"></div>' +
      '<div class="field"><label>Max Tokens</label><input type="number" value="' + (override.maxTokens || 8192) + '" onchange="setAgentField(\\'' + id + '\\',\\'maxTokens\\',parseInt(this.value))"></div>' +
      '</div>';
  }).join('');

  // Set current selections
  setTimeout(() => {
    Object.entries(config.modelOverrides || {}).forEach(([id, o]) => {
      const val = o.provider + '/' + o.model;
      const sel = document.querySelector('[data-agent="' + id + '"]');
    });
  }, 100);
}

function setAgentModel(id, val) {
  if (!val) {
    delete config.modelOverrides[id];
    return;
  }
  const [provider, model] = val.split('/');
  if (!config.modelOverrides[id]) config.modelOverrides[id] = {};
  config.modelOverrides[id].provider = provider;
  config.modelOverrides[id].model = model;
}

function setAgentField(id, field, val) {
  if (!config.modelOverrides[id]) config.modelOverrides[id] = {};
  config.modelOverrides[id][field] = val;
}

async function saveConfig() {
  try {
    // Clean empty overrides
    if (config.modelOverrides) {
      for (const [k, v] of Object.entries(config.modelOverrides)) {
        if (!v || Object.keys(v).length === 0) delete config.modelOverrides[k];
      }
    }
    // Collect env vars that need to be set
    const envVars = {};
    let warnings = [];
    if (config.providers) {
      for (const p of config.providers) {
        const m = (p.apiKey || '').match(/^\\$\\{(\\w+)\\}$/);
        if (m) {
          const varname = m[1];
          if (!envValues[varname]) {
            warnings.push(varname + ' is not set in .env — you will get 401 errors!');
          }
        }
      }
    }
    if (warnings.length > 0) {
      if (!confirm('⚠ WARNING:\\n\\n' + warnings.join('\\n') + '\\n\\nContinue saving anyway?')) return;
    }
    const r = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ config, envVars }) });
    if (r.ok) { showStatus('Config saved! Restart Ouroboros to apply.', 'ok'); await loadConfig(); }
    else { const t = await r.text(); showStatus('Save failed: ' + t, 'err'); }
  } catch(e) { showStatus('Error: ' + e.message, 'err'); }
}
let envValues = {};

async function saveJsonConfig() {
  try {
    const json = JSON.parse(document.getElementById('json-editor').value);
    config = json;
    await saveConfig();
  } catch(e) { showStatus('Invalid JSON: ' + e.message, 'err'); }
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('[id^="tab-"]').forEach(t => t.style.display = 'none');
  document.getElementById('tab-' + tab).style.display = '';
  document.querySelector('.tab:nth-child(' + (tab === 'providers' ? 1 : tab === 'agents' ? 2 : 3) + ')').classList.add('active');
  if (tab === 'json') { document.getElementById('json-editor').value = JSON.stringify(config, null, 2); }
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status status-' + type;
  setTimeout(() => el.textContent = '', 4000);
}

init();
</script>
</body>
</html>`;
}

export function startConfigServer(): { server: Server; port: number; url: string } {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // API: get config
    if (req.method === "GET" && url.pathname === "/api/config") {
      try {
        const config = await readConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(config, null, 2));
      } catch (e: any) {
        res.writeHead(500);
        res.end(e.message);
      }
      return;
    }

    // API: save config
    if (req.method === "POST" && url.pathname === "/api/config") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", async () => {
        try {
          const { config, envVars } = JSON.parse(body);
          await writeConfig(config);
          // Also write env vars to .env
          if (envVars && Object.keys(envVars).length > 0) {
            saveEnvVars(envVars);
          }
          res.writeHead(200);
          res.end("OK");
        } catch (e: any) {
          res.writeHead(400);
          res.end(e.message);
        }
      });
      return;
    }

    // API: get .env values
    if (req.method === "GET" && url.pathname === "/api/env") {
      const envPath = resolve(process.cwd(), ".env");
      const env: Record<string, string> = {};
      try {
        const raw = readFileSync(envPath, "utf-8");
        for (const line of raw.split("\n")) {
          const m = line.match(/^\s*(\w+)\s*=\s*(.+)/);
          if (m) env[m[1]] = m[2].trim();
        }
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(env));
      return;
    }

    // Serve HTML page
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getHTML());
  });

  server.listen(PORT);

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  const url = `http://localhost:${port}`;

  return { server, port, url };
}

export function openBrowser(url: string): void {
  const cmd = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
    ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.error("Failed to open browser:", err.message); });
}
