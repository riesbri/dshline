# Installation

English | [中文](install.zh.md)

> **If you are an AI agent:** this page is the complete procedure. Follow it in order, then use the last section to confirm it worked.
> ```
> curl -s https://raw.githubusercontent.com/riesbri/dshline/main/docs/install.md
> ```

## Requirements

- **Node.js** `^22.19 || >=24`.
- **A working [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation** with a model configured. If `dsh web` starts and answers a prompt, you are ready.
- **A real terminal.** This interface needs a terminal for both input and output. If either is redirected, it exits with an error instead of waiting with nothing on screen. For scripts, use `--profile headless` instead.

## The short version

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline   # the harness, and this interface
dshline                                            # from any folder, on any machine
```

The first time you run it, `dshline` asks whether Harness may create the `dshline` profile and install this package into it. Answer yes and the same command carries on into the session you asked for; there is no second step. `dshline --setup` performs that install on its own, without asking, which is what a script, a retry, or a source checkout needs.

The rest of this page explains each step, and what to do when one of them does not apply to you.

## 1. Make sure you have a `dsh` command

This plugin is started by the harness's own command-line program, so you need a way to run it. Either option works.

Install the harness globally:

```sh
npm install -g @deepseek-ai/dsh
```

Or, if you work from a harness source checkout, use its workspace script — `pnpm dsh` behaves the same as `dsh`:

```sh
cd ~/path/to/deepseek-harness
pnpm dsh --version
```

The rest of this page writes `dsh`. If you use the second option, write `pnpm dsh` instead, and run it from inside the harness folder.

## 2. Manual setup through Harness

```sh
dsh plugin --profile dshline add @dshline/dshline
dsh --profile dshline
```

A **profile** is a named set of plugins, stored in `$DSH_HOME/profiles/<name>` (by default `~/.dsh`). The first command creates the `dshline` profile if it does not exist, installs this plugin into it, and adds it to the profile's plugin list. Your profile is now the harness's standard set plus this interface.

### Installing from a source checkout

To run changes that are not released yet:

```sh
git clone https://github.com/riesbri/dshline && cd dshline
pnpm install && pnpm build
dsh plugin --profile dshline add ./packages/dshline
```

A relative path is resolved against the folder the command runs in. With `pnpm dsh` that folder is the harness checkout, not this one, so give an absolute path:

```sh
pnpm dsh plugin --profile dshline add ~/path/to/dshline/packages/dshline
pnpm dsh --profile dshline
```

The same applies to `dshline --setup` when `DSH_HARNESS` names a harness checkout: that launcher only runs with the checkout as its working folder, so `dshline --setup ./packages/dshline` would install a folder of that name from inside the harness. Name the path in full:

```sh
dshline --setup ~/path/to/dshline/packages/dshline
```

Installing directly from a Git URL is not supported. `dsh plugin add github:riesbri/dshline` would install the repository root, which is a workspace containing two packages rather than the plugin itself. Use the npm package name, or a path to `packages/dshline`.

## 3. Get a one-word command

Installing this package globally puts a `dshline` command on your PATH:

```sh
npm install -g @dshline/dshline
dshline             # the same as: dsh --profile dshline --cwd "$PWD"
dshline --setup     # the same as: dsh plugin --profile dshline add @dshline/dshline
dshline --version   # this package's version, with no harness and no profile needed
```

It is a small wrapper around the harness's launcher, and nothing more: it finds `dsh`, adds `--profile dshline` unless you asked for another profile, pins the session to the folder you ran it from, and passes everything else through. So `dshline --resume`, `dshline "run the tests"` and `dshline --help` all reach the real launcher.

Two things it needs to find:

- **The launcher**, looked for in four places, in the order in which you have already made a decision: `$DSH_BIN`, then `$DSH_HARNESS`, then `dsh` on your PATH, then the `@deepseek-ai/dsh` package sitting next to its own — which is why installing both globally in one command is enough.

  For a **source checkout**, set `DSH_HARNESS` to the checkout itself:

  ```sh
  export DSH_HARNESS=~/path/to/deepseek-harness
  ```

  A checkout has no `dsh` executable to point `DSH_BIN` at: its launcher is a TypeScript entry run through a loader, written down in the checkout's own `package.json` as a `dsh` script. `dshline` reads that script and runs it from the checkout, so it keeps working if the harness moves its own files. `DSH_BIN` is for a real executable — a global install, or a `node_modules/.bin/dsh` from installing the harness as a dependency.

- **The profile.** The first run offers to create it: one question, then `dsh plugin --profile dshline add @dshline/dshline` through the launcher it just found, then the session you originally asked for — `dshline --resume`, `dshline -C ~/code/api` and `dshline "run the tests"` all continue into what you typed. Answer no and nothing is installed.

  Three things that behaviour deliberately does not do. It does not run without a terminal to ask on: a script or a CI job is told to run `dshline --setup`, because the install reaches the network through pnpm and nothing scripted agreed to that. It does not touch a profile that already exists, however broken it looks — the harness's own loader is what diagnoses a failed profile, and `dshline --setup` is the retry. And it does not apply at all when you name a profile yourself: `dshline --profile other`, or even `dshline --profile dshline`, is you using harness profiles directly, so `dshline` inspects nothing and simply forwards the choice.

  `dshline --setup` is also how you install from a checkout instead of the registry: give it the path, `dshline --setup ./packages/dshline`.

The npm package is scoped as `@dshline/dshline`. The unscoped `dshline` package on npm is unrelated.

## 4. Confirm it worked

```sh
dshline --version          # the version a bug report asks for
dshline --dump-config      # look for a "# == dshline" section
dshline --help             # the flags this interface adds
dshline                    # a banner, an input line, and a "ready" status line
```

**A fresh install has no model yet, and dshline says so rather than leaving you at a prompt that cannot send.** When the launch would otherwise open a composer with no usable model — no route, no selection, or a selection whose route is gone — the session opens on [`/setup`](usage.md#setup): it prints what your installation is — Node, dshline, the Harness generation, the profile, and why there is no model — and then offers to open `/connect`, going straight into `/model` once connecting produces the missing route. Nothing is written unless you choose it, `esc` goes straight to the composer, and `/setup` reopens the flow at any time. Once a route is configured and a model is selected it never appears on its own again.

Inside the session, type `/` to list the commands your profile provides, then press `ctrl-d` to leave.

If a keyboard shortcut does nothing, run `node tools/keyprobe.mjs` from a checkout of this repository. It shows what your terminal sends and how this project reads it, which is what a bug report needs.

## Troubleshooting

### `Command "dsh" not found`

```
$ pnpm dsh --profile dshline
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "dsh" not found
```

`pnpm dsh` is a script belonging to the **harness** repository, so it only exists when you run it from inside a harness checkout. Run it from anywhere else — including a clone of this repository — and pnpm reports that there is no such command. Three ways to fix it:

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

### `$DSH_BIN points at … which does not exist`

```
$ export DSH_BIN=~/path/to/deepseek-harness/node_modules/.bin/dsh
$ dshline
dshline: $DSH_BIN points at …/node_modules/.bin/dsh, which does not exist.
```

A harness **source checkout does not contain that file**, and nothing builds it: the launcher there is a script in the checkout's `package.json`, which is why `pnpm dsh` works from inside the checkout and a path to a binary does not. Name the checkout instead:

```sh
export DSH_HARNESS=~/path/to/deepseek-harness
```

`DSH_BIN` is only for a real executable, such as the one `npm install -g @deepseek-ai/dsh` puts on your PATH.

### `the "dshline" profile is not set up` from a script

```
$ dshline < /dev/null
dshline: the "dshline" harness profile is not set up.
Automatic first-run setup asks first, because it installs packages, and there is
no terminal here to ask on.
```

The first-run question needs a terminal on both input and output, and installing packages without being asked is not something a scripted run should do silently. Do the install once, explicitly — `dshline --setup` works with no terminal, because naming it is the permission — and the scripted `dshline` runs normally after that.

### Windows: `an argument contains a line break`

A first task with a newline in it cannot be passed through the `dsh.cmd` shim npm installs on Windows: a `cmd` command line has no representation for one, so the character would end the command rather than travel inside the argument. `dshline` refuses instead of handing your text to `cmd` as syntax. Send the text as one line, or type it into the session instead of on the command line.

### It exits immediately with a message about needing a terminal

That is the frontend refusing to start without a real terminal, which happens when its input or output is redirected. Run the launcher directly rather than through a wrapper that does not pass a terminal through, or use `--profile headless` for scripted runs.

### A keyboard shortcut does nothing

Run `node tools/keyprobe.mjs` from a checkout of this repository and press the key. It prints the bytes your terminal sends and the key this project decodes them into; an empty result is a bug worth reporting.

## Uninstalling

This removes both the package and the profile's reference to it:

```sh
dsh plugin --profile dshline remove @dshline/dshline
```

Your profile, its settings, and the harness's saved sessions are left alone. To remove the profile as well, delete `$DSH_HOME/profiles/dshline`.

## If you installed from a checkout you are editing

The plugin is linked, and that link resolves to the compiled `lib/` folder — not to `src/`. So after every change to source:

```sh
pnpm build     # in the dshline checkout
```

Then start the interface again. If you skip this step, you are testing the previous version. See [`AGENTS.md`](../AGENTS.md#one-trap-build-before-you-test-by-hand).
