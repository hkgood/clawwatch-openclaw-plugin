# clawwatch-openclaw-plugin

在运行 **OpenClaw** 的机器上安装的 **独立** Node 插件：向 [ClawWatch](https://github.com/hkgood/ClawWatchServer) Worker 上报遥测（`agent/setup`、`agent/claim`、`agent/report_policy`、`agent/report`，HMAC 与官方 README 一致）。

本仓库与 [ClawWatchServer](https://github.com/hkgood/ClawWatchServer)、[ClawWatchiOS](https://github.com/hkgood/ClawWatchiOS) **分开维护**；请在本仓库提 Issue / PR。

## 安装（供 OpenClaw 集成）

1. 克隆或作为子模块放到你的 OpenClaw 插件/扩展目录（具体目录名以 OpenClaw 文档为准）：

   ```bash
   git clone https://github.com/hkgood/clawwatch-openclaw-plugin.git
   cd clawwatch-openclaw-plugin
   ```

2. 全局或局部安装 CLI（便于 PATH 里直接 `clawwatch-agent`）：

   ```bash
   npm install -g .
   # 或: npm link
   ```

3. 在 OpenClaw 侧将 `clawwatch-agent` 挂到子命令、包装脚本或 **LaunchAgent / systemd**（推荐对 `run` 保活）。OpenClaw 若提供「外部插件注册」入口，请指向本包 `bin` 字段对应的 `src/agent.mjs`。

## 使用流程

**Worker 根地址**（无尾部斜杠）：

- 参数：`--base https://你的-worker.workers.dev`
- 或环境变量：`CLAWWATCH_BASE_URL`

### 1. 首次登记节点

```bash
clawwatch-agent setup --base https://你的-worker.workers.dev
# 或: node src/agent.mjs setup --base ...
```

凭据写入 `~/.clawwatch/agent.json`（可用 `CLAWWATCH_STATE` 覆盖路径）。

### 2. 与手机账号绑定

在 ClawWatch App 里生成 **link token**，在节点执行：

```bash
clawwatch-agent bind --base https://你的-worker.workers.dev "<paste_token>"
```

### 3. 常驻上报

```bash
clawwatch-agent run --base https://你的-worker.workers.dev
```

未绑定前 Worker 会拒绝 `report`，进程会以 `report_policy` 为主循环等待绑定。

### 可选：自定义快照字段

环境变量 `CLAWWATCH_PAYLOAD_JSON`：JSON 对象，**不要**包含 `node_id`（会自动注入）。用于接入 OpenClaw 采集到的指标。

```bash
export CLAWWATCH_PAYLOAD_JSON='{"status":"online","cpu_load":12.5,"mem_usage":8192}'
```

## API 说明

与 ClawWatch Worker 契约见 Server 仓库：[README — HMAC](https://github.com/hkgood/ClawWatchServer/blob/main/README.md) 与架构文档。

## 开发

```bash
node src/agent.mjs --help 2>&1 || true
# 子命令: setup | bind | run
```
