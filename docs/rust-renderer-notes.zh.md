# Rust 渲染器迁移说明

[English](rust-renderer-notes.md) | 中文

## 架构决定

Rust 是纯规范化展示后端，不是第二个前端或 Harness 运行时。现有 TypeScript 导出、封装和行为保留为参考和回退。[渲染器参考约定](renderer-spec.zh.md) 定义边界；对应机器可读文件记录精确的当前 API。第一阶段不引入原生分派或运行时依赖。用户要求的 Zod 仅为根目录开发依赖，用于验证捕获输入和输出 JSON Schema，避免手动维护第二套 schema。渲染器包保持无依赖。

现有方案预检考察了持续维护的 napi-rs 绑定和 unicode-width。它们可提供传输或实现组件，但不拥有语义约定：unicode-width 的字素处理与当前码点求和不同，原生字符串转换也不能丢失畸形 UTF-16。复用仓库宽度表和模拟器工具。没有理由自建终端模拟器、替换解析语义或建立 agent（智能体）运行时。

## 顺序门槛

1. 规范、schema 和捕获：当前阶段；精确公共声明、规范化 Zod schema、确定性实时调用捕获和架构决定。独立审查必须批准此阶段后才能继续。
2. 语料及差分测试框架：仅在第一阶段批准后；扩展获得同意的或合成的输入及终端单元格证据。第一阶段不引入语料或差分框架。
3. 纯 Rust 渲染器 crate：仅在第二阶段批准后；不含绑定；实现纯转换并通过全部黄金一致性测试，然后获得独立批准。
4. napi-rs 绑定及 TS 集成：仅在第三阶段批准后；添加 auto/rust/typescript 选择器和 dshline 配置选项，保留 TS 宿主 I/O，然后获得独立批准。
5. CI、预构建及文档：仅在第四阶段批准后；覆盖 Linux、Darwin 和 Windows 的 x64、arm64，更新文档及 CONTRIBUTING，然后获得独立批准。
6. 基准、soak 及最终就绪报告：仅在第五阶段批准后；运行基准，添加 soak 脚本并报告分支最终就绪状态。各阶段作者须自审；父 agent 负责在 feat/rust-renderer 上提交、推送和创建草稿 PR。main 变化时变基；未授权合并或发布。

## 当前状态与缺口

第一阶段经过三轮审查后已获独立批准；已验证精确执行来源、完整 Unicode 码点准入和聚合资源限制。第二阶段已获独立批准：现已包含 82 个合成及 4 个实际隔离启动夹具、精确差分框架和仅运行基准的 CI 步骤。这不是穷尽或真实模型生产会话语料。不会访问私人会话或 profile。第三阶段已获独立批准。第四阶段绑定、选择与配置正在进行集成检查及审查；原生打包和预构建 CI 仍属于第五阶段。规范记录有界整数的规范化准入，并禁止对被拒绝工作执行无约束回退；直接公共 TS 语义不变；已明确解析后的调色板快照和纯 markdown 状态转移 ABI；穷尽边缘情况和基准测试仍属于后续受门槛约束的工作。原生打包必须在集成前解决可选传输与渲染器无运行时依赖规则之间的关系；第一阶段不授权例外。

## 可复现检查

先构建，确保捕获和声明快照使用当前源代码。聚焦工具测试检查完整 Unicode 码点准入、有效行为重建后的预加载 ESM 缓存隔离、schema 拒绝、精确 API/schema 漂移、确定性实际调用、ANSI、畸形 UTF-16 和 Screen 无操作写入。故意将 schema 改为接受未知字段，必须使具名的领域对象拒绝测试失败。现有渲染器测试保持不变，包括真实终端模拟器检查。审查者必须评估语义完整性，而非仅看自动检查通过；双语配对结构有效不能证明翻译准确。

```sh
pnpm build
node tools/renderer-spec.mjs
pnpm exec vitest run --project repo tools/renderer-spec.spec.mjs
pnpm run verify-docs docs/renderer-spec.md docs/rust-renderer-notes.md
```

## 第二阶段一致性测试框架

`pnpm build && pnpm test:renderer-parity` 使用新验证的 TypeScript 产物校验 82 个
合成展示夹具及 4 个实际启动展示夹具。每个夹具独立记录来源、源码/构建/编译器摘要及有效的已解析调色板；
每次捕获仅包含一个用例，保留现有保守准入限制。
回放前，验证器将每个完整规范化请求与规范语料比较，
包括参数、有效调色板及来源；重复、缺失及意外残留的旧夹具均失败。
即使 ID 不变，修改输入也须显式重新记录预期输出。
`node tools/renderer-parity.mjs --record` 仅通过实际调用显式更新已记录规范化语料的预期输出，
不会猜测预期输出或搜索私人会话。基准直接加载已验证快照的实现模块，
不经过未来的公开后端选择器。本阶段不引入原生代码或生产分发。

