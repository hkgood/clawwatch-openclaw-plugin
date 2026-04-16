# clawwatch-openclaw-plugin

本仓库提供两部分能力：

1. **Native OpenClaw 插件**（`openclaw.plugin.json` + `dist/index.js`）：在 Gateway 内注册后台 **Service**，按配置拉起 `clawwatch-agent run`（自适应上报）。
2. **独立 CLI `clawwatch-agent`**（`src/agent.mjs`）：可在任意 Node 环境执行 `setup` / `bind` / `run`，向 [ClawWatch Worker](https://github.com/hkgood/ClawWatchServer) 上报遥测；HMAC 与 [ClawWatchServer README](https://github.com/hkgood/ClawWatchServer/blob/main/README.md) 一致。

与 [ClawWatchServer](https://github.com/hkgood/ClawWatchServer)、[ClawWatchiOS](https://github.com/hkgood/ClawWatchiOS) **分仓维护**；Issue / PR 请在本仓库提交。

---

## OpenClaw 用户：安装与配置

- **兼容**：本包 `package.json` 中 `openclaw.compat` / `openclaw.build` 以 **OpenClaw 2026.4.14** 为基线；请使用相同或更新且满足 `pluginApi` 的 Gateway（详见 [Building Plugins](https://docs.openclaw.ai/plugins/building-plugins)）。
- **Node**：开发与作为插件安装的环境需 **Node ≥ 22**（`engines.node`）。仅运行已编译 CLI 的极简场景仍可用 Node 18+ 直接执行 `node src/agent.mjs`，但 `npm install` 本包会按 engines 校验。

安装示例（任选其一）：

```bash
# 自 ClawHub（发布后）
openclaw plugins install clawhub:clawwatch-openclaw-plugin

# 或本地路径开发（不拷贝）
openclaw plugins install -l /path/to/clawwatch-openclaw-plugin
```

在 OpenClaw 配置中为插件 `clawwatch`（与 `openclaw.plugin.json` 的 `id` 一致）提供 **必填** `worker_base_url`（示例为 JSON5，请按你实际配置文件格式书写）：

```json5
{
  plugins: {
    enabled: true,
    entries: {
      clawwatch: {
        enabled: true,
        config: {
          worker_base_url: "https://你的-worker.workers.dev",
          // state_path: "/optional/custom/agent.json",
        },
      },
    },
  },
}
```

修改配置后执行 **`openclaw gateway restart`**（或依赖你当前的 config watch 行为）。后台服务会在启动时 `spawn` 本包内的 `src/agent.mjs run --base <worker_base_url>`，并把 `state_path` 映射为环境变量 `CLAWWATCH_STATE`（若设置）。

**说明**：`setup` / `bind` 仍建议通过 **`clawwatch-agent` CLI**（全局安装或 `npx` / `node src/agent.mjs`）在节点上执行一次；Gateway Service 主要负责 **已登记且绑定后** 的常驻 `run` 循环。

---

## 前置条件

| 项目 | 要求 |
|------|------|
| **Node.js** | **≥ 22**（安装本 npm 包 / 作为 OpenClaw 插件开发时）；裸跑 `node src/agent.mjs` 可仍用 18+ |
| **ClawWatch Worker** | 已部署并可访问的根地址（无尾部 `/`） |
| **ClawWatch 账号与 App** | 生成 **link token** 或（旧流程）扫码绑定码完成绑定 |

---

## 获取代码（私有仓库）

若本仓库为 **GitHub Private**，克隆时需已登录 GitHub：

- **HTTPS（推荐配合 gh 或凭据管理器）**  
  ```bash
  gh auth login   # 若尚未登录
  git clone https://github.com/hkgood/clawwatch-openclaw-plugin.git
  ```
  或使用 [Personal Access Token](https://github.com/settings/tokens) 作为密码（需 `repo` 权限）。

- **SSH**  
  ```bash
  git clone git@github.com:hkgood/clawwatch-openclaw-plugin.git
  ```
  需本机已配置 [SSH key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh) 并添加到 GitHub。

```bash
cd clawwatch-openclaw-plugin
```

---

## 安装指南

### 1. 安装依赖（开发/本地运行）

```bash
npm install
```

本包无第三方运行时依赖，安装步骤主要用于校验 `package.json` 与后续 `npm link` / `npm install -g`。

### 2. 将 CLI 加入 PATH

任选其一：

**全局安装（推荐在生产节点）**

```bash
npm install -g .
```

完成后应能直接执行：

```bash
clawwatch-agent setup --base https://你的-worker.workers.dev
```

**仅当前仓库可执行（开发调试）**

```bash
npm link
# 或不用 link，始终使用：
node src/agent.mjs setup --base https://你的-worker.workers.dev
```

### 3. 验证安装

```bash
which clawwatch-agent   # 若使用全局安装
node src/agent.mjs      # 无参数时应打印 Usage 并以非零退出（预期行为）
```

预期 Usage 提示：

```text
Usage: clawwatch-agent <setup|bind|run> --base <workerOrigin> [link_token]
```

### 4. 与 OpenClaw 集成（无 Gateway / 仅进程保活）

若不使用上述 Native 插件 Service，仍可：

1. 将仓库放到任意路径，`npm install -g .` 或 `npm link`；
2. 用 **LaunchAgent**（macOS）或 **systemd**（Linux）对 `clawwatch-agent run --base …` **保活**。

---

## 发布到 ClawHub（维护者）

1. 安装 CLI：`npm i -g clawhub`，并 `clawhub login`。  
2. 在本仓库执行 `npm run build`，再 **`clawhub package publish . --dry-run`**，确认无报错后去掉 `--dry-run` 正式发布。  
3. 详见官方 [ClawHub](https://docs.openclaw.ai/tools/clawhub) 与仓库内 [CONTRIBUTING.md](./CONTRIBUTING.md)。

**凭据安全**：`setup` 写入的 `~/.clawwatch/agent.json`（或 `CLAWWATCH_STATE`）含节点密钥；勿提交到 Git；本包在写入后会尝试 `chmod 600`（POSIX）。

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `CLAWWATCH_BASE_URL` | Worker 根地址；与 `--base` 二选一（不要尾部 `/`） |
| `CLAWWATCH_STATE` | 凭据文件路径；默认 `~/.clawwatch/agent.json` |
| `CLAWWATCH_PAYLOAD_JSON` | JSON **对象**，自定义上报字段；**不要**包含 `node_id`（会自动注入）。未设置时使用内置默认占位字段 |

---

## 使用流程

### 1. 首次登记节点（`setup`）

```bash
clawwatch-agent setup --base https://你的-worker.workers.dev
# 或: node src/agent.mjs setup --base ...
```

凭据写入 `~/.clawwatch/agent.json`（或由 `CLAWWATCH_STATE` 指定）。

### 2. 与手机账号绑定（`bind`）

在 ClawWatch App 中生成 **link token**，在节点执行：

```bash
clawwatch-agent bind --base https://你的-worker.workers.dev "<粘贴的_token>"
```

### 3. 常驻上报（`run`）

```bash
clawwatch-agent run --base https://你的-worker.workers.dev
```

未绑定前 Worker 会拒绝 `report`；进程会以 `report_policy` 为主循环等待绑定。

### 自定义快照示例

```bash
export CLAWWATCH_PAYLOAD_JSON='{"status":"online","cpu_load":12.5,"mem_usage":8192}'
clawwatch-agent run --base https://你的-worker.workers.dev
```

---

## API 与契约

与 ClawWatch Worker 的 HMAC、路径约定见 Server 仓库：[ClawWatchServer README](https://github.com/hkgood/ClawWatchServer/blob/main/README.md)。

---

## 故障排查

| 现象 | 处理 |
|------|------|
| `Missing --base` | 传入 `--base <URL>` 或设置 `CLAWWATCH_BASE_URL` |
| `Invalid state file; run setup first` | 先执行 `setup`，再 `bind` / `run` |
| `report` / `claim` 返回 4xx | 检查 Worker 地址、是否已 `bind`、link token 是否过期 |
| 私有仓库 `git clone` 失败 | 使用 `gh auth login`、SSH key 或带 `repo` 权限的 PAT |

---

## 开发

```bash
npm install
npm run typecheck
npm run build
node src/agent.mjs
# 子命令: setup | bind | run
```

本仓库**不把 `openclaw` 写入 devDependencies**：其依赖树会通过 `git@github.com:...` 拉私有/特殊仓库，在未配置 SSH 时会导致 `npm install` 失败。插件在 **Gateway 进程内**加载时由 OpenClaw 提供真实模块；本地编译使用 `types/openclaw-plugin-sdk.d.ts` 类型桩。

## 许可证

MIT
