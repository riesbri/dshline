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

第一阶段经过三轮审查后已获独立批准；已验证精确执行来源、完整 Unicode 码点准入和聚合资源限制。现在可以开始第二阶段。捕获输出按需生成，不声称是生产会话语料。不会访问私人会话或 profile。不添加 Rust crate、绑定、CI 或 dshline 集成。规范记录有界整数的规范化准入，并禁止对被拒绝工作执行无约束回退；直接公共 TS 语义不变；已明确解析后的调色板快照和纯 markdown 状态转移 ABI；穷尽边缘情况和基准测试仍属于后续受门槛约束的工作。原生打包必须在集成前解决可选传输与渲染器无运行时依赖规则之间的关系；第一阶段不授权例外。

## 可复现检查

先构建，确保捕获和声明快照使用当前源代码。聚焦工具测试检查完整 Unicode 码点准入、有效行为重建后的预加载 ESM 缓存隔离、schema 拒绝、精确 API/schema 漂移、确定性实际调用、ANSI、畸形 UTF-16 和 Screen 无操作写入。故意将 schema 改为接受未知字段，必须使具名的领域对象拒绝测试失败。现有渲染器测试保持不变，包括真实终端模拟器检查。审查者必须评估语义完整性，而非仅看自动检查通过；双语配对结构有效不能证明翻译准确。

```sh
pnpm build
node tools/renderer-spec.mjs
pnpm exec vitest run --project repo tools/renderer-spec.spec.mjs
pnpm run verify-docs docs/renderer-spec.md docs/rust-renderer-notes.md
```