未来命令是**宿主适配器**，而非 Rust crate ABI。它必须保持 Screen 状态/写入
及 Markdown 序列归未改动的 TS 所有，仅为准入的纯变换注入 Rust。
Screen/Markdown 序列计入 `hostAdapterCases`，不计为原生纯用例；
Rust 不得实现 Screen 状态。命令协议为标准输入中的一个规范化捕获 JSON 对象，
以及标准输出中的一个
`{ok:true,value:{cases:[{id,output}]}}` JSON 对象，并保留用例顺序。
使用 `--require-rust --backend '["path/to/renderer-command"]'` 调用；
参数不会交给 shell 解释。比较精确的 JSON 值及 UTF-16 字符串，包括 ANSI、
写入边界和不配对代理单元；不剥离 ANSI，也不将渲染字符串转换为 UTF-8。
缺少原生代码时报告 **PENDING**，原生用例数为零，强制原生模式失败。
仅基准 CI 通过不代表 Rust 一致性通过。

语料覆盖全部 20 个规范化操作标签、宽度边界、中日韩文字、组合标记、
表情/ZWJ、不配对代理单元、畸形 ANSI 和模型控制字符、框体几何、
围栏/部分 Markdown、已解析的 0/4/8/24 色深及缺失角色，
以及有序的 Screen 提交/缩放/失效/关闭调用。无头 xterm 检查字符、颜色、
宿主当前样式下的背景色擦除和光标位置。具名的重置/代理单元/写入边界/后端
故意变异必须触发精确比较失败。四个实际输入来自隔离的打包插件启动，使用 Harness 0.2.0-rc.2、80×24 终端，
到达就绪输入框后通过 Ctrl-D 退出，没有执行模型轮次。
`tools/renderer-parity-session/` 保存规范化输入、仅观察钩子及证据。
复现时设置绝对路径 `NODE_OPTIONS=--import=/path/to/observe.mjs`，
将 `RENDERER_OBSERVED_OUTPUT` 指向临时文件，再运行
`node tools/consumer-smoke.mjs --launcher-version 0.2.0-rc.2`。
包含临时路径的调用已排除。流式及敌意输入夹具仍属合成数据，
不会把合成夹具宣称为真实会话。第三阶段仍须独立批准。

文件准入在 JSON 解析前从同一个打开的句柄最多读取 1048577 字节，
出现额外字节即拒绝。不信任预先获取的路径元数据，因此文件替换或增长
不能绕过 1048576 字节限制。


## 第三阶段纯 Rust 验证

纯 `crates/dshline-renderer` 库和有界 CLI 实现规范化呈现变换，不包含
Node、Cordis、Harness 或终端 I/O。文本全程使用 `Vec<u16>`；验证传输使用
数值 UTF-16 数组，包括调色板 ID 和角色键。角色以键/参数对传输，而不是
JSON 对象键，因此孤立代理项不会经过 Rust UTF-8 字符串的有损转换。
操作名和固定枚举标签仍为普通 JSON 字符串。输入输出均检查准入，错误为有界类型信封。

`tools/renderer-rust-host.mjs` 是验证工具，不是生产分派。每个纯变换都调用
真实 Rust 可执行文件，并报告原生调用次数。Screen 配方加载已验证且不变的
TS Screen，只把换行替换为原生操作。Markdown 序列状态仍由 TS 宿主持有，
以显式传入/传出围栏状态调用纯 Rust 转移。Screen、输入编辑器、键盘和智能体
状态机均不会移入 Rust。

当前验证：86 个黄金夹具全部一致（83 个纯原生案例及三个 TS 宿主序列案例），
另有 442 个确定性对抗差分比较及独立的孤立代理项调色板元数据检查。这不是
穷尽 Unicode 或 markdown 一致性声明。第三阶段独立审查已批准此实现，并验证了额外 1000 个对抗请求。

```sh
cargo test --manifest-path crates/dshline-renderer/Cargo.toml
cargo build --manifest-path crates/dshline-renderer/Cargo.toml
node tools/renderer-parity.mjs --require-rust --backend '["node","tools/renderer-rust-host.mjs"]'
```

宽字符与零宽范围复制项目的 Unicode 17 表，而非替换为不同的字素或 ANSI
解析器策略。Markdown 的 L/N 字词属性由 Node v24.18.0、Unicode 17.0 生成；
生成器要求 Unicode 17.0。其他受支持 Node 版本可能使用不同属性表。第四阶段现已按宿主 Unicode 版本保护原生 markdown 兼容性；宽度操作仍遵循项目固定
宽度表。

两个 cargo-fuzz 目标覆盖畸形 ANSI/UTF-16 及有界 JSON 准入。带种子的稳定版
libFuzzer 冒烟运行每个目标完成 10000 次执行；这些运行未启用覆盖率插桩或
sanitizer。带插桩的 nightly 模糊测试仍是额外检查，不声称已经完成覆盖率验证。


## 阶段 4：原生绑定与后端选择

