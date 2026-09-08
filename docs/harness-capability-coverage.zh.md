# DeepSeek Harness 能力在 dshline 中的采纳状况

[English](harness-capability-coverage.md) | 中文

一份以源码为依据的 DeepSeek Harness 能力普查，逐项衡量 dshline——一个终端原生的 Harness 前端——对每项能力的采纳完整程度。它是 dshline 能力工作的决策台账：每个分类都标注上游权威与 dshline 证据，每个缺口都附有决策。

## 摘要

**基线。** dshline 采纳的 Harness 生代是 **`0.1.2-rc.1`**，切自上游修订 `a66e4702047846cdaa10c66c9d3df3951f5ea70d`（tag `dsh-v0.1.2-rc.1`，发布于 2026-09-03）。这也是 npm `latest` dist-tag 所服务的版本，因此 dshline 当前发布不受阻塞。写作时点最新已发布的生代是 **`0.1.3-alpha.2`**，修订 `82a5fd61a7cf5c293cec4bdff68f455398d685e9`（tag `dsh-v0.1.3-alpha.2`，发布于 2026-09-07），在 npm 上仅经 `alpha` dist-tag 提供。未发布的 `master` 行为一律标注 `UNRELEASED`，绝不计为已提供的能力。工作分支为 `main`，干净，无进行中的迁移。

**普查规模。** 共考察十个领域的 101 项能力条目。写作时点的分类计数：

| 分类 | 条目 |
| --- | --- |
| FULL | 63 |
| PARTIAL | 6 |
| NONE | 6 |
| INTENTIONAL-NONE | 10 |
| BLOCKED | 5 |
| N/A | 8 |
| PENDING-HARNESS-ADOPTION | 2 |
| EXCLUDED | 1 |

计数不是支持率评分。各能力的产品相关性差异巨大，而 FULL 之外最大的类别是"刻意不做"——那是架构的成功，不是欠缺。

**覆盖最强的领域。** 会话语料库及其查询面的终端呈现（列表、过滤、全文搜索、谱系、标题、重命名、统计）；基于 `ctx.jobs` / `ctx.subagents` / `workflow` 事件的 Work 适配器及其精确的控制策略；经四条 Connect seam（`ctx.llm`、`ctx.settings`、`ctx.credentials`、`ctx.authorization`）的提供方配置；经工具呈现约定的工具卡片渲染；经 projection 的 agent 模式（plan、goals、todos）；以及经计量器 projection 的 compaction、token 计量与上下文占用。

**最重要的部分采纳缺口。** `ask_user_question` 的答案被无声降级：`multiSelect` 标志被忽略，`custom` 自由文本答案从不产生（`packages/dshline/src/questions.ts`、`src/select.ts`）。会话内搜索命中只透露摘要与元数据，而 `readEvent()` 明明发布了窗口化读取，却无法打开该事件的上下文。命令注册表的 `input.hint` 参数提示从不渲染。

**最重要的"未支持但可实现"缺口。** 上述三项在采纳生代上即可实现。为 `settings`、`credentials`、`llm` seam 增补能力探针亦可实现——它们的证据目前散落在探针表之外的 Connect 测试里。

**主要的刻意不采纳决策。** 不暴露 `ctx.jobs.kill()`（面向模型的 reported 送达语义）；不做 workflow 运行控制（引擎只发布 `start()`）；不打断一次性 subagent（归持有者所有）；不做会话归档（上游为单向，且非语料事实）；不做跨进程存活声明（无所有权约定）；不做 MCP 状态面（不存在公开的注册表约定）；`ctx.credentials` 之外不接触提供方 HTTP 或密钥；任何地方都不建第二套持久化、projection 或计价权威。

**主要上游阻塞。** skill 手势就绪 seam（组合是否挂载了 `dsh-tool-skill`）；对称的会话归档生命周期；独立于传输层的人类队列控制 seam（本文排除）；MCP 连接状态约定；运行时 Harness 版本服务。

**等待 Harness 采纳。** dshline 钉在 `0.1.2-rc.1`；`0.1.3-alpha.2` 移除了 `assistant/chunk` 事件，代之以 `agent/assistant-stream` 帧加持久的 `assistant/attempt` 记录——dshline 的流式层无法对其编译——并新增了通用文件附件、附件感知的命令输入（`input.attachments`）与基于 handle 的会话持久化 API。本次活动实现的缺口无一需要该迁移，因此刻意不移动 `HARNESS_TARGET`；采纳跟随正常的 `harness-sync` 拉取请求。

## 方法与定义

**什么算一项 Harness 能力。** Harness 通过公开约定发布的行为：插件上下文上的服务（`ctx.*`）、作用域事件或 waterfall、持久的 `SessionEventMap` 记录、会话 projection 单元、命令或工具注册表条目、settings/credential schema seam。一项能力以所属包的 `package.json` `exports` 与 `src/index.ts` 为准确立——从不依据文件名、私有模块或渲染输出推断。

**什么算 dshline 的采纳。** dshline 在其终端前端呈现或作用于该约定，处理了约定定义的生命周期与失败状态，持久约定的重放语义正确，且能力缺席时诚实降级。FULL 不要求复刻 Web 客户端的手势——只要求属于终端原生前端的那一部分。

**提供方无关。** 提供方特有的事实（线上协议字段、OAuth 方言、上传 API）不是通用能力。dshline 策展某一适配器族字段之处（`connect/pi-ai.ts` 对应 `llm-pi-ai`），本研究显式标注边界；真实提供方是验收证据，绝不是把提供方名字写进生产决策逻辑的理由。

**终端相关性。** 终端无法有意义呈现的能力——HTTP 路由、浏览器视图注册表、Web RPC 面——分类为 N/A，而非缺口。终端相关性正是 FULL 与 N/A 的分界，并以 dshline 的有界活动区域与已提交的原生滚动缓冲区为准绳。

**公开约定与实现细节。** 导出与上下文合并是公开的；文件布局、监听器注册、内存映射、settings.yaml 惯例不是。dshline 自身记录了基于惯例的连接之处（pi-ai 的 `recordKeyFor` 身份），本研究注明该连接是"有文档的惯例"，而非 Harness 约定。

**生代如何比较。** 两个已发布 tag 分别检出为只读 git worktree，逐包对比其导出面；npm dist-tag 经查询确认发布状态。分类以*采纳*生成为准，除非某行另有说明；仅最新发布生代独有的事实记为 PENDING-HARNESS-ADOPTION，未发布 `master` 的事实标注 `UNRELEASED` 并排除在一切决策之外。

**研究方法。** 十个独立的只读领域扫描（sessions/query、agent 生命周期/模式、work/委派、LLM/settings/credentials、tools/commands/skills、permissions/questions、attachments/context/usage、platform/composition、上游发布增量，以及一张 dshline 采纳地图）由主 agent 综合归一；下方每个重要论断都对照所属源码核验。上游文件引用给出其所在 tag 下的路径；dshline 引用给出仓库路径。

## 能力矩阵

`权威` 一栏给出上游包及其公开符号。`证据` 一栏给出 dshline 生产文件（除注明外位于 `packages/dshline/src/`）与测试。论断起关键作用的上游路径附精确 tag 链接。

