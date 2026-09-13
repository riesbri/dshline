<p align="center">
  <img src=".github/assets/dshline-hero.svg" alt="dshline：面向 DeepSeek Harness 的终端原生前端。Harness 插件通过能力约定流入原生终端 UI。" />
</p>

# dshline

[English](README.md) | 中文

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件生态系统的终端原生前端。**

agent（智能体）在你的终端里，而不是取代你的终端。完成后的输出会留在终端自身的滚动缓冲区（scrollback）中，只有有界的活动区域会重绘。

**网站：**[dshline.xyz](https://dshline.xyz)

[![npm](https://img.shields.io/npm/v/%40dshline%2Fdshline?color=ff6b35&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@dshline/dshline)
[![CI](https://img.shields.io/github/actions/workflow/status/riesbri/dshline/ci.yml?branch=main&color=369eff&labelColor=black&logo=github&style=flat-square&label=ci)](https://github.com/riesbri/dshline/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/riesbri/dshline?color=c4f042&labelColor=black&style=flat-square&label=scorecard)](https://scorecard.dev/viewer/?uri=github.com/riesbri/dshline)
[![license](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

## 实际效果

<p align="center">
  <img src=".github/assets/dshline-demo.gif" alt="dshline 的终端动画演示：选择模型、浏览插件，以及跟进一个 subagent 任务。" />
</p>

## 安装

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline
dshline
```

首次运行会先询问一次，然后才让 Harness 创建 `dshline` 配置文件并把本包安装进去。关于系统要求、校验、用 `dshline --setup` 显式安装以及源码安装，请参阅[安装](docs/install.zh.md)。

> [!WARNING]
> 沙箱和工具权限由当前激活的 Harness 配置文件控制；普通工具调用可能在未经逐次审查的情况下直接运行。在对重要代码使用 dshline 之前，请先参阅[权限与沙箱](docs/usage.zh.md#permissions-and-the-sandbox)。

## 为什么选择 dshline？

Harness 插件发布能力；dshline 在终端中以原生方式呈现受支持的能力。它在进程内运行并消费 Harness 约定，而不是创建独立的提供方运行时、状态存储或策略。

`Harness plugin → standard capability → dshline presentation adapter → native terminal UI`

Harness 拥有能力、状态、运行时、持久化与策略；dshline 只负责终端呈现。

<p align="center">
  <img src=".github/assets/dshline-architecture.svg" alt="能力从 DeepSeek Harness 插件出发，经标准能力接口与 dshline 适配器，流入具备真实滚动缓冲区的原生终端 UI。" />
</p>

### 通用能力集成

dshline 通过标准 Harness 能力进行集成，而不是编写提供方专用代码。Work 视图消费 `ctx.jobs` 和 `ctx.subagents`；Sessions 视图使用 `ctx.sessionQuery`；`/connect` 使用 Harness 的模型、设置、凭据和授权服务；`/plugins` 通过 `ctx.agentPresets` 读取并切换运行中 agent 的组合；`/profiles` 通过 Harness 自己的 home-path 服务读取配置文件名册，并把每一项变更转发给 `dsh plugin`。因此，新提供方可以经由现有接口接入，无需专门的 dshline 实现。

它不附带提供方列表，也没有登录协议：`/connect` 提供所有已挂载适配器声明为可配置的内容，并运行 Harness 已注册的所有流程，因此终端与官方 Web 的 Models 页面可以基于同一份设置文档和同一个凭据存储，访问相同的提供方。

关于能力模型与当前适配器边界，请参阅[架构](docs/architecture.zh.md)。

### 原生终端设计

完成后的输出会写入真实的终端滚动缓冲区（scrollback），绝不会被重写。dshline 只重绘有界的活动区域，正常的滚动、选择和复制在此期间始终可用。与 Harness 无关的渲染器保持小巧、依赖极轻，并专注于终端正确性：宽度、Unicode、转义、按键与安全重绘。

关于终端不变量，请参阅[设计](docs/design.zh.md)；关于相关取舍，请参阅[对比](docs/comparison.zh.md)。

## 使用 dshline

输入 `/` 即可发现当前激活的 Harness 配置文件中可用的命令与能力。

- `/new` — 在当前工作区开始一个全新会话；当前激活的 Harness 配置文件提供会话持久化时，上一个会话仍可重新打开
- `/clear` — 清屏并在当前工作区开始一个全新会话，如同 `/new`；当前激活的 Harness 配置文件提供会话持久化时，上一个会话仍可重新打开
- `/image <path>` — 为下一条提示暂存 PNG、JPEG、WebP 或 GIF，作为真正的 Harness 图片；`@path` 仍是文本引用
- `/sessions` — 浏览并恢复 Harness 会话
- `/worktrees` — 选择你的 Harness 会话历史中有代表的工作目录，然后选择那里的一场对话或开一场新的
- `/work` — 查看工作流、subagent 与任务
- `/subagents` — 浏览本会话持久的 subagent 对话、检视其中一个，并继续一个 continuable 子级；也可以在 `/work` 中按 `c` 进入
- `/connect` — 通过 Harness 配置提供方
- `/plugins` — 浏览、搜索并定制运行中 agent 的 Harness 预设组合
- `/profiles` — 浏览 Harness 配置文件及各自组合的 bundle；安装、更新或移除其中之一
- `/todos` — 查看投影的 Todo 状态
- `/model` — 切换已注册的模型
- `/theme` — 选择本窗口绘制所用的颜色配色

[使用](docs/usage.zh.md)涵盖按键、会话、命令与权限指南。

## 贡献

欢迎各种贡献，尤其是通用能力适配器、终端健壮性、跨平台验证、Unicode/CJK 正确性、会话、附件以及聚焦的 UX 改进。请从 [CONTRIBUTING.md](CONTRIBUTING.zh.md) 开始，然后阅读 [AGENTS.md](AGENTS.md) 和权威[路线图](ROADMAP.zh.md)。

## 文档

- [安装](docs/install.zh.md)
- [使用](docs/usage.zh.md)
- [架构](docs/architecture.zh.md)
- [设计](docs/design.zh.md)
- [路线图](ROADMAP.zh.md)
- [对比](docs/comparison.zh.md)
- [贡献](CONTRIBUTING.zh.md)
- [安全](SECURITY.zh.md)

## 许可证

[MIT](LICENSE)。本项目与 DeepSeek 无关联，也未经其认可。
