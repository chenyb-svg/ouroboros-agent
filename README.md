# Ouroboros — The Agent OS

CLI-native AI agent with full terminal integration. Built with TypeScript, runs on Node.js 22+.

```
    ____  _    _ _____   ____  ____   ____  _____   ____   _____
   / __ \| |  | |  __ \ / __ \|  _ \ / __ \|  __ \ / __ \ / ____|
  | |  | | |  | | |__) | |  | | |_) | |  | | |__) | |  | | (___
  | |  | | |  | |  _  /| |  | |  _ <| |  | |  _  /| |  | |\___ \
  | |__| | |__| | | \ \| |__| | |_) | |__| | | \ \| |__| |____) |
   \____/ \____/|_|  \_\\____/|____/ \____/|_|  \_\\____/|_____/
  ═══════════════════════════════════════════════════════════════
  Ouroboros v1.0 — The Agent OS
```

---

## Quick Start

```bash
# 1. 克隆仓库
git clone https://github.com/chenyb-svg/ouroboros-agent.git
cd ouroboros-agent

# 2. 一键安装
install.bat

# 3. 配置 API Key
cp .env.example .env
# 编辑 .env，填入你的 API Key（支持 DeepSeek / OpenAI / 硅基流动 等）

# 4. 启动
npx tsx src/repl.ts

# 5. (可选) 全局安装
npm link
ourob
```

**前置条件：** Node.js >= 22.0.0

---

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/memory` | Memory stats (working + long-term) |
| `/sessions` | List recent sessions (💾 = resumable) |
| `/session <id>` | Switch to another session (saves current) |
| `/resume <id>` | Resume a paused workflow `<id>` [`[feedback]`] |
| `/skills` | List installed Claude Code skills |
| `/install <name>` | Install a skill from GitHub |
| `/checkpoint` | Save a session checkpoint |
| `/switch` | Open model config web UI (switch providers/models) |
| `/tasks` | Show task tree |
| `/history` | Show command history |
| `/sandbox` | Show sandbox status |
| `/recipe` | Manage recipes: `list` · `run <trigger>` · `save <name>` · `forget <trigger>` · `new` |
| `/fork` | Fork current session |
| `/rewind` | Show checkpoints |
| `/diff` | Show git working tree diff |
| `/debug` | Show debug server status |
| `/instances` | List other running Ouroboros instances (multi-open) |
| `/send <id> <msg>` | Send a message to another instance's inbox |
| `/clear` | Clear screen |
| `/exit` | Save and exit (or `/quit`) |

> 注：`/resume <id>` 在 REPL 内恢复的是**暂停的 workflow**。恢复会话用 `/session <id>` 切换，或用 CLI 的 `ourob resume <id>`。

---

## CLI Commands

```bash
# Start interactive REPL
ourob

# Resume a saved session
ourob resume <session-id>

# List sessions (no REPL startup)
ourob sessions

# List running instances + their blackboard state (no REPL startup)
ourob instances