### Agent 生命周期与执行

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent 创建/恢复/销毁 | 0.1.2-rc.1 | `ctx.agents`（`AgentRegistry`、`AgentHandle`） | 核心 | FULL | `sessions/reopen.ts`、`resume.ts` | — | — |
| Agent 状态（`agent/status`，idle/running） | 0.1.2-rc.1 | `AgentStatus` | 核心 | FULL | `attachment.ts`、`work/activity.ts`、状态栏 | — | — |
| 带 user 原因的取消 | 0.1.2-rc.1 | `Agent.cancel(cause)` | 核心 | FULL | `attachment.ts`（ctrl-c）、`window.ts` 前奏 | — | — |
| Agent 生命周期事件 | 0.1.2-rc.1 | `agent/created`、`agent/disposed` | 核心 | FULL | `work/index.ts`、`work/activity.ts` | — | — |
| 实时助手流式输出（`assistant/chunk`） | 0.1.2-rc.1；0.1.3 移除 | `SessionEventMap` | 核心 | FULL（采纳生代） | `stream.ts`、`attachment.ts`、`resume.ts`、`work/activity.ts` | 0.1.3 以 `agent/assistant-stream` + `assistant/attempt` 取代；dshline 无法对其编译 | 随下次 `harness-sync` 采纳迁移（PENDING-HARNESS-ADOPTION） |
| 失败尝试与重试 | 0.1.2-rc.1 | `agent/request-error` waterfall；`turn/end` 原因 `error` | 核心 | FULL | `transcript.ts` 错误行；无重试策略 UI（归 harness 所有） | 0.1.3 `assistant/attempt` 记录为 PENDING-HARNESS-ADOPTION | — |
| Turn/step 生命周期 | 0.1.2-rc.1 | `turn/start`、`turn/end`、`step/start`、`step/end` | 核心 | FULL | `timing.ts`、`activity.ts`、`work/activity.ts` | — | — |
| `whenIdle` / `runMaintenance` | 0.1.2-rc.1 | `Agent.whenIdle`、`Agent.runMaintenance` | 低 | N/A | —（仅测试桩） | 宿主驱动方关切；前端无功能需要它 | 无需工作 |
| 输入投递动词（followup/steer） | 0.1.2-rc.1 | `Agent.followup`、`Agent.steer`、inbox 事件 | 核心 | FULL | `steering.ts`、`enter.ts`、`views.ts` 状态计数 | 队列*控制*为 EXCLUDED（另行活动） | — |
| 每会话模型切换 | 0.1.2-rc.1 | `ModelSelectionRef`、`installModelSelection` | 核心 | FULL | `model.ts`、`window.ts` | — | — |
| 推理努力程度 | 0.1.2-rc.1 | `ctx.llm.resolveCallConfig`、`LlmModelReasoningInfo` | 核心 | FULL | `reasoning.ts` | — | — |
| 持久默认模型 | 0.1.2-rc.1 | `ctx.agentDefaultModel` | 核心 | FULL | `selection.ts` | — | — |

### Agent 模式与结构化状态

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Plan 模式 | 0.1.2-rc.1 | `plan/mode` 事件；`PlanModeController` | 核心 | FULL | `modes.ts` 日志折叠、`plan-review.ts`、`questions.ts` | 写入留在 `/plan` 与 `exit_plan_mode` | — |
| Goals（持久域 + 激活） | 0.1.2-rc.1 | `goal` projection；`ctx.goals.get().activation` | 核心 | FULL | `goals/model.ts`、`attachment.ts`、状态栏 | 变更留在 `/goal` 命令与 goal 工具 | — |
| Goal 自动轮次驱动 | 0.1.2-rc.1 | `goal-round-driver` | N/A | N/A | — | harness 内部自动化；dshline 渲染其产生的轮次 | 无需工作 |
| Todos | 0.1.2-rc.1 | `todos` projection；`todo_write` 工具 | 核心 | FULL | `todos/model.ts`、`todos/overlay.ts` | 写入按设计由模型驱动 | — |
| Agent 预设 | 0.1.2-rc.1 | `ctx.agentPresets`（名册、mount、select） | 核心 | FULL | `plugins/*`、`window.ts`、`sessions/reopen.ts` | — | — |

### 会话、查询与持久化

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 会话语料列表 + 折叠标题 | 0.1.2-rc.1 | `ctx.sessionQuery.listSessions`、`readTitleSnapshots` | 核心 | FULL | `sessions/catalog.ts`、`sessions/filters.ts` | — | — |
| 恢复 / 新建 / 原地重开 | 0.1.2-rc.1 | `ctx.agents.resume` / `.create` | 核心 | FULL | `resume.ts`、`sessions/reopen.ts`、`session-scope.ts` | — | — |
| Fork 谱系 | 0.1.2-rc.1 | `traceSession` | 核心 | FULL | `sessions/lineage.ts`、`sessions/lineage-overlay.ts` | — | — |
| 全量日志读取 | 0.1.2-rc.1 | `readSession`、`listEvents` | 核心 | FULL | `resume.ts`、`sessions/panels.ts` | — | — |
| 语料全文搜索 | 0.1.2-rc.1 | `searchSessions`（可选能力） | 核心 | FULL | `sessions/catalog.ts`（`SESSION_QUERY_SEARCH_DISABLED` 降级） | — | — |
| 会话内事件搜索 | 0.1.2-rc.1 | `searchEvents` | 核心 | FULL | `sessions/catalog.ts`、`sessions/panels.ts` | — | — |
| 事件上下文读取（`readEvent` 窗口） | 0.1.2-rc.1 | `SessionQueryEngine.readEvent` | 核心 | NONE | `sessions/panels.ts` 只显示摘要 + `type · seq · time` | 命中周边事件可经已发布的窗口化 API 读取 | **实现（P1）** |
| `observeSession` / `readSurface` / `filterEvents` / `traceEvent` | 0.1.2-rc.1 | `SessionQueryEngine` | 低 | NONE | — | 当前没有界面需要它们；活动会话经 `session/event` 到达 | 无需工作；检查器需要时再议 |
| 会话重命名 | 0.1.2-rc.1 | `ctx.sessionTitle.rename`（user 权威） | 核心 | FULL | `sessions/index.ts`、`attachment.ts` | 已关闭的持久会话：该服务只持活动对象——是上游形态，不是 dshline 缺口 | 上游阻塞（已注明） |
| 会话归档 / 删除 | 0.1.2-rc.1 | `ctx.workspaceRegistry.archiveSession` | 核心 | BLOCKED | `ROADMAP.md` "Sessions is not archive-aware" | 归档单向、无取消归档、且非 `sessionQuery` 语料事实；从唯一能恢复会话的界面提供不可逆隐藏是错的 | 等待对称的上游生命周期 |
| 跨进程会话所有权 / 存活 | 0.1.2-rc.1 | —（未发布任何约定） | 核心 | BLOCKED | `sessions/catalog.ts` 头注；`ROADMAP.md` 当前限制 | 不存在 lease、pid 属主或心跳约定；dshline 记录在案而非发明 | 需要上游约定 |
| 会话统计 | 0.1.2-rc.1 | `sessionStats` projection（dsh-session-stats） | 核心 | FULL | `performance.ts`、`usage.ts`；探针 `tests/capability/session-stats.probe.spec.ts` | — | — |
| 全日志轮次大纲（`turnOutline`） | 0.1.2-rc.1 | `turnOutline` projection 单元（dsh-session-turn-outline） | 低 | NONE | — | 没有 dshline 界面需要轮次大纲；文本记录本身就是大纲 | 无需工作；待办注记 |
| 持久化 / 存储 / projection 缓存（直接使用） | 0.1.2-rc.1 | `ctx.sessionPersistence`、`ctx.storage`、`ctx.sessionProjectionCache` | 宿主面 | INTENTIONAL-NONE | `sessions/catalog.ts` "no persistence scan" | 前端从不扫描磁盘、从不建第二套存储；alpha 的 handle API 是宿主关切（PENDING-HARNESS-ADOPTION，间接） | — |
| 工作区注册表（`ctx.workspaceRegistry`） | 0.1.2-rc.1 | `WorkspaceRegistry` | 低 | INTENTIONAL-NONE | `sessions/filters.ts`、`worktrees/*` | 域栈为单进程（`dsh-storage-domain`）；语料上的 cwd 分组才是多终端安全模型 | — |
| 会话日志 ZIP 导出 | 0.1.2-rc.1 | `session-log-export` HTTP 路由 | 无 | N/A | — | Web 宿主路由；终端没有 HTTP 面 | — |
| 面向模型的会话查询工具 | 0.1.2-rc.1 | `tool-session-query` | 无 | N/A | — | 模型侧；dshline 为自身 UI 消费同一引擎 | — |

