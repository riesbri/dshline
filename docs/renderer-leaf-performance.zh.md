# 原生叶子函数查找表实现

[English](renderer-leaf-performance.md) | 中文

## 范围

本次实现针对已审查的渲染器基线 `5e48b70`，落实
[研究 PR 301](https://github.com/riesbri/dshline/pull/301) 中的仅查找表和无循环依赖
原生叶子函数提案。不采用已被拒绝的两遍扫描尾部算法或 ASCII 换行，不扩大原生
接纳范围，也不将宿主所有权移入 Rust。

`native-primitives.ts` 拥有现有可选加载器、进程渲染模式和带守卫的直接操作，
仅依赖未改变的 TS 宽度策略与 Node 模块加载器。`backend.ts` 在复合和 Markdown
派发中复用该选择。Screen 及 box/frame 内部导入基础函数 seam；不存在反向导入
复合层的路径，并测试运行时图无循环。TypeScript 仍拥有回调、可变对象、调色板、
文档状态、终端写入、滚动缓冲区和生命周期。Harness 拥有所有 agent 状态。

## 派生查找表

生成器仅读取已提交的 Unicode 宽度策略，不依赖网络或构建。生成 4352 个单字节
索引和 108 个独特的 256 字节页：**32000 字节表数据**，小于研究原型的双字节
索引。未来策略若需要超过 256 页，生成会失败，而不是截断索引。原始 Rust 范围
仍是独立的测试基准，并穷举比较每个 Unicode 码点。ANSI 扫描、控制字符优先级、
孤立代理项及库对域外输入的行为保持不变。构建和 CI 拒绝过期生成数据。

首轮生产路径测量发现编译形态退化：小查找表被自动内联进显示扫描器，使 Linux
ARM64 的纯 ASCII 宽度/填充变慢 10–25%。在专项探针中，将 `code_point_width`
保持为非内联调用恢复了 ASCII 和末尾 CJK 的基线行为，同时保留大幅 Unicode
收益。分离辅助函数的变体改善了部分 token 变换，却使填充退化，因此未保留。
最终重复测量必须在每个被测平台评估此控制；原始结果仍明确标记为初始结果，
而不是悄悄覆盖。

## 正确性与接纳

现有 auto 阈值、2048 单元输入上限和 ±256 列预算保持不变。缺失产物或不支持的
宿主值在执行前选择 TS；已获准的原生调用发生错误时直接传播，不重试 TS。
显式 TS 模式从不调用 addon，包括 Screen/frame 内部。强制 Rust 仍允许宿主回调，
但回调中的已获准标量叶子工作现在进入同一个原生选择器，而非独立宿主实现。

已验证参考快照会在加载宿主模块前显式选择 TS，包括现有基准、持续对比和原生
边界测试中的参考，避免悄悄将原生宿主路径与其自身
比较。声明快照包含传递性重新导出的模块。全部 86 个黄金样例的输入输出保持
不变；仅刷新源码/构建身份。

真实 addon 测试统计宿主原生调用，并在 auto/rust/TS 模式下比较精确写入、回调
观测、模拟器单元格、光标、颜色、过期/收缩/尺寸变化及无操作重绘行为。资源错误
探针证明不会重试；微小、超大和窄输入证明执行前回退。

## 测量

`tools/renderer-upgrade-bench.mjs` 要求单独构建的精确基线检出，验证双方生成的 TS
模块图及 addon 源码/二进制来源，统计宿主原生调用，然后比较公共 auto、直接
Rust 和显式 TS。每项负载保留八个变化的输入、三轮轮换顺序测量，以及每轮五个
经过校准的批次平均值。计时后重新检查源码/原生身份。宿主配方使用内存写入
目标：这是合成 CPU 测量，不代表 PTY、终端 I/O、真实会话、单次调用尾部延迟
或整轮性能。

## macOS 研究

Apple Silicon 和 Intel 托管 runner 均使用相同 Rust/Node 工具链构建精确基线，
再执行公共/宿主比较。独立临时 ThinLTO/单代码生成单元构建保留 panic 展开和
可移植目标 CPU 默认值，在计时前通过穷举宽度及额外有界变换一致性检查。仅在
基准进程中临时选择其函数；调优二进制不替换打包的 addon。原始结果上传为
`renderer-upgrade-darwin-arm64` 和 `renderer-upgrade-darwin-x64`。对应运行完成前，
这些测量仍待完成。

[Rust Apple 目标](https://doc.rust-lang.org/rustc/platform-support/apple-darwin.html) 和
[编译器选项](https://doc.rust-lang.org/rustc/codegen-options/index.html#target-cpu) 仍是
可移植性边界。不要为追求本地结果而分发仅适用于构建宿主的 CPU 指令，或提高
macOS 最低版本。Apple 的 [Instruments 指南](https://developer.apple.com/videos/play/wwdc2025/308/)
适合作为真实 Mac 上的下一步分析；Linux ARM64 的提速结果不能证明 Apple Silicon
或 Intel macOS 也有相同收益。

## 审查状态

实现和本地行为检查正在自查。精确提交头的托管正确性、macOS 计时和最终结果仍
待完成。本次不授权合并、发布、模型轮次、用户 profile 或服务策略变更。
