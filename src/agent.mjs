#!/usr/bin/env node
/**
 * ClawWatch node agent — setup / bind (link_token) / adaptive run loop.
 *
 * Key design principles:
 * - No exec of openclaw CLI (incompatible with收紧权限的新版OpenClaw)
 * - All data read from local files (agents dir, sessions, openclaw.json)
 * - Local diff before report: skip if payload unchanged (dedupe自然成立)
 * - TTL cache with disk persistence (survives in-memory cache expiry)
 * - All field comparisons done locally; server receives complete payload
 */
import crypto from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'os';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

const defaultStatePath = () =>
  process.env.CLAWWATCH_STATE || path.join(process.env.HOME || '.', '.clawwatch', 'agent.json');

const defaultCachePath = () =>
  path.join(process.env.HOME || '.', '.clawwatch', 'agent_cache.json');

// ─── State & Cache helpers ───────────────────────────────────────────────────

function loadState(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveState(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  try { fs.chmodSync(p, 0o600); } catch { /* non-POSIX */ }
}

/**
 * TTL cache persisted to disk.
 * - Cache is read from disk on startup (survives process restart)
 * - Each entry: { value, expiresAt }
 */
class TtlCache {
  constructor(filePath, defaultTtlMs = 60_000) {
    this.filePath = filePath;
    this.defaultTtl = defaultTtlMs;
    this.data = {};
    this._loaded = false;
  }

  _loadSync() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
    } catch { this.data = {}; }
  }

  _persistSync() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  /** Get cached value, or null if absent/expired. */
  get(key) {
    this._loadSync();
    const entry = this.data[key];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      delete this.data[key];
      return null;
    }
    return entry.value;
  }

  /** Set value with optional custom TTL (ms). */
  set(key, value, ttlMs) {
    this._loadSync();
    this.data[key] = { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtl) };
    this._persistSync();
  }

  /** Invalidate a key immediately. */
  del(key) {
    this._loadSync();
    delete this.data[key];
    this._persistSync();
  }
}

// Global field cache (60s TTL, persisted to disk)
const fieldCache = new TtlCache(defaultCachePath(), 60_000);

// Last successfully reported payload (for diff comparison)
let lastPayload = null;
const lastPayloadPath = () =>
  path.join(process.env.HOME || '.', '.clawwatch', 'last_payload.json');

function loadLastPayload() {
  try {
    lastPayload = JSON.parse(fs.readFileSync(lastPayloadPath(), 'utf8'));
  } catch { lastPayload = null; }
}

