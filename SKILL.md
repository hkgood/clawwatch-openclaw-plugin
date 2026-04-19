---
name: clawwatch
description: ClawWatch node telemetry agent for OpenClaw. Reports system metrics (CPU, memory, disk, GPU) and token usage to the ClawWatch Worker. Includes a Gateway background service for adaptive reporting (60s active / 3600s idle). Use when a user wants to monitor their OpenClaw node via the ClawWatch iOS/watchOS app.
metadata:
  {
    "openclaw":
      {
        "emoji": "⌚",
        "os": ["darwin", "linux"],
        "requires": { "Bun": [], "node": [] },
        "install":
          [
            {
              "id": "openclaw-plugin",
              "kind": "openclaw-plugin",
              "label": "Install ClawWatch plugin",
            },
          ],
      },
  }
---

# ClawWatch

OpenClaw 插件，向 ClawWatch Server 上报节点遥测数据。

## 功能

- 上报今日 token 用量、输入/输出 token
- 上报任务请求数、失败数
- 上报 token 速度、活跃会话数
- 上报系统指标（CPU、内存、磁盘、运行时间等）
- 自适应上报间隔：有前台查看时 60 秒，无前台时 3600 秒

## 使用

安装后自动启动上报服务，无需额外配置。

```bash
openclaw plugins install -l ~/.openclaw/extensions/clawwatch
```

然后重启 Gateway：
```bash
openclaw gateway restart
```

## 前提条件

- OpenClaw Gateway
- ClawWatch Worker 部署在 https://cw.osglab.win

## Node CLI

插件也包含独立的 CLI，可在非 Gateway 环境下使用：

```bash
clawwatch-agent setup --base https://cw.osglab.win
clawwatch-agent bind --base https://cw.osglab.win <link_token>
clawwatch-agent run --base https://cw.osglab.win
```