独立的 `crates/dshline-renderer-node` napi-rs crate 依赖纯渲染 crate，反向依赖禁止。
有界 `execute` JSON 传输保留给验证及强制 Rust 复合操作。宽度、去除 ANSI、控制字符
转义、粘贴清洗、截断、尾部选择、适配、分块及换行方法直接传递 UTF-16，避免 JSON
及数字数组。复制到 Rust 所有权缓冲区之前先检查输入：直接文本最多 2048 个 UTF-16
单元，列预算为 ±256；这些单输入变换的输出扩张由该限制约束。每个 FFI 操作都捕获
panic。`native/index.d.ts` 由实际 napi 编译器元数据生成。`JsStringUtf16` 的切片包含
C 终止符，绑定按测得的 JavaScript 长度截取，保留真实末尾 NUL 和孤立代理项，不把
附加终止符渲染出来。

纯扫描器借用源文本跨度，不再为每个字符分配向量。宽度测量不分配 token，普通 ASCII
不查 Unicode 表。前缀截断到达预算后即停止扫描。尾部选择仍保留借用的 token 跨度，
因为 ANSI 识别需要先向前扫描。

公共渲染器保留原签名，并新增 `setRendererBackend` 与 `rendererBackend`。`auto`
明确采用混合策略：测得有收益的直接操作仅在文本长度 64–2048 时选择原生，分块为
512–2048；换行要求 32–256 列，分块要求 64–256 列。其他原生候选为宽度、尾部选择和适配。
单码点查询、前缀截断、去除 ANSI、转义、清洗以及 JSON 复合/Markdown 操作在 auto
下保留 TypeScript，因为完整边界开销未显示普遍收益。阈值来自保守的本机测量，不是
跨平台保证。原生输出错误绝不触发无界 TypeScript 重试。

缺失/损坏的附加模块，以及不满足 auto 准入的公共输入，在执行原生代码之前选择原有
TypeScript 语义。稀疏数组、回调、getter、未知选项字段及调用方对象不走另一条遍历
路径。`rust` 要求附加模块，对不支持或超预算的输入明确报错；它用于正确性验证和
调试，不保证每个操作更快。`typescript` 不调用原生操作。原生 Markdown 还要求宿主
Unicode 为 17.0，以保留定界符侧翼规则。任意边框回调仍是 TS 专用公共功能。

流式 Markdown 在 TypeScript 中保存明确的原生围栏状态；回退时才从该围栏构造参考
渲染器，不再把每条已提交行完整渲染两遍。一旦提交 TS 回退行，该文档余下部分由 TS
拥有；之后强制 Rust 会失败，不会猜测状态。partial 回退不提交状态。调色板快照只在
原生 Markdown 工作时构造，不缓存：现有调用方持有的 SGR 数组可能变化，原 TS 行为
会观察到这些变化。

组合时的 dshline `renderer` 配置接受 `auto`、`rust`、`typescript`。审查仅批准通过
现有 `run` 参数和 `createWindow` 选项传递配置；inject 依赖、回调、错误处理和所有权
不变。选择随窗口释放，不是 volatile 设置或 Harness 能力。

```yaml
- id: dshline
  config:
    renderer: auto
```

真实附加模块通过全部 86 个差异夹具，包括统计原生调用的 TS 宿主序列。测试覆盖直接
畸形 UTF-16/ANSI/NUL 输出、缺失/损坏模块、不重试的类型化错误、流式回退、可变调色板、
稀疏数组及应忽略的宿主 getter。优化后的完整测试为 5560 通过、26 跳过，仅保留本机
此前已观察到的三个启动器前提测试失败（本机 `/usr/bin` 中安装了 pnpm）。原生导致的
选择器超时已消失，未修改测试超时。跨平台预构建仍是下一道门禁；阶段 4 独立批准待定。

## 优化实验与复现

原 release 构建为每个 token 分配文本缓冲区，且大多数公共调用支付数字 UTF-16 数组和
JSON 成本。测量比较了原实现、无分配扫描、直接 napi 方法和最终混合公共选择器。
窄列实验还否定了一个看似合理的策略：返回数百个单字符行时，原生分块即使扫描更快，
完整调用仍可能比 TS 慢七倍。用户随后明确要求优化，因此探索测量及直接 FFI soak 提前
在阶段 4 执行；这不代表阶段 6 最终就绪或绕过阶段 5 包装门禁。

可复现工具先断言精确输出，再计时；缺失原生代码即失败，不会把 TS 回退标作 Rust。
基准记录环境、附加模块摘要、五次校准批次平均值的中位数和最大值。最大值不是单次
调用的 p95 尾延迟。`--baseline` 可传入旧包快照，须带匹配的 `lib/` 和 `native/`。
没有重复输入缓存。

```sh
pnpm build
node tools/renderer-bench.mjs --output /tmp/renderer-bench.json
node tools/renderer-soak.mjs 10000
```

soak 是确定性的直接附加模块差异测试，不声称具有覆盖率插桩或 sanitizer。独立审查
另查所有 Unicode 码点宽度、畸形 UTF-16 和调色板/后端切换。
[性能结果](renderer-performance.zh.md) 区分内核/FFI 原始收益与公共路径测量，并列明限制。
