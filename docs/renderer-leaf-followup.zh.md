# 原生叶级后续修订：准入与终端预算

[English](renderer-leaf-followup.md) | 中文

## 边界

独立 renderer 和 dshline 组合/窗口入口现在都默认使用 TypeScript。`auto` 是对已准入
原生叶级路径的显式启用，不把 StreamBuffer、Screen、回调、终端写入、Markdown 或
Harness 状态迁入 Rust。既有 `rust` 选择仍是诊断用强制模式，但不能绕过 Unicode
兼容性。没有合并、发布、安装到工作 profile、增加依赖、改变 CPU 目标、panic 策略
或 ThinLTO。

原有 2048 UTF-16 单元输入上限、±256 列准入和 auto 阈值不变。新增排除条件仅收窄
自动准入。在调用原生前选择 TS；已准入执行产生的错误继续直接传播，不重试。

## 1. ASCII 回归族

原来的 **M1 30/120、Intel 11/120** 包含所有公共路径回归，不全是 ASCII。两台机器
合计包含 **29 个 ASCII/ANSI/稀疏 CJK 观测**（含两台机器上的重复用例）。余下 12 个
是原本已选择 TS 的 CJK/emoji 或微小宿主用例，并非可通过 Rust 查表修复的原生回归。

下列具名守卫让失利的输入族在 `auto` 中保留 TS。这是可移植的排除条件，不是平台
专用代码，也不是精确 fixture 字符串白名单。历史输入、八种变化结尾及这些族的其他
成员都保留 TS 语义。

| 守卫 | 新增自动原生排除条件 |
| --- | --- |
| `ascii-short-width` | 宽度操作：≤512 单元的 ASCII，含 ANSI 转义 |
| `ascii-dominant-width` | 宽度操作：短文本中，或长文本末尾的 ASCII 中恰好一个非 ASCII 码点 |
| `ascii-tail` | 尾部选择：≥512 单元的 ASCII/ANSI |
| `ascii-chunk` | ASCII/ANSI 分块 |
| `ascii-wrap` | ASCII/ANSI 换行：≤512 单元、≥256 列，或含转义 |

既有阈值也排除微小、窄列及长度不足的分块用例。长的无样式 ASCII 适配/宽度、普通
列预算的长 Screen 配方仍可准入，密集 CJK/查表负载亦然。守卫是路由修复，**不代表
TS 比经审查的原生基线更快**：回退可能更慢，原始前后中位数保留这一代价。

新增测试从已提交的原始档案还原历史失利输入，独立锚定 29 个观测，并统计原生执行。
刻意移除回归守卫会使测试失败。即使存在有效附加模块，显式 TS 也始终保留 TS。

## 2. Unicode 版本耦合

宽度表生成器输出 `WIDTH_UNICODE_VERSION`；Rust 查找表生成器从该已提交策略中
派生版本，并拒绝缺失或不一致的版本。附加模块通过 `unicodeVersion()` 暴露实际
已编译查找表的版本，而非构建机器的版本。任何公共原生执行之前，Node 的
`process.versions.unicode`、TS 表和已编译查找表的版本必须一致。元数据缺失、旧模块
或运行时版本不符时，即使强制模式也选择 TS。当前表为 Unicode 17.0。虽然宽度策略
本身固定，运行时 Unicode 属性也影响扫描器/格式化器行为，因此使用此保守守卫。

真实附加模块子进程测试把匹配、不匹配和缺失的运行时版本，与实际、不匹配和缺失的
编译元数据交叉，逐值比较宽度、尾部、适配、换行、分块、单码点、frame 和 Markdown。
匹配运行时确实调用 Rust；所有不匹配组合的原生变换调用数均为零。刻意禁用运行时
守卫会使调用计数断言失败。全域查找表新鲜度与穷举检查继续保留。

## 3. 真实 PTY 流式整轮

基准复用既有 consumer-smoke 的 `script(1)` PTY 方案和已安装的 xterm 模拟器，不引入
node-pty 或其他依赖。它打开两个真实的 80×24 控制终端会话：一个显式 TS，另一个
显式启用 `auto`（仅已准入的 Rust 叶级操作）。生产 dshline `StreamBuffer`、renderer
`Screen` 和输入框 frame 消费一条完整确定性回复：**65,536 UTF-16 单元、32 条长逻辑行、
512 个 128 单元 delta**，包含 live 重绘、scrollback 提交、组装消息核对和最后清理。

每个负载先预热一次，再交替 TS/Rust 顺序运行五组配对整轮；本机不同时运行构建/测试。
从发送终端输入开始计时，直到输出经过 PTY 并被模拟器消费完。每对输入、按序终端
字节、完整模拟器 scrollback/光标必须一致；TS 原生调用必须为零，Rust 启用轮必须
实际调用原生叶级路径且不得调用原生 JSON 复合操作。原始记录含首字节延迟、内部
渲染时间、PTY 消费延迟、完整模拟器消费延迟、吞吐量及各操作调用计数。

这是实际 PTY 的**呈现整轮**预算，不是内存微基准、物理显示绘制、Harness 会话启动
或 provider/model 响应时间。不需要且不包含凭证、网络或模型调用。模拟器与终端传输
可能主导用户可见预算，不能把内核收益报告成整个模型轮的收益。

## 复现

构建当前代码与必需附加模块；以相同工具链分别构建经审查基线 `5e48b70` 和守卫前
候选 `af3459e`：

```sh
pnpm build
node tools/build-renderer-native.mjs --required
node tools/renderer-upgrade-bench.mjs --baseline-root /path/to/5e48b70 --previous-root /path/to/af3459e --output public.json
node tools/renderer-pty-bench.mjs --output pty.json
```

公共工具在同轮比较审查基线、守卫前版本、新自动分派、显式 TS 及两个直接附加模块，
记录原生调用和具名守卫，计时前检查等价性，结束后再核验源码/构建/二进制身份。
它保留八种输入变化、校准批次及三次轮换。中位数属于批次平均值，不是单调用尾延迟。
PTY 工具要求兼容运行时和真实附加模块；若 Rust 实际回退则失败，不会冒充原生计时。
`--smoke` 在较短整轮上验证同一 PTY 协议，不作完整预算声明。

手动分派 `ci.yml` 会在两台真实 Mac 上运行公共与 PTY 测量；普通 PR 仍要求六目标
原生正确性。之前的临时 ThinLTO 实验不再重跑，也不采用。

## 被拒绝的对照与测试台检查

第一个守卫实现本身造成 M1 长 ASCII 宽度回归：审查基线 2.09 µs、守卫前 1.94 µs、
守卫后 9.65 µs。该构建被拒绝，不与最终结果混合。仅改为首个非 ASCII 搜索仍给 Linux
增加一次完整扫描；最终守卫先检查长文本的稀疏 Unicode 后缀，普通长 ASCII 不再付出
第二遍 JS 文本遍历代价。初始原始数据明确保留为 `*-initial.json`。

首轮修正后的 Mac PTY 尝试未通过严格 CJK 输出等价性：M1 为 803,311 对 803,309 字节，
Intel 为 803,310 对 803,309 字节，计时均拒绝采用。诊断工具现在分别记录 Screen
产生的写入身份和 PTY 字节流，保留精确失败字节与上下文；不豁免等价性、不经 TS
重试，也不改变生产准入。刻意给 auto 增加 `CORRUPT` 写入会使 PTY 断言失败；不在
真实 PTY 中运行 worker 也失败。原生构件仅在等价性门禁通过后上传，性能失败证据
则继续保留。

诊断 M1 失败中，两种模式生成的写入 SHA-256 均为
`541b48eea21c0c6fb5788a3baece71a42c11976736fd2645f4d30d427556beda`，
模拟器状态也相同。首个差异位于字节 90,047：一条流在原本相同的 CRLF 前多一个 CR。
移除 CR 后完整字节流一致，但**基准不做此归一化**。Screen 本身已显式输出 CRLF，
因此基准仅在进入原始输入模式后，对私有 slave 禁用 OPOST；接着既要求每条收到的流
与生成的 Screen 写入具有完全相同的长度和哈希，也要求两后端一致。失败原始流和
上下文保留在[拒绝的 PTY 证据](../benchmarks/renderer-pty-darwin-arm64-rejected/evidence.json)。
生产终端配置不变。

Intel 曾在单个五秒 Vitest 预算下，用 5.855 秒完成九个 Unicode 子进程。现将九种组合
拆成九个独立报告的测试，每个仍保留原五秒限制和全部断言，不延长超时或减少覆盖。

## 最终证据与中位数

测量源码/工具提交：`2c74b500ca4d511ff620f311f558be75d6b322a7`。
生产 renderer 源码最后修改于 `f5a2616`；之后仅改测试台、测试 fixture 设置、文档与
证据。保留原始 provenance，不重新标成最终报告提交。每个平台三个源码 checkout
都使用 Rust 1.99.0 / LLVM 23.1.1 和 Node Unicode 17.0：Linux Cortex-A76 / Node 24.18，
M1（Virtual）/ Node 24.20，Intel i7-8700B / Node 24.19。不要跨这些环境排名硬件性能。

**原来标记的 41 个观测在 auto 中均为零次原生变换**：包括 **M1 20 个 + Intel 9 个
ASCII 族观测**，以及原本就在 TS 路径的 12 个非 ASCII/微小宿主观测。同轮守卫前
复现中，**M1 5/20、Intel 4/9 ASCII 族用例**比审查基线慢 >10%；其他原始标记未在
该阈值重现，仍保守地保留守卫。这里复现了每个原始输入，不代表每个原始回归都稳定。

### 每个原始 ASCII 族观测

单位均为 **µs**，同轮比较：审查原生基线 → 守卫前候选 → 新 auto 守卫路径。末列
说明实际 TS 排除条件；JSON 还记录既有阈值先触发时匹配的具名守卫。
`op/kind/units/columns` 唯一识别公共负载。这些用例是**守卫回退，不是统一加速**；
其中有的有意付出明显的 TS 开销。

| 平台 | 负载 | 审查基线 | 守卫前 | 守卫后（TS） | TS 排除条件 |
| --- | --- | ---: | ---: | ---: | --- |
| darwin-arm64 | displayWidth/ascii/96/40 | 0.26 | 0.27 | 1.02 | ascii-short-width |
| darwin-arm64 | displayWidth/ansi/96/40 | 0.28 | 0.27 | 1.10 | ascii-short-width |
| darwin-arm64 | displayWidth/ansi/512/40 | 0.63 | 0.69 | 5.57 | ascii-short-width |
| darwin-arm64 | tailToWidth/ascii/2048/40 | 7.97 | 9.40 | 29.89 | ascii-tail |
| darwin-arm64 | tailToWidth/ansi/2048/40 | 7.01 | 7.55 | 26.10 | ascii-tail |
| darwin-arm64 | wrapToWidth/ascii/96/40 | 2.09 | 2.44 | 4.11 | ascii-wrap |
| darwin-arm64 | wrapToWidth/ascii/512/40 | 10.62 | 10.84 | 19.82 | ascii-wrap |
| darwin-arm64 | chunkToWidth/ascii/512/40 | 8.26 | 6.47 | 8.29 | existing narrow-row threshold |
| darwin-arm64 | chunkToWidth/ascii/2048/40 | 32.53 | 25.93 | 31.38 | existing narrow-row threshold |
| darwin-arm64 | chunkToWidth/ansi/24/40 | 0.55 | 0.55 | 0.51 | existing minimum length |
| darwin-arm64 | chunkToWidth/ansi/96/40 | 1.64 | 1.52 | 1.72 | existing minimum length |
| darwin-arm64 | chunkToWidth/ansi/2048/40 | 33.73 | 28.03 | 33.64 | existing narrow-row threshold |
| darwin-arm64 | wrapToWidth/narrow/512/32 | 11.73 | 13.79 | 20.91 | ascii-wrap |
| darwin-arm64 | wrapToWidth/narrow/512/256 | 5.55 | 5.85 | 18.97 | ascii-wrap |
| darwin-arm64 | chunkToWidth/narrow/512/8 | 9.82 | 7.59 | 9.71 | existing narrow-row threshold |
| darwin-arm64 | chunkToWidth/narrow/512/120 | 4.33 | 4.90 | 8.18 | ascii-chunk |
| darwin-arm64 | chunkToWidth/narrow/512/256 | 4.10 | 4.81 | 8.46 | ascii-chunk |
| darwin-arm64 | displayWidth/lateCjk/64/40 | 0.27 | 0.27 | 1.09 | ascii-dominant-width |
| darwin-arm64 | displayWidth/lateCjk/2048/40 | 1.84 | 1.92 | 27.90 | ascii-dominant-width |
| darwin-arm64 | frame/ansi/24/80 | 2.05 | 1.85 | 1.98 | existing TS host thresholds |
| darwin-x64 | displayWidth/ansi/24/40 | 0.64 | 0.47 | 0.69 | existing minimum length |
| darwin-x64 | tailToWidth/ascii/512/40 | 6.48 | 7.98 | 13.69 | ascii-tail |
| darwin-x64 | wrapToWidth/ascii/24/40 | 2.71 | 2.46 | 2.82 | existing minimum length |
| darwin-x64 | wrapToWidth/ascii/96/40 | 6.81 | 8.03 | 11.39 | ascii-wrap |
| darwin-x64 | wrapToWidth/ansi/2048/40 | 116.81 | 152.99 | 213.42 | ascii-wrap |
| darwin-x64 | chunkToWidth/ansi/96/40 | 7.51 | 3.57 | 6.65 | existing minimum length |
| darwin-x64 | wrapToWidth/narrow/512/32 | 36.74 | 43.27 | 43.85 | ascii-wrap |
| darwin-x64 | wrapToWidth/narrow/512/256 | 15.24 | 14.21 | 46.55 | ascii-wrap |
| darwin-x64 | displayWidth/lateCjk/512/40 | 1.10 | 1.08 | 12.68 | ascii-dominant-width |

### 长负载对照与保留的查表收益

2048 单元负载，单位 **µs**。适配使用 40 列；Screen 配方仍是合成 CPU 对照，不是
下文真实 PTY 整轮。每个列出的 auto 对照确实调用原生。密集 CJK 查表和适配收益在
三个平台都保留。

| 平台 | 负载 | 审查基线 | 守卫前 | auto 守卫后 | 相对审查基线加速 |
| --- | --- | ---: | ---: | ---: | ---: |
| linux-arm64 | displayWidth/ascii | 3.34 | 3.38 | 3.40 | 0.98× |
| linux-arm64 | displayWidth/cjk | 49.29 | 8.44 | 8.69 | 5.67× |
| linux-arm64 | fitToWidth/ascii | 4.69 | 2.00 | 2.00 | 2.35× |
| linux-arm64 | fitToWidth/cjk | 51.05 | 1.61 | 1.62 | 31.49× |
| linux-arm64 | screen/ascii | 718.59 | 231.19 | 230.33 | 3.12× |
| linux-arm64 | screen/cjk | 1209.10 | 303.27 | 291.03 | 4.15× |
| darwin-arm64 | displayWidth/ascii | 1.70 | 1.80 | 1.78 | 0.96× |
| darwin-arm64 | displayWidth/cjk | 23.94 | 4.66 | 4.95 | 4.84× |
| darwin-arm64 | fitToWidth/ascii | 2.21 | 0.76 | 0.79 | 2.79× |
| darwin-arm64 | fitToWidth/cjk | 22.96 | 0.60 | 0.61 | 37.64× |
| darwin-arm64 | screen/ascii | 287.62 | 104.44 | 114.22 | 2.52× |
| darwin-arm64 | screen/cjk | 586.10 | 148.03 | 138.93 | 4.22× |
| darwin-x64 | displayWidth/ascii | 2.47 | 2.94 | 2.32 | 1.06× |
| darwin-x64 | displayWidth/cjk | 40.21 | 14.82 | 14.26 | 2.82× |
| darwin-x64 | fitToWidth/ascii | 5.11 | 3.19 | 3.65 | 1.40× |
| darwin-x64 | fitToWidth/cjk | 35.67 | 2.32 | 2.28 | 15.67× |
| darwin-x64 | screen/ascii | 636.92 | 321.62 | 327.12 | 1.95× |
| darwin-x64 | screen/cjk | 1342.77 | 552.17 | 615.84 | 2.18× |

Intel 的各次测量漂移明显。例如 CJK Screen 守卫前中位数为 641.5/417.4/552.2 µs，
守卫后为 637.5/376.2/615.8 µs：总中位数之比比守卫前慢 11.5%，但三次配对中两次
更快（配对比值中位数 0.994）。这不能证明稳定的内核回归，也不保证所有用例都无
回归。相对审查基线的 CJK Screen 收益仍为 2.18×，不作统计显著性声明。所有当前
>10% 较慢的公共用例（包括新增 TS 回退代价）仍逐一列在摘要中，每个平台为 30/120。

### 终端整轮预算

每项均为 **TS → 显式启用的已准入 Rust**。延迟单位 **ms**；吞吐量为**千输入 UTF-16
单元/秒**。每个完整轮含 65,536 单元，覆盖终端输入、PTY 传输和生产流式路径。
可见完成代理还包含 headless 模拟器消费，不代表物理显示器。全部 **60 个实测轮**及
预热均通过生成写入、接收字节和模拟器状态严格相等检查，不调用原生复合/Markdown。

| 平台 | 负载 | PTY 消费完成 ms | 模拟器消费完成 ms | 千单元/秒 |
| --- | --- | ---: | ---: | ---: |
| linux-arm64 | ascii | 129.0 → 118.8 | 537.3 → 550.1 | 122.0 → 119.1 |
| linux-arm64 | cjk | 185.2 → 126.4 | 540.7 → 524.0 | 121.2 → 125.1 |
| darwin-arm64 | ascii | 91.8 → 74.0 | 762.2 → 798.0 | 86.0 → 82.1 |
| darwin-arm64 | cjk | 103.1 → 91.0 | 1489.9 → 1374.7 | 44.0 → 47.7 |
| darwin-x64 | ascii | 123.9 → 111.8 | 735.6 → 717.9 | 89.1 → 91.3 |
| darwin-x64 | cjk | 241.5 → 228.9 | 1367.2 → 1342.3 | 47.9 → 48.8 |

模拟器/传输预算占主导。CJK 整轮完成约快 2–8%，而非内核的数倍收益。ASCII 在
Linux/M1 上约慢 2–5%，Intel 上约快 2%。内部 renderer 与 PTY 消费完成样本分开保留，
不能替代用户可见完成时间。这也是 TS 保持默认、叶级路径保持显式与保守的原因。

### 检查与原始记录

- **43 个聚焦测试通过**：包括九个独立报告的运行时/编译 Unicode 组合、29 观测路由
  检查、精确 API、模拟器和真实附加模块。历史回调 frame 测试使用与基准相同的真实
  数组/选项/边框回调形状。
- 最新完整本地生产源码测试：**5,584 通过 / 26 跳过**，仍有相同的**三个基线
  launcher-pnpm 前置条件失败**。后续测试拆分增加八个独立报告的用例，不减少覆盖；
  测试专用修改后聚焦检查通过。此前一个受时钟边界影响的活动词断言，在聚焦重检和
  完整重跑中均通过。
- build、typecheck、安全/工作流检查、生成表重建、Rust 全码点宽度与 12 个语义测试
  通过。86 个 golden 的输入输出不变。移除守卫、Unicode 不匹配和终端字节损坏对照
  均使相应断言失败。
- [完整测量源码 CI，含两台 Mac 公共路径和 PTY 测量](https://github.com/riesbri/dshline/actions/runs/38922097262)
  是源码验证记录。最终报告提交检查状态记在[草稿 PR 302](https://github.com/riesbri/dshline/pull/302)。
- 公共原始数据：[Linux](../benchmarks/renderer-guard-linux-arm64.json)、
  [M1](../benchmarks/renderer-guard-darwin-arm64.json)、
  [Intel](../benchmarks/renderer-guard-darwin-x64.json)。
- 完整 PTY 记录：[Linux](../benchmarks/renderer-pty-linux-arm64.json)、
  [M1](../benchmarks/renderer-pty-darwin-arm64.json)、
  [Intel](../benchmarks/renderer-pty-darwin-x64.json)。
- [机器可读摘要](../benchmarks/renderer-guard-summary.json)保留全部 41 个原始观测、当前
  所有 >10% 公共回归、路由、环境/源码/构建/附加模块身份、选定对照及 PTY 预算。
  初始守卫测量和被拒绝的 CR 诊断分别标记。旧的非字节保真 PTY 计时已被取代，不混合。

这是自审，不是独立审查。分支仍叠在未改动的 #300（`5e48b70`）之上，保持草稿且未
合并。没有发布、安装到工作 profile、模型变更、CPU 目标/panic 策略变更或采用 ThinLTO。
