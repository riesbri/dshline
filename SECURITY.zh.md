# 安全

[English](SECURITY.md) | 中文

## 报告漏洞

请通过 GitHub 的[私有漏洞报告](https://github.com/riesbri/dshline/security/advisories/new)私下提交。它会直接送达维护者而不公开，这也是唯一渠道——请不要为可被利用的问题开公开 issue（问题单）。

预计一周内会收到确认。这是一个个人项目，而非有资金支持的项目，因此这是一个现实的承诺，而不是有团队支撑的目标。如果报告得到确认，修复与安全公告会一同发布，除非你另有要求，否则你会在公告中署名。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 本身的漏洞属于上游，不属于这里。如果你不确定问题出在哪一侧，请在这里报告，我们会负责转交。

## 范围

`dshline` 是面向 agent 的终端原生前端。它的暴露面由此而来，下面这些是最值得仔细检查的地方。

**终端转义注入。**本项目绘制的每一个字符串都来自模型、工具、文件或粘贴内容，它们都不被信任。终端把字节当作命令：模型回复中的转义序列可以重定位光标、重写用户已读过的行、重设窗口标题，在某些终端模拟器中甚至能把文本塞进输入缓冲区。因此，任何到达屏幕的内容都会先经过 `escapeControls`，并以脱字符记法（caret notation）显示；样式只应用于已经安全化的文本——绝不能反过来，因为对已着色的输出做转义会破坏样式，而只转义部分片段则会让控制序列从其他位置漏过。未经转义就到达终端的路径在本项目中是漏洞，而不是渲染缺陷。渲染器的测试套件对普通文本、代码片段、围栏代码块、标题、列表项、链接、工具输出、粘贴文本和实时流式区域都做了断言。

**截断与宽度。** `displayWidth` 会忽略转义序列，因此 `wrapToWidth` 和 `truncateToWidth` 也必须如此。落在序列内部的截断会输出一段不完整的转义，终端会用后续内容把它补全——所以宽度缺陷就是带额外步骤的注入缺陷。

**括号粘贴（bracketed paste）。**粘贴内容在其进入输入行时被净化，而不是在绘制时。否则，包含转义序列的文档就会成为通过只想粘贴文本的用户触达终端的途径。此后，大段粘贴的内容会被绘制成紧凑的 `[Pasted text #1 +11 lines]` 占位符而不是其内容，这构成了从不受信输入通往屏幕的第二条路径，因此有同样的要求：占位符完全由本项目生成的数字组装而成，绝不包含粘贴内容的任何字符，且净化不会推迟到那一步。被隐藏的内容仍然保持隐藏——提交、历史记录与补全来源读取的都是已净化的缓冲区，而不是投影。

**这里不涵盖的内容。**agent 被允许做什么——有哪些工具、哪些调用需要审批、沙箱允许什么——由挂载本插件集的配置文件决定，而不是由本插件集决定。这是刻意的：Harness 把策略放在组合层，而一个替你决定策略的前端并不是寻找它的正确位置。关于工具执行了不应执行的操作的报告，除非此前是本前端批准了本应拒绝的审批请求，否则应归上游或组合层处理。

## 本仓库如何自我防御

这不是安全的承诺，只是实际接线了什么、以及去哪里看。

| 控制项 | 位置 |
| --- | --- |
| 每次推送与每周的漏洞库扫描 | `.github/workflows/security.yml` |
| 每个拉取请求的新依赖与许可证审查 | `.github/workflows/security.yml` |
| 全历史密钥（secret）扫描 | `.github/workflows/security.yml` |
| 工作流加固检查（`zizmor`，pedantic 级别） | `.github/workflows/security.yml` |
| 静态分析（`CodeQL`，`security-extended`） | `.github/workflows/security.yml` |
| 供应链态势评级（`OpenSSF Scorecard`） | `.github/workflows/security.yml` |
| Actions 固定到提交（commit）而不是标签 | 每个工作流 |
| CI 中从不运行安装脚本 | `--ignore-scripts` |
| 锁文件受校验而非信任 | 从不使用 `--trust-lockfile` |
| 不安装任何发布不足 2 小时的版本 | `minimumReleaseAge`，`pnpm-workspace.yaml`；适用于每一个任务，没有例外。以前存在的豁免只服务于一条追赶 npm dist-tag 的车道，而那条车道已被删除：dshline 现在针对 `HARNESS_TARGET` 中记录的确切 Harness 修订版，因此没有任何任务需要在某个版本刚发布的那一刻安装它。若该豁免重新出现，`tools/ci-workflow.spec.mjs` 会让测试套件失败 |
| 用户的首次运行安装的正是发起该次运行的那个 dshline 版本，并遵循同样的 2 小时窗口 | `packages/dshline/bin/dshline.mjs` 指名自己的确切版本，并把 `--config.minimum-release-age` 传给 Harness 的 pnpm。pnpm 安装进入的 profile 属于 Harness，其中不含任何 dshline 配置，因此该窗口通过命令行传递，而不是写进别人的文件。仍处于窗口内的版本绝不会在未经询问的情况下被安装：在终端上 pnpm 会把决定权交给用户，而在无人可问的场合则直接拒绝。两种情况下安装都会停止、什么也不会启动，这正是目的所在：若不显式声明，pnpm 11 自带的默认值会让一个裸包名静默地解析到比运行中的 wrapper 更旧的 dshline |
| 削弱包信任证据的行为会使安装失败 | `trustPolicy: no-downgrade`，`pnpm-workspace.yaml` |
| 依赖与 Actions 升级以人工审查方式提出 | `.github/dependabot.yml` |
| 发布由 CI 构建并附带签名来源证明（provenance） | `.github/workflows/publish.yml` |
| npm 只信任指定的工作流，并用其 OIDC 身份换取短期、按包限定的凭据；GitHub 中不存储 npm token | `id-token: write` 与 `tools/check-trusted-publishers.mjs` |
| 任一包发布前，两个包的身份交换均被校验 | `.github/workflows/publish.yml` |
| 只有发布与 registry 校验成功后，才能写入 GitHub Release | `.github/workflows/publish.yml` 中独立的 `github-release` 任务 |
| 自动化版本标签来自已合并的生成版本 PR，或经校验与该 PR 合并提交一致的显式恢复（recovery）调度 | `.github/workflows/version.yml` |
| 另一发布处于活动状态时，拒绝创建新的自动化标签，以免 GitHub 丢弃待处理的中间运行 | `.github/workflows/version.yml` |
| 版本 PR 的 token 与只读任务 token 分离，且仅限 Contents 与 Pull requests 写入，以便在不把那些作用域授予任务的情况下触发必需的 PR 检查 | `.github/workflows/version.yml` 中的 `VERSION_TOKEN` |
| 触发标签的 token 是独立的、细粒度且仅限 Contents，而不是宽泛的发布凭据 | `.github/workflows/version.yml` 中的 `RELEASE_TOKEN` |
| 发布构建不恢复任何分支可能写入过的缓存 | `package-manager-cache: false` |
| 与要发布的版本不一致的标签在创建前被拒绝，并在发布前再次校验 | `tools/check-release-tag.mjs` |
| 只发布了一半的发布会直接失败，而不是事后才发现 | `tools/verify-published.mjs` |

## 校验你安装的内容

发布由 GitHub Actions 构建并发布，它会记录一份签名证明，把每个 tarball 绑定到本仓库、构建它的提交以及构建它的工作流。因此你无须信任已发布包与源码一致：

```sh
npm audit signatures
```

npm 上每个版本页面都链接到对应的提交与工作流运行。没有该证明的版本不是由这套流水线发布的。

已发布的包除彼此之外不声明任何运行时依赖，这是它们界面（攻击面）如此之小的最大原因：`@dshline/renderer` 完全没有运行时依赖，而 Harness 提供的一切都是宿主已具备的 peer（对等）依赖。