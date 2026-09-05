# 架构

[English](architecture.md) | 中文

## 产品边界

```
DeepSeek Harness
        ↓
capability surfaces and domain state
        ↓
internal dshline presentation adapters
        ↓
bounded TuiSlots / Screen rows
        ↓
native terminal
```

**Harness 拥有能力；dshline 只负责终端呈现。**生命周期、状态、持久化、提供方选择、权威与策略属于 Harness。dshline 读取最狭窄的权威接口，把结构化事实变成终端行，并且不复刻运行时、提供方连接或领域状态机。

渲染器包位于那条边界之下。它了解显示宽度、控制转义、按键、边框盒与 `Screen`；它绝不能了解 Harness、agent、任务、提供方或 Todo 这样的领域。

## 原生滚动缓冲区（scrollback）就是终端模型

`Screen.commit()` 把完成后的会话记录行写入用户真实终端的滚动缓冲区。这些行绝不虚拟化、不作为内存屏幕保留，也绝不重写。`Screen` 只重绘底部有界的活动区域：流式行、输入行、状态或临时浮层。每一次终端写入都经过它，因此活动区域保持最后。

这是刻意的产品架构，而不是临时的实现选择。dshline 不会用拥有历史终端输出的协调器替换 `Screen`，也不会采用备用屏幕/全屏会话记录模型。React + Ink 可以支持不同的终端取舍；dshline 为它已完成会话记录保留正常的终端滚动、选择与复制。

未来的视图代码可能变得更声明式，但它的最终输出仍必须是供 `TuiSlots` 与 `Screen` 使用的有界终端行。浮层可以在打开时改变活动区域；它不能重写已提交的滚动缓冲区。

## 支持 Harness 能力

支持一个 Harness 插件并不意味着把每个插件或提供方复制进 dshline。上游服务图把其中一些接口称为 seam、另一些称为核心服务；对呈现而言，重要的区别是是否存在 dshline 可以消费的标准权威约定。

### 1. 通用能力接口

优先使用标准 Harness 接口，而不是某个具体包或提供方：

| 需求 | 权威 | 呈现后果 |
| --- | --- | --- |
| 后台工作 | `ctx.jobs` | 观察通用任务快照与变更。 |
| 委派工作 | `ctx.subagents` | 观察提供方无关的生命周期与发现。 |
| 编排工作 | `ctx.workflowEngine` + 持久 `tool-workflow/*` 记录 | 观察运行身份、阶段与成员；不持有运行句柄。 |
| 模型 | `ctx.llm` | 读取已注册提供方/模型元数据，以及配置可激活路由的可配置提供方目录。 |
| 用户配置 | `ctx.settings` | 读取脱敏的命名空间描述符；对读取时的修订号执行写入路径操作。 |
| 密钥 | `ctx.credentials` | 询问引用或记录是否已配置且可写；绝不持有值。 |
| 获取凭据 | `ctx.authorization` | 渲染 seam 的中立通知与提示词汇；不拥有登录协议。 |
| 人类命令 | `ctx.commands` | 发现并执行已注册的命令约定。 |
| 工具 | `ctx.tools` | 渲染工具拥有的呈现意图，而不是工具名的特例。 |
| 人类应答 | `ctx.userQuestions` | 注册一个终端应答者；认领本前端能够呈现的请求，绝不假设该请求只发给了本前端。 |
| 会话 | `ctx.sessionQuery` | 查询 Harness 偏好活动的会话语料库；不构建另一个数据库。其全文方法是抽象的，因此把内容搜索视为可选。 |
| 附件 | `ctx.fs` + `ctx.attachments` | 路径只作为会话本地草稿；通过当前文件系统执行有界读取，并把持久图片引用作为一个批次发布。绝不持久化字节、base64 或主机路径。 |
| 日志派生的状态 | `ctx.sessionProjections` | 消费已注册的领域快照与变更。 |
| 上下文占用 | `ctx.sessionProjections`（`contextPressure`、`contextBreakdown`、`tokenUsage`） | 读取 O(1) 折叠；绝不自行计数 token 或分词。 |
| 会话统计 | `ctx.sessionProjections`（`sessionStats`） | 读取全日志计数与墙钟时间；除了对两个已发布总量做一次除法之外不再推导任何东西。将该单元视为可选。 |
| 逐条目的上下文组成 | `ctx.tokenMeter` | 只在检视器需要时索取逐节点测量；其自身约定称之为 O(surface)。 |
| 缩减上下文 | `ctx.commands`（`/compact`） | 派发已注册的命令；观察 `compaction/*` 事件。绝不调用 `ctx.compaction`。 |
| agent 组合 | `ctx.agentPresets` | 读取名册、某个预设的组合，以及某个会话实际运行的预设；只通过这个 seam 加入或切换一个 agent，绝不用私有注册表。 |
| Host 组合 | `ctx.dshHomePath`、`ctx.baseUrl`、`dsh plugin` | 通过 Harness 自己的 home-path 服务读取配置文件名册，从 Loader 的 base URL 读取已启动的配置文件；变更只转发给 `dsh plugin`，绝不写入配置文件清单。 |
| 技能 | `ctx.skills` | 用 `snapshot({ cwd, scope: agent })` 观察按作用域解析出的有效目录；提供并检视已解析的摘要。绝不发现、加载或注入技能正文——开头带 `/name` 的一行按原样发送，它的含义由 `dsh-tool-skill` 拥有。 |
| 提供方健康 | `ctx.subagents` | 在呈现指名某个提供方可用的行之前，先向注册表询问哪些提供方存在；绝不从某一行被启用推断可用性。 |

新的 subagent 提供方应通过 `ctx.subagents` 出现；后台生产者通过 `ctx.jobs`；LLM 适配器通过 `ctx.llm`；命令或工具通过其标准注册表。真实 Codex 验收已经证明，发布 `ctx.subagents` / `ctx.jobs` 的提供方由通用 Work 显示，而不是由 Codex 专用的 dshline 代码。[Provider 验收](provider-acceptance.md)记录了该证据及其配置边界。如果所需事实在接口上缺失，改进上游约定，而不是解析文本或私下连接提供方。

技能是最后这条规则当前活生生的例子。`ctx.skills` 回答一个 agent 能看到哪些技能、其中哪些是 `userInvocable`，但真正解释人类 `/name` 手势的消费者是一个独立的包（`dsh-tool-skill`），而没有任何接口说明某个组合是否挂载了它。因此一个手工搭建的组合可以发布一个用户可调用的技能，而任何 `/name` 行都到达不了它。dshline 不推断这种就绪性——不解析预设 YAML，不检视 Cordis 的监听器注册，也不把一个名为 `skill` 的模型工具当作人类手势边界存在的证据；这些读的都是实现而非约定。它遵循 `userInvocable`，这与 Harness 自己的 Web 客户端遵循的约定相同（`session-controller` 的技能目录 Remote 仅按 `isUserInvocable` 过滤），并且这一缺口是向用户记录下来，而不是靠猜。一个权威的就绪性 seam 属于上游工作。

### 2. 已知的投影领域

领域插件可以通过 `ctx.sessionProjections` 发布结构化、日志派生的状态。dshline 可以为 `todos` 或 `goal` 这样的已知键提供原生呈现适配器，但领域与 Harness 仍然是状态权威。TUI 不得解析工具输出、折叠会话日志的第二份副本，或创建竞争性的持久化格式。

投影模式是：

```
domain plugin
        ↓ registers a projection unit
Harness projection registry drives, caches, and notifies
        ↓ snapshot + change feed
dshline presentation adapter
```

对于权威投影状态，读取 `ctx.sessionProjections.snapshot(session)`，并用 `ctx.sessionProjections.onChanged(...)` 订阅。注册表在已提交事件上驱动已注册的纯单元，给 `snapshot()` 一个同步一致的切面，并且只在单元变化时发出变更。dshline 内部的、会话作用域的观察器为确切的 `Session` 订阅一次，在该同步驱动落定后在一个微任务中合并失效，并把所有值留在注册表中供适配器通过 `snapshot()` 读取。它不是第二个投影存储。投影键的存在是进程级的，而不是每会话的能力信号：任何组合注册的键都可能出现在每个会话快照中。请解释投影值（例如 Todo 列表或 `null`），而不是把 `todos` 的存在当作这个确切 agent 启用了 Todo 的证据。这是内部架构模式，**不是**稳定的公共 `ProjectionAdapter` 接口。