### 文本记录与会话呈现

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 用户 / 助手消息、推理 | 0.1.2-rc.1 | `user/message`、`assistant/message` + `MessageSourceMap` | 核心 | FULL | `transcript.ts`、`stream.ts`、`reasoning.ts` 显示 | — | — |
| 工具调用/结果卡片 | 0.1.2-rc.1 | `ToolCallView` / `ToolResultView` 呈现约定 | 核心 | FULL | `cards.ts`、`tool-pending.ts`、`tool-output.ts`（ctrl-o 检查器） | — | — |
| 命令回显 + 结果 | 0.1.2-rc.1 | `command/run`、`command/done`、`sourceEventSeq` | 核心 | FULL | `transcript.ts`、`history.ts`、`context/compaction.ts` | — | — |
| Compaction 注记 | 0.1.2-rc.1 | `compaction/summary`、`compaction/end`、`compaction/prune` | 核心 | FULL | `context/compaction.ts` | — | — |
| Turn 结局（error/aborted/max-tokens/blocked） | 0.1.2-rc.1 | `turn/end` `TurnEndReason` | 核心 | FULL | `transcript.ts` | — | — |
| PTC 子调用事件（`tool/code-dispatch`） | 0.1.2-rc.1 | `dsh-tools` PTC 记录 | 低 | NONE | — | 标准组合未挂载 PTC；PTC 会话真实存在后才渲染 | 刻意等待 |
| 请求头 | 0.1.2-rc.1 | `Session.requestHeader()`、`EpochHeader` | 核心 | FULL | `cache/model.ts`、`context/model.ts`、`work/index.ts` | — | — |

### Work 与委派

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Jobs 观察 | 0.1.2-rc.1 | `ctx.jobs.list`、`onJobsChanged` | 核心 | FULL | `work/index.ts`、`work/model.ts`；探针 `tests/capability/jobs.probe.spec.ts` | — | — |
| Job 终止 | 0.1.2-rc.1 | `ctx.jobs.kill` | 核心 | INTENTIONAL-NONE | `work/index.ts` 拒绝注释；`ROADMAP.md` 控制规则 | kill 将记录标记为 `reported`，改变模型送达语义 | 仅当 harness 发布人类安全的 kill 时重分类 |
| Subagent 生命周期 + 发现 | 0.1.2-rc.1 | `ctx.subagents` 事件、`listChildren` | 核心 | FULL | `work/index.ts`；探针 `tests/capability/subagents.probe.spec.ts` | — | — |
| 可续子 agent 的人类中断 | 0.1.2-rc.1 | `subagents.interrupt(id, {kind:'user', parentSessionId})` | 核心 | FULL | `work/index.ts` `interrupt()`、`work/overlay.ts` | — | — |
| 一次性 subagent 中断 | 0.1.2-rc.1 | —（按约定仅持有者可用） | 核心 | INTENTIONAL-NONE | `work/index.ts`（`interruptible: false`） | 不存在服务级中断操作；持有者的工具调用拥有它 | — |
| 人类发起 / 消息可续子 agent | 0.1.2-rc.1 | `subagents.sendMessage`（父 agent 权威） | 核心 | BLOCKED | 正确的不采纳（下文）；`ROADMAP.md` Work 行 | 该 seam 建模的是*父 agent* 的权威，不是人类向子 agent 发话的 seam；从终端驱动它会混淆人类与模型权威 | 需要上游约定 |
| Workflow 观察 | 0.1.2-rc.1 | `workflow/*` 事件 + 持久 `tool-workflow/*` | 核心 | FULL | `work/workflows.ts`、`work/index.ts`；探针 `tests/capability/workflow.probe.spec.ts` | — | — |
| Workflow 运行控制 | 0.1.2-rc.1 | 仅 `ctx.workflowEngine.start()` | 核心 | INTENTIONAL-NONE | `work/index.ts` | 引擎未为前端发布任何取消/控制面 | 上游发布后重分类 |
| Work 遥测（`subagentTiming`、`tokenUsage`） | 0.1.2-rc.1 | projection 单元 | 核心 | FULL | `work/index.ts` `CHILD_PROJECTION_KEYS`；探针 `tests/capability/subagent-telemetry.probe.spec.ts` | — | — |
| 面向模型的委派工具 | 0.1.2-rc.1 | `dsh-tool-subagent`、`dsh-tool-jobs`、`dsh-tool-subagent-control` | 无 | N/A | 经通用工具卡片渲染 | 模型侧 | — |
| Inbox / 队列控制 | 0.1.2-rc.1 | `Agent.inbox`、`sessionController.updateQueue` | 核心 | EXCLUDED | `ROADMAP.md` "Pending input can be seen but not managed" | EXCLUDED — 另行能力活动 | 延后 |

### LLM、提供方、settings、credentials

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 提供方注册表 + 可配置目录 | 0.1.2-rc.1 | `ctx.llm.listProviders`、`listConfigurableProviders` | 核心 | FULL | `model.ts`、`connect/catalog.ts`、`connect/harness.ts` | — | — |
| 每路由模型目录 | 0.1.2-rc.1 | `ctx.llm.listModels` | 核心 | FULL | `model.ts`、`connect/catalog.ts` | — | — |
| 模型能力元数据 | 0.1.2-rc.1 | `ctx.llm.resolveModelInfo`（`LlmResolvedModelInfo`） | 核心 | FULL | `window.ts`（上下文窗口、模态）、`context/model.ts` | — | — |
| 草稿端点上的模型发现 | 0.1.2-rc.1；anthropic 协议 0.1.3 新增 | `ctx.llm.discoverModels` | 核心 | FULL | `connect/route-editor.ts` | 0.1.3 协议拓宽为增量；dshline 无需改动 | — |
| 路由编辑（base URL、协议、headers、目录） | 0.1.2-rc.1 | `ctx.settings.mutate` 路径操作；pi-ai schema | 核心 | FULL | `connect/route-editor.ts`、`connect/header-editor.ts`、`connect/pi-ai.ts` | — | — |
| Compat 档案 / 重试策略 / 每模型推理映射 | 0.1.2-rc.1 | pi-ai `compatProfile`、`RetryPolicySchema`、`PiAiReasoningEfforts` | 低 | INTENTIONAL-NONE | `connect/pi-ai.ts` 策展注记；`ROADMAP.md` Connect 限制 | 高级字段留在 `settings.yaml`；终端策展的是读者所能*抵达*的范围 | — |
| Settings 描述 / 带修订的变更 | 0.1.2-rc.1 | `ctx.settings.describe`、`mutate(ns, ops, expectedRevision)` | 核心 | FULL | `settings.ts`、`connect/harness.ts`、`connect/actions.ts` | 探针表无 `settings` 行（证据在 Connect 测试中） | **增补探针（P2）** |
| Credential 记录 | 0.1.2-rc.1 | `ctx.credentials`（`describeRecord`、`deleteRecord`） | 核心 | FULL | `connect/harness.ts`、`connect/actions.ts` | 同样的探针表缺口 | **增补探针（P2）** |
| 授权流程 | 0.1.2-rc.1 | `ctx.authorization`（`AuthorizationFlow`、notice、prompt） | 核心 | FULL | `connect/authorize.ts`、`connect/harness.ts`；探针 `tests/capability/authorization.probe.spec.ts` | — | — |
| 路由激活 | 0.1.2-rc.1 | settings 监听 + `llm/adapters-updated` | 核心 | FULL | `connect/activation.ts`、`connect/actions.ts` | — | — |
| 文件内容块（`FileBlock`、`fileRequestText`） | 0.1.3-alpha.2 | `dsh-llm` types | 核心 | PENDING-HARNESS-ADOPTION | —（采纳生代的产物中不存在） | 随下次采纳与文件附件同行 | — |
| 提供方注册表探针 | 0.1.2-rc.1 | `ctx.llm` | 核心 | PARTIAL | 存在 `connect/*.spec.ts` 但探针表无行 | seam 已被演练，但 `tools/capability-probes.mjs` 未指名 | **增补探针（P2）** |

