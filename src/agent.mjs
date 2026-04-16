#!/usr/bin/env node
/**
 * ClawWatch node agent — setup / bind (link_token) / adaptive run loop.
 * Uses the same HMAC rules as ClawWatchServer README: sign the exact JSON body bytes.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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
    extra = {
      status: 'online',
      cpu_load: 0,
      mem_usage: 0,
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

    const payload = buildPayloadFromEnv(node_id);
    const body = JSON.stringify(payload);
    const hash = sha256Hex(body);
    const now = Date.now();
    if (hash === lastHash && now - lastSentAt < dedupeWindowMs) {
      await sleep(intervalSec * 1000);
      continue;
    }

    try {
      const rep = await postReport(baseUrl, node_id, node_secret, payload);
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