`todos` 是第二个证明。`@deepseek-ai/dsh-tool-todo` 提供面向模型的 `todo_write` 工具、持久的整列表 `todo/write` 事件，以及可选的 `todos` 投影。dshline 通过一个有界的 `/todos` 浮层与一个可选的 `todo completed/total` 状态段呈现其当前快照；它不拥有任何 Todo 变更、生命周期、折叠或持久化。Todo 项只有 `content` 以及 `pending`、`in_progress` 或 `completed` 状态；每次写入替换完整列表。投影在写入前是 `null`，包含最新列表，并在下一次 `turn/start` 时清空。预期路径是：

```
@deepseek-ai/dsh-tool-todo
        ↓ todo/write and todos projection
ctx.sessionProjections
        ↓
dshline Todo presentation
```

它不得检查 `todo_write` 调用或渲染后的卡片来推断状态。

权限选择遵循同一条边界：可选的 `permissions` 投影提供部署定义的可选值与当前状态；
裸终端 `/permission` 只呈现这个选择，而选中的值运行已注册的 Harness
`/permission <preset>` 命令。dshline 从不折叠权限事件或直接调用预设服务；没有该
投影时，裸命令原样回退。

上下文智能是第四个，也是把便宜权威与昂贵权威区分开来的那一个。
`@deepseek-ai/dsh-token-meter` 发布三个投影单元——`contextPressure`（提供方最新的
提示词采样、同一采样加上此后 surface 变动的带符号启发式重定价，以及最新记录的路线
容量）、`contextBreakdown`（启发式的 system/tools/messages 组成）与 `tokenUsage`
（提供方分桶的累计值）——全部是 O(1) 折叠。状态行与 `/context` 的头条数字读的就是
它们。

同一服务还暴露 `measure(session)`，它给当前 surface 的每个节点定价并返回一份深拷贝；
其自身文档因此说明该测量是 O(surface)。那是逐条目的 X 光，规则是只有打开着的检视器
才可以索取它。dshline 把一次缓存的测量以节点价格所依赖的全部输入、且仅以这些输入为
键：Harness 自己的 surface 修订号（节点数加上 `replaceGeneration`），以及生效的定价
路线——后者读自 `session.requestHeader()`，因为 header 的 provider 与 model 正是选中
计量所依据的适配器图片定价的东西。因此一个在流式回复期间一直开着的检视器只测量一次，
而落地的压缩（compaction）或路线变更会在下一次绘制时被采纳；而每来一个 chunk 都会
变动的日志长度，特意不进入这个键。只有**成功**的测量会被缓存：计量器缺失或拒绝时会
重试，因为计量器可以在检视器首次读取之后才被挂载，而针对畸形日志抛出的错误也可能被
之后的追加修复。以上任何一项都不存在定时器。

两套词汇绝不混用。预测（projected）占用与启发式的组成并排呈现，且绝不相互相除；逐
条目价格作为估算呈现，因为节点计量是按路线定价或启发式的，而不是提供方的分词器。为了
让一个面板加得起来而把其中一套缩放成另一套，就是 dshline 在臆造记账——这也是逐条目
份额被标注为**消息上下文**份额的原因：`surfaceTokens` 定价的是对话，而 envelope 由
另一个权威定价。

来源判定遵循同一条规则。`contextPressure.projectedTokens` 作为一个预测值呈现，而不是
一个偶尔变得精确的提供方数字：与 `pressureTokens` 相等并不能证明 surface 没有动过，
因为多处变动可以互相抵消为零。压缩摘要只依据压缩自身的持久 checkpoint source 来认定
——即 `{ kind: 'plugin', plugin: 'compact' }` 标记加上该事务的 `compactionId`，以结构
方式读取，而不是通过 `isCompactCheckpointSource`，那是一个位于可选包中的值——其他任何
替换都报告为 `replaced`，因为 surface 约定允许任何生产方进行替换，也并未说明一次替换
就是一次缩减。

`tokenUsage` 的范围是 agent（智能体）自己的模型请求。压缩的摘要生成器把它的用量报告在
`compaction/summary` 上，而该投影不折叠它（上游自己的投影测试就追加了该事件，并断言
各分桶保持不动）。dshline 如实报告这一范围，而不是为它增加记账。

会话统计是第五个领域，也是 dshline 自己组合的第一个。`@deepseek-ai/dsh-session-stats`
只发布一个 `sessionStats` 单元——全日志的 `turns`、`steps`、`llmMs`、`toolMs`、
`ttftMs`、`ttftSteps`、`decodeMs`、`decodeTokens`——它们在完整的持久日志上折叠，
因此被恢复的会话报告的是它自身的全部，而不是本进程恰好看到的那一部分。`dsh-base`
不挂载它，上游自己的 TUI 与 headless 装配因此不提供该键，所以 dshline 的 bundle
patch 把这一行插入在 host 平面，与本前端自己的行并列，并且**不**放在 agent 预设之后：
该单元注册的是一个纯折叠，对模型不可见，且按会话而非按 agent 键控，所以让预设拥有它
会使 `/usage` 的性能数字取决于某个会话恰好运行哪个预设——并且会为每个已挂载的预设重复注册
同一个单元。上游所证明的事情比上面这段论证更窄：Harness 自己的 Web bundle 把同一个官方包
挂载为一行 host 层的 bundle 行，供消费它的那个界面——它的聊天统计条——使用。这一行就是同样
的处理方式，只是换了读者：一个有界的 `/usage` 小节；而上面那段理由是 dshline 自己的。

无论如何，呈现层都把该单元视为可选，而这才是要紧之处。包的可得性与能力的可得性是两个
分开的概念：随附的前端以普通依赖的形式带上它自己 bundle 所挂载的插件，而某个组合仍然
可以自由地丢掉这一行。这样做的 profile 依然能启动、能正常跑会话，并且照旧报告它的
token、缓存拆分与费用；性能小节会用一行说明本 profile 未挂载 Harness 会话统计，或者在
完全没有投影注册表时被整段省略——因为它上面那一节已经这么说过了。这里没有回退实现：
dshline 不重新统计会话日志，不安装定时器，不重放事件，也不维护自己的累加器，它在该投影
之上所做的全部算术就是两个平均值——`ttftMs / ttftSteps` 与
`decodeTokens / (decodeMs / 1000)`。

有两条规则决定什么会被打印出来，而它们是不同的规则。没有分母的推导数字会缺席，因为
`0 / 0` 不是平均值。总计墙钟时间为零同样缺席，而理由更强：在这个单元里，零意味着没有任何
贡献，而不是一次测得为零的测量。`llmMs` 只在从 `step/start` 到已组装的 `assistant/message`
这段请求墙钟时间上累加，`toolMs` 只在由 `tool/result` 配对上的 `tool/call` 上累加，因此一个
流式输出过、随后被取消的步骤，以及一个结果从未到达的调用，都会在真实工作确实流逝的情况下
把各自的总计留在零。于是 `model time 0ms` 会宣称一次 Harness 从未做过的测量。计数是例外，
并且保持无条件：`turns` 与 `steps` 来自 `step/end`，而 agent 循环在 `finally` 中追加它，
所以那里的零是一个真实的计数。

没有任何东西在 Harness 的两次更新之间做插值，让某个数值动得比投影本身更平滑。这一小节之所以
是实时的，是因为它读的正是其他一切都在读的那份会话作用域观察者切面，并借用投影变更本已引发的
那次重绘——而且由于 `sessionStats` 与 `tokenUsage` 是同一份 `ProjectionSnapshot` 里的值，
`/usage` 中两个由投影支撑的部分不可能描述两个不同的时刻。它们旁边的金额并不在那份快照里：
它仍然是 dshline 自己的定价折叠，是并列报告的，而不是包含在其中。

压缩（compaction）遵循观察/控制的分离。dshline 读取持久的 `compaction/start`、
`compaction/summary`、`compaction/end` 与 `compaction/prune` 事件来呈现变化了什么——
包括完全没有命令生命周期的自动压缩——并通过 `sourceEventSeq` 把命令结果与它点名的
事件关联起来，且仅在该事件确实被本前端投影过时才采纳。缩减本身仍属于已注册的
`/compact` 命令，它拥有校验、agent（智能体）空闲锁、取消、持久生命周期与持久化检查点。
`compactRegion` 存在于该服务上，并被特意不暴露：人类命令不接受参数，而一个范围选择
界面会是上游尚未定义的控制约定。