### 工具、命令与技能

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 工具注册表 + 呈现约定 | 0.1.2-rc.1 | `ctx.tools.get`、`ToolCallView`/`ToolResultView` | 核心 | FULL | `cards.ts`、`tool-pending.ts` | — | — |
| 工具注册表变更馈送 | 0.1.2-rc.1 | `tools/change` | 低 | PARTIAL | 无监听；呈现按调用惰性解析（`attachment.ts:330`） | 今日无用户可见缺口；实时工具列表 UI 才会需要 | 无需工作；再议 |
| 命令注册表 + 执行 | 0.1.2-rc.1 | `ctx.commands.list`、`execute`、`commands/change` | 核心 | FULL | `attachment.ts`、`completion.ts` | — | — |
| 命令参数提示（`input.hint`） | 0.1.2-rc.1 | `CommandDescriptor.input.hint` | 核心 | PARTIAL | `attachment.ts:1089` 以文字提及该提示；无 UI 渲染它 | 输入仅提示型命令的读者得不到词汇 | **实现（P2）** |
| 附件感知的命令输入 | 0.1.2-rc.1（图片）；0.1.3 推广 | `input.images` → `input.attachments` | 核心 | FULL（采纳生代） | `attachment.ts` 闸门、`image-drafts.ts` | 0.1.3 文件回执为 PENDING-HARNESS-ADOPTION | — |
| 文件引用发现（`@` 语法） | 0.1.2-rc.1 | `ctx.fileReferences.list` + `activeAtToken`/`formatFileMention` | 核心 | NONE | `attachment.ts:1089`——`@` 补全直接经 `ctx.fs` 列举 | 用户可见行为已经过另一条公开 seam 存在；上游自家前端为此组合了 `file-reference-local` | 待办（P2）：将 `@` 补全迁移到共享 seam |
| 命令结果持久化 | 0.1.2-rc.1 | `command/run` / `command/done` 持久记录 | 核心 | FULL | `transcript.ts`、`history.ts` | — | — |
| 技能目录 | 0.1.2-rc.1 | `ctx.skills.snapshot`、`skills/change`、`userInvocable` | 核心 | FULL | `skills/catalog.ts`、`skills/overlay.ts`；探针 `tests/capability/skills.probe.spec.ts` | — | — |
| 技能手势就绪 | 0.1.2-rc.1 | —（没有 seam 说明 `dsh-tool-skill` 已挂载） | 核心 | BLOCKED | `architecture.md` 技能一节 | 就绪只能从实现推断，绝非约定 | 需要上游 seam |
| MCP 连接状态 | 0.1.2-rc.1 | —（mcp-client 不发布任何注册表/状态约定） | 核心 | BLOCKED | —（dshline 无 MCP 代码） | 工具名与 `tools/change` 使状态*可推断*，却从未被发布；dshline 不推断 | 需要上游约定 |
| Shell / code-runtime seam | 0.1.2-rc.1 | `ctx.shell`、`ctx.codeRuntime` | 宿主面 | INTENTIONAL-NONE | 其输出的工具卡片已通用渲染 | 宿主侧执行；卡片级覆盖已完整 | — |

### 权限、授权与人类交互

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 审批应答方 | 0.1.2-rc.1 | `approval/request` waterfall、`ApprovalOutcome` | 核心 | FULL | `approval.ts`；测试 `approval.spec.ts` | — | — |
| 审批策略旋钮 | 0.1.2-rc.1 | `setApprovalPolicy`、`approval/policy` 事件 | 核心 | FULL | 经预设选择器抵达（`permission.ts`）——与 harness 自家客户端相同的面 | 直接旋钮会重复预设面 | — |
| 权限预设 + projection | 0.1.2-rc.1 | `ctx.permissionPresets`、`permissions` projection | 核心 | FULL | `permission.ts`、`attachment.ts`；探针 `tests/permission.spec.ts` | — | — |
| 沙箱状态读取/控制 | 0.1.2-rc.1 | `ctx.sandbox`（无前端约定） | 低 | INTENTIONAL-NONE | — | 无 projection、无控制 seam；可见性经预设与升级拒绝抵达 | — |
| 沙箱升级审批 | 0.1.2-rc.1 | `sandbox_permissions` → `ctx.approval.request` | 核心 | FULL | `approval.ts` 按普通审批渲染 | — | — |
| 用户提问（单选） | 0.1.2-rc.1 | `user-questions/request` waterfall | 核心 | FULL | `questions.ts`、`select.ts`；探针 `tests/capability/user-questions.probe.spec.ts` | — | — |
| 用户提问（多选 + 自由文本） | 0.1.2-rc.1 | `AskUserQuestionItem.multiSelect`、`AnswerItem.custom` | 核心 | PARTIAL | `questions.ts` `askOne` 忽略 `multiSelect`；`custom` 从不产生 | 答案被无声降级为单个选项标签 | **实现（P0）** |
| Plan 评审意图 | 0.1.2-rc.1 | `AskUserQuestionIntent {kind:'plan-review'}` | 核心 | FULL | `questions.ts`、`plan-review.ts` | — | — |
| 命令反馈（`/feedback`） | 0.1.2-rc.1 | `command-feedback` 注册命令 | 核心 | FULL | 经通用注册命令路径（`attachment.ts`） | 终端等价物已以另一方式提供；按消息评分是 Web remote——N/A | — |

