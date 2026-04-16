import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pluginManifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'openclaw.plugin.json'), 'utf8'),
) as { configSchema: Record<string, unknown> };

type ClawWatchPluginConfig = {
  worker_base_url?: string;
  state_path?: string;
};

function resolveAgentScript(rootDir: string | undefined): string {
  const root = rootDir ?? path.join(__dirname, '..');
  return path.join(root, 'src', 'agent.mjs');
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/$/, '');
}

/** Single child process for adaptive `run` loop (Gateway service). */
let runChild: ChildProcess | null = null;

export default definePluginEntry({
  id: 'clawwatch',
  name: 'ClawWatch',
  description: 'ClawWatch Worker telemetry agent (CLI + optional Gateway reporting service).',
  configSchema: pluginManifest.configSchema,
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as ClawWatchPluginConfig;
    const baseRaw = typeof cfg.worker_base_url === 'string' ? cfg.worker_base_url : '';
    const base = baseRaw ? normalizeBase(baseRaw) : '';

    api.registerService({
      id: `${api.id}.telemetry-agent`,
      async start(ctx) {
        if (!base) {
          ctx.logger.warn(
            '[clawwatch] Missing worker_base_url in plugin config; reporting service not started. Set plugins.entries.clawwatch.config.worker_base_url.',
          );
          return;
        }

        if (runChild && !runChild.killed) {
          ctx.logger.warn('[clawwatch] Reporting service already running; skipping duplicate start.');
          return;
        }

        const agentScript = resolveAgentScript(api.rootDir);
        const env: NodeJS.ProcessEnv = { ...process.env };
        env.CLAWWATCH_BASE_URL = base;
        if (typeof cfg.state_path === 'string' && cfg.state_path.trim()) {
          env.CLAWWATCH_STATE = cfg.state_path.trim();
        }

        try {
          runChild = spawn(process.execPath, [agentScript, 'run', '--base', base], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
          });
        } catch (e) {
          ctx.logger.error(`[clawwatch] Failed to spawn agent: ${String(e)}`);
          runChild = null;
          return;
        }

        const log = (line: Buffer, stream: 'stdout' | 'stderr') => {
          const t = line.toString('utf8').trimEnd();
          if (!t) return;
          if (stream === 'stderr') ctx.logger.warn(`[clawwatch-agent] ${t}`);
          else ctx.logger.info(`[clawwatch-agent] ${t}`);
        };

        runChild.stdout?.on('data', (chunk: Buffer) => log(chunk, 'stdout'));
        runChild.stderr?.on('data', (chunk: Buffer) => log(chunk, 'stderr'));
        runChild.on('exit', (code, signal) => {
          ctx.logger.info(`[clawwatch] clawwatch-agent exited (code=${code}, signal=${signal ?? 'none'})`);
          runChild = null;
        });
        runChild.on('error', (err) => {
          ctx.logger.error(`[clawwatch] clawwatch-agent process error: ${String(err)}`);
          runChild = null;
        });

        ctx.logger.info('[clawwatch] Started clawwatch-agent run (background service).');
      },
      async stop(ctx) {
        if (!runChild || runChild.killed) {
          runChild = null;
          return;
        }
        runChild.kill('SIGTERM');
        const proc = runChild;
        runChild = null;
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
            resolve();
          }, 8000);
          proc.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
        ctx.logger.info('[clawwatch] Stopped clawwatch-agent reporting service.');
      },
    });
  },
});