Goal 是一个具有两个权威的已知投影领域，dshline 分别从各自的所有者读取。所有持久内容——objective、phase、blocked reason、`roundsStarted`、`maxGoalRounds`、revision、时间戳——都来自 `goal` 投影，取自状态行已经为 Todo 与上下文占用所取的同一份会话作用域观察器切面，因此 Goal 不增加第二次 dshline 直接快照。`ctx.goals` 只回答一个问题，并且只在答案能改变读数时才被询问：对于持久 phase 为 `active` 的已投影目标，读取实时、进程局部的续跑激活。该读取是实时的，且从不缓存，因为 `disarm()` 按设计是进程局部的——它改变激活时不产生 `goal/change` 事件、不推进 revision、也不发出 `goal/changed` 通知，因此任何投影观察器都无法重建或拥有它。无法获取的激活绝不被当作 `armed`：持有持久 active 目标的恢复会话报告 `goal idle`，而不是声称本进程会继续它——这正是任一权威单独都说不出的那件事。

之所以整体读取该服务视图，是因为已采纳的这一代没有发布仅取激活的访问器，而 `GoalService.get()` 会先通过 `sessionProjections.stateOf(session, 'goal')` 解析它自己的持久部分，再与进程局部的运行时状态合并。那次内部读取属于该服务而不属于本前端，并且本前端只从其返回值中取用 `.activation`——因此权威划分是精确的，尽管在物理上还不够窄。上游若提供仅取激活的访问器，就能免去服务端的那次 `stateOf()` 读取，使两者兼得。Plan 仍由其文档化的 Harness 权威治理。

### 3. 新颖的第三方能力

第三方插件可以引入 dshline 没有原生适配器的领域。这是将来提供小型 TUI 贡献 API 的原因，而不是为每个插件承诺定制 UI 的理由。首先我们需要几个内部适配器来确立权威、生命周期与布局规则。

`TuiSlots`、`TuiSlotView`、`TuiSlotName` 与 `TuiOverlay` 是 1.0 之前实验性的词汇。它们不是稳定的 SDK，还没有承诺任何公共 API 包。持久扩展行还需要全局布局预算；在那之前，能力 UI 属于有界浮层。

**composer 与浮层共享视觉根，而不是所有权。** composer 与每一个临时浮层都通过同一个共享边框绘制——左边是 `dshline`，右边是工作区或视图身份，导航帮助在下边框内部——因此浏览器读起来像 composer 展开，而不是脱离的模态框。这种共享只是呈现层面的：浮层挂载期间仍然替换整个活动区域并接管每一次按键，composer 的缓冲区与光标不在它下面，关闭时 composer 原样恢复。共享 chrome 是一个纯辅助函数，无状态、除它所渲染的内容外无输入、没有自己的生命周期、也不持有对 Harness 的视图；输入与状态所有权不与它共享。

## Work：第一个通用适配器

Harness Work 是遵循这一模型的第一个适配器。它通过 `/work` 与一个可选状态摘要，在独立分区中呈现 `ctx.jobs`、`ctx.subagents` 与 Harness 工作流（workflow）运行。它用 `list()` 读取任务快照并观察 `onJobsChanged()`；它不消费面向模型的 `read()` 游标。它观察 subagent 生命周期边沿，并且只从 Harness 发布的 `listChildren()` 事实中丰富。没有权威关联 id，它不合并两个权威，也不发明提供方未暴露的标签或活动运行。

三个权威，一个投影层：

```
ctx.jobs                        → Jobs
ctx.subagents                   → Subagents
tool-workflow/* + workflow/*    → Workflows
```

工作流需要第二条所有权规则，这正是它们成为独立适配器、而不是在任务/subagent 投影内部再加分支的原因。任务读取按调用方作答，subagent 生命周期边沿按委派父级限定作用域，但原始 `workflow/*` 事件携带的是 `{ id, meta }`——一个运行的身份，而从不携带请求它的那个 Session。仅仅订阅那条事件流，会把另一个窗口的编排显示进这一个窗口。

因此所有权来自持久这一侧。`dsh-tool-workflow` 只把 `tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` 追加进顶层运行的父 Session，别处都不写；在 subagent 内部启动的嵌套运行不记录任何东西。`run-start` 到达了所附会话自己日志的运行可证明属于本窗口，而存活的 `workflow/*` 事件只对那些记录已经证明过的运行被接受——作为丰富信息（描述、当前阶段、最新日志行、终态停止原因），绝不作为第二份成员存储。六个 `workflow/*` 事件中只订阅四个：`workflow/start` 在 `workflowEngine.start()` 内部同步发出，因此每次都会被所有权闸门丢弃；而 `workflow/agent-end` 只会为那些其 `agent-start` 已经携带过相同 meta 的调用发出。重建只依据实时事件流：一个已死进程留下的 `run-start` 并不能证明现在有脚本正在执行，而持久的工作流历史属于 transcript（文本记录）。

这条所有权规则也换来了 Work 所做的唯一那一条关联。`WorkflowAgentInfo` 在 subagent seam 上发布每个成员的 `childId`，因此一个工作流成员与一个 subagent 生命周期期可证明是同一个子级；成员把该子级呈现在它的工作流之下，而不是在扁平的 Subagents 分区里重复一遍，而从成员导航过去到达的是同一套 subagent 呈现。没有其他任何一对记录被联接，并且已结束的成员会释放该联接。

动画规则出自同一套纪律。弧线转子意味着 dshline 持有正在计算的证据——一个 Harness 报告为 `running` 的存活进程内子级 Agent。处于 `running` 的任务是一条注册表记录而不是一次观察，而没有发布进程内子级的提供方并不通过通用 seam 暴露中间活动，因此两者都保持静态。工作流只在它自己的某个成员在动时才动，因为引擎在两次 `agent()` 调用之间不发布属于自己的执行信号。`ctx.workflowEngine` 暴露 `start()`，别无其他可供 UI 触及的东西，所以 Work 观察工作流运行，不对它们提供任何控制。

人工验证的 Codex 提供方是这些通用约定的验收证明，而不是直接的 dshline 集成。通过 `@deepseek-ai/dsh-subagent-claude-code`、`ctx.subagents` 与 `ctx.jobs` 的 Claude Code 是合乎逻辑的下一个目标，但尚未人工验证。两者以及未来提供方的必需路径记录在 [Provider 验收](provider-acceptance.md)。

## Sessions：一个语料库，两个生命周期

Sessions 是第三个适配器，它只读取一个权威。`ctx.sessionQuery` 已经发布一个偏好活动的逻辑语料库，把 `ctx.sessions` 与任何已挂载的持久化合并，因此浏览器列出 `listSessions()` 记录，并用一次批量的 `readTitleSnapshots()` 观察折叠它们的标题。没有会话目录扫描、没有标题缓存、没有第二个索引；前端索引会在任一侧第一次变化时与语料库不一致。

这两次读取就是浏览的全部开销，而这是一个呈现层的决定，不是运气。浏览器首先是一个**选择器**：一行就是标题加相对年龄，因为这正是回答"哪一个会话"的两个事实，而其他每一个事实都在与这个答案争夺注意力。工作区、来源、可用性、血统、事件计数与会话 id 都在 `→` 之后针对**单个**会话披露。那里也正是 `listEvents()` 被读取的地方。一个事件计数与一个最后活动时间要花费一次完整的日志加载与表层折叠，因此显示它们的清单不得不在光标每次移动时都做这次读取；披露界面才是呈现它们的界面，因此打开它才是为它们付费的动作。过滤回答的是关于语料库的问题，而不是关于某一行的问题，所以它是浏览器级别的 `ctrl-f`——用 ctrl 手势，因为这里每一个可打印字符都已经是搜索输入。

归档属于 Harness，而 dshline 不呈现它。`ctx.workspaceRegistry` 拥有一个持久的、注册表全局的归档集合，`archiveSession()` 向其中添加，但上游明确记载归档是单向的、目前还不存在取消归档的操作，而且归档集合不是 `ctx.sessionQuery` 的事实——`SessionRecord` 不带任何归档字段，`SessionResultFilter` 没有归档谓词，归档变更的唯一流只有 Workspace 控制器的 Remote `follow()`。提供归档就是把一次不可逆的隐藏交给阅读者；隐藏已归档的会话则会把它们从唯一还能恢复它们的界面上移走，并且需要第二个语料库权威才能知道哪些是它们。两者都等待上游出现对称的生命周期。