### 附件、上下文、compaction 与用量

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 图片附件 | 0.1.2-rc.1 | `ctx.attachments.saveImages`、`imageLimits` | 核心 | FULL | `image-drafts.ts`、`attachment.ts`；测试 `image-drafts.spec.ts`、`image-attachment-flow.spec.ts` | — | — |
| 图片准入错误 | 0.1.2-rc.1 | `AttachmentErrorCode` | 核心 | FULL | `attachment.ts` 预读界限 + 存储错误码 | — | — |
| 命令图片输入 | 0.1.2-rc.1 | 描述符 `input.images` | 核心 | FULL | `image-drafts.ts` `encodeCommandImages` | — | — |
| 通用文件附件 | 0.1.3-alpha.2 | `admitEncodedFile`、`FileAttachmentRef`、`FileBlock` | 核心 | PENDING-HARNESS-ADOPTION | `ROADMAP.md` "Still ahead: arbitrary file attachments" | 采纳生代只暴露图片；`@path` 仍是诚实的手势 | 随下次采纳迁移 |
| Compaction 观察 + `/compact` | 0.1.2-rc.1 | `compaction/*` 事件；注册的 `/compact` | 核心 | FULL | `context/compaction.ts`；探针 `tests/capability/compaction.probe.spec.ts` | 从不调用 `ctx.compaction` | — |
| 区域 compaction（`compactRegion`） | 0.1.2-rc.1 | `CompactionEngine.compactRegion` | 核心 | INTENTIONAL-NONE | `architecture.md` compaction 一节 | 人类命令无参数；范围选择 UI 是上游未定义的控制约定 | — |
| 上下文 projection + 计量器 | 0.1.2-rc.1 | `contextPressure`、`contextBreakdown`、`tokenUsage`；`ctx.tokenMeter.measure` | 核心 | FULL | `context/model.ts`、`context/overlay.ts`、`usage.ts` | — | — |
| 每轮用量（`deriveTurnTokenUsage`） | 0.1.2-rc.1 | `dsh-token-meter/client` | 低 | PARTIAL | 无任何导入 | 累计 + 占用面已存在；每轮数字属于润色 | 待办（P2），本轮未选 |
| 缓存前缀稳定性 | — | —（任何生代均未发布） | 核心 | INTENTIONAL-NONE | `cache/model.ts` 头注记录了该拒绝 | 重建一个会让 dshline 成为第二历史权威 | 需要上游约定 |

### 插件、组合与平台

| Harness 能力 | 生代 | 上游权威 | 终端相关性 | dshline 状态 | dshline 证据 | 缺口 / 决策 | 行动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Profile 名册 + bundle 生命周期 | 0.1.2-rc.1 | `ctx.dshHomePath`、`dsh plugin`、`ctx.baseUrl` | 核心 | FULL | `profiles/*`（变更一律转发，从不直写） | — | — |
| dshline 所需的组合行 | 0.1.2-rc.1 | dshline `cordis.patch.yml`（session-stats、authorization） | 核心 | FULL | `packages/dshline/cordis.patch.yml` | 是组合而非实现——seam 仍归 harness 所有 | — |
| 兼容性检查 | 0.1.2-rc.1 | —（无运行时版本服务） | 核心 | FULL | `/profiles` 读取 peer 钉定与组合的 `dsh-base` 版本；未知一律不标注 | harness 不发布 `ctx.version`；manifest 是已发布的事实 | — |
| 持久终端 | 0.1.2-rc.1 | `ctx.terminals` | 核心 | NONE | — | 真实的 harness 能力，零采纳；PTY 在有界活动区域内的设计未解 | 待办（P1），大切片，需先行设计 |
| 定时提醒 projection | 0.1.2-rc.1 | 可选 `schedule` projection 单元 | 低 | PARTIAL | — | 提醒已经以后续消息形式抵达文本记录；目录浮层属于润色 | 待办（P2），本轮未选 |
| Web 面（client、api、gateway、sdk、acp、webhook、webhost） | 0.1.2-rc.1 | `packages/client`、`packages/api` 等 | 无 | N/A | — | 进程内前端；Web RPC/浏览器机制按架构不属于范围 | — |
| 实验包（agent-team、inspector、python 运行时） | experimental | `packages/experimental/*` | 无 | N/A | — | "不属于任何正式发布"；仅在晋级后进入范围 | — |
| Identity / hooks / e2b / spill / typert / lsp / util | 0.1.2-rc.1 | 各自的包 | 无 | N/A | — | 宿主面或模型侧管道；无终端面 | — |

## 领域详述

### Agent 生命周期、模式与结构化状态

**Harness 提供什么。** agent 面（`@deepseek-ai/dsh-agent`，[core/agent](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/core/agent/src/runtime-types.ts)）发布 `ctx.agents`（`create`/`resume` 返回归调用者所有的 `AgentHandle`）、带 `agent/status` 的 `AgentStatus` 状态机、带类型化原因的取消、按 agent 作用域的生命周期事件、供宿主驱动方使用的 `whenIdle`/`runMaintenance`，以及带 `followup`/`steer` 投递动词的 inbox。模型选择是会话头快照加可变 `ModelSelectionRef`，经 waterfall 安装；推理努力程度对照适配器发布的 `LlmModelReasoningInfo` 校验；持久默认在 `ctx.agentDefaultModel`。Plan 模式、goals、todos 是结构化状态域：plan 经 `plan/mode` 持久翻转；goals 把持久 projection（`goal`：目标、阶段、轮次、修订）与进程本地、刻意永不持久化的续跑 `activation` 分开；todos 是整表持久写入加 projection。Agent 预设按 agent 组合工具、提示段与委派后端，在 `setup(agentCtx)` 连接，且仅在空白会话上可切换。

**dshline 今天做什么。** 窗口拥有按键路由与退出；attachment 拥有一个 agent，并将其日志（`session/event`）折叠进文本记录、卡片、计时、活动与 work。重开使用所持 handle 的 `dispose()` 后接 `ctx.agents.resume`，对 harness 未定义生命周期的状态一律拒绝。流式输出经 `assistant/chunk` 实时渲染文本与推理，在 `assistant/message` 上落定。状态栏把 `goal` projection 与活动中的 `ctx.goals.get(agent).activation` 相连接——实时读取且从不缓存，因为 `disarm()` 不写任何持久物——并从日志折叠渲染 `plan/mode`，使重放能恢复它。模型与推理选择器先写引用、再存持久默认，并在文本记录里说明。`/plugins` 经 `ctx.agentPresets` 呈现预设名册与组合，编辑前先复制系统预设，并按会话自身记录的预设恢复。

**缺什么。** 在采纳生代内没有面向终端的缺口。0.1.3 的流式替换（`agent/assistant-stream` 帧、`assistant/attempt` 记录、移除 `assistant/chunk`）是唯一重大的 PENDING-HARNESS-ADOPTION：dshline 有五个文件折叠被移除的事件，无法对 `0.1.3-alpha.2` 编译。

**决策。** 对采纳生代无需工作。流式迁移属于下一次 `harness-sync` 采纳拉取请求，不属于能力活动。

**证据。** 上游：`packages/core/agent/src/runtime-types.ts`、`packages/core/agent/src/model-selection.ts`、`packages/core/session/src/types.ts`、`packages/plan/plan-mode/src/index.ts`、`packages/goal/goal/src/{index,types,domain}.ts`、`packages/preset/agent-presets/src/index.ts`（均在 `dsh-v0.1.2-rc.1`）。dshline：`packages/dshline/src/{attachment,session-scope,resume,stream,modes,goals/model,plugins/window…}` 及矩阵所列探针。

### 会话、查询与持久化

**Harness 提供什么。** `ctx.sessionQuery`（[session-query](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/session-query/session-query/src/index.ts)）发布"活动优先"的逻辑语料：`listSessions`、`filterSessions`、全文 `searchSessions` 与 `searchEvents`（引擎仅有的抽象面，故为可选）、经重放校验的 `readSession`、`listEvents`、窗口化 `readEvent`、`traceSession` 谱系、批量 `readTitleSnapshots`，以及 `readSurface`/`observeSession`/`filterEvents`/`traceEvent`。标题由 `dsh-session-title` 折叠，其 `rename` 追加带显式 user 权威的仅日志 `session/title` 事件，但只持活动会话对象。`ctx.workspaceRegistry` 拥有持久工作区实体与单向 `archiveSession`。持久化（`dsh-session-persistence`，JSONL 后端）属宿主面；跨进程所有权被记录为对调用方的要求，而非强制。

