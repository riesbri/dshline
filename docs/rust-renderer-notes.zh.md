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

第一阶段经过三轮审查后已获独立批准；已验证精确执行来源、完整 Unicode 码点准入和聚合资源限制。第二阶段实现已完成，等待独立批准：现已包含 82 个合成及 4 个实际隔离启动夹具、精确差分框架和仅运行基准的 CI 步骤。这不是穷尽或真实模型生产会话语料。不会访问私人会话或 profile。不添加 Rust crate、绑定、原生/预构建 CI 或 dshline 运行时集成。规范记录有界整数的规范化准入，并禁止对被拒绝工作执行无约束回退；直接公共 TS 语义不变；已明确解析后的调色板快照和纯 markdown 状态转移 ABI；穷尽边缘情况和基准测试仍属于后续受门槛约束的工作。原生打包必须在集成前解决可选传输与渲染器无运行时依赖规则之间的关系；第一阶段不授权例外。

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