引擎的两个全文方法是它**唯一**的抽象接口，因此内容搜索是可选能力，而不是保证。后端未实现任何内容搜索的部署报告 `SESSION_QUERY_SEARCH_DISABLED`，浏览器在说明内容搜索已关闭的同时继续过滤它已有的行。过滤不是私有索引：它匹配一行已经显示的文本。

Sessions 还迫使了一个前端此前不需要的生命周期拆分：

```
window        terminal, key routing, model route, reader preferences
   ↓ attaches
attachment    one Agent, its log projection, its capability adapters, its views
```

当一次启动在进程生命周期内恰好驱动一个会话时，插件 fiber 与会话是同一个生命周期，`ctx.effect` 是适合拥有一切的地方。原位重新打开会话打破了这个同一性：槽位注册、日志监听器、旋转指示器以及 Work 与投影适配器都描述同一个会话，因此它们属于一个在其 agent 句柄之前拆除的 `SessionScope`。按键路由向另一个方向移动，上移到窗口，这也是为什么 `ctrl-d` 现在从启动浏览器退出，而那个浏览器不拥有自己的键盘。

重新打开只使用受支持的生命周期，别无其他：拥有的 `AgentHandle.dispose()` 使当前 agent 退役——句柄是本前端的能力，因为本前端创建了该 agent——而 `ctx.agents.resume` 打开下一个。会话记录追加进已有内容下的原生滚动缓冲区；没有任何已提交内容被重写。被拒绝的恢复既不终止进程，也不替换会话：到那时前一个 agent 已退役，因此窗口提交 Harness 的原因，并通过同一个浏览器再次询问。关掉它正是读者刻意选择新会话的方式。

## Connect：配置是四个 seam，而不是一个

Provider 配置是前端最容易滋生自己意见的地方——一个提供方列表、一个 OAuth 实现、一个它写入密钥的文件。Harness 已经拥有这一切，分为四个回答四个不同问题的独立接口：

| 问题 | 权威 |
| --- | --- |
| 哪些提供方路由根本可以配置？ | `ctx.llm.listConfigurableProviders()` |
| 现在注册了哪些？ | `ctx.llm.listProviders()` |
| 一个如何配置、在什么修订号下？ | `ctx.settings.describe()` / `mutate()` |
| 它命名的密钥是否存在且可写？ | `ctx.credentials.describe()` / `set()` |
| 需要询问时，凭据如何*获取*？ | `ctx.authorization` |

`/connect` 是这些的联结，别无其他。随之而来三个后果，每一个都是一个快捷方式被拒绝的原因：

**没有提供方注册表。**一条路由进入浏览器，是因为某个已挂载适配器声明它可配置——裸挂载的 `llm-pi-ai` 会在任何路由存在之前，为其整个已安装目录这样做。dshline 不发布提供方名称列表，因此添加提供方的适配器无需此处代码变更即可呈现。

**没有字段名知识。**存储 API 密钥需要知道哪个配置文件属性携带凭据*引用*，而两个随附适配器都把它叫做 `apiKeyEnv`。dshline 不这样：它从 `describe()` 读取命名空间的序列化 schema，取 schemastery 角色为 `credential-ref` 的属性。角色是约定；名字是巧合。

**没有登录协议。**`ctx.authorization` 渲染为一个通知形态与三个提示形态——`text`、`secret`、`select`——刻意比任何提供方自己的词汇都小。一个能渲染一个流程的接口能渲染所有流程，因此 OAuth、设备码与在提供方库提示中键入的密钥都以同一种交互到达这里。终端专属的决策只是每一半*放哪里*：通知提交到原生滚动缓冲区，因为登录 URL 与设备码是一个人最需要选择和复制的两样东西，而提示是有界浮层，因为它要接收键盘。

浏览器拥有它启动之物的生命周期。授权尝试可以带着没有挂载提示的浏览器回调等待，因此关闭 `/connect` 会中止该尝试的信号——seam 把它结算为 `cancelled`，任何已挂载的提示随之落下，而尚未观察到其信号的流程之后的任何通知或提示都会被丢弃，而不是画在不相关的会话记录上。

由于两个接口写入同一个命名空间与同一个引用，终端中做出的变更在官方 Web Models 页可见，反之亦然。两者都没有自己的存储可以与之不一致。对尚未命名引用的路由的 `<ROUTE>_API_KEY` 派生，正是为此共享的。

`/connect` 仍然**不**合并它的两个分区。可配置提供方条目由 `settingsNs` 加一个路由键寻址；授权流程由一个作用域为其所属插件注册名的 `CredentialKey` 寻址。Harness 并不发布「两者在一般情况下必须对应」的约定，因此合并这两行会是前端发明关联——与 Work 把任务与 subagent 分开时相同的拒绝。两者都被列出，各自使用 Harness 给它的身份。

改变的是断言，而不是这个拒绝。有一个适配器家族为**它自己**把该对应关系写进了文档，而且写在两侧：`dsh-llm-pi-ai` 的 `recordKeyFor` 构造 `llm-pi-ai/<providerId>`，并把那个 id 称为「pi-ai 自己的 provider id，它同时也是 harness 的路由键」，而它的 `directoryEntries` 把同一个 id 发布在同一命名空间的 `providers.<id>`。读取某一个家族自己发布的身份，正是 `connect/pi-ai.ts` 存在的目的——它已经因为同样的理由持有那些精选字段名与声明目标——所以 `piAiSignInRoute` 住在那里，而 `connect/model.ts` 保持通用：它持有一个展示模块*可以*填充的 `route` 字段，自己不推导任何东西。这个联接是被验证而不是被假定的：一个键只会对照目录**确实发布过**的路由、在它发布路由的地址上解析，因此一个不再指向这个命名空间的作用域，或一个把路由挪走的命名空间，都会回答「未知」，让登录独自站着。

这个联接之所以存在，是因为那两次写入确实是分开的，而且两者都必需：

```
ctx.credentials   the RECORD an authorization flow commits   llm-pi-ai/openai
ctx.settings      the PROFILE that registers a route         llm-pi-ai.providers.openai
```

`registerPiAiFlows` 为每个已安装的目录提供方提供登录，且「与路由集无关」，而适配器只为设置提供的那些 profile 注册路由。两半都是对的，合在一起却产生了本前端最需要解释的那一个失败：一个人登录了，流程报告成功，而 `/model` 仍然什么都没有。`connect/activation.ts` 就是那句缺失的话，并且不多做一点——它针对一次**全新的读取**提供 `Activate this route`，也就是浏览器本来就有的那个动作，并且只在人选择时才写入。**认证成功并不等于同意更改提供方配置**，因此取消、`Not now` 与关闭浏览器都让设置保持原样；而依据陈旧快照来判断，则意味着把一份空 profile 写在别的东西期间已经配置好的路由之上。

### 授权 seam 是一行 dshline 自己组合的行

在被采纳的这一代里，没有任何随附的 Harness 组合包挂载 `@deepseek-ai/dsh-authorization`——`dsh-base` 没有，`web-app` 没有，`headless` 没有，`acp-app` 没有，`dsh` 应用本身也没有。唯一向它注册流程的包把该注册限定在这个 seam 存在时（`ctx.inject(['authorization'], …)`），因此一个没有这一行的组合，对任何提供方都没有账户登录：`/connect` 的 Sign-ins 分区永远为空，而以账户认证的提供方在终端里无法触达。

所以 dshline 自己的 `cordis.patch.yml` 插入了它，与它插入 `session-stats` 完全一样，理由也一样——一个本界面要读、而 base 并不携带的 host 平面 seam。这是组合，正是一个 bundle 的用途；它不是 dshline 在实现、包装或安装任何东西。seam 与每一个流程仍然属于 Harness。

另一条路被考虑过并被否决。`dsh-authorization` 不声明 `dsh.bundle`，所以 `dsh plugin add` 会把它作为一个什么都不组合的普通依赖装上——正是 `/profiles` 已经会报告的「装了却是惰性的」状态——而要把这件事做完，就意味着 dshline 往 profile 自己的 `cordis.patch.yml` 里写一行组合，而那个 patch 层没有任何 Harness 变更 API 拥有。为一个 bundle 直接组合就能得到的能力去做首次运行安装器，是在不需要生命周期的地方多造一个生命周期。

