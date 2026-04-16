# clawwatch-openclaw-plugin

在运行 **OpenClaw**（或任意可执行本 CLI 的环境）的机器上安装的 **独立** Node 插件：向 [ClawWatch Worker](https://github.com/hkgood/ClawWatchServer) 上报遥测，调用 `agent/setup`、`agent/claim`、`agent/report_policy`、`agent/report`，请求体 HMAC 规则与 ClawWatchServer 官方 README 一致。

本仓库与 [ClawWatchServer](https://github.com/hkgood/ClawWatchServer)、[ClawWatchiOS](https://github.com/hkgood/ClawWatchiOS) **分开维护**；问题与改进请在本仓库提 Issue / PR。

---

## 前置条件

| 项目 | 要求 |
|------|------|
| **Node.js** | **18+**（推荐当前 LTS；本包 `engines.node` 为 `>=18`） |
| **ClawWatch Worker** | 已部署并可访问的根地址，例如 `https://你的-worker.workers.dev`（无尾部斜杠） |
| **ClawWatch 账号与 App** | 用于生成 **link token** 完成节点绑定 |

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

### 4. 与 OpenClaw 集成（说明）

OpenClaw 的插件目录名以 **OpenClaw 官方文档** 为准。常见做法是：

1. 将本仓库克隆或 **git submodule** 放到 OpenClaw 指定的扩展目录；
2. 用 **LaunchAgent**（macOS）或 **systemd**（Linux）对 `clawwatch-agent run` **保活**；
3. 若 OpenClaw 提供「外部命令注册」，将入口指向 `package.json` 中 `bin` 所对应的 `./src/agent.mjs`。

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
node src/agent.mjs
# 子命令: setup | bind | run
```

## 许可证

MIT