**dshline 今天做什么。** `/sessions` 与 `/worktrees` 只读一个权威——语料——按精确 `SessionHeader.cwd` 做瞬态分组；`/sessions` 是选择器优先，每会话的披露面在打开时才为 `listEvents` 付费，`ctrl-f` 过滤即 harness 子句，谱系导航走 `traceSession`，会话内搜索走 `searchEvents` 加游标分页，本窗口驱动的会话经 `ctx.sessionTitle.rename` 重命名。恢复用 `readSession` 重建文本记录，且与实时绘制走同一代码路径。内容搜索在 `SESSION_QUERY_SEARCH_DISABLED` 时诚实降级。

**缺什么。** 选中的事件搜索命中只显示其摘要加 `type · seq · time`——`readEvent(sessionId, seq, before, after)` 发布的周边事件不可读。`observeSession`、`readSurface`、`filterEvents`、`traceEvent` 没有消费界面。归档刻意不提供（BLOCKED：单向、非语料事实）。任何地方都不声明跨进程存活。

**决策。** 经 `readEvent` 实现命中上下文查看（P1；`ROADMAP.md` "Still ahead for Sessions" 已列）。其余：无需工作或已有记录的上游阻塞。

**证据。** 上游：`packages/session-query/session-query/src/{index,types}.ts`、`packages/session/session-title/src/index.ts`、`packages/workspace/workspace/src/index.ts`（均在 `dsh-v0.1.2-rc.1`）。dshline：`packages/dshline/src/sessions/*`、`src/resume.ts`、`tests/sessions-query.integration.spec.ts`（`sessionQuery` 探针）。

### 文本记录呈现

**Harness 提供什么。** 持久 `SessionEventMap` 记录——带 `MessageSourceMap` 来源的 `user/message` 与 `assistant/message`、携带工具声明的 `ToolCallView`/`ToolResultView` 呈现意图与工具私有 `meta` 的 `tool/call`/`tool/result`、带 `sourceEventSeq` 关联的 `command/run`/`command/done`、`compaction/*`、`turn/end` 原因、`request/header` 快照。

**dshline 今天做什么。** 一个 projection 折叠画出全部，实时与重放完全一致；流式行就是早一个换行的已提交路径；`ctrl-o` 为被省略的卡片输出打开有界检查器；命令结果在恢复后仍在，因为它们从日志投影而来，从不在提交时刻直接打印。

**缺什么。** `tool/code-dispatch` 子调用记录（PTC）不渲染——标准组合未挂载 PTC，没有真实会话会产生它们。

**决策。** 刻意等待；PTC 会话真实存在后才渲染子调用。

**证据。** dshline：`packages/dshline/src/{transcript,stream,cards,tool-pending,tool-output,history,context/compaction}.ts`；布局门为帧测试与 `packages/dshline/tests/streaming-frames.spec.ts`。

### Work 与委派

**Harness 提供什么。** `ctx.jobs`（作用域快照；`kill` 会把记录标记为面向模型送达的 `reported`）、`ctx.subagents`（生命周期事件、`listChildren` 发现、对可续子 agent 带显式 user 权威的 `interrupt`、父 agent 权威下的 `sendMessage`），以及 workflow 引擎（只读事件加父会话中的持久 `tool-workflow/*` 记录）。

**dshline 今天做什么。** `/work` 是通用适配器：三个权威、一层投影；workflow 运行经本会话自己的持久记录确权，且仅由这些记录已证明的活动事件做富化；成员经 harness 发布的 `childId` 连接到 subagent 行。控制只有一个——对可续子 agent 的 user 权威中断——每个拒绝（job kill、一次性中断、workflow 控制）都连同理由被写明。

**缺什么。** 缺人类对可续子 agent 的发起/发话面（BLOCKED：公开 seam 建模的是父 agent 权威）。Inbox/队列控制为 EXCLUDED——另行活动。

**决策。** 除已记录的拒绝外无需工作。

**证据。** 上游：`packages/jobs/jobs/src/index.ts`、`packages/subagent/subagent/src/{index,types,control-types}.ts`、`packages/workflow/workflow/src/index.ts`（均在 `dsh-v0.1.2-rc.1`）。dshline：`packages/dshline/src/work/*`，探针 `jobs`、`subagents`、`subagent-telemetry`、`workflow`。

### LLM、提供方、settings、credentials

**Harness 提供什么。** `ctx.llm`（适配器注册表、可配置提供方目录、每路由目录、`resolveModelInfo`、推理努力程度、`discoverModels`）、`ctx.settings`（脱敏 describe、带修订与路径操作的 mutate）、`ctx.credentials`（按 `CredentialKey` 的记录 describe/set/unset/delete）、`ctx.authorization`（中立的 notice/prompt 流程词汇），以及使路由可声明的 pi-ai 适配器 settings schema。

**dshline 今天做什么。** `/connect` 是四条 seam 的连接，没有提供方列表、没有字段名知识（`credential-ref` schema 角色才是约定）、没有登录协议；`connect/pi-ai.ts` 是唯一被允许知道 pi-ai 策展字段（`displayName`、`baseURL`、`api`、`headers`、`models`）及其声明路由形态的模块；模型发现仅作建议；激活是独立的人类同意。`/model` 与 `/reasoning` 先写活动引用、再整体存持久默认。

**缺什么。** 没有面向终端的缺口。pi-ai 高级字段（`compat`、重试策略、每模型推理映射）按有记录的策展策略留在 `settings.yaml`。探针表虽经 Connect 测试演练这些 seam，却未指名任何行。

**决策。** 为 `settings`/`credentials`/`llm` 增补探针表行（P2）。无产品缺口。

**证据。** 上游：`packages/llm/llm/src/{index,types}.ts`、`packages/llm/llm-pi-ai/src/{config,catalog,discovery}.ts`、`packages/settings/settings/src/index.ts`、`packages/credentials/credentials/src/index.ts`、`packages/credentials/authorization/src/index.ts`（均在 `dsh-v0.1.2-rc.1`）。dshline：`packages/dshline/src/connect/*`、`src/settings.ts`、`src/selection.ts`、`src/reasoning.ts`、`src/model.ts`。

### 工具、命令与技能

**Harness 提供什么。** `ctx.tools`（注册、作用域限制、呈现意图、`tools/change`）、`ctx.commands`（带 `input.hint`/`input.images` 的描述符、执行、持久 `command/run`/`command/done`、`commands/change`）、`ctx.skills`（作用域分层目录、`userInvocable`、`skills/change`）、`ctx.fs`（有界读取）、`dsh-tool-skill`（`/name` 手势边界），以及完全不发布注册表/状态约定的 MCP 客户端。

**dshline 今天做什么。** 工具卡片渲染工具声明的任何内容；补全提供注册命令及其可枚举参数值；`/skills` 呈现按作用域生效的目录而从不加载正文；路径补全读取 `ctx.fs`。

**缺什么。** `input.hint` 从不渲染（实现，P2）。`tools/change` 未被观察（惰性解析已覆盖）。技能手势就绪与 MCP 状态是上游阻塞，dshline 记录在案而非推断。

**决策。** 实现提示（P2）；其余无需工作。

**证据。** 上游：`packages/core/tools/src/index.ts`、`packages/interaction/commands/src/{index,types}.ts`、`packages/skill/skill/src/index.ts`、`packages/mcp/mcp-client/src/index.ts`（均在 `dsh-v0.1.2-rc.1`）。dshline：`packages/dshline/src/{cards,tool-pending,completion,attachment,skills/*}.ts`。

### 权限、授权与人类交互

