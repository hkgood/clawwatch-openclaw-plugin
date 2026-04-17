#!/usr/bin/env node
/**
 * ClawWatch node agent — setup / bind (link_token) / adaptive run loop.
 * Uses the same HMAC rules as ClawWatchServer README: sign the exact JSON body bytes.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const defaultStatePath = () =>
  process.env.CLAWWATCH_STATE || path.join(process.env.HOME || '.', '.clawwatch', 'agent.json');

function loadState(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function saveState(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* non-POSIX or permission denied */
  }
}

function hmacHex(secret, bodyUtf8) {
  return crypto.createHmac('sha256', secret).update(bodyUtf8, 'utf8').digest('hex');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function parseArgs(argv) {
  const out = { cmd: null, base: null, positional: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' && argv[i + 1]) {
      out.base = argv[++i].replace(/\/$/, '');
    } else if (a.startsWith('--base=')) {
      out.base = a.slice('--base='.length).replace(/\/$/, '');
    } else if (a === 'setup' || a === 'bind' || a === 'run') {
      out.cmd = a;
    } else if (!a.startsWith('-')) {
      out.positional.push(a);
    }
  }
  if (!out.base) out.base = process.env.CLAWWATCH_BASE_URL?.replace(/\/$/, '') || null;
  return out;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    const msg = json?.error || text || res.statusText;
    throw new Error(`${res.status} ${msg}`);
  }
  return json;
}

async function cmdSetup(baseUrl, statePath) {
  const url = `${baseUrl}/api/v1/agent/setup`;
  const res = await fetchJson(url, { method: 'POST' });
  const { node_id, node_secret, binding_code } = res;
  if (!node_id || !node_secret) throw new Error('Unexpected setup response');
  saveState(statePath, { base_url: baseUrl, node_id, node_secret, binding_code: binding_code ?? null });
  console.log('Saved credentials to', statePath);
  console.log('node_id:', node_id);
  console.log('Next: create a bind token in the ClawWatch app, then run:');
  console.log(`  clawwatch-agent bind --base ${baseUrl} <link_token>`);
}

async function cmdBind(baseUrl, statePath, linkToken) {
  const st = loadState(statePath);
  const node_id = st.node_id;
  const node_secret = st.node_secret;
  if (!node_id || !node_secret) throw new Error('Invalid state file; run setup first');
  const bodyObj = { node_id, link_token: linkToken.trim() };
  const body = JSON.stringify(bodyObj);
  const sig = hmacHex(node_secret, body);
  const url = `${baseUrl}/api/v1/agent/claim`;
  await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': sig },
    body,
  });
  console.log('Bound node', node_id, 'to your account.');
}

