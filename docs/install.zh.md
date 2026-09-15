# 安装

[English](install.md) | 中文

> **如果你是一个 AI agent：**本页就是完整流程。请按顺序执行，然后用最后一节确认它是否成功。
> ```
> curl -s https://raw.githubusercontent.com/riesbri/dshline/main/docs/install.md
> ```

## 环境要求

- **Node.js** `^22.19 || >=24`。
- **一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 安装。**`npm install -g @deepseek-ai/dsh` 就够了。Harness 源码检出同样可以——见[开发与源码检出](#开发与源码检出)。
- **PATH 上有 pnpm。**Harness 用 pnpm 安装配置文件的插件，所以没有它，配置流程根本无法开始。可以 `npm install -g pnpm`，或者在你的 Harness 检出已经声明了自己的 pnpm 时用 `corepack enable pnpm`。`dshline` 会在改动任何东西**之前**检查，并在缺失时告诉你，而不是先创建一个配置文件再停下。
- **真实终端。**本界面在输入和输出两端都需要终端。如果任一端被重定向，它会报错退出，而不是空屏等待。脚本化运行请改用 `--profile headless`。

**已配置的模型不是前提。**全新安装会以 [`/setup`](usage.zh.md#setup) 打开：它打印你的安装是什么，并提供打开 `/connect`——登录账号，或存入某条路由所需的密钥——随后继续进入 `/model`。除非你选择，否则不写入任何东西。

## 正常安装

简短版本：

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline   # the harness, and this interface
dshline                                            # from any folder, on any machine
```

第一次运行时，`dshline` 会询问是否允许 Harness 创建 `dshline` 配置文件并把本包安装进去。回答“是”，同一条命令就会继续进入你要的会话，没有第二个步骤。`dshline --setup` 则不询问、单独执行这次安装——脚本、重试或源码检出需要的正是它。

本页其余部分解释每个步骤，以及某一步不适用于你时该怎么办。

### 1. 确保你有一个 `dsh` 命令

本插件由 Harness 自己的命令行程序启动，所以你需要一种运行它的方式。两种选择都可以。

全局安装 Harness：

```sh
npm install -g @deepseek-ai/dsh
```

或者，如果你在 Harness 源码检出中工作，可以使用它的工作区脚本——`pnpm dsh` 与 `dsh` 行为一致：

```sh
cd ~/path/to/deepseek-harness
pnpm dsh --version
```

本页其余部分写作 `dsh`。如果你用第二种方式，请改写作 `pnpm dsh`，并在 Harness 文件夹内运行它。

### 2. 通过 Harness 手动安装

```sh
dsh plugin --profile dshline add @dshline/dshline
dsh --profile dshline
```

**配置文件（profile）**是一组有名字的插件，存储在 `$DSH_HOME/profiles/<name>`（默认 `~/.dsh`）。第一条命令会在不存在时创建 `dshline` 配置文件、把本插件安装进去，并把它加入配置文件的插件列表。你的配置文件现在是 Harness 的标准插件集再加上本界面。

要从源码检出而不是 registry 安装，见[开发与源码检出](#开发与源码检出)——那里是两个彼此独立的决定，而不是一个。

### 3. 获得一个单词的命令

全局安装本包会在你的 PATH 上放置一个 `dshline` 命令：

```sh
npm install -g @dshline/dshline
dshline             # the same as: dsh --profile dshline --cwd "$PWD"
dshline --setup     # the same as: dsh plugin --profile dshline add @dshline/dshline
dshline --version   # this package's version: no harness, no profile, no terminal
dshline --help      # what this wrapper owns and how it forwards: same, no profile needed
```

它是 Harness 启动器的一层轻量封装，仅此而已：它找到 `dsh`、除非你指定了其他配置文件否则加上 `--profile dshline`、将会话固定在你运行它的文件夹，然后透传其余一切。因此 `dshline --resume` 与 `dshline "run the tests"` 都会原样到达真正的启动器。有三个参数属于这层封装本身，会停在这里——`--setup`、`--version` 与 `--help`——因为每一个都必须在 Harness、配置文件或两者恰好就是坏掉的那台机器上可用。要查看 Harness 自己的选项，去问 Harness：

```sh
dsh --profile dshline --help
```

它需要找到两样东西：

- **启动器**，按你已经做决定的顺序在四个位置查找：`$DSH_BIN`，然后是 `$DSH_HARNESS`，然后是 PATH 上的 `dsh`，然后是与它自己相邻的 `@deepseek-ai/dsh` 包——这就是为什么一条命令同时全局安装两者就足够了。

  对于**源码检出**，把 `DSH_HARNESS` 设为检出本身：

  ```sh
  export DSH_HARNESS=~/path/to/deepseek-harness
  ```

  检出没有可供 `DSH_BIN` 指向的 `dsh` 可执行文件：它的启动器是一个通过加载器运行的 TypeScript 入口，写在检出自身的 `package.json` 中，作为 `dsh` 脚本。`dshline` 会读取该脚本并从检出中运行它，因此即使 Harness 移动了自己的文件，它也能继续工作。`DSH_BIN` 用于真正的可执行文件——全局安装，或把 Harness 作为依赖安装所产生的 `node_modules/.bin/dsh`。

- **配置文件。**首次运行会主动提出创建它：先问一个问题，然后通过刚找到的启动器执行 `dsh plugin --profile dshline add @dshline/dshline`，接着进入你原本要的会话——`dshline --resume`、`dshline -C ~/code/api` 和 `dshline "run the tests"` 都会继续执行你输入的内容。回答“否”则什么都不安装。

  对已经存在的配置文件，它做的事刻意很窄。它只看一件事——本包是否记录在它自己的配置文件里，以及记的是哪个发布版本——并拒绝启动进入两种背后没有可用前端的状况：失败安装留下的空配置文件，以及记录的发布版本与启动它的封装不同的配置文件。两种都会连同原因和修复方式 `dshline --setup` 一起报出，并且在终端上会主动提出执行该修复。配置文件的其他一切——bundle 列表、`node_modules`、别的插件——都交给 Harness 自己的加载器，它才是这方面的权威。

  这个行为仍然不做三件事。没有可供询问的终端时它不会运行安装：脚本或 CI 任务会被告知运行 `dshline --setup`，因为这次安装会通过 pnpm 访问网络，而脚本化运行从未同意过。前提缺失时它不会开始安装——pnpm 会先被检查，所以没有它的机器得到的是一句话，而不是一个半成品配置文件。当你自己指定配置文件时它完全不适用：`dshline --profile other`，甚至 `dshline --profile dshline`，都表示你在直接使用 Harness 的配置文件语义，因此 `dshline` 不做任何检查，只是把这个选择透传过去。

  要从检出而不是 registry 安装，用的同样是 `dshline --setup`：把**绝对**路径交给它。在设置了 `DSH_HARNESS` 时，`dsh plugin` 以 Harness 检出为工作文件夹运行，所以相对的 `./packages/dshline` 指的是 Harness 内部的文件夹。

npm 包的作用域名是 `@dshline/dshline`。npm 上不带作用域的 `dshline` 包与本项目无关。

### 4. 确认成功

```sh
dshline --version                    # the version a bug report asks for
dshline --help                       # what this wrapper owns, and how it forwards
dsh --profile dshline --dump-config  # look for a "# == dshline" section
dshline                              # a banner, an input line, and a "ready" status line
```

`--dump-config` 属于 Harness，不属于 `dshline`。它导出组合后的配置文件——那是 Harness 自己的结构——而 `dsh --profile dshline --dump-config` 是唯一规范的写法，也正是 bug 报告模板要求的。这里刻意不提供 `dshline --dump-config` 别名：多一个标志就得与 Harness 的那个并排维护，而且会与它逐渐偏离。

**全新安装还没有模型，而 dshline 会明说，不会把你丢在一个发不出去的提示符前。**当这次启动原本会打开一个没有可用模型的输入框时——没有路由、没有选择，或者选择所指的路由已经消失——会话会以 [`/setup`](usage.zh.md#setup) 打开：它打印你的安装是什么——Node、dshline、Harness 世代、profile，以及为什么没有模型——随后提供打开 `/connect`，并在连接产生了那条缺失的路由之后直接进入 `/model`。除非你选择，否则不写入任何东西；`esc` 直接进入输入框，而 `/setup` 随时可以重新打开这个流程。一旦路由被配置并且选中了模型，它就再也不会自行出现。

在会话内输入 `/` 列出你的配置文件提供的命令，然后按 `ctrl-d` 退出。

如果某个键盘快捷键没有反应，请在本仓库检出的目录下运行 `node tools/keyprobe.mjs`。它会显示你的终端发送了什么、本项目如何解读它，这正是缺陷报告需要的内容。

## 开发与源码检出

Harness 与 dshline 是两个彼此独立的选择，而其中哪一个是检出，会改变你要输入的命令。对任一方来说，检出都是一个已经做出的决定，所以这里不会拿它去和任何已发布的版本比较。

| Harness | dshline | 命令序列 |
| --- | --- | --- |
| npm 包 | npm 包 | `npm install -g @deepseek-ai/dsh @dshline/dshline`，然后 `dshline` |
| npm 包 | 本地 dshline 检出 | `npm install -g @deepseek-ai/dsh` · 在 dshline 检出中 `pnpm install && pnpm build` · `dshline --setup /abs/path/to/dshline/packages/dshline` · `dshline` |
| 本地 Harness 检出 | npm dshline 包 | `npm install -g @dshline/dshline` · `export DSH_HARNESS=~/path/to/deepseek-harness` · `dshline` |
| 本地 Harness 检出 | 本地 dshline 检出 | 以上两者都用：既设置 `DSH_HARNESS`，**也**执行 `dshline --setup /abs/path/to/dshline/packages/dshline` |

第一行是普通安装，也是本页上面唯一走完的那一种。其余三行用于开发尚未发布的代码，每一种都需要指名一样东西：

- **dshline 检出**是按路径安装的，不是按名字：`dshline --setup /abs/path/to/dshline/packages/dshline`。请给出**绝对**路径。设置了 `DSH_HARNESS` 时，`dsh plugin` 以 *Harness* 检出为工作文件夹运行，所以相对的 `./packages/dshline` 指的是 Harness 内部的文件夹。配置文件随后记录的正是这个路径，这就是 `dshline` 从不把它当作过期发布版本的原因：根本没有可比较的发布版本。
- **Harness 检出**用 `DSH_HARNESS` 指名，绝不要用 `DSH_BIN`。检出没有 `dsh` 可执行文件——它的启动器是它自己 `package.json` 里的 `dsh` 脚本，通过加载器运行——所以 `dshline` 读取该脚本并从检出中运行它。`DSH_BIN` 用于真正的可执行文件：`npm install -g @deepseek-ai/dsh` 放到你 PATH 上的那个，或者把 Harness 作为依赖安装所产生的 `node_modules/.bin/dsh`。

然后，每次改动源码后都要重新构建——插件解析到编译后的 `lib/`，而不是 `src/`：

```sh
pnpm build     # in the dshline checkout
```

### 不支持：安装仓库根目录

```sh
dsh plugin --profile dshline add github:riesbri/dshline   # do not use this
```

这会安装 `dshline-workspace`，也就是仓库根目录——它是装着两个包的工作区，而不是插件本身。它不是配置文件的一层，所以你得到的配置文件里没有前端，Harness 在安装时也会这样告诉你。请使用 npm 包名，或指向 `packages/dshline` 的绝对路径。

## 故障排查

### `cannot set up the "dshline" profile, because pnpm is not available`

```
$ dshline
dshline: cannot set up the "dshline" profile, because pnpm is not available.

The harness installs a profile's plugins with pnpm, so pnpm has to be on your
PATH before setup can begin. Nothing has been changed: no profile was created
and nothing was installed.
```

Harness 用 pnpm 安装配置文件的插件，所以没有它，配置流程无法开始。`dshline` 会在创建任何东西**之前**检查 pnpm，所以你得到的是一句话，而不是一个存在却空无一物的配置文件——那正是过去会让下一次启动卡在空白屏幕上的状态。安装它，然后重新运行配置：

```sh
npm install -g pnpm
dshline --setup
```

Harness **检出**会在自己的 `packageManager` 字段里声明它想要的 pnpm 版本，所以那里优先给出 `corepack enable pnpm`，以保留该版本。

### `the "dshline" profile is half set up, so there is nothing to launch`

```
$ dshline
dshline: the "dshline" profile is half set up, so there is nothing to launch.
```

上一次配置创建了配置文件，却没能把任何东西装进去就停下了。Harness 会在安装**之前**写入配置文件清单，所以清单在那里只能证明配置开始过，永远不能证明它完成过——这正是过去信任它就会打开空白终端并一直等待的原因。运行 `dshline --setup` 把它做完，或者在终端上出现提示时接受该提议。

### `this dshline is X, but the "dshline" profile has @dshline/dshline Y`

```
$ npm install -g @dshline/dshline@latest
$ dshline
dshline: this dshline is 0.22.0, but the "dshline" profile has
@dshline/dshline 0.20.0.
```

配置文件里装着真正运行的前端；全局命令只是启动它的那层封装，所以更新其中一个并不会更新另一个。把它们对齐，或者在终端上出现提示时接受该提议：

```sh
dshline --setup
```

若要用**原样**的配置文件驱动 Harness，请自己指定配置文件——`dshline --profile dshline`——这会完全关闭本封装的整个生命周期行为，与指定任何其他配置文件一样。

<a id="command-dsh-not-found"></a>

### `Command "dsh" not found`

```
$ pnpm dsh --profile dshline
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "dsh" not found
```

`pnpm dsh` 是 **Harness** 仓库的脚本，因此只有当你从 Harness 检出内部运行时它才存在。在别处运行它——包括本仓库的克隆——pnpm 会报告没有该命令。有三种修复方式：

```sh
# 1. Install both globally and use the one-word command from anywhere.
npm install -g @deepseek-ai/dsh @dshline/dshline
dshline

# 2. Keep your source checkout, and name it.
export DSH_HARNESS=~/path/to/deepseek-harness
dshline

# 3. Run it from the harness folder, pointing the session elsewhere with -C.
cd ~/path/to/deepseek-harness
pnpm dsh --profile dshline -C ~/code/my-project
```

<a id="dsh_bin-points-at--which-does-not-exist"></a>

### `$DSH_BIN points at … which does not exist`

```
$ export DSH_BIN=~/path/to/deepseek-harness/node_modules/.bin/dsh
$ dshline
dshline: $DSH_BIN points at …/node_modules/.bin/dsh, which does not exist.
```

Harness **源码检出不包含该文件**，也没有任何东西会构建它：那里的启动器是检出 `package.json` 中的一个脚本，这就是为什么 `pnpm dsh` 在检出内部有效、而指向二进制的路径无效。请指定检出本身：

```sh
export DSH_HARNESS=~/path/to/deepseek-harness
```

`DSH_BIN` 只用于真正的可执行文件，比如 `npm install -g @deepseek-ai/dsh` 放到你 PATH 上的那个。

### 脚本中出现 `the "dshline" profile is not set up`

```
$ dshline < /dev/null
dshline: the "dshline" harness profile is not set up.
Automatic first-run setup asks first, because it installs packages, and there is
no terminal here to ask on.
```

首次运行的询问在输入和输出两端都需要终端，而未经询问就安装软件包不该是脚本化运行悄悄做的事。请显式地做一次安装——`dshline --setup` 无需终端也能工作，因为指名调用它本身就是许可——之后脚本里的 `dshline` 就会正常启动。

### Windows：`an argument contains a line break`

带换行的首个任务无法穿过 npm 在 Windows 上安装的 `dsh.cmd` 垫片：`cmd` 的命令行没有表示换行的方式，那个字符会结束命令，而不是留在参数内部。`dshline` 因此选择拒绝，而不是把你的文本当作语法交给 `cmd`。请把文本写成一行，或者进入会话后再输入。

### 立即退出并提示需要终端

这是前端在缺少真实终端时拒绝启动，发生在它的输入或输出被重定向时。请直接运行启动器，而不是通过不透传终端的封装脚本；脚本化运行请使用 `--profile headless`。

### 键盘快捷键没有反应

在本仓库检出的目录下运行 `node tools/keyprobe.mjs` 并按下该按键。它会打印你的终端发送的字节以及本项目解码出的按键；结果为空是一个值得报告的缺陷。

## 卸载

这会同时移除包和配置文件对它的引用：

```sh
dsh plugin --profile dshline remove @dshline/dshline
```

你的配置文件、它的设置以及 Harness 保存的会话都会保留。如果要连配置文件一起删除，删除 `$DSH_HOME/profiles/dshline`。

## 如果你安装的是正在编辑的检出

插件是被链接的，该链接解析到编译后的 `lib/` 目录——而不是 `src/`。因此每次修改源码后：

```sh
pnpm build     # in the dshline checkout
```

然后重新启动界面。如果跳过这一步，你测试的是之前的版本。请参阅 [`AGENTS.md`](../AGENTS.md#one-trap-build-before-you-test-by-hand)。