**Harness 提供什么。** `approval/request` waterfall（一次性结局、无应答方时失败关闭）、经 `ctx.permissionPresets` 及其 `permissions` projection 写入的持久每会话审批策略与沙箱模式、经审批解决的沙箱升级，以及 `ctx.userQuestions`——`ask_user_question` 请求，其条目携带 `options`、`multiSelect`、`detail`、`header` 与 `plan-review` 意图，以 `{ id, selected: string[], custom?: string }` 作答。

**dshline 今天做什么。** 终端应答方认领每个请求，在有界浮层中逐个提问，把"读者关闭"与"请求被撤回"区分开（本地 `ASK_CANCELLED`、撤回为 `ASK_ABORTED`），把 plan 评审渲染为独立界面，并经预设选择器抵达权限旋钮——与 harness 自家客户端完全一致。

**缺什么。** `multiSelect` 被忽略且 `custom` 从不产生：多选题只答一个标签，自由文本回答不可能。上游自家 Web 客户端提供带"其他"输入的复选框、单选下以自定义文本取代选择、无选项问题渲染自由文本块。

**决策。** 实现完整答案约定（P0）。

**证据。** 上游：[packages/interaction/user-questions/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/interaction/user-questions/src/types.ts)、`packages/interaction/user-approval/src/index.ts`、`packages/interaction/permission-presets/src/index.ts`、`packages/interaction/tool-ask-user/src/index.ts`（均在 `dsh-v0.1.2-rc.1`）。dshline：`packages/dshline/src/{questions,select,approval,permission,plan-review}.ts`，探针 `user-questions`、`authorization`；projection 测试 `todos.spec.ts`、`goals.spec.ts`、`permission.spec.ts`。

### 附件、上下文、compaction 与用量

**Harness 提供什么。** 图片附件准入（`ctx.attachments` 带限制与稳定错误码）、带持久 `compaction/*` 事件与注册 `/compact` 的 compaction 引擎、计量器的 O(1) projection（`contextPressure`、`contextBreakdown`、`tokenUsage`) 加 O(surface) 的 `measure()`、会话统计，以及——仅 `0.1.3-alpha.2`——通用文件附件与附件感知计量。

**dshline 今天做什么。** `/image` 不做 I/O 地暂存路径，在发送时发布一批持久引用；`/context`、`/usage`、`/cache` 与状态栏只读已发布的 projection，仅由打开的检查器调用 `measure()`，且从不混合两套词汇；compaction 从其事件呈现，削减归注册命令所有。

**缺什么。** 文件附件（PENDING-HARNESS-ADOPTION）。每轮用量（`deriveTurnTokenUsage`）无任何导入（待办润色）。缓存前缀稳定性任何生代都未发布（刻意不采纳，已记录）。

**决策。** 本活动除本研究外无需工作。

**证据。** 上游：`packages/attachment/attachment/src/{index,types,admission}.ts`、`packages/compaction/compaction/src/index.ts`、`packages/llm/token-meter/src/*.ts`、`packages/session/session-stats/src/projection.ts`（均在 `dsh-v0.1.2-rc.1`）。dshline：`packages/dshline/src/{image-drafts,attachment,context/*,usage,usage-overlay,cache/*,performance}.ts`，探针 `tokenMeter`、`compaction`、`sessionStats`、`requestHeader`。

### 插件、组合与平台

**Harness 提供什么。** Profile 组合（`dsh.profile.bundles`、`dsh plugin`、补丁层）、插件上下文面（约 40 个 `ctx.*` 服务）、agent 预设、dshline 组合的宿主面 seam（`session-stats`、`authorization` 作为 bundle 行）、`ctx.terminals`（持久 PTY）、可选的定时提醒 projection，以及 Web/API/SDK/ACP 面。

**dshline 今天做什么。** `/profiles` 呈现名册并把一切变更转发给 `dsh plugin`；`/plugins` 呈现组合；bundle 补丁恰好挂载 dshline 读取的宿主面行；兼容性检查读 manifest，因为 harness 不发布版本服务，且未知一律不标注。

**缺什么。** 持久终端是真实的采纳生代能力，dshline 零采纳（待办 P1——写代码之前需要有界行设计）。schedule projection 是未消费的润色（待办 P2）。平台清单上其余皆因架构而 N/A。

**决策。** 本活动不做平台工作。

**证据。** 上游：`packages/bundle/base/cordis.patch.yml`、`packages/boot/app-boot/README.md`、`packages/terminal/terminal/src/index.ts`、`packages/schedule/*`（均在 `dsh-v0.1.2-rc.1`）。dshline：`packages/dshline/src/{profiles,plugins,setup,window,startup}.ts`、`packages/dshline/cordis.patch.yml`。

## 值得实现的能力缺口

优先级：**P0** 高价值、当前约定干净 · **P1** 有价值但更窄 · **P2** 润色/完整性 · **BLOCKED** 需要上游约定 · **DECLINED** 刻意不适合 dshline。

### P0 — 完整的 `ask_user_question` 答案约定（多选 + 自由文本）

- **用户问题。** 模型提出多选题（或期待"其他"回答）时，终端无声地以单个选项标签作答，且无法给出文本。模型收到的答案严格窄于协议定义，人类也无法说出问题本请它说的话。
- **Harness 权威。** `AskUserQuestionItem.multiSelect`、`AskUserQuestionAnswerItem {selected, custom}`——采纳生代上公开、提供方无关的约定（`user-questions/src/types.ts`）。上游 Web 客户端（`QuestionComposer.tsx`）定义了预期语义：多选累积标签且可伴随自定义文本；单选下自定义文本取代选择；无选项问题渲染自由文本块。
- **dshline 为何不足。** `questions.ts` 的 `askOne` 把每个条目映射为单选 `promptSelect` 并返回 `selected: [oneLabel]`；`custom` 从不设置；无选项问题降级为 OK 确认。
- **拟议终端交互。** 为选择浮层扩展多选模式：`space` 勾选/取消一行，`enter` 确认所选集合；一个显式的"其他…"行打开既有的有界文本提示（`prompt.ts`），其结果与所选并存（多选）或取代所选（单选）；无选项问题直接呈现文本提示；帮助段按既定规则整段放弃；紧凑回退保持可作答。
- **涉及文件。** `packages/dshline/src/select.ts`（或其姊妹浮层）、`src/questions.ts`、测试。
- **测试。** 浮层帧测试（勾选状态、切换/确认、其他流程、esc = 取消、中止 = `ASK_ABORTED`）、答案形状测试（多标签、仅 custom、custom + selected、单选 custom 取代）、以及一次刻意的破坏验证每个测试按名失败。
- **风险。** 窄终端下的浮层几何（由既有紧凑回退缓解）；共享 `promptSelect` 的审批/模型选择器回归风险（以单选行为逐字节不变缓解）。
- **是否需要 Harness 采纳。** 否。

### P1 — 经 `readEvent()` 查看会话内搜索命中上下文

- **用户问题。** 搜索命中回答了"这个会话说过类似的话"，却回答不了"它前后在发生什么"；读者只能恢复会话再用眼睛搜一遍。
- **Harness 权威。** `SessionQueryEngine.readEvent(request)` → `SessionEventWindow`（前后记录），采纳生代已发布；`ROADMAP.md` "Still ahead for Sessions" 已列。
- **dshline 为何不足。** `sessions/panels.ts` 只渲染摘要与 `type · seq · time`；没有任何界面调用 `readEvent`。
- **拟议终端交互。** 在选中的命中上按键（enter）打开有界子浮层，显示该事件内容及其 `before`/`after` 邻居；esc 返回命中列表；渲染每事件一行，采用与文本记录相同的来源样式；读取随浏览器取消。
- **涉及文件。** `src/sessions/catalog.ts`（端口）、`src/sessions/panels.ts`、`src/sessions/overlay.ts`、测试。
- **测试。** 窗口成形（命中居中、边界钳制）、渲染界限、取消、降级搜索部署不受影响。
- **风险。** 子浮层行预算（与他处一样用有界视口）；冷会话读取延迟（每次打开一次窗口化读取，不预取）。
- **是否需要 Harness 采纳。** 否。