async function postPolicy(baseUrl, node_id, node_secret) {
  const body = JSON.stringify({ node_id });
  const sig = hmacHex(node_secret, body);
  return fetchJson(`${baseUrl}/api/v1/agent/report_policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': sig },
    body,
  });
}

async function postReport(baseUrl, node_id, node_secret, payload) {
  const body = JSON.stringify(payload);
  const sig = hmacHex(node_secret, body);
  return fetchJson(`${baseUrl}/api/v1/agent/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': sig },
    body,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Real system metrics for macOS ---
function getCpuLoad() {
  try {
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    return total > 0 ? Math.round(((total - idle) / total) * 100 * 100) / 100 : 0;
  } catch {
    return 0;
  }
}

function getMemUsage() {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return Math.round((used / 1024 / 1024) * 100) / 100; // MB
  } catch {
    return 0;
  }
}

function getUptimeSeconds() {
  return os.uptime();
}

function getDiskUsage() {
  try {
    const out = execSync('df -h / | tail -1', { timeout: 5000 }).toString().trim();
    const cols = out.split(/\s+/);
    // macOS cols: Filesystem  Size  Used  Avail  Capacity  iused  ifree  %iused  Mounted
    // Linux cols (df -h):    Filesystem  Size  Used  Avail  Use%  Mounted
    // Try macOS capacity column first (5th = index 4), then Linux (5th = index 4)
    const capStr = cols[4]?.replace(/%/g, '');
    const cap = parseFloat(capStr);
    if (!isNaN(cap)) return cap;
    // Fallback: compute from 512-byte blocks (Linux df -k style)
    const used = parseInt(cols[2], 10);
    const avail = parseInt(cols[3], 10);
    if (!isNaN(used) && !isNaN(avail)) {
      return Math.round((used / (used + avail)) * 10000) / 100;
    }
    return 0;
  } catch {
    return 0;
  }
}

function getVersion() {
  try {
    // Try openclaw version first, then node version
    const out = execSync('openclaw --version 2>/dev/null || node --version', { timeout: 3000 }).toString().trim();
    return out.replace(/^v/, '');
  } catch {
    return process.version.replace(/^v/, '');
  }
}

function getIpAddress() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.internal || iface.family !== 'IPv4') continue;
        return iface.address;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function getRegion() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Map common timezones to region names
    if (tz.includes('Shanghai') || tz.includes('Beijing') || tz.includes('Chongqing') || tz.includes('Urumqi')) return 'Asia/Shanghai';
    if (tz.includes('Tokyo') || tz.includes('Osaka')) return 'Asia/Tokyo';
    if (tz.includes('Seoul')) return 'Asia/Seoul';
    if (tz.includes('Los_Angeles') || tz.includes('San_Francisco')) return 'America/Los_Angeles';
    if (tz.includes('New_York')) return 'America/New_York';
    if (tz.includes('London')) return 'Europe/London';
    if (tz.includes('Berlin') || tz.includes('Paris') || tz.includes('Amsterdam')) return 'Europe/Berlin';
    return tz;
  } catch {
    return null;
  }
}

function getGpuModel() {
  try {
    const out = execSync('system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model" | head -1', { timeout: 5000 }).toString().trim();
    return out.replace(/^.*:\s*/, '').trim() || null;
  } catch {
    return null;
  }
}

function getVramUsage() {
  // Apple M4 uses unified memory — VRAM is shared with system RAM.
  // Try to parse dedicated VRAM on discrete GPUs (Intel/w dGPU), return null for Apple Silicon.
  try {
    const out = execSync('system_profiler SPDisplaysDataType 2>/dev/null | grep -i "VRAM" | head -1', { timeout: 5000 }).toString().trim();
    const mb = out.match(/(\d+)\s*MB/i)?.[1];
    if (mb) return parseInt(mb, 10);
    const gb = out.match(/(\d+)\s*GB/i)?.[1];
    if (gb) return parseInt(gb, 10) * 1024;
  } catch { /* ignore */ }
  return null; // null = unified memory (Apple Silicon) or unavailable
}

function getGpuLoad() {
  // Apple Silicon (M-series): GPU is integrated; no user-accessible GPU load without root.
  // powermetrics requires sudo. top -stats gpu produces no output on macOS.
  // Estimate: Apple Silicon GPU activity is proportional to overall CPU pressure.
  // Leave as null to indicate "not measured" — cpu_load is the best proxy.
  return null;
}

function getActiveModel() {
  // Try to read the active model from OpenClaw environment / runtime state
  // Check common env vars that might carry model info
  const model = process.env.OC_MODEL
    || process.env.ACTIVE_MODEL
    || process.env.OPENCLAW_MODEL
    || null;
  return model;
}

function getAgentsSummary() {
  try {
    // openclaw CLI may hang if gateway is busy; use short timeout
    const out = execSync('openclaw agents list --json 2>/dev/null | head -c 2000 || echo ""', { timeout: 3000 }).toString().trim();
    if (!out || out === '[]' || out === '' || out.includes('error') || out.includes('Error')) return null;
    let parsed;
    try { parsed = JSON.parse(out); } catch { return null; }
    if (!Array.isArray(parsed)) return null;
    return JSON.stringify(parsed.map(a => ({
      id: a.id || a.agentId,
      name: a.name || a.displayName || a.id,
      status: a.status || (a.running ? 'running' : 'idle'),
    })));
  } catch {
    return null;
  }
}

