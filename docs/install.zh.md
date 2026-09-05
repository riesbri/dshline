# 安装

[English](install.md) | 中文

> **如果你是一个 AI agent：**本页就是完整流程。请按顺序执行，然后用最后一节确认它是否成功。
> ```
> curl -s https://raw.githubusercontent.com/riesbri/dshline/main/docs/install.md
> ```

## 环境要求

- **Node.js** `^22.19 || >=24`。
- **可用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 安装**，且已配置模型。如果 `dsh web` 能启动并回答提示，你就准备好了。
- **真实终端。**本界面在输入和输出两端都需要终端。如果任一端被重定向，它会报错退出，而不是空屏等待。脚本化运行请改用 `--profile headless`。

## 快速上手

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline   # the harness, and this interface
dshline                                            # from any folder, on any machine
```

第一次运行时，`dshline` 会询问是否允许 Harness 创建 `dshline` 配置文件并把本包安装进去。回答“是”，同一条命令就会继续进入你要的会话，没有第二个步骤。`dshline --setup` 则不询问、单独执行这次安装——脚本、重试或源码检出需要的正是它。

本页其余部分解释每个步骤，以及某一步不适用于你时该怎么办。

## 1. 确保你有一个 `dsh` 命令

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

## 2. 通过 Harness 手动安装

```sh
dsh plugin --profile dshline add @dshline/dshline
dsh --profile dshline
```

**配置文件（profile）**是一组有名字的插件，存储在 `$DSH_HOME/profiles/<name>`（默认 `~/.dsh`）。第一条命令会在不存在时创建 `dshline` 配置文件、把本插件安装进去，并把它加入配置文件的插件列表。你的配置文件现在是 Harness 的标准插件集再加上本界面。

### 从源码检出安装

要运行尚未发布的变更：

```sh
git clone https://github.com/riesbri/dshline && cd dshline
pnpm install && pnpm build
dsh plugin --profile dshline add ./packages/dshline
```

相对路径按命令运行所在的文件夹解析。使用 `pnpm dsh` 时，该文件夹是 Harness 检出，而不是本仓库，所以请给出绝对路径：

```sh
pnpm dsh plugin --profile dshline add ~/path/to/dshline/packages/dshline
pnpm dsh --profile dshline
```

当 `DSH_HARNESS` 指向一个 Harness 检出时，`dshline --setup` 也是同样的情况：那个启动器只能以检出作为工作文件夹运行，所以 `dshline --setup ./packages/dshline` 会从 Harness 内部安装一个同名文件夹。请写出完整路径：

```sh
dshline --setup ~/path/to/dshline/packages/dshline
```

不支持直接从 Git URL 安装。`dsh plugin add github:riesbri/dshline` 会安装仓库根目录，而它是包含两个包的工作区，并不是插件本身。请使用 npm 包名，或指向 `packages/dshline` 的路径。

## 3. 获得一个单词的命令

全局安装本包会在你的 PATH 上放置一个 `dshline` 命令：

```sh
npm install -g @dshline/dshline
dshline             # the same as: dsh --profile dshline --cwd "$PWD"
dshline --setup     # the same as: dsh plugin --profile dshline add @dshline/dshline
dshline --version   # this package's version, with no harness and no profile needed
```

它是 Harness 启动器的一层轻量封装，仅此而已：它找到 `dsh`、除非你指定了其他配置文件否则加上 `--profile dshline`、将会话固定在你运行它的文件夹，然后透传其余一切。因此 `dshline --resume`、`dshline "run the tests"` 与 `dshline --help` 都会到达真正的启动器。

它需要找到两样东西：

- **启动器**，按你已经做决定的顺序在四个位置查找：`$DSH_BIN`，然后是 `$DSH_HARNESS`，然后是 PATH 上的 `dsh`，然后是与它自己相邻的 `@deepseek-ai/dsh` 包——这就是为什么一条命令同时全局安装两者就足够了。

  对于**源码检出**，把 `DSH_HARNESS` 设为检出本身：

  ```sh
  export DSH_HARNESS=~/path/to/deepseek-harness
  ```

  检出没有可供 `DSH_BIN` 指向的 `dsh` 可执行文件：它的启动器是一个通过加载器运行的 TypeScript 入口，写在检出自身的 `package.json` 中，作为 `dsh` 脚本。`dshline` 会读取该脚本并从检出中运行它，因此即使 Harness 移动了自己的文件，它也能继续工作。`DSH_BIN` 用于真正的可执行文件——全局安装，或把 Harness 作为依赖安装所产生的 `node_modules/.bin/dsh`。

- **配置文件。**首次运行会主动提出创建它：先问一个问题，然后通过刚找到的启动器执行 `dsh plugin --profile dshline add @dshline/dshline`，接着进入你原本要的会话——`dshline --resume`、`dshline -C ~/code/api` 和 `dshline "run the tests"` 都会继续执行你输入的内容。回答“否”则什么都不安装。

  这个行为刻意不做三件事。没有可供询问的终端时它不会运行：脚本或 CI 任务会被告知运行 `dshline --setup`，因为这次安装会通过 pnpm 访问网络，而脚本化运行从未同意过。已经存在的配置文件它一概不动，无论看起来多坏——诊断损坏的配置文件是 Harness 自己加载器的职责，而 `dshline --setup` 就是重试手段。当你自己指定配置文件时它完全不适用：`dshline --profile other`，甚至 `dshline --profile dshline`，都表示你在直接使用 Harness 的配置文件语义，因此 `dshline` 不做任何检查，只是把这个选择透传过去。

  要从检出而不是 registry 安装，用的同样是 `dshline --setup`：把路径交给它，`dshline --setup ./packages/dshline`。

npm 包的作用域名是 `@dshline/dshline`。npm 上不带作用域的 `dshline` 包与本项目无关。

## 4. 确认成功

```sh
dshline --version          # the version a bug report asks for
dshline --dump-config      # look for a "# == dshline" section
dshline --help             # the flags this interface adds
dshline                    # a banner, an input line, and a "ready" status line
```

**全新安装还没有模型，而 dshline 会明说，不会把你丢在一个发不出去的提示符前。**当这次启动原本会打开一个没有可用模型的输入框时——没有路由、没有选择，或者选择所指的路由已经消失——会话会以 [`/setup`](usage.zh.md#setup) 打开：它打印你的安装是什么——Node、dshline、Harness 世代、profile，以及为什么没有模型——随后提供打开 `/connect`，并在连接产生了那条缺失的路由之后直接进入 `/model`。除非你选择，否则不写入任何东西；`esc` 直接进入输入框，而 `/setup` 随时可以重新打开这个流程。一旦路由被配置并且选中了模型，它就再也不会自行出现。

在会话内输入 `/` 列出你的配置文件提供的命令，然后按 `ctrl-d` 退出。

如果某个键盘快捷键没有反应，请在本仓库检出的目录下运行 `node tools/keyprobe.mjs`。它会显示你的终端发送了什么、本项目如何解读它，这正是缺陷报告需要的内容。

## 故障排查

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