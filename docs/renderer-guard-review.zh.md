# ASCII 准入守卫审查

[English](renderer-guard-review.md) | 中文

审查对象：草稿 [PR #302](https://github.com/riesbri/dshline/pull/302)，
`6928a8ba32452bfa09144fba656dfa4c432cef2d`，叠在 #300 上。这是对抗性自审，
不是独立审查或合并批准。**没有应用任何生产修复。** 默认值、阈值、回退、
Unicode 准入、编译策略和包源码均未改变。

## 发现与待决定的方案

### 1. 稀疏 Unicode 的守卫扫描会抵消叶子函数收益（性能缺陷）

长 ASCII 的末尾两个码元探针解决了此前 M1 纯 ASCII 9.65 µs 的回退，
但没有限制双字节字符串上 `/[^\x00-\x7f]/u` 搜索的成本。第二个非 ASCII 字符
距离第一个很远时，宽度守卫扫描整个后缀，**然后仍然准入 Rust**。
Tail/chunk 在最后一个字符为非 ASCII 时也会做同样的全扫描。

执行 `pnpm build` 并具备版本兼容的实际 addon 后，最小复现：

```js
import * as r from './packages/renderer/lib/index.js'
r.setRendererBackend('auto')
r.displayWidth('a中' + 'a'.repeat(2045) + '中') // guard returns undefined
r.tailToWidth('a'.repeat(2047) + '中', 80)     // guard returns undefined
r.chunkToWidth('a'.repeat(2047) + '中', 80)    // guard returns undefined
```

Linux ARM64 控制实验中位数，单位 µs/调用：五轮轮换顺序，每轮五个校准批均值，
使用八个变化且扁平化的字符串。“无守卫”是**私有反事实模块图**，唯一差别是
守卫函数返回 undefined；旧边界、最小长度、版本检查和实际 addon 字节完全保留。

| 用例 | 仅守卫探针 | 带守卫 auto | 无守卫 | 显式 TS |
| --- | ---: | ---: | ---: | ---: |
| Width，两个相距很远的 CJK，2048 码元 | 18.092 | 21.601 | 3.388 | 14.971 |
| Width，两个相距很远的 CJK，512 码元 | 4.643 | 5.963 | 1.252 | 3.983 |
| Tail，末尾 CJK，2048 码元 /80 列 | 18.006 | 34.766 | 16.704 | 65.992 |
| Chunk，末尾 CJK，2048 码元 /80 列 | 18.027 | 62.762 | 44.668 | 57.184 |

准入的 2048 码元 width 比相同原生分派去掉守卫后**慢6.38倍**，也慢于 TS。
Chunk 同样输给 TS；tail 仍快于 TS，但相对反事实成本超过翻倍。所有输出精确一致，
所有准入变体都调用实际 addon。这些是本次新测的 **Linux 守卫成本**，不是新的 Mac 测量。

**建议修复，未应用：** 评估不使用 Unicode 正则模式的 ASCII **码元**谓词，
或其他有界廉价扫描。这里仅使用 `search` 起始偏移和 `test` 布尔值，
单码点排除已有显式代理对计数。接受方案前，应验证代理对/孤立代理码元、ANSI、
边界上的守卫判断完全一致，逐个删除守卫的测试仍有效，并在三台机器重测
稀疏/密集/ASCII。不能通过扩大原生准入或改变阈值掩盖缺陷。

### 2. 保守门控排除了原生赢家；路由修复不等于延迟修复

每个门控都可能拒绝赢家。Linux 控制实验中位数（带守卫 auto→无守卫原生，µs）：
ASCII512 width **4.680→1.245**；末尾仅一个 CJK 的 width2048
**32.945→3.412**；ASCII2048/80 tail **69.713→16.756**；ASCII512/64 chunk
**14.602→12.172**；ASCII512/80 wrap **45.842→16.253**。
它们反驳的是“TS 更快”的说法，不是输出正确性。这些门控旨在避免历史回退家族
调用原生，并非为每个输入选择最快后端。

保留的 Mac 数据已经体现末尾单 CJK width2048 的代价：M1 的评审基线/门控前/
门控后/TS 中位数为 **1.842/1.915/27.896/19.164 µs**；Intel 为
**2.468/2.065/46.754/38.851 µs**。守卫本身也增加回退工作量。
这些是不同公共变体的中位数，不应相减后当作严格隔离的守卫成本。

**建议决定：** 明确接受保守排除，或在扫描缺陷解决后另行授权基于证据缩小范围。
本次未删除或收窄任何门控。证明走 TS 的测试不是速度测试。

### 3. 准入并不普遍保证不会选中输家

保留的120用例中，没有准入的纯 ASCII/ANSI 用例比评审原生基线或显式 TS
慢超过10%。有限语料不能证明所有字符串/列预算；上面的稀疏输入就是反例。
另一个零预算例子 `tailToWidth('中'.repeat(2048), 0)` 仍被准入：Linux 上
**auto0.835 µs，TS0.175 µs**。主要代价来自既有边界，而非这五个守卫。
Intel 保留数据中，稀疏 CJK `fitToWidth` 的64码元/40列为 **3.014 µs**，
评审原生基线 **2.702 µs**（+11.55%）；五个守卫都不适用于 `fitToWidth`。

**建议决定：** 明确记录准入局限，另行决定是否增加有界排除。
本次不悄悄调整旧的零预算/窄列/最小长度阈值。

## 精确排除集合及未排除输入的成本

`n` 表示 UTF-16 长度，**A** 表示所有码元为0–127，包含 C0、DEL、换行与 ANSI
字节，而非仅可打印 ASCII。下表是经过既有输入/列边界、最小长度后的 `auto`
**有效**守卫；原生执行还要求运行时/策略/addon Unicode 一致。
默认 `typescript` 在所有守卫之前短路；显式 `rust` 绕过这些性能守卫，
但保留既有边界/版本检查。

| 守卫 | 精确排除集合 | 未排除输入上的工作 / 误判 |
| --- | --- | --- |
| `ascii-short-width` | `displayWidth`，A，**64≤n≤512** | 与下一守卫共用 width 搜索。短密集 CJK **0.127 µs**；512码元两个远距 CJK 在准入前 **4.643 µs**。长 ASCII 不跑正则，仅末尾两个码元探针 **0.025 µs**。拒绝原生更快的 ASCII512。 |
| `ascii-dominant-width` | `displayWidth`，**64≤n≤2048**，恰一个非 ASCII 码点（有效代理对计一次，孤立代理码元也计一次），且 **n≤512** 或末尾两个码元至少一个非 ASCII | 首次搜索、两次 `charCodeAt`、代理对判断、后缀切片、第二次正则测试。即使最终准入，也可线性扫描。长密集 CJK **0.130 µs**，远距双 CJK **18.092 µs**。长串单 CJK 在中间且末两码元为 ASCII 时跳过守卫（**0.026 µs**）；同一码点移到末尾则被排除，尽管原生仍快。这是刻意的位置规则，不是真正统计 ASCII 占比。 |
| `ascii-tail` | `tailToWidth`，A，**512≤n≤2048**，任意有界整数列预算 | <512仅比较（511码元 **0.023 µs**）；否则一次 ASCII 正则测试。密集 CJK 立即停止（**0.054 µs**）；末尾 CJK **18.006 µs**，然后 Rust 再扫描。拒绝原生更快的长 ASCII，并准入零预算输家。 |
| `ascii-chunk` | `chunkToWidth`，A，**512≤n≤2048**，**64≤columns≤256** | 每次符合条件调用做一次 ASCII 正则测试。密集 CJK **0.053 µs**，末尾 CJK **18.027 µs**。拒绝原生更快的 ASCII512/64；准入现已慢于 TS 的末尾 CJK。 |
| `ascii-wrap` | `wrapToWidth`，A，**64≤n≤2048**，**32≤columns≤256**，且 **n≤512 或 columns=256 或任意位置有 ESC** | 短串/最大列预算直接测试 ASCII；其他长串先搜索 ESC，即便开头就是密集 CJK。长 ASCII/80 **0.121 µs**；密集 CJK/80 **0.212 µs**；末尾 ESC 的 CJK **0.249 µs**。长串无 ESC 时跳过 ASCII 正则。拒绝短/最大列/带 ESC 的 ASCII 赢家；准入普通长 ASCII 和 CJK，并非所有 ASCII 都走 TS。 |

探针成本包含调用/循环开销；空探针约 **0.017 µs**。这是批均值的中位数，
不是单调用尾延迟；公共分派小差异可能是噪声。两个 width 守卫共用实现，
不能分别相减分摊扫描成本。`fitToWidth` 会进入守卫函数，但不匹配任何分支
（长 ASCII 控制用例探针 **0.021 µs**）。

Unicode 运行时不兼容时，带列预算的分派在守卫前短路；一元分派在守卫**之后**
才检查运行时。缺少 addon 也在守卫后检查。因此 opt-in auto 即使最终不能运行
原生也可能支付扫描代价。建议后续仅调整冗余预准入工作的顺序，保留回退/错误语义；
**本次未应用**。

### 遮蔽和逐守卫变异覆盖

>2048码元、非整数或绝对值>256列在守卫前被边界检查排除。旧最小长度使
width/wrap<64、tail<64、chunk<512先走 TS；窄列规则使 chunk<64列、wrap<32列
（含负预算）先走 TS。五个有效集合互不重叠：操作不同，而两个 width 集合
分别要求零个与恰一个非 ASCII 码点。

历史 **29** 个 ASCII 家族观测（M1 20个、Intel9个）中，**19** 个真正触发具名
排除：short-width3、dominant-width3、tail3、chunk2、wrap8。
另 **10** 个经旧的短串/窄列/宿主路径已经走 TS。尤其大量 chunk40/8列不能证明
`ascii-chunk`；只有512码元 chunk120/256列观测可以。基准 JSON 单独调用
`regressionGuard(...)` 得到的标签，**不代表**实际分派运行到了该守卫。

现有测试 `defaults to TS even with an available addon, and gates every recorded
ASCII regression in auto` 原样执行**通过**；然后每次仅将**一个**守卫的具名返回值
替换为 `undefined`，共 **五次失败**：

| 删除的守卫 | 未被阈值遮蔽的历史见证 | 结果 |
| --- | --- | --- |
| short-width | ASCII96 width | 禁止的原生调用→`BACKEND_FAILURE` |
| dominant-width | 末尾 CJK64 width | 同上 |
| tail | ASCII2048/40 tail | 同上 |
| chunk | ASCII512/120 chunk | 同上 |
| wrap | ASCII96/40 wrap | 同上 |

没有死守卫，也未发现缺失的逐守卫删除覆盖，因此没有添加重复单元测试。
现有测试证明路由，**不证明**扫描便宜。变异仅改动未跟踪编译产物，在 `finally`
恢复，并在结束后验证源码/构建身份和 addon 哈希。这不是一次性删掉所有守卫，
也不是构建或加载失败。

## 三平台 PTY 展示整轮验证

这里的“前→后”是 **显式 TS→opt-in auto 准入 Rust**，不是门控前 auto→门控后 auto；
未测过后一种 PTY 配对。生产 StreamBuffer + frame + Screen，真实私有80×24 PTY，
65,536 UTF-16码元、512增量、32条长逻辑行、完整消息对账/滚屏/关闭；每种输入/机器
预热一轮后交替顺序测五对。完成包含 PTY 和无头 xterm 排空，不包含提供商/模型时间、
Harness 启动或物理显示绘制。

| 平台 / 负载 | PTY排空 ms，TS→auto | 模拟器排空 ms，TS→auto | 千UTF-16码元/s，TS→auto |
| --- | ---: | ---: | ---: |
| Linux ARM64 / ASCII，保留 | 129.035→118.817 | 537.337→550.054 | 121.965→119.145 |
| Linux ARM64 / CJK，保留 | 185.240→126.399 | 540.741→524.016 | 121.197→125.065 |
| M1 / ASCII，保留托管测量 | 91.765→74.031 | 762.205→798.003 | 85.982→82.125 |
| M1 / CJK，保留托管测量 | 103.148→90.954 | 1489.853→1374.740 | 43.988→47.672 |
| Intel x64 / ASCII，保留托管测量 | 123.924→111.760 | 735.580→717.909 | 89.094→91.287 |
| Intel x64 / CJK，保留托管测量 | 241.506→228.884 | 1367.192→1342.251 | 47.935→48.825 |
| Linux ARM64 / ASCII，本次新复测 | 128.973→122.408 | 560.559→541.076 | 116.912→121.122 |
| Linux ARM64 / CJK，本次新复测 | 166.823→131.398 | 571.371→503.295 | 114.700→130.214 |

**跨平台结论：**

- 历史 ASCII 家族的 TS 排除在**三平台都成立**：41个原始观测（29个 ASCII 家族+
  12个其他）在每个平台120用例档案中都不调用原生，共 **123** 次检查。
  这**不是**所有 ASCII 都走 TS：每个 ASCII PTY 轮仍调用原生 wrap1958次、width32次。
- CJK 的 Rust 可达性、相对评审基线的长 width/fit 收益在三平台成立：width
  **5.67× /4.84× /2.82×**，fit **31.49× /37.64× /15.67×**（Linux/M1/Intel）。
  密集控制用例收益保留，但稀疏守卫缺陷仍在。
- 保留测量的 CJK 展示完成中位数分别改善 **3.09% /7.73% /1.82%**，新 Linux 复测
  **11.91%**。**ASCII 没有跨平台一致的完成收益**：保留 Linux/M1 分别慢
  **2.37% /4.70%**，Intel 快 **2.40%**；新 Linux 快 **3.48%**，方向翻转。
  仅五对、样本范围重叠，不能证明统计显著性或延迟 SLO。

Mac 记录已**重新下载，与 artifact12054597967/12055467287 逐字节比较**，来源为
`2c74b50` 上成功的[测量源码 CI](https://github.com/riesbri/dshline/actions/runs/38922097262)；
日志确认两台机器完成所有 PTY 轮次。这是重新验证保留测量，**不是重新跑 Mac 硬件**。
新 Linux 测量绑定审查对象6928a8b。四份记录均匹配当前经编译器验证的源码/构建/配置
身份和未变的 PTY 工具哈希。全部80个实测轮通过生产写入→接收字节/哈希一致、
跨后端完整模拟器快照/光标一致、输入身份一致、TS零调用、Rust正调用、组合操作
`execute` 零调用。没有通过归一化字节使验证通过。

## 复现与审查材料

```sh
pnpm build
node tools/renderer-pty-bench.mjs --output benchmarks/renderer-pty-linux-arm64-review.json
node tools/renderer-guard-audit.mjs benchmarks/renderer-guard-audit-linux-arm64.json
node tools/renderer-guard-evidence-review.mjs
pnpm exec vitest run tools/renderer-leaf.spec.mjs tools/renderer-native.spec.mjs tools/renderer-lookup.spec.mjs tools/renderer-spec.spec.mjs
```

审查工具临时变异编译产物期间，不要并行运行构建、测试或计时。工具要求现有、具有
干净输入证明的实际 addon，不能用回退代替。
原始批均值、变换调用数、逐守卫变异见证及工具/源码/addon身份：
[守卫审计](../benchmarks/renderer-guard-audit-linux-arm64.json)。
重算中位数、样本范围、123次门控检查和80轮PTY检查：
[验证结果](../benchmarks/renderer-guard-review-validation.json)。
下载 artifact 哈希：[托管验证](../benchmarks/renderer-guard-review-hosted.json)。
新增20轮复测：[Linux PTY](../benchmarks/renderer-pty-linux-arm64-review.json)。

本地检查：build、typecheck/能力类型检查、**43个聚焦测试**、安全和 EN/ZH 配对。
未改包/Rust/CI/阈值/默认值/编译策略，未合并、发布或安装到工作 profile。
扫描成本修复和任何准入策略变更均留给评审者决定；PR 仍为草稿。