function buildPayloadFromEnv(node_id) {
  let extra = {};
  const raw = process.env.CLAWWATCH_PAYLOAD_JSON;
  if (raw) {
    try {
      extra = JSON.parse(raw);
      if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
        throw new Error('CLAWWATCH_PAYLOAD_JSON must be a JSON object');
      }
    } catch (e) {
      throw new Error(String(e.message || e));
    }
  } else {
    const cpuLoad = getCpuLoad();
    const memUsage = getMemUsage();
    const uptimeSec = Math.round(getUptimeSeconds());
    const diskUsage = getDiskUsage();
    const version = getVersion();
    const ipAddress = getIpAddress();
    const region = getRegion();
    const gpuModel = getGpuModel();

    extra = {
      status: 'online',
      cpu_load: cpuLoad,
      mem_usage: memUsage,
      uptime_seconds: uptimeSec,
      version,
      disk_usage: diskUsage,
      ip_address: ipAddress,
      region,
      gpu_model: gpuModel,
      gpu_load: getGpuLoad(),
      vram_usage: getVramUsage(),
      active_model: getActiveModel(),
      agents_summary: getAgentsSummary(),
      api_latency: 0,
      // Default tokens to 0; override via CLAWWATCH_PAYLOAD_JSON if needed
      today_tokens: 0,
    };
  }
  return { node_id, ...extra };
}

async function cmdRun(baseUrl, statePath) {
  const st = loadState(statePath);
  const node_id = st.node_id;
  const node_secret = st.node_secret;
  if (!node_id || !node_secret) throw new Error('Invalid state file; run setup first');

  let lastHash = null;
  let lastSentAt = 0;
  const dedupeWindowMs = 60_000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let policy;
    try {
      policy = await postPolicy(baseUrl, node_id, node_secret);
    } catch (e) {
      console.error('[clawwatch-agent] report_policy failed:', e.message || e);
      await sleep(30_000);
      continue;
    }

    const intervalSec = Math.max(5, Number(policy.next_interval_sec) || 180);
    if (!policy.report_allowed) {
      await sleep(intervalSec * 1000);
      continue;
    }

    // Build base payload with system metrics
    const basePayload = buildPayloadFromEnv(node_id);
    const body = JSON.stringify(basePayload);
    const hash = sha256Hex(body);
    const now = Date.now();
    if (hash === lastHash && now - lastSentAt < dedupeWindowMs) {
      await sleep(intervalSec * 1000);
      continue;
    }

    try {
      const rep = await postReport(baseUrl, node_id, node_secret, basePayload);
      lastHash = hash;
      lastSentAt = Date.now();
      const next = rep?.next_interval_sec;
      if (typeof next === 'number' && next > 0) {
        await sleep(next * 1000);
      } else {
        await sleep(intervalSec * 1000);
      }
    } catch (e) {
      console.error('[clawwatch-agent] report failed:', e.message || e);
      await sleep(intervalSec * 1000);
    }
  }
}

async function main() {
  const { cmd, base, positional } = parseArgs(process.argv);
  if (!cmd) {
    console.error('Usage: clawwatch-agent <setup|bind|run> --base <workerOrigin> [link_token]');
    process.exit(1);
  }
  if (!base) {
    console.error('Missing --base <worker URL> or CLAWWATCH_BASE_URL');
    process.exit(1);
  }
  const statePath = defaultStatePath();
  if (cmd === 'setup') {
    await cmdSetup(base, statePath);
    return;
  }
  if (cmd === 'bind') {
    const tok = positional[0];
    if (!tok) {
      console.error('Missing link_token argument');
      process.exit(1);
    }
    await cmdBind(base, statePath, tok);
    return;
  }
  if (cmd === 'run') {
    await cmdRun(base, statePath);
    return;
  }
  console.error('Unknown command', cmd);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