由于这一行现在归 dshline 挂载，它的形状也就成了 dshline 的兼容性问题：`tests/capability/authorization.probe.spec.ts` 把真实服务挂载在一个真实的抽象 `CredentialProvider` 子类之上，而 `tools/capability-probes.mjs` 把它列为 `authorization` seam 的证据。

seam 接口本身在 `connect/harness.ts` 中结构化写出，而不是依赖整个服务，原因与 `SessionQueryReads` 给出的一样——点名一个视图调用比依赖整个服务更易读。该文件里的每一个导入仍然只是类型导入，所以 Connect 在运行时不携带任何 Harness 代码；`connectSeams` 中的三处赋值在每次构建时把每个窄视图与真实服务做校验，因为每个服务包都用自己的类型扩展了 `Context`。

### Connect 2.0：一条路由可以是声明，而不只是查找

`listConfigurableProviders()` 说明哪些路由是适配器已经知道如何激活的。它对一条尚不存在的路由——一个私有网关、一台自托管服务器、一个本地 OpenAI 兼容端点——什么也不说，因为 `LlmConfigurableProvider` 里没有任何字段标记「这个命名空间接受一个它从未见过的键」。这在当前 Harness 上是真实存在的空缺：没有通用 seam 能让配置界面询问「我可以在这里声明一条全新的路由吗」，官方 Web Models 页填补这个空缺的方式与本前端相同——具体地知道 `llm-pi-ai` 的设置配置文件能够描述整条提供方路由。

一个把命名空间的路由形状化为 `dict` 的 schema——即「一个元素节点描述每一个键，无论是否见过」这一形状——只证明了该处结构上接受任意键。它不能证明写入这样一个键就声明了一条新的 LLM 路由：未来某个适配器完全可能发布 `providers: dict<ProviderConfig>`，却仍然只识别一组固定的键，而 schema 形状本身对此不会给出任何相反的说明。`/connect` 不允许这个推断跨入通用代码。`connect/model.ts` 把 `ConnectNewRouteTarget` 保持为一个纯粹的数据形状——一个命名空间、一个父路径、一个修订号——并且不断言哪些命名空间可以安全地产出这样一个目标；它绝不在那里仅凭 schema 形状推导出来。

这一判定只做一次，在 `connect/pi-ai.ts` 内部完成，它是唯一被允许知道 `llm-pi-ai` 具体是一个其设置配置文件能够描述整条提供方路由的领域的模块。`piAiDeclarationTarget()` 先把目录过滤到 `llm-pi-ai` 自己的条目，再检查它们是否就其 dict 所在位置达成一致、该处的 schema 是否真的把它形状化为一个 `dict`、精选的 `baseURL` 字段是否仍然可达，以及是否仍能推导出一个协议选项——这与 `protocolChoices()` 所做的是同一个 schema 形状检查，因为一个此模块无法为其提供协议的命名空间，同样也是一个它无法安全地向其声明路由的命名空间。任何一项检查失败都意味着 schema 已经偏离了这个呈现模块所知道的读法，而 `+ 添加自定义提供方` 只在每一项检查都通过时才被提供——绝不提供一行注定会在向导中途失败的选项，这与 Connect 其余普通动作已经遵循的「不提供已知会失败的选项」规则相同。如果 Harness 之后发布了自己的声明 seam，`piAiDeclarationTarget()` 就是该被替换的函数，而不是 `connect/model.ts`。

知道一个地址存在，不等于知道该往那里写什么。一个精选编辑器需要「基础 URL」「协议」「请求头」「模型目录」这类没有任何通用 seam 会发布的字段名，因此呈现它们本身就意味着了解某一个命名空间的形状。这份知识与上面的声明检查一起被隔离在 `connect/pi-ai.ts` 中，而且它：

- 把它精选的五个字段（`displayName`、`baseURL`、`api`、`headers`、`models`）命名为普通字符串，并从命名空间自身的序列化 schema（字符串常量的 `z.union`）读取协议*选项*，而不是一个 dshline 常量，因此 `dsh-llm-pi-ai` 之后新增的协议无需在此变更。判断哪些字段值得一个终端表单的标准，是一条路由能够**抵达**什么：`headers` 因此入选——一个用 `credential-ref` 字段以外的方式做认证的网关，否则根本无法从终端抵达——而 `compat`、重试策略与每个模型的推理设置因此留在外面；
- 即便字段名是硬编码的，字段的**形状**仍从 schema 读取：只有在命名空间仍然把 `headers` 描述为字符串 dict 时才提供它，这与一个无法读取的 `api` union 会产生零个协议选项而不是一份陈旧列表，是同一个失败关闭检查；
- 通过其他每个 Connect 动作已经使用的同一套 `ctx.settings.mutate()` 路径操作写入——每个变更字段一个 `set`/`unset`，绝不整体替换，因此 `compat`、重试策略以及本次未渲染的其他一切在编辑后原样保留；
- 在运行时从不导入 `@deepseek-ai/dsh-llm-pi-ai`，不注册任何提供方，不解析任何模型输出，也不发起任何网络请求。这些事情仍然全部由 Harness 完成。

创建向导本身的失败关闭方式与它的声明检查一致：如果它在向导实际打开的那一刻推导出的协议选项为空——即那一行被展示与向导真正开始之间发生了 schema 漂移——它会立即拒绝，而不是写入一个 Harness 会在几步之后以一个信息量更少的错误拒绝的、被猜测出来的 `api: ''`。而且这个向导从不在中途持久化：每一个字段，包括模型目录，都先被收集进一份内存中的草稿，只有在最终审阅——展示回 Provider ID 与其余每一个字段，API 密钥永远只显示「已配置」或「未设置」——上明确选择「创建提供方」，才会触发第一次写入。特别是离开模型子菜单而未采纳任何内容不会改变任何东西：一条继承其目录的路由会保持继承状态，直到一次真正的采纳发生，绝不会仅仅因为子菜单被打开又关闭，就变成一个被存储的 `models: []`。

`connect/model-editor.ts` 与 `connect/route-editor.ts` 建在其上：前者是模型列表草稿的纯逻辑（采纳一个被发现的候选项而不覆盖手工修正过的容量，把继承的目录与显式的空目录区分开），后者把其他每个 Connect 动作已经使用的同一套 `promptSelect` / `promptText` 浮层编排成两个小型菜单循环——编辑一条已声明的现有路由，与声明一条新路由——而不是一个定制的表单浮层。

模型发现是建议性的，并且这一点由构造保证：`ctx.llm.discoverModels()` 接受一份草稿（对已有路由是 `provider`，好让所有者适配器自行解析它自己存储的凭据，本前端永远不会把它读回来；对尚不存在的路由则是一次性的、手动键入的密钥）并回答候选项。一个 id 已在草稿中的候选项会被原样保留——一份端点列表至多携带一个 id、一个名字与两个容量，永远不会比一行已被人工修正过的记录知道得更多——而且在读者明确保存之前，任何取来的内容都不会被写入。

结果正是验收测试所围绕的那个形状：

```
custom endpoint
    ↓
Harness settings  (ctx.settings.mutate through connect/pi-ai.ts's path ops)
    ↓
llm-pi-ai         (resolves the declared profile into a live provider)
    ↓
ctx.llm provider route
    ↓
dshline /model
```

而绝不是：

```
custom endpoint
    ↓
dshline client
```

dshline 不发起任何提供方 HTTP 请求，除了在一次显式的创建之后交给 `ctx.credentials.set()` 的那个一次性值之外不持有任何密钥，也不保留第二个状态存储：一条被创建的路由可以通过与每一条目录路由完全相同的 seam 来寻址、编辑与移除。

## 预设：组合属于 Harness，不属于 dshline

agent 预设是 Harness 自己对"这个 agent 能做什么"的回答——一个由工具、提示词分节与委派后端
构成的具名组合，通过 `ctx.agentPresets` 解析，并在其生命周期唯一受支持的那个点
`setup(agentCtx)` 上加入某个 agent。`/plugins` 是这个 seam 的终端呈现：它列出名册，展示运行中
agent 的预设实际组合的那些行，并通过与官方 Web 界面所做变更相同的权威执行变更。它不保留插件
注册表、能力列表，也没有自己的提供方专用分支——正是本文档中每一个适配器都遵循的同一条规则，
只是从"它能与哪些提供方对话"换成了"这个 agent 有哪些工具"。