### P2 — 渲染命令参数提示

- **用户问题。** 描述符声明了 `input.hint` 的命令（带自由文本参数的 harness 注册命令）不给终端读者任何词汇；Web 客户端会在输入处显示提示。
- **Harness 权威。** `CommandDescriptor.input.hint`（公开，采纳生代）。
- **dshline 为何不足。** `attachment.ts` 仅在文字中提及提示；`completion.ts` 只提供可枚举参数值，从不提供提示。
- **拟议终端交互。** 当编辑器处于某命令的参数位置、其输入携带提示且没有值候选（或宽度允许时与其并列）时，提示以注释行的形式出现在补全区；窄时整段放弃，与其他所有提示一致。
- **涉及文件。** `src/completion.ts`、`src/attachment.ts`、测试。
- **测试。** 参数位置的提示渲染；有值候选或宽度不足时的抑制；dshline 本地命令无提示。
- **风险。** 补全列表高度预算（一行）。
- **是否需要 Harness 采纳。** 否。

### P2 — 为 `settings`、`credentials`、`llm` 增补能力探针

- **用户问题。** 无直接用户问题；缺口在验证。探针表是本仓库对上游约定破坏的雷达，而 dshline 重度依赖的三条 seam 只被探针表未指名的 Connect 测试演练。
- **Harness 权威。** `ctx.settings`、`ctx.credentials`、`ctx.llm` 公开面。
- **dshline 为何不足。** `tools/capability-probes.mjs` 没有它们的行。
- **拟议交互。** 无（纯测试）。在 `packages/dshline/tests/capability/` 下为每条 seam 增加小探针（或指名最强的现有 Connect 测试），并加表行。
- **涉及文件。** `tools/capability-probes.mjs`、新探针测试。
- **测试。** 探针本身。
- **风险。** 除套件时长外无。
- **是否需要 Harness 采纳。** 否。

### 待办（本轮未选）

- **持久终端（`ctx.terminals`）** — P1，体量大；在活动区域内承载 PTY 的有界行设计完成之前不写任何代码。
- **每轮用量数字（`deriveTurnTokenUsage`）** — `/usage` 的 P2 润色。
- **定时提醒目录** — 读取可选 schedule projection 的 P2 润色。
- **经 `ctx.fileReferences` 的 `@` 补全** — P2；把编辑器的 `@` 列举从直接读 `ctx.fs` 迁移到共享文件引用 seam（有界模糊发现、共享语法、`formatFileMention` 引号），并像 dshline 组合 `session-stats` 那样组合 `file-reference-local`。属于改变行为的编辑器工作；应有其独立切片。
- **轮次大纲（`turnOutline` projection）** — P2；若某检查器需要，提供一个有界的轮次索引。

### BLOCKED（需要上游约定）

- 会话归档生命周期（对称的归档/取消归档 + 语料可见的归档事实）。
- 跨进程会话所有权/存活（lease 或所有权约定）。
- 面向人类的子 agent 发话 seam（人类权威的消息传递）。
- 技能手势就绪 seam（`dsh-tool-skill` 是否挂载）。
- MCP 连接状态约定（注册表/状态服务）。
- 运行时 Harness 版本服务（兼容性检查现改读 manifest）。
- 人类安全的 job 终止（不带走模型送达语义的控制）。

### DECLINED（刻意不适合 dshline）

- 在标准组合不挂载 PTC 的当下渲染 PTC 子调用时间线。
- 在 harness 自家客户端所用的预设选择器旁再做直接的审批策略/沙箱模式旋钮。
- dshline 内部的提供方 HTTP、密钥保管或提供方注册表。
- 任何前端自有的持久化、projection 存储、计价权威或会话索引。
- Web 面呈现（client、api、gateway、sdk、acp、webhook）。

## 正确的不采纳

本研究不是"每个 Harness 包都需要一个 dshline UI"的清单。以下刻意不采纳——均已在仓库中记录——是成功的架构决策：

- **`ctx.jobs.kill()`** — 人类杀死一个 job 会把记录标记为 `reported`，无声吞掉面向模型的完成通知。Work 观察 jobs 并拒绝人类 kill。
- **Workflow 运行控制** — 引擎只发布 `start()`，再无其他；前端取消没有权威。
- **一次性 subagent 中断** — 只有持有者（模型的工具调用）拥有它。
- **`ctx.compaction` / `compactRegion`** — 削减属于注册的 `/compact`；范围选择没有人类控制约定。
- **持久化、存储、projection 缓存、工作区注册表** — dshline 刻意不触碰的宿主面或单进程状态；语料与 cwd 分组诚实地取代了它们。
- **归档与跨进程存活** — 在上游发布对称、语料可见的约定之前拒绝；拒绝已记录在 `ROADMAP.md`，而非隐藏。
- **MCP、shell、code-runtime、LSP** — 模型侧或宿主侧 seam，其用户可见输出已经过通用工具卡片抵达，或完全不发布前端约定。
- **Web 面** — client、api、gateway、sdk、acp、webhook、e2b、identity、hooks：进程内终端前端不是浏览器，复刻 Web 栈会成为第二个前端。
- **实验包** — 上游自家的 README 将其排除在发布之外；采纳一个会把 dshline 与未发布行为耦合。
- **Inbox/队列控制** — 经活动决策排除于本研究（`EXCLUDED — separate capability campaign`），不计为 dshline 缺陷。

## 上游阻塞的机会

一旦 Harness 发布狭窄约定即可成立的能力，并注明最小 seam：

| 缺失的 seam | 将解锁 |
| --- | --- |
| 对称归档生命周期 + 语料上的归档事实 | `/sessions` 的归档动作与已归档过滤 |
| 跨进程会话所有权（lease/心跳） | `/sessions` 与 `/worktrees` 中诚实的"他处打开"状态 |
| 人类权威的子 agent 发话（prompt-to-continuable-child） | 从 `/work` 向可续子 agent 发话 |
| 技能就绪 seam（手势边界是否挂载） | `/skills` 诚实就绪状态，取代已记录的告诫 |
| MCP 连接注册表/状态服务 | 带服务器身份与健康度的 `/mcp` 浏览器 |
| 人类安全的 job 取消 | 保留模型送达的 Work kill 动作 |
| 运行时版本/能力服务 | 读取已发布事实而非 manifest 的兼容性检查 |
| 独立于传输的人类队列控制 | 被排除的 Inbox/Queue 活动的前提 |

对其中任何一项都不实现投机适配器。

## 排除：Inbox / 队列控制

一切 Inbox/队列控制能力工作——排队消息浏览、编辑、删除、单条队列转 steer、全部 steer、待发消息重排、任意 `Agent.inbox` 变更、根会话与可续子 agent 的队列管理——均为 **EXCLUDED — separate capability campaign**。本研究只记录既有投递行为（queue/steer 动词、状态栏计数、`ctrl-c` 丢弃语义）与上游阻塞前提（`sessionController.updateQueue` 仅 Web bundle 挂载；缺失的 seam 是独立于传输的人类队列控制）。该排除在本文件任何处都不计为 dshline 缺陷。
