# Contributing & release

## Local build

```bash
npm install
npm run typecheck
npm run build
```

**注意**：本包**不**把 `openclaw` 放进 `devDependencies`。`openclaw` 的传递依赖里存在通过 `git+ssh` 拉取的包；在未配置 GitHub SSH 的机器上会导致 `npm install` 失败。开发与类型检查依赖 `types/openclaw-plugin-sdk.d.ts` 桩；运行时由 Gateway 提供真实 `openclaw/*` 模块。

`peerDependencies` 里仍声明 `openclaw` 以提示版本，但 **`peerDependenciesMeta.openclaw.optional: true`**，避免 npm 7+ 自动安装 peer 时再次拉取上述依赖树。

若你本机已能 `npm install openclaw`（或配置了 HTTPS 代替 SSH），可自行安装作参考，但不要求提交 `package-lock` 里锁死该树。

`prepack` runs `npm run build` so `npm pack` / registry publish includes `dist/`.

## Test inside OpenClaw (no ClawHub upload)

From this repository root:

```bash
npm run build
openclaw plugins install -l .
openclaw gateway restart
```

Enable the plugin in your OpenClaw config under `plugins.entries.clawwatch` (see README). Use `openclaw plugins list` / `openclaw plugins inspect clawwatch` to verify load.

## ClawHub dry-run

Install the [ClawHub CLI](https://docs.openclaw.ai/tools/clawhub), log in (`clawhub login`), then:

```bash
npm run build
clawhub package publish . --dry-run
```

Fix any reported issues, then publish without `--dry-run` when ready.

## Telemetry agent without Gateway

The `clawwatch-agent` CLI still works standalone (`npm install -g .` or `node src/agent.mjs`); see README.