**系统预设属于 Harness，在这里保持只读。**随部署一同提供的预设带有 `system` 信任等级；
`/plugins` 绝不编辑那个文件。定制其中之一走的是 Harness 自己支持的路径——把它复制为一个新的、
本地编写的预设（`ctx.agentPresets.copy()`），然后编辑副本——在内置预设的行上按空格，正是终端
提议去做这件事，而绝不是绕过它的捷径。用户编写的副本除了它自己的组合文件之外，没有更窄的
Harness 变更 API，因此在那里切换一行是只触及该字段、其余部分原封不动的最小编辑；结果是否可用，
仍由 Harness 自己对该预设的健康检查决定，而不是私自重新读取它。

**会话组合是生命周期事实，不是本前端保存的设置。**新会话按名册当前的默认值组合。已恢复的会话
按它自己日志所记录的内容组合——它被创建时所用的预设，或它还空白时做出的后续切换——而绝不是
*今天*碰巧是什么默认值；已产生会话的工具集是历史，把它当作活动设置会让它在一段已经发生过的
对话脚下漂移。究竟是哪个预设，从 Harness 自己的 `agentPreset` 会话投影读取——它把创建时的
header 与其后每一次选择折叠在一起；dshline 不从原始日志重建任何东西，因此恢复路径与
`/plugins` 不可能对一个会话实际运行什么产生分歧。

**提供某个动作与授权某个动作是两件事。**切换一个会话的预设是 Harness 的完整操作——
`ctx.agentPresets.select()` 按会话串行化各次选择，在该队列内部重新读取权威的 `turnBoundary`
投影，拒绝已开始的会话，重新组合，并且只有在重新组合已提交之后才记录这次切换。`/plugins`
调用它并报告答案。本前端仍然决定的，只是把什么摆到读者面前：对已开始的会话，提供的是
*下一个会话的默认值*，而不是一次它得不到的切换。那个提供读取的正是 Harness 会重新检查的同一个
`turnBoundary` 投影，并且在被执行的那一刻读取，而不是沿用决定某次按键时的读数——这里的一个动作
要跨越自己的若干 await：两次由人回答的提示、一次文件写入、一次 Harness 重新解析，而跨越它们
开始的一轮必须改变答案。它是一个恰好与权威一致的呈现决策，绝不是权威的第二份副本。

在无法精确定位那段历史的地方，缺口被点名，而不是被含糊带过。在 dshline 采纳预设之前产生的会话
根本没有记录预设，因而按随附的 `standard` 恢复——这个预设的含义正是每个这样的会话当初实际
运行的那套扁平工具集。未提供可用 `standard` 的部署没有诚实的等价物，因此恢复回退到该部署自己的
默认值，并把这次替代报告进 transcript（文本记录）。直接拒绝恢复等于为了保护一份组合记录而扣下
它所属的会话记录，这是错误的取舍：读者能看见一条提醒，却看不见一个打不开的会话。

这也是 dshline 自己的组合为采纳它而改变形态的原因。在预设之前，dshline 为整个进程一次性挂载
`dsh-base` 的完整工具集——对一个无从切换的前端来说是正确的，但对一个浏览组合的命令来说什么也
不是。`dsh-base` 过去无条件挂载的每一个按 agent 的行，现在都移到某个 agent 实际加入的预设之后，
与 Harness 自己的 Web bundle 出于完全相同的理由已经走过的"agent 平面移到 agent 预设之后"是同
一步；而没有按会话含义的进程级服务——各类注册表、沙箱与审批栈、token 计量器——原地不动。

## 配置文件提供；预设暴露

两个 Harness 层回答两个不同的问题，而混淆它们正是本前端要让人看见的那个错误。

```
profile   what the HOST can do    dsh.profile.bundles → patch layers → the composed tree
preset    what an AGENT may see   agent.cordis.yml rows → one agent's tools and prompt
```

配置文件由启动器选定，并在启动时应用一次。预设按会话选定，并且可以在会话还空白时重新组合。
因此 `/profiles` 和 `/plugins` 不是同一件事的两个视图：它们分处一条边界的两侧，而它们之间的
每一处差别都由此而来。

**某一行被启用只能证明后半句。**随附的 `standard` 预设在它自己的可选委派行旁边就是这么说的
——"在这个配置文件中安装对应的 Bundle 并重启 Host，然后复制这个预设，并从对应的工具行上移除
`disabled`。仅有 Host 可用性并不授予工具。"反过来的情况更容易不小心撞上：启用一个其 bundle
从未安装过的行，得到的是一个能挂载的预设、一个模型看得见的工具，以及一次首次使用就失败的委派。
`/plugins` 在能够*证明*的地方补上这个缺口——某一行指名的提供方是已挂载的 Host 注册表并不提供的，
它会被标注，而该行自身的状态保持诚实。在证明不了的地方，它什么也不声称：这项检查是一张能力模块
的数据表，因此它未覆盖的模块、它从不求值的 `!!js` 提供方，以及这个配置文件并不挂载的注册表，
都产生"没有判定"而不是一个猜测。

**重启是这条边界的一部分，而不是关于它的一句附注。**`/profiles` 通过 Harness 自己的包生命周期
`dsh plugin` 执行 bundle 变更，然后说明它影响了什么、没有影响什么：对运行中配置文件的变更报告
`restart required`，对其他配置文件的变更指出接手它的命令。切换配置文件根本不提供，因为没有
seam 能重新链接一个已组合 Host 的 bundle 层，而发明一个正是本文档所禁止的那种竞争性生命周期。

### 启动器唯一的生命周期决定

`bin/dshline.mjs` 是一层启动器封装，首次运行是它唯一触及生命周期的时刻。它询问一个问题，回答“是”时通过与普通启动完全相同的启动器执行一条 Harness 命令——`dsh plugin --profile dshline add @dshline/dshline`——然后继续执行最初要求的那次启动。它不写任何配置文件文件，从不调用 pnpm，也从不读取某个包的 `dsh.bundle` 声明：这些都属于 `dsh plugin`，它本来就会在首次使用时初始化配置文件，并按实际安装状态对账 `dsh.profile.bundles`。

边界就是一个文件。**未初始化**意味着配置文件没有 `package.json`——这正是 `dsh plugin` 自己采用的判据——其余一切都是**已存在**的配置文件。因此，安装被中断的、缺少依赖的、`node_modules` 为空的，或者根本启动失败的配置文件，仍然会照常启动，由 Harness 自己的加载器说明问题所在。在这里修复它，等于去猜一个 Harness 有权威结论的诊断，并把它藏在一次没人要求的软件包操作背后。显式的 `--profile`——包括 `--profile dshline`——会完全关闭这个行为：调用方在直接使用 Harness 的配置文件语义，封装层不再往里添加任何东西。

**dshline 不为 Harness 的配置文件变更做串行化，也不修复它们。**并发的软件包变更由 Harness 定义；dshline 只执行它获得许可的那次安装，并把 Harness 的成功或失败当作权威结论——安装失败就让这次调用失败，什么都不启动。因此两次重叠的首次运行各自委派一次，而不是其中一个去判定另一个的安装已经完成。那个判定在本地没有诚实的答案：`dsh plugin` 在安装*之前*就写入配置文件清单，所以该文件只能证明有一次安装开始了，永远无法证明某次已经完成，而要分辨这一点就得去读依赖、node_modules 或 bundle 状态——也就是上一段留给 Harness 的配置文件健康状况。在 `$DSH_HOME` 下加锁，正是本文档禁止的竞争性生命周期。

## Setup：一个指挥者，而不是向导

在「安装 dshline」与「发送一个回合」之间隔着两件事，而它们分处一条边界的两侧。`bin/dshline.mjs` 只能创建 profile，此外什么都做不了——它在任何 Host 存在之前运行，因此 `ctx.llm`、`ctx.settings`、`ctx.credentials` 与 `ctx.authorization` 全都够不着，而去够它们会让这个 wrapper 成为 Harness 之外的第二个 Harness 状态读取者。因此「profile 有了 manifest」之后的一切都属于插件，而那些 seam 本来就都在那里。

所以 `src/setup/` 在已组合的 Host 内运行，而 `dshline --setup` 保留它既有的含义（把这个包安装进 profile）。该流程在第一次附着之前自动打开；`/setup` 则随时按需打开它。

