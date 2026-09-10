# 贡献

[English](CONTRIBUTING.md) | 中文

感谢你的关注。缺陷报告、终端证据、文档修正以及聚焦的拉取请求，都有助于让 dshline 成为 DeepSeek Harness 插件生态系统中可靠的终端呈现层。

请在提交拉取请求前阅读本页。它很短。

## 目前最有价值的工作

- **通用 Harness 能力适配器。**优先使用标准能力接口而非提供方专用集成，并让 Harness 继续作为状态、运行时、持久化与策略的权威来源。
- **终端健壮性。**键盘解码、调整大小与几何（geometry）行为、终端恢复或不可读输出方面的报告与修复尤其有价值。请附上你的终端、操作系统、列宽，以及有用时的截图。
- **跨平台与 Unicode 证据。**Ghostty 之外的 macOS 终端、Windows Terminal 之外的 Windows 终端、Linux PTY 覆盖以及 CJK/宽字符正确性，都在守护原生终端模型。
- **会话、附件与聚焦的 UX 改进。**改进应使用 Harness 的权威性，而不是新增并行的数据库、提供方连接或全屏会话记录。
- **与现实不符、或需要读两遍才能理解的文档。**表达清晰是正确性问题，而不是品味问题。

权威[路线图](ROADMAP.zh.md)给出了产品方向与限制；请不要在 issue（问题单）或拉取请求描述中重复它。

## 报告缺陷

开一个 [issue](https://github.com/riesbri/dshline/issues)，包含：

- 你做了什么、你期望什么、实际发生了什么。
- 你的终端程序与版本、操作系统，以及 `node --version` 的输出。
- 如果问题与安装或加载了哪些插件有关，附上 `dsh --profile dshline --dump-config` 的输出。

**对于没有任何反应的按键，**最有用的信息是你的终端实际发送的内容。下面的命令会把它打印出来：

```sh
pnpm build && node tools/keyprobe.mjs
```

按下行为异常的按键。每一行显示原始字节，以及本项目把它解码成的按键。空的 `[]` 表示该按键未被识别——请把这些行连同你的终端名称一起复制进 issue。

**不要在公开的 issue 中报告安全漏洞。**私有渠道请见[`SECURITY.md`](SECURITY.zh.md)。

## 提交变更

1. **任何大于聚焦修复的变更，先开 issue**，以免把时间花在不适合架构或路线图的事情上。
2. **阅读[`AGENTS.md`](AGENTS.md)。**它列出了容易被无意破坏的规则，并解释了渲染器、Harness 接线与终端模型为何保持分离。
3. **添加一个在没有你的变更时失败的测试。**然后故意破坏你自己的修复，确认测试能察觉。对已破坏版本依然通过的测试保护不了任何东西。
4. **对于面向用户的包变更，运行 `pnpm changeset` 并提交生成的 Markdown 文件。**文档、CI 与仅内部使用的变更不需要它。[`AGENTS.md`](AGENTS.md#preparing-a-release) 解释了版本 PR 与标签流程。
5. **不要添加依赖。**渲染器没有任何依赖，这是刻意的特性。需要新包的变更需要先讨论。
6. **在提交信息里说明原因。**写出用户看到了什么、明显的修复错在哪里、以及你如何验证。这里的长提交信息很正常。

```sh
pnpm install
pnpm build        # also required before testing by hand; see AGENTS.md
pnpm test         # the full suite, no terminal and no model needed
pnpm typecheck
pnpm security     # the dependency and workflow checks that CI runs
```

以上全部必须通过。CI 在 Node 22.19、24 与 26 上运行它们，外加 Harness target 车道（`HARNESS_TARGET` 中已采纳的上游修订版）与 Harness published 消费方路径，合并前每一项检查都必需。

### 选择加入的真实 Codex 验收

通用 Work 适配器还有一项真实提供方的验收检查。它不是常规 CI 的一部分：它会启动包托管的 Codex 应用服务器，并要求你有本机 Codex 认证。在仓库根目录运行：

```sh
pnpm test:codex
```

它使用一个临时的空工作区，通过 Work 及其现有浮层校验通用的 `subagent/start` 与 `subagent/end`，然后等待受管进程树退出。不要在 CI 中设置该变量。

## 哪些可能被拒绝

如实说明可以节省你的时间：

- **新增依赖**，除非它替换了明显更差的东西。
- **在标准 Harness 能力接口就能提供同样事实的地方，实现提供方专用的方案。**
- **重写到 UI 框架。**「追加 + 活动区域」的终端模型是刻意的；见[设计](docs/design.zh.md)。
- **需要全屏布局的特性**，例如分屏或侧边面板。本界面打印进原生终端滚动缓冲区（scrollback），这刻意排除了它们。

## 你能期待什么

这不是一个有资金支持的项目，审阅可能需要几天。长期没有回复的拉取请求并不代表被拒绝了——请再次评论它。

通过贡献，你同意你的贡献按 [MIT 许可证](LICENSE) 授权，与本项目其余部分相同。