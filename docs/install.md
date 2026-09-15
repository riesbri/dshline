# Installation

English | [中文](install.zh.md)

> **If you are an AI agent:** this page is the complete procedure. Follow it in order, then use the last section to confirm it worked.
> ```
> curl -s https://raw.githubusercontent.com/riesbri/dshline/main/docs/install.md
> ```

## Requirements

- **Node.js** `^22.19 || >=24`.
- **A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation.** `npm install -g @deepseek-ai/dsh` is enough. A harness source checkout works too — see [Development and source checkouts](#development-and-source-checkouts).
- **pnpm on your `PATH`.** The harness installs a profile's plugins with pnpm, so profile setup cannot begin without it. `npm install -g pnpm`, or `corepack enable pnpm` where your harness checkout declares its own. `dshline` checks for this *before* it changes anything and tells you so if it is missing, rather than creating a profile and stopping.
- **A real terminal.** This interface needs a terminal for both input and output. If either is redirected, it exits with an error instead of waiting with nothing on screen. For scripts, use `--profile headless` instead.

**A configured model is not a prerequisite.** A fresh installation opens on [`/setup`](usage.md#setup), which prints what your installation is and offers to open `/connect` — sign in to an account, or store the key a route needs — and then goes on to `/model`. Nothing is written unless you choose it.

## Normal installation

The short version:

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline   # the harness, and this interface
dshline                                            # from any folder, on any machine
```

The first time you run it, `dshline` asks whether Harness may create the `dshline` profile and install this package into it. Answer yes and the same command carries on into the session you asked for; there is no second step. `dshline --setup` performs that install on its own, without asking, which is what a script, a retry, or a source checkout needs.

The rest of this page explains each step, and what to do when one of them does not apply to you.

### 1. Make sure you have a `dsh` command
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

### 2. Manual setup through Harness

```sh
dsh plugin --profile dshline add @dshline/dshline
dsh --profile dshline
```

A **profile** is a named set of plugins, stored in `$DSH_HOME/profiles/<name>` (by default `~/.dsh`). The first command creates the `dshline` profile if it does not exist, installs this plugin into it, and adds it to the profile's plugin list. Your profile is now the harness's standard set plus this interface.

To install from a source checkout instead of the registry, see [Development and source checkouts](#development-and-source-checkouts) — there are two independent choices there, not one.

### 3. Get a one-word command

Installing this package globally puts a `dshline` command on your PATH:

```sh
npm install -g @dshline/dshline
dshline             # the same as: dsh --profile dshline --cwd "$PWD"
dshline --setup     # the same as: dsh plugin --profile dshline add @dshline/dshline
dshline --version   # this package's version: no harness, no profile, no terminal
dshline --help      # what this wrapper owns and how it forwards: same, no profile needed
```

It is a small wrapper around the harness's launcher, and nothing more: it finds `dsh`, adds `--profile dshline` unless you asked for another profile, pins the session to the folder you ran it from, and passes everything else through. So `dshline --resume` and `dshline "run the tests"` reach the real launcher unchanged. Three arguments are the wrapper's own and stop here instead — `--setup`, `--version` and `--help` — because each has to work on a machine where the harness, the profile, or both are exactly what is broken. For the harness's own options, ask the harness:

```sh
dsh --profile dshline --help
```

Two things it needs to find:

- **The launcher**, looked for in four places, in the order in which you have already made a decision: `$DSH_BIN`, then `$DSH_HARNESS`, then `dsh` on your PATH, then the `@deepseek-ai/dsh` package sitting next to its own — which is why installing both globally in one command is enough.

  For a **source checkout**, set `DSH_HARNESS` to the checkout itself:

  ```sh
  export DSH_HARNESS=~/path/to/deepseek-harness
  ```

  A checkout has no `dsh` executable to point `DSH_BIN` at: its launcher is a TypeScript entry run through a loader, written down in the checkout's own `package.json` as a `dsh` script. `dshline` reads that script and runs it from the checkout, so it keeps working if the harness moves its own files. `DSH_BIN` is for a real executable — a global install, or a `node_modules/.bin/dsh` from installing the harness as a dependency.

- **The profile.** The first run offers to create it: one question, then `dsh plugin --profile dshline add @dshline/dshline` through the launcher it just found, then the session you originally asked for — `dshline --resume`, `dshline -C ~/code/api` and `dshline "run the tests"` all continue into what you typed. Answer no and nothing is installed.

  What it does about a profile that already exists is deliberately narrow. It looks at one thing — whether its own package is recorded in its own profile, and at which release — and refuses to launch into the two states that have no working frontend behind them: a profile a failed setup left empty, and a profile recording a different release from the wrapper starting it. Each is reported with its cause and with the repair, `dshline --setup`, and on a terminal it offers to run that repair. Everything else about a profile — a bundle list, `node_modules`, another plugin — is left to the harness's loader, which is the authority on it.

  Three things that behaviour still does not do. It does not run setup without a terminal to ask on: a script or a CI job is told to run `dshline --setup`, because the install reaches the network through pnpm and nothing scripted agreed to that. It does not begin a setup whose prerequisite is missing — pnpm is checked first, so a machine without it gets a sentence instead of a half-made profile. And it does not apply at all when you name a profile yourself: `dshline --profile other`, or even `dshline --profile dshline`, is you using harness profiles directly, so `dshline` inspects nothing and simply forwards the choice.

  `dshline --setup` is also how you install from a checkout instead of the registry: give it the path, `dshline --setup ./packages/dshline`.

The npm package is scoped as `@dshline/dshline`. The unscoped `dshline` package on npm is unrelated.

### 4. Confirm it worked

```sh
dshline --version                    # the version a bug report asks for
dshline --help                       # what this wrapper owns, and how it forwards
dsh --profile dshline --dump-config  # look for a "# == dshline" section
dshline                              # a banner, an input line, and a "ready" status line
```

`--dump-config` belongs to the harness, not to `dshline`. It dumps the composed profile — the harness's own structure — and `dsh --profile dshline --dump-config` is the one canonical spelling, which is also what the bug report template asks for. There is deliberately no `dshline --dump-config` alias: a second flag would have to be maintained beside the harness's, and would drift from it.

**A fresh install has no model yet, and dshline says so rather than leaving you at a prompt that cannot send.** When the launch would otherwise open a composer with no usable model — no route, no selection, or a selection whose route is gone — the session opens on [`/setup`](usage.md#setup): it prints what your installation is — Node, dshline, the Harness generation, the profile, and why there is no model — and then offers to open `/connect`, going straight into `/model` once connecting produces the missing route. Nothing is written unless you choose it, `esc` goes straight to the composer, and `/setup` reopens the flow at any time. Once a route is configured and a model is selected it never appears on its own again.

Inside the session, type `/` to list the commands your profile provides, then press `ctrl-d` to leave.

If a keyboard shortcut does nothing, run `node tools/keyprobe.mjs` from a checkout of this repository. It shows what your terminal sends and how this project reads it, which is what a bug report needs.

## Development and source checkouts

Harness and dshline are two independent choices, and which one is a checkout changes
what you type. A checkout of either is a decision already made, so nothing here
compares it against a released version.

| Harness | dshline | Command sequence |
| --- | --- | --- |
| npm package | npm package | `npm install -g @deepseek-ai/dsh @dshline/dshline` then `dshline` |
| npm package | local dshline checkout | `npm install -g @deepseek-ai/dsh` · `pnpm install && pnpm build` in the dshline checkout · `dshline --setup /abs/path/to/dshline/packages/dshline` · `dshline` |
| local Harness checkout | npm dshline package | `npm install -g @dshline/dshline` · `export DSH_HARNESS=~/path/to/deepseek-harness` · `dshline` |
| local Harness checkout | local dshline checkout | both of the above: `DSH_HARNESS` set **and** `dshline --setup /abs/path/to/dshline/packages/dshline` |

The first row is the ordinary installation and the only one this page walks through
above. The other three exist for working on unreleased code, and each needs one thing
named:

- **A dshline checkout** is installed by path, not by name: `dshline --setup
  /abs/path/to/dshline/packages/dshline`. Give an **absolute** path. With
  `DSH_HARNESS` set, `dsh plugin` runs with the *harness* checkout as its working
  folder, so a relative `./packages/dshline` would name a folder inside the harness.
  The profile then records that path, which is why `dshline` never treats it as an
  out-of-date release: there is no release to compare it with.
- **A harness checkout** is named with `DSH_HARNESS`, never with `DSH_BIN`. A checkout
  has no `dsh` executable — its launcher is the `dsh` script in its own `package.json`,
  run through a loader — so `dshline` reads that script and runs it from the checkout.
  `DSH_BIN` is for a real executable: the one `npm install -g @deepseek-ai/dsh` puts on
  your PATH, or a `node_modules/.bin/dsh` from a harness installed as a dependency.

Then rebuild after every source change — the plugin resolves to the compiled `lib/`,
not to `src/`:

```sh
pnpm build     # in the dshline checkout
```

### Not supported: installing the repository root

```sh
dsh plugin --profile dshline add github:riesbri/dshline   # do not use this
```

This installs `dshline-workspace`, the repository root, which is a workspace holding
two packages rather than the plugin itself. It is not a profile layer, so the profile
you get has no frontend in it, and the harness says as much when it installs it. Use
the npm package name, or an absolute path to `packages/dshline`.

## Troubleshooting

### Harness version mismatch

dshline supports one Harness generation at a time. Its Harness-facing dependencies are
pinned to that generation rather than widened across neighbouring releases, so the normal
versionless install stays the recommended command:

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline
```

A mismatch can present in two ways: npm reports a dependency or peer conflict, or
[`/setup`](usage.md#setup) shows different installed and targeted Harness versions. Do not
combine them with `--force` or `--legacy-peer-deps`; those options can produce an
installation that completes but contains no supported Harness generation.

dshline and Harness are published independently, so their npm channels can occasionally be
temporarily out of alignment. `/setup` already shows both versions and the generation this
dshline targets, and gives the deterministic recovery when one is known — follow that
diagnostic rather than forcing the dependency graph.

### `cannot set up the "dshline" profile, because pnpm is not available`

```
$ dshline
dshline: cannot set up the "dshline" profile, because pnpm is not available.

The harness installs a profile's plugins with pnpm, so pnpm has to be on your
PATH before setup can begin. Nothing has been changed: no profile was created
and nothing was installed.
```

The harness installs a profile's plugins with pnpm, so profile setup cannot start
without it. `dshline` checks for pnpm *before* it creates anything, which is why you get
this sentence rather than a profile that exists and holds nothing — the state that used
to leave the next launch hanging on a blank screen. Install it, then run setup again:

```sh
npm install -g pnpm
dshline --setup
```

A harness **checkout** declares the pnpm version it wants in its own `packageManager`
field, so `corepack enable pnpm` is offered there first, to keep that version.

### `the "dshline" profile is half set up, so there is nothing to launch`

```
$ dshline
dshline: the "dshline" profile is half set up, so there is nothing to launch.
```

A previous setup created the profile and then stopped before installing anything into
it. The harness writes the profile manifest *before* it installs, so the manifest being
there proves a setup began and never that one finished — which is why trusting it used
to open a blank terminal and wait. Run `dshline --setup` to finish it, or accept the
offer to do so when it appears on a terminal.

### `this dshline is X, but the "dshline" profile has @dshline/dshline Y`

```
$ npm install -g @dshline/dshline@latest
$ dshline
dshline: this dshline is 0.22.0, but the "dshline" profile has
@dshline/dshline 0.20.0.
```

The profile holds the frontend that actually runs; the global command is only the
wrapper that starts it, so updating one does not update the other. Reconcile them, or
accept the offer to do so when it appears on a terminal:

```sh
dshline --setup
```

To drive the harness with the profile exactly as it is, name the profile yourself —
`dshline --profile dshline` — which switches this wrapper's lifecycle behaviour off
entirely, the same as naming any other profile.

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