# Send a message to another running instance (no REPL startup)
ourob send <session-id> <message>
```

> 多开：可以在多个终端各开一个 `ourob`，共享同一工作目录互不干扰（端口自动回退，内存/历史写入加锁合并，git 自动提交带锁重试）。实例间通过黑板（`~/.ouroboros/instances/<session-id>.json`）互通状态：每个实例在开始任务时上报 `state: reasoning + currentTask`，任务结束后把**最近完成的任务与结果摘要**（`lastTask`/`lastResult`）持久化到黑板，所以其他实例即使空闲也能回答"对方刚才在做什么"；系统提示词会注入其他实例的完整会话 ID。通过 inbox（`~/.ouroboros/instances/<id>/inbox/`）互发消息。**Agent 自主对话**：提问方用 `ouroboros:ask <会话ID> <问题>` 阻塞等待回复（至多 120s，超时可重试或转问别的实例）；每个空闲实例的后台应答器会自动回答收到的 `ask`（只读工具、有界轮次、永不递归问别人），`send_message` 仍是单向留言（收件方下次提问时浮现）。可用 `config.yaml` 的 `coordination.autoReply: false` 关闭自动应答。实例名：环境变量 `OUROBOROS_INSTANCE_NAME` → `config.yaml` 的 `coordination.name` → 会话 ID 前 8 位；设备名：`OUROBOROS_DEVICE`（默认主机名）。

---

## Built-in Tools (30+)

### File Operations
| Tool | Description |
|---|---|
| `ouroboros:read` | Read a text file with offset/limit |
| `ouroboros:write` | Write content to a file atomically |
| `ouroboros:edit` | Surgical string replacement in a file |
| `ouroboros:cat` | Quick file dump (no encoding detection) |
| `ouroboros:ls` | List directory contents |
| `ouroboros:mkdir` | Create directory recursively |
| `ouroboros:rm` | Delete file/directory (with safety guards) |
| `ouroboros:find` | Find files by name pattern |
| `ouroboros:view` | Browse directory tree |

### Search
| Tool | Description |
|---|---|
| `ouroboros:search` | Search code with regex (rg > grep > Node.js fallback) |
| `ouroboros:grep` | Line-level text search |

### Network
| Tool | Description |
|---|---|
| `ouroboros:curl` | HTTP request (GET/POST/headers/body) via Node.js fetch |
| `ouroboros:webfetch` | Fetch web page + strip HTML to readable text |
| `ouroboros:websearch` | Search the web (DuckDuckGo → Bing fallback, no API key) |
| `ouroboros:github` | GitHub API (read PRs, issues) |

### Execution
| Tool | Description |
|---|---|
| `ouroboros:bash` | Execute shell commands (spawn, streaming, timeout, exit code) |
| `ouroboros:test` | Run project test suite (auto-detect framework) |
| `ouroboros:lint` | Run linter (ESLint > tsc --noEmit) |
| `ouroboros:format` | Format code (Prettier auto-detect) |
| `ouroboros:build` | Build/compile project (auto-detect tool) |

### Memory & Planning
| Tool | Description |
|---|---|
| `ouroboros:memory` | Search/recall working + long-term memory |
| `ouroboros:save_memory` | Persist important facts |
| `ouroboros:correct_memory` | Correct wrong memories |
| `ouroboros:plan_tasks` | Create structured task plan |
| `ouroboros:update_todo` | Update task status (pending → in_progress → completed) |

### Skills & Ecosystem
| Tool | Description |
|---|---|
| `ouroboros:load_skill` | Load Claude Code skill instructions |
| `ouroboros:mcp` | Bridge to MCP server tools |
| `ouroboros:notify` | Send desktop notification |
| `ouroboros:git` | Git read-only queries (status, diff, log, show) |
| `ouroboros:docker` | Docker operations (ps, logs, build) |
| `ouroboros:db` | Database query (read-only SELECT) |

### 多实例协同 (Multi-instance)
| Tool | Description |
|---|---|
| `ouroboros:ask` | Ask another running instance a question and block for its reply (≤120s) |
| `ouroboros:send_message` | Send a one-way note to another instance's inbox |
| `ouroboros:instances` | List other running instances + their state/current task |

---

## Architecture

### ReAct Engine
```
User Input → Reason (LLM streaming) → Act (Tool execution) → Review → Repeat
```

- **No hard step limit** — agent runs until task complete
- **Intelligent termination** — detects completion, empty turns, repetitive patterns
- **Streaming output** — real-time text and tool call display
- **Spinner** — visual feedback during tool execution

### Error Recovery
- **Root cause analysis** — auto-classifies 400/context/timeout errors
- **Auto strategy switch** — injects recovery prompts on repeated failure
- **Checkpoint rollback** — restores clean state on corruption
- **Failure memory** — remembers failed strategies to avoid repetition
- **Ctrl+C interrupt** — once to stop current action, twice to save and exit

### Multi-Channel (CLI + WeChat)
- **CLI REPL** — full terminal agent with slash commands
- **WeChat Work Bot** — same engine via 企业微信回调
- **Shared state** — conversation history, memory, tools shared across channels
- **Auto tunnel** — Cloudflare Tunnel auto-launch for WeChat callbacks

---

## Configuration

### Step 1: Get an API Key

Ouroboros 使用 OpenAI 兼容 API，支持几乎所有大模型供应商。选一个：

| 供应商 | 获取 API Key | 价格 | 推荐模型 |
|---|---|---|---|
| **DeepSeek** | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | 极低 | `https://api.deepseek.com` |
| **OpenAI** | [platform.openai.com](https://platform.openai.com/api-keys) | 高 | `https://api.openai.com/v1` |
| **硅基流动** | [siliconflow.cn](https://siliconflow.cn) | 低 | `https://api.siliconflow.cn/v1` |
| **阿里百炼** | [bailian.console.aliyun.com](https://bailian.console.aliyun.com) | 中 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| **智谱 GLM** | [open.bigmodel.cn](https://open.bigmodel.cn) | 中 | `https://open.bigmodel.cn/api/paas/v4` |
| **Moonshot Kimi** | [platform.moonshot.cn](https://platform.moonshot.cn) | 低 | `https://api.moonshot.cn/v1` |

> 只要是 OpenAI 兼容的 API（`/v1/chat/completions` 端点）都能用。

### Step 2: 创建 .env 文件

```bash
cp .env.example .env
```

编辑 `.env`，填入你的 API Key：

```bash
# 必填：至少配一个 LLM 供应商
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx

# 如果用 OpenAI
# OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
```

### Step 3: 配置模型供应商

编辑 `.ouroboros/config.yaml` 的 `providers` 部分。

**用 DeepSeek（默认）：**
```yaml
providers:
  - name: deepseek
    type: openai
    apiKey: ${DEEPSEEK_API_KEY}
    baseUrl: https://api.deepseek.com
    models:
      - deepseek-v4-pro       # 复杂推理
      - deepseek-v4-flash     # 快速执行
```

**用 OpenAI：**
```yaml
providers:
  - name: openai
    type: openai
    apiKey: ${OPENAI_API_KEY}
    baseUrl: https://api.openai.com/v1
    models:
      - gpt-4o
      - gpt-4o-mini

modelOverrides:
  "builtin:coordinator":
    provider: openai
    model: gpt-4o
  "Worker":
    provider: openai
    model: gpt-4o-mini
```

**用硅基流动（国内便宜）：**
```yaml
providers:
  - name: siliconflow
    type: openai
    apiKey: ${SILICONFLOW_API_KEY}
    baseUrl: https://api.siliconflow.cn/v1
    models:
      - deepseek-ai/DeepSeek-V4-Pro
      - Qwen/Qwen3.5-Plus
```

**多供应商混用：**
```yaml
providers:
  - name: deepseek
    type: openai
    apiKey: ${DEEPSEEK_API_KEY}
    baseUrl: https://api.deepseek.com
    models:
      - deepseek-v4-pro
  - name: openai
    type: openai
    apiKey: ${OPENAI_API_KEY}
    baseUrl: https://api.openai.com/v1
    models:
      - gpt-4o

# Coordinator 用最强的，Worker 用最快的
modelOverrides:
  "builtin:coordinator":
    provider: openai
    model: gpt-4o
  "Worker":
    provider: deepseek
    model: deepseek-v4-flash
```

### 模型角色说明

| 角色 | 用途 | 推荐模型 |
|---|---|---|
| **Coordinator** | 主推理引擎，复杂规划 | 最强模型 (gpt-4o / deepseek-v4-pro) |
| **Worker** | 工具执行 | 快速模型 (gpt-4o-mini / deepseek-v4-flash) |
| **Specialist** | 专业技能 | 中等模型 |

---

## Session Persistence

Every session is auto-saved to `~/.ouroboros/sessions/<session-id>/`:

- `meta.json` — session metadata (timestamp, model, config)
- `session-state.json` — conversation history, memories, agent state
- `transcript.jsonl` — full event log

Resume with: `ourob resume <session-id>` (CLI) or `/session <id>` (inside REPL). `transcript.jsonl` 是完整事件日志，即使没有 `session-state.json` 也可通过 CLI 回放恢复。

---

## Memory System

Three-tier JSONL-backed memory:
- **Working memory** — in-progress facts, auto-cleaned
- **Long-term memory** — persisted important facts
- **Failure patterns** — auto-saved to avoid repeating bad strategies

Memory supports Chinese via bigram tokenization and confidence-weighted scoring.

---

## Skills

Claude Code-compatible skill ecosystem. Install skills from GitHub:

```
/install <skill-name>
```

Skills are loaded via `ouroboros:load_skill` tool. SKILL.md frontmatter is parsed for tools, instructions, and capabilities.

---

## Recipes — 自动化工作流（自动学习）

Recipes 是可复用的多步骤工作流。三个自动学习阶段：

| 阶段 | 触发时机 | 行为 |
|---|---|---|
| **P1 手动保存** | `/recipe save <name>` | 从本次执行轨迹生成 YAML，存入 `.ouroboros/skills/workflows/` |
| **P2 回合自动学习** | 每轮结束后 | 检测到重复的多工具模式，自动保存为 recipe（用户无需手动 `/recipe save`） |
| **P3 会话级学习** | `/exit` 退出时 | LLM 总结整个会话，提取可复用工作流，去重后保存/更新 |

- 自动学习的 recipe 带 `# auto-learned by ouroboros` 标记
- **手动维护的 recipe 永远不会被自动覆盖**
- 新版本更简单会更新旧的（复杂度 = 步骤数 + 工具数）；更复杂则跳过
- 名称高度相似（jaccard ≥ 0.6 且 ≥ 4 个 token）会按重复跳过

管理：`/recipe list` · `/recipe run <trigger>` · `/recipe forget <trigger>` · `/recipe new`

---

## WeChat Work Integration

1. Configure `.env` with WeChat credentials
2. Start `ourob` — WeChat server auto-launches on port 9878
3. Cloudflare Tunnel auto-creates public URL
4. Configure callback URL in 企业微信后台 → 应用管理 → 自建应用

Messages from WeChat go through the same ReAct engine as CLI input.

---

## Requirements

- Node.js 22+
- TypeScript 5.7+
- DeepSeek API key

---

## License

MIT