function saveLastPayload(payload) {
  try {
    fs.mkdirSync(path.dirname(lastPayloadPath()), { recursive: true });
    fs.writeFileSync(lastPayloadPath(), JSON.stringify(payload, 'utf8'));
  } catch { /* ignore */ }
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function hmacHex(secret, bodyUtf8) {
  return crypto.createHmac('sha256', secret).update(bodyUtf8, 'utf8').digest('hex');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { cmd: null, base: null, positional: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' && argv[i + 1]) { out.base = argv[++i].replace(/\/$/, ''); }
    else if (a.startsWith('--base=')) { out.base = a.slice('--base='.length).replace(/\/$/, ''); }
    else if (a === 'setup' || a === 'bind' || a === 'run') { out.cmd = a; }
    else if (!a.startsWith('-')) { out.positional.push(a); }
  }
  if (!out.base) out.base = process.env.CLAWWATCH_BASE_URL?.replace(/\/$/, '') || null;
  return out;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
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
  const { node_id, node_secret } = st;
  if (!node_id || !node_secret) throw new Error('Invalid state file; run setup first');
  const bodyObj = { node_id, link_token: linkToken.trim() };
  const body = JSON.stringify(bodyObj);
  const sig = hmacHex(node_secret, body);
  await fetchJson(`${baseUrl}/api/v1/agent/claim`, {
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── System metrics (no exec required) ───────────────────────────────────────

/**
 * Cross-platform CPU load:
 * - macOS:   top -l 1 -n 2 (second sample is accurate)
 * - Linux:   /proc/stat
 * - Windows/other: null (unavailable)
 */
function getCpuLoad() {
  if (process.platform === 'darwin') {
    try {
      // -n 2 gives us two samples; the second is the recent average
      const out = execSync('top -l 1 -n 2', { timeout: 4000, encoding: 'utf8', maxBuffer: 4096 });
      const lines = out.split('\n');
      // macOS CPU line format: "CPU usage: X% user, Y% sys, Z% idle"
      const cpuLine = lines.find(l => l.includes('CPU usage') || l.includes('CPU:'));
      if (!cpuLine) return null;
      const userMatch = cpuLine.match(/(\d+\.?\d*)% user/);
      const sysMatch = cpuLine.match(/(\d+\.?\d*)% sys/);
      if (userMatch && sysMatch) {
        return Math.round((parseFloat(userMatch[1]) + parseFloat(sysMatch[1])) * 100) / 100;
      }
      // Fallback pattern: "X%Y%"
      const m = cpuLine.match(/(\d+\.?\d*)%/g);
      if (m && m.length >= 2) {
        // Usually: [user%, sys%, idle%] or [user%, idle%]
        // Find idle% to subtract
        const idleMatch = cpuLine.match(/(\d+\.?\d*)% idle/);
        if (idleMatch) {
          const total = m.slice(0, 2).reduce((s, x) => s + parseFloat(x), 0);
          return Math.round((total - parseFloat(idleMatch[1])) * 100) / 100;
        }
        return Math.round(m.slice(0, 2).reduce((s, x) => s + parseFloat(x), 0) * 100) / 100;
      }
    } catch { /* fall through */ }
  } else if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync('/proc/stat', 'utf8');
      const cpuLine = raw.split('\n').find(l => l.startsWith('cpu '));
      if (!cpuLine) return null;
      const vals = cpuLine.split(/\s+/).slice(1).map(Number);
      const total = vals.reduce((a, b) => a + b, 0);
      const idle = vals[3] || 0;
      return total > 0 ? Math.round(((total - idle) / total) * 10000) / 100 : null;
    } catch { /* fall through */ }
  }
  return null;
}

function getMemUsage() {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    return Math.round(((total - free) / 1024 / 1024) * 100) / 100; // MB
  } catch { return 0; }
}

function getUptimeSeconds() { return os.uptime(); }

function getDiskUsage() {
  try {
    // df -k gives 512-byte blocks (Linux/macOS compatible)
    const out = execSync('df -k / | tail -1', { timeout: 5000, encoding: 'utf8', maxBuffer: 4096 }).trim();
    const cols = out.split(/\s+/);
    // macOS: Filesystem  Size  Used  Avail  Capacity  iused  ifree  %iused  Mounted
    // Linux:   Filesystem  Size  Used  Avail  Use%  Mounted
    // Capacity/Use% is at index 4 on macOS (5th col) and Linux (5th col)
    const capStr = cols[4]?.replace(/%/g, '');
    const cap = parseFloat(capStr);
    if (!isNaN(cap)) return cap;
    // Fallback: compute from 512-byte blocks
    const used = parseInt(cols[2], 10);
    const avail = parseInt(cols[3], 10);
    if (!isNaN(used) && !isNaN(avail)) {
      return Math.round((used / (used + avail)) * 10000) / 100;
    }
    return 0;
  } catch { return 0; }
}

function getVersion() {
  try {
    const out = execSync('openclaw --version 2>/dev/null || node --version', { timeout: 3000, encoding: 'utf8', maxBuffer: 4096 }).trim();
    return out.replace(/^v/, '');
  } catch { return process.version.replace(/^v/, ''); }
}

function getIpAddress() {
  try {
    for (const name of Object.keys(os.networkInterfaces())) {
      for (const iface of os.networkInterfaces()[name]) {
        if (iface.internal || iface.family !== 'IPv4') continue;
        return iface.address;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Region detection:
 * - Try ipapi.co (free, no API key needed, ~50ms)
 * - Fallback: infer from OS timezone (unreliable, indicate uncertainty)
 */
async function getRegion() {
  // Fast path: try to get from cache first
  const cached = fieldCache.get('region');
  if (cached) return cached;

  try {
    // Use ipapi.co for accurate geolocation (falls back to IP-based country)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('http://ipapi.co/json/', {
      signal: controller.signal,
      headers: { 'User-Agent': 'clawwatch-agent/1.0' },
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const region = data.timezone || data.region || data.country_code || null;
      if (region) {
        fieldCache.set('region', region, 3_600_000); // cache 1 hour
        return region;
      }
    }
  } catch { /* fall through */ }

  // Fallback: use system timezone (less reliable)
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      fieldCache.set('region', tz, 300_000); // cache 5 min only (unreliable)
      return tz;
    }
  } catch { /* ignore */ }
  return null;
}

function getGpuModel() {
  if (process.platform === 'darwin') {
    try {
      const out = execSync(
        'system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model" | head -1',
        { timeout: 5000, encoding: 'utf8', maxBuffer: 4096 }
      ).trim().replace(/^.*:\s*/, '').trim();
      return out || null;
    } catch { /* ignore */ }
  }
  return null;
}

function getVramUsage() {
  if (process.platform === 'darwin') {
    try {
      const out = execSync(
        'system_profiler SPDisplaysDataType 2>/dev/null | grep -i "VRAM" | head -1',
        { timeout: 5000, encoding: 'utf8', maxBuffer: 4096 }
      ).trim();
      const mb = out.match(/(\d+)\s*MB/i)?.[1];
      if (mb) return parseInt(mb, 10);
      const gb = out.match(/(\d+)\s*GB/i)?.[1];
      if (gb) return parseInt(gb, 10) * 1024;
    } catch { /* ignore */ }
  }
  return null;
}

function getGpuLoad() { return null; } // Requires elevated privileges; leave null

// ─── OpenClaw local file readers (no exec) ───────────────────────────────────

/** Read current active model from openclaw.json config. */
function getActiveModel() {
  const cached = fieldCache.get('active_model');
  if (cached !== null) return cached;

  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const model = cfg.defaults?.model || cfg.models?.default || null;
    fieldCache.set('active_model', model, 60_000);
    return model;
  } catch { return null; }
}

/**
 * Get agents summary by reading local agent directories.
 * Replaces: execSync('openclaw agents list --json')
 *
 * Fields per agent:
 * - name: directory name
 * - status: inferred from session mtime (active < 5min = running, 5-60min = idle, > 60min = offline)
 * - lastActiveAt: ISO timestamp from most recent session file mtime
 * - sessions: count from sessions.json
 */
function getAgentsSummary() {
  const cached = fieldCache.get('agents_summary');
  if (cached !== null) return cached;

  const agentsDir = path.join(os.homedir(), '.openclaw', 'agents');
  if (!fs.existsSync(agentsDir)) {
    fieldCache.set('agents_summary', [], 60_000);
    return [];
  }

  let agentEntries;
  try {
    agentEntries = fs.readdirSync(agentsDir);
  } catch {
    fieldCache.set('agents_summary', [], 60_000);
    return [];
  }

  const now = Date.now();
  const FIVE_MIN = 5 * 60_000;
  const SIXTY_MIN = 60 * 60_000;

  const agents = [];
  for (const agentId of agentEntries) {
    if (agentId.startsWith('.')) continue;
    const agentDir = path.join(agentsDir, agentId);
    const sessionsDir = path.join(agentDir, 'sessions');

    let sessionCount = 0;
    let lastSessionMtime = 0;

    if (fs.existsSync(sessionsDir)) {
      // Count sessions from sessions.json
      const sp = path.join(sessionsDir, 'sessions.json');
      try {
        const obj = JSON.parse(fs.readFileSync(sp, 'utf8'));
        sessionCount = Object.keys(obj).length;
      } catch { /* ignore */ }

      // Find most recent session file mtime
      try {
        const files = fs.readdirSync(sessionsDir);
        for (const f of files) {
          if (!f.endsWith('.jsonl') || f.includes('.checkpoint') || f.includes('.deleted')) continue;
          const stat = fs.statSync(path.join(sessionsDir, f));
          if (stat.mtimeMs > lastSessionMtime) lastSessionMtime = stat.mtimeMs;
        }
      } catch { /* ignore */ }
    }

    // Infer status from last session activity
    let status = 'offline';
    if (lastSessionMtime > 0) {
      const age = now - lastSessionMtime;
      if (age < FIVE_MIN) status = 'running';
      else if (age < SIXTY_MIN) status = 'idle';
    }

    // Format lastActiveAt as ISO8601 UTC
    const lastActiveAt = lastSessionMtime > 0
      ? new Date(lastSessionMtime).toISOString()
      : null;

    agents.push({
      name: agentId,
      status,
      lastActiveAt,
      sessions: sessionCount > 0 ? sessionCount : (lastSessionMtime > 0 ? 1 : 0),
      storePathSummary: null,
      workState: null,
      bootstrapMissing: null,
    });
  }

  fieldCache.set('agents_summary', agents, 60_000);
  return agents;
}

// ─── Token stats from session jsonl (no exec) ─────────────────────────────────

/**
 * Parse today's token usage from session transcript jsonl files.
 * Tracks: input_tokens, output_tokens, api_calls, error_count, active_session_count
 */
function getTodayTokenStats() {
  const now = Date.now();
  const msPerDay = 86_400_000;
  // Today in UTC+8
  const utc8OffsetMs = 8 * 3_600_000;
  const todayStartMs = Math.floor((now - utc8OffsetMs) / msPerDay) * msPerDay + utc8OffsetMs;

  let freshInput = 0, freshOutput = 0, apiCalls = 0, errorCount = 0;
  const todayActiveSessionIds = new Set();

  const agentsDir = path.join(os.homedir(), '.openclaw', 'agents');
  if (!fs.existsSync(agentsDir)) {
    return { todayTokens: 0, inputTokens: 0, outputTokens: 0, apiCalls: 0, errorCount: 0, activeSessionCount: 0 };
  }

  try {
    const agentIds = fs.readdirSync(agentsDir);
    for (const agentId of agentIds) {
      if (agentId.startsWith('.')) continue;
      const sessionsDir = path.join(agentsDir, agentId, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;

      const files = fs.readdirSync(sessionsDir).filter(f =>
        f.endsWith('.jsonl') && !f.includes('.checkpoint') && !f.includes('.deleted') && !f.includes('.reset')
      );

      for (const file of files) {
        const fp = path.join(sessionsDir, file);
        try {
          const stat = fs.statSync(fp);
          // Skip files with no recent modifications
          if (stat.mtimeMs < todayStartMs) continue;

          const content = fs.readFileSync(fp, 'utf8');
          const lines = content.split('\n');

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj?.type === 'error') { errorCount++; continue; }
              if (obj?.sessionId) todayActiveSessionIds.add(obj.sessionId);
              if (obj?.message?.usage) {
                freshInput += obj.message.usage.input || 0;
                freshOutput += obj.message.usage.output || 0;
                apiCalls++;
              }
            } catch { /* skip malformed JSON lines */ }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* ignore */ }

  return {
    todayTokens: freshInput + freshOutput,
    inputTokens: freshInput,
    outputTokens: freshOutput,
    apiCalls,
    errorCount,
    activeSessionCount: todayActiveSessionIds.size,
  };
}

/** Get total session count across all agents. */
function getSessionsCount() {
  const agentsDir = path.join(os.homedir(), '.openclaw', 'agents');
  if (!fs.existsSync(agentsDir)) return 0;

  let total = 0;
  try {
    for (const agentId of fs.readdirSync(agentsDir)) {
      if (agentId.startsWith('.')) continue;
      const sp = path.join(agentsDir, agentId, 'sessions', 'sessions.json');
      if (fs.existsSync(sp)) {
        try {
          const obj = JSON.parse(fs.readFileSync(sp, 'utf8'));
          total += Object.keys(obj).length;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return total;
}

// ─── Payload building ─────────────────────────────────────────────────────────

function buildPayloadFromEnv(node_id) {
  const version = getVersion();
  const diskUsage = getDiskUsage();
  const ipAddress = getIpAddress();
  const gpuModel = getGpuModel();
  const uptimeSec = getUptimeSeconds();

  const tokenStats = getTodayTokenStats();

  return {
    node_id,
    version,
    disk_usage: diskUsage,
    ip_address: ipAddress,
    region: null, // filled async below
    gpu_model: gpuModel,
    gpu_load: getCpuLoad(),
    vram_usage: getVramUsage(),
    active_model: getActiveModel(),
    agents_summary: getAgentsSummary(),
    today_tokens: tokenStats.todayTokens,
    input_tokens: tokenStats.inputTokens,
    output_tokens: tokenStats.outputTokens,
    requests_processed: tokenStats.apiCalls,
    requests_failed: tokenStats.errorCount,
    tokens_per_second: uptimeSec > 0 ? Math.round((tokenStats.todayTokens / uptimeSec) * 100) / 100 : 0,
    sessions: getSessionsCount(),
    active_sessions: tokenStats.activeSessionCount,
    // context_percent / cache_hit_rate: unavailable without exec; omit (server keeps last value)
  };
}

/**
 * Local diff: deep-compare two payloads.
 * Returns true if any value changed (strict equality).
 */
function payloadsEqual(a, b) {
  if (!a || !b) return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    // Deep compare for objects/arrays
    if (typeof va === 'object' && typeof vb === 'object') {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
    } else {
      return false;
    }
  }
  return true;
}

// ─── Main run loop ────────────────────────────────────────────────────────────

async function cmdRun(baseUrl, statePath) {
  const st = loadState(statePath);
  const { node_id, node_secret } = st;
  if (!node_id || !node_secret) throw new Error('Invalid state file; run setup first');

  // Restore last payload and region cache from disk
  loadLastPayload();

  let consecutiveErrors = 0;
  const MAX_ERRORS_BEFORE_LONG_WAIT = 5;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let policy;
    try {
      policy = await postPolicy(baseUrl, node_id, node_secret);
    } catch (e) {
      console.error('[clawwatch-agent] report_policy failed:', e.message || e);
      consecutiveErrors++;
      await sleep(consecutiveErrors >= MAX_ERRORS_BEFORE_LONG_WAIT ? 300_000 : 30_000);
      continue;
    }

    consecutiveErrors = 0; // reset on successful policy fetch
    const intervalSec = Math.max(5, Number(policy.next_interval_sec) || 180);

    if (!policy.report_allowed) {
      await sleep(intervalSec * 1000);
      continue;
    }

    // Build payload
    const payload = buildPayloadFromEnv(node_id);

    // Fill region asynchronously (has its own cache)
    const region = await getRegion();
    payload.region = region;

    // Worker RTT
    let latMs;
    try {
      const t0 = Date.now();
      await fetch(`${baseUrl}/api/v1/health`);
      latMs = Date.now() - t0;
    } catch { /* ignore */ }
    if (latMs != null) payload.api_latency = latMs;

    // Local diff: skip if nothing changed
    if (lastPayload !== null && payloadsEqual(payload, lastPayload)) {
      // Nothing changed; skip reporting but respect server's next_interval
      const next = policy.next_interval_sec;
      await sleep((typeof next === 'number' && next > 0 ? next : intervalSec) * 1000);
      continue;
    }

    try {
      const rep = await postReport(baseUrl, node_id, node_secret, payload);
      lastPayload = payload;
      saveLastPayload(payload);
      consecutiveErrors = 0;

      const next = rep?.next_interval_sec;
      await sleep((typeof next === 'number' && next > 0 ? next : intervalSec) * 1000);
    } catch (e) {
      consecutiveErrors++;
      console.error('[clawwatch-agent] report failed:', e.message || e);
      // Exponential back-off on errors, capped at 5 minutes
      const backoffMs = Math.min(300_000, intervalSec * 1000 * Math.pow(1.5, consecutiveErrors - 1));
      await sleep(backoffMs);
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
    if (!tok) { console.error('Missing link_token argument'); process.exit(1); }
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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