**触发条件问的是这次启动能不能发送一个回合，而不是有没有路由存在。**只看路由注册是错的问题：一条已注册的路由只是 `/model` 从中提供选项的来源，而输入框打开时用的是 `selection.current` 解析出来的东西。因此 `setupReason` 读取窗口已经持有的两样东西——`ctx.llm.listProviders()` 与 `/model` 写入的那个 selection ref——并给出三种状态之一：什么都没注册、什么都没选中，或者选中的东西所指的路由没有被任何适配器注册（一个其提供方已离开该 profile 的、被记住的默认值）。

那是两次同步读取，没有 I/O。它刻意止步于**提供方**粒度：某条路由是否仍然提供那个确切的模型 id，只有 `listModels` 能回答，而去问它会在每次启动前放上一次可能的网络调用，只为细化一个选择器本来就会给出的判定。任何地方都没有首次运行标记——一个存下来的「已完成设置」标志是可能与它所声称描述的配置不一致的重复状态，而每次启动都重新询问实时状态则不会。

setup 贡献的只是一次读取与一个顺序，此外没有别的。这个顺序由「缺什么」领头：一旦有路由被注册，`Choose a model` 排在第一位；而当 `/connect` 关闭、刚刚产生了第一条可用路由、而选择仍然缺失或陈旧时，指挥者会自己打开选择器，而不是回到一张只会告诉你去打开它的清单。做这件事的是指挥者，永远不是 `/connect`——浏览器仍然只是浏览器，对 setup 一无所知——并且只在模型正是那块缺失的拼图时才做，因为连接第二个提供方并不是更换一个已经可用的选择的请求。

每一步都交给一个本来就是该事权威的浏览器——`/connect` 负责配置与认证，`/model` 负责选择——因此这里没有第二个路由编辑器、没有第二份模型目录，也没有状态机：循环每一轮都重新读取 Harness 并提供此刻为真的东西，这也是为什么中途退出不留下任何东西，运行两次与运行一次结果相同。

那次读取是**提交到滚动缓冲区而不是画在浮层里**的，这是终端模型在做实事，而不是风格选择。版本号，以及那句说明为什么没有模型的话，是最值得保留的输出；有界的活动区域会在下一样东西被画出来的那一刻把它们滚走，而这恰恰是一个人要粘贴进缺陷报告的文本。它用到的唯一活动区域接口是 `promptSelect`，它已经是有界、抗缩放且被测试过的。

### 一次兼容性检查可以断言什么

在被采纳的这一代里，Harness 不发布运行时版本服务——没有 `ctx.version`，`dsh-brand` 只是编译期标记，而 `dsh-plugin-package-inventory-deepseek` 构建的包清单只作为官方 API 的请求元数据。因此证据是磁盘上的 manifest，并通过 `/profiles` 已经拥有的机制读取：被采纳的世代是本包自己的 `dsh-*` peer 钉住值（`tools/harness-target.mjs` 证明它就是 `HARNESS_TARGET.version`），而你拥有的那个是运行中的 profile 所组合的 `@deepseek-ai/dsh-base` 版本。

由此得出三条规则，每一条都是一次拒绝：

- **标记就是断言，所以未知不带标记。**任一侧读不出来就是 `·` 并如实说明——永远不说「不兼容」，也永远不说「没问题」。
- **不一致只陈述它能证明的那个方向。**安装这个构建所面向的世代是确定性的，因为那个版本是报告本来就持有的事实。反过来移动 dshline 并不是它的镜像：`update` 取的是注册表此刻提供的东西，而这里没有任何东西知道是否存在某个已发布的 dshline 面向已安装的那个世代。因此那个方向是作为一个条件给出的，而不是一条指令——要确定它就意味着把各个发布版本对照它们的 peer 钉住值去解析。
- **它从不拒绝继续。**在 dshline 能够比较世代的时候，两半已经一起启动到足以画出这个比较；提供「仍然继续」会暗示一个 Harness 已经用「它启动了」这件事否证过的判定。真正不兼容的一对会更早、更响亮地失败在 Loader 里，而那个诊断属于 Harness。

Node 不带判定，出于同一理由的缩小版：这个进程正运行在它上面，所以打勾是循环论证，而把 `engines` 变成通过或失败意味着求值一个 semver 范围。

## 观察不是控制

可调用的 Harness 变更不自动是人类安全的 UI 操作。在暴露人类操作之前，验证所属接口是否明确提供该操作的生命周期语义、授权、调度语义以及模型感知或通知后果。

Sessions 是指向另一方向的案例。`AgentHandle` 交给创建该 agent 的调用者，其文档说明处置器是那个所有者持有的能力——因此使 agent 退役在这里是被授权的，而重新打开会话是前端可以采取的人类操作。Harness **不**定义的是，当其所属 agent 中途消失时，任务或委派 subagent 应该发生什么，因此窗口在任一者附着时拒绝重新打开，并拒绝在一轮进行中时重新打开，点名原因而不是猜测。重命名会话因镜像的原因被推迟：`ctx.sessionTitle` 建模明确的 `user` 权威，因此它会在浏览器拥有文本输入模式时暴露，而不是作为列出标题的副作用。

`ctx.jobs.kill()` 是当前的反例：成功取消把任务移到 `stopping` 并标记终端交付已报告，这是面向模型的控制语义。因此 Work 观察任务，但不提供人类取消。`ctx.subagents.interrupt(..., { kind: 'user', parentSessionId })` 是相反的案例：seam 明确建模人类停止活动可续 subagent 的权威。这条规则适用于每一个未来能力，而不仅仅是 Work。同样，Work 呈现生命周期与任务状态，而不是提供方推理、命令、工具活动、进度或 diff，除非 Harness 通过通用约定暴露这些事实；它绝不能刮取提供方输出。

## 上游兼容性

dshline 对 Harness 的策略是激进跟踪、窄口支持：它一次只针对**一个已采纳的 Harness 架构**，并保持贴近上游 `master`，以便使用最新的 Harness 能力、性能改进与原生 API。当 Harness 发生不兼容变更时，做法是把 dshline 向前迁移并删除过时假设——而不是加入兼容层、运行时特性检测，或为更旧的预发布版本再添一条 peer 范围分支。两个项目都在 1.0 之前；历史预发布兼容并不是目标。

仓库根目录的 `HARNESS_TARGET` 是该架构的唯一事实来源：一个上游提交，以及从该提交切出的 Harness 版本。两个清单中的每个 `dsh-*` dependency、devDependency 与 peerDependency 都字面携带该版本——没有 caret，也没有 `||`。caret 还会承诺同一范围内更晚的发布，而那是一项没有任何测试覆盖的兼容性声明；判断某个 caret 是否仍然接受目标，正是"版本兼容引擎"要做的事，而确切版本是把这个问题删除，而不是更快地回答它。因此 `tools/harness-target.mjs` 只是一次字符串比较，任何一处规格漂移它都会失败。`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 保留普通的 caret 范围：它们按自己的编号版本化，并非从已采纳的修订版切出。

`HARNESS_TARGET` 中的两行必须描述同一代，而 CI 会证明这一点而不是信任它——`Harness target` 读取检出的 Harness 工作区根自身的 `version`，若不一致则同时打印两个值并失败。没有这道防线，源码车道与 npm 车道可能各自验证不同的代而全部通过。已采纳的修订版是一个发布代的提交，而不是 `master` 上任意一点，这正是让源码车道与已发布车道描述同一事物的原因；这并不意味着更旧的版本受支持。修改那两行就**是**迁移本身，而且只需一次提交。

覆盖被拆为三个彼此独立的问题，全部位于 `.github/workflows/ci.yml`。**Core** 是 dshline 自身在每个受支持 Node 上的正确性，针对已采纳那一代的已发布包。**Harness target** 按那个确切提交从源码检出已采纳的上游修订版，构建它，并用 `tools/link-harness.mjs` 链接——方式与为手动开发链接本地检出完全相同——只做类型检查加能力探针，而不是把整套测试再跑一遍。它是阻塞的，也是确定性的：一个完整的 commit sha 不会在本仓库同一提交的两次运行之间发生变化。**Harness published** 回答源码无法回答的问题：普通用户能否安装它、它能否启动，针对固定在已采纳版本上的真实已发布启动器。

Core 还会额外运行 `pnpm peers check`，而这与 dshline 自己的代码毫无关系。Harness 线为一些**刻意不**固定到 `HARNESS_TARGET.version` 的包声明了下限——`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 按自己的编号版本化——而这些下限会随代次变动。它们变动过一次，却连续两代无人察觉：未满足的 peer 只是安装时打印、构建时忽略的一条警告，而源码链接车道同样看不见它，因为链接一个 Harness 检出会用该检出自带的 vendored cordis 顶替。这个检查读取 lockfile，不需要网络，不表达任何 Harness 专属意见，只是拒绝让已安装的依赖图自相矛盾。

### 提出下一代

不再有任何东西盯着上游 `master`。跟随分支头是把正确的直觉对准了错误的对象：`master` 上的任意提交并不是 `HARNESS_TARGET` 能记录的东西，因此那个信号从来都不能被直接执行，产出它的车道必须先由人阅读并翻译才有意义。

取而代之，`.github/workflows/harness-sync.yml` 盯的是"采纳"真正是什么。上游用同一种方式标记每一个发布代——一个 tag 为 `dsh-v<version>` 的已发布 GitHub Release——而本项目采纳过的每一个修订版，恰恰就是其中某个 tag 所指的那个提交。每天若干次，`tools/harness-sync.mjs` 询问是否存在更新的一个；若存在，它把 tag 解析为不可变提交（对 annotated tag 做解引用，而不是记录 tag 对象本身；也绝不读取 `target_commitish`，那是一个分支名），核对该提交自身的根清单声明的版本与其 tag 编码的版本一致，并通过上游证明已采纳的修订版是它的祖先。任何无法证明的情况都按失败关闭，交给人来看。

只有到这一步，它才写入机械的采纳状态——`HARNESS_TARGET` 的两行、受管的 `dsh-*` 固定版本、刷新后的 lockfile，以及一条一句话的 changeset——并开启一个 pull request。

这个区分正是整个设计。提出者从不判断 dshline 是否**能工作**在候选代上；它不读源码，也不评估兼容性。上面那些任务才判断，就在那个 pull request 上，与任何其他 PR 完全一样：

```text
harness-sync   is there a newer generation to propose?
ci             does dshline work against it?
```

绿色意味着这次采纳不需要任何代码改动，由人合并。红色意味着一次真正的迁移，而答案是针对那一代向前迁移——绝不是恢复对上一代的支持。没有自动合并；是否加入自动合并，是在若干代实际运行之后另行决定的事。

有两种拒绝值得点名，因为它们都看起来像失败而实际不是。如果候选代的包仍处在仓库的发布年龄隔离期内，pnpm 会拒绝安装，运行会如实报告并停止——不开 PR、不加豁免、也不自行计算包龄。而一个已经开启的采纳永远不会被自动取代：它可能承载着迁移工作，用更新的候选强推覆盖它，恰恰会丢掉最昂贵的那部分。

开发兼容性 CI 不跟随 npm dist-tag。`next`、`alpha`、`rc` 是上游的分发渠道，而不是 dshline 的架构概念：它们会在架构不变的情况下变化，而以渠道名为键的兼容性车道每次渠道变动都需要重新设计。目标是一个确切提交与一个确切版本，已发布车道只询问该确切版本是否已经存在于注册表上。GitHub 源码先行移动，npm 随后跟上；当它尚未跟上时，该车道会如实说明并且不验证任何东西。"尚未发布"是一个发布渠道的事实，它绝不构成为更旧的已发布代编写兼容代码的理由。

### 发布渠道是另一个问题

那个"发布渠道"的事实最终确实会决定一件事，而且只有一件：某个 dshline 发布是否可以成为**默认**安装。这两种关切很容易混为一谈，而绝不能混为一谈，因为面对同一个事件它们给出相反的答案。

文档记载的安装方式是两个不带限定的包名，因此两侧都通过 npm 的默认 tag 解析：

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline
```

`@deepseek-ai/dsh` 把整条 `dsh-*` 线固定到它自己那一代，因此该 tag 提供的版本**就是**一次普通安装最终运行的 Harness 代。所以这条不变量关乎渠道，而不关乎代码：

> `@dshline/dshline@latest` 绝不能推进到某个构建，其已采纳的 Harness 代与 `@deepseek-ai/dsh@latest` 所提供的不同。

`main` 可以在 DeepSeek 把某一代提升到 npm 默认 tag 之前就采纳它，而且这会经常发生——激进跟踪正是要点所在。这个时间差**并不**产生继续兼容更旧默认代的义务：不放宽任何东西，peer 范围不长出第二条分支，也不出现运行时特性检测。取而代之的是发布等待。changeset 照常累积，生成的 `Version Packages` pull request 可以在"尚未就绪发布"的状态下停留任意久，而针对已采纳那一代的日常开发全程不受影响。

`tools/check-release-harness.mjs` 就是这道闸门，它以确切字符串相等比较 `HARNESS_TARGET.version` 与 `@deepseek-ai/dsh@latest`。两个方向上的确切性都重要：dshline 只支持一代，因此默认渠道**越过**已采纳目标同样会失败——"更新"不等于"受支持"，此时的应对是把 `HARNESS_TARGET` 迁移到 Harness 实际提升的那一代，而绝不是假定向前兼容。注册表无法访问时同样按失败关闭，并报告为"无法确立"而不是"不匹配"。

它在三个答案仍可能改变结果的边界上运行：在生成的 `Version Packages` pull request 上，使默认安装的一致性在人类合并之前可见；在 `.github/workflows/version.yml` 中于创建不可变的 `v*` tag 之前——这是首要的不可逆边界，在那里失败会留下没有 tag、没有发布、也无需清理的状态；以及在 `.github/workflows/publish.yml` 中于发布第一个包之前，因为在这期间 tag 可能由绿转红。它通过分支与仓库身份识别，而不是通过 pull request 标题；它不持有任何写权限、也不持有任何 secret：它只读取仓库中的一个文件，并向 npm 提出一个问题。

这是一道发布闸门，不是兼容性车道，并且它丝毫不改变上面那句话——不是生成的发布 PR 的 pull request 永远不会解析 dist-tag，因此由 DeepSeek 移动的指针仍然永远无法让无关工作无法合并。一旦两个默认值一致，普通的不带限定安装就重新解析出一致的一对，而这正是这道闸门始终在保护的唯一东西。

每条 Harness 车道都会额外运行 `tools/capability-report.mjs`，它把一个 seam 的真实 Harness 约定——真实的 `SessionQueryEngine`、真实的 `SubagentRuntime`、真实的抽象 `JobRegistry` 子类、真实的 `UserQuestionService`、在真实 `Session` 之上的真实抽象 `WorkflowEngine` 子类，绝不是 dshline 臆造的假对象——转化为按能力命名的通过/失败结果。目前的覆盖是初始的，而非穷尽的：`sessionQuery`、`jobs`、`subagents`、`sessionProjections`、`workflows`、`userQuestions`、`tokenMeter`（真实 `SessionStore` 之上的真实 `TokenMeter`）、`compaction`（真实的 `CompactionEngine` 子类）与 `skills`（真实的按作用域分层的 `SkillRegistry`，以及把打出的 `/name` 一行变成注入的真实 `dsh-tool-skill` pre-step 边界），之所以选择它们，是因为每一个都已经有（或能够低成本获得）一个针对真实类而非手工伪造对象构建的测试。上游对其中一个的变更读起来是 `sessionQuery contract changed`，而不只是笼统的 `pnpm typecheck failed`；尚未进入这张表的 seam，仍以 `pnpm typecheck`/`pnpm test` 作为后备。`tools/capability-probes.mjs` 是一张指针表，不是约定的第二份拷贝：它只指出哪个既有或新建的测试已经在验证每个 seam，因此扩大这一覆盖意味着往那张表里加一行（或在 `packages/dshline/tests/capability/` 下新增一个小探针），而绝不是让这个模块自己学会该 seam 的形状。

`userQuestions` 是这套雷达第一次证明它能发现真实的破坏：Harness 的 `ctx.userQuestions` 注册方式发生了变化，`packages/dshline/src/questions.ts` 一度用一个小的运行时判断把两种形态桥接起来。那个桥接属于债务而不是范式——它早于"一次只支持一代"的规则——随后的那次采纳已经删除了它：该模块现在直接注册在按作用域分层的 `user-questions/request` 瀑布上。不应再写出同类的新桥接。迁移是移除旧调用，而不是同时保留两者。
