# Usage

English | [中文](usage.zh.md)

## Starting a session

| | |
| --- | --- |
| `dshline` | Start in the current folder |
| `dshline -C ~/code/api` | Start in a different folder |
| `dshline "run the tests"` | Send a first message on startup |
| `dshline --resume` | Browse, search, and reopen a past session |
| `dshline --resume <id>` | Reopen a session you know the id of |
| `dshline --help` | All flags this interface adds |
| `dshline --version` | The version of this package, for a bug report |
| `dshline --setup` | Install the profile explicitly: for a script, a retry, or a source checkout |

On a first run — no `dshline` profile yet — `dshline` asks once whether Harness may create it and install this package into it, then carries on into whatever you typed. See [Install](install.md) for what it does without a terminal to ask on, and why an existing profile is never repaired.

`dshline` is a small wrapper around the harness's own launcher: it finds `dsh`, adds `--profile dshline`, and pins the session to the folder you ran it from. Everything else is passed through, so `dshline <anything>` and `dsh --profile dshline <anything>` behave the same. Use whichever you prefer.

`-C` (or `--cwd`) sets the folder the *session* works in. It does not change where the command itself runs from.

Reopening a session with `--resume` keeps the folder that session was created in, because that folder is recorded in the session file. `-C` is therefore ignored when resuming, rather than quietly moving an old conversation to a new folder.

`dshline` already opens the folder you are standing in, so no alias is needed for that.

If your harness is a source checkout rather than a global install, name the checkout once:

```sh
export DSH_HARNESS=~/path/to/deepseek-harness
```

A checkout has no `dsh` executable to point at — its launcher is a script — so this names the folder and lets `dshline` read that script from it. See [Install → Troubleshooting](install.md#dsh_bin-points-at--which-does-not-exist).

Without a global `dsh` and without that variable, `pnpm dsh` still works — but only from inside the harness folder, because that script belongs to the harness repository. See [Install → Troubleshooting](install.md#command-dsh-not-found).

## Keys

| | |
| --- | --- |
| `enter` | Send. While a turn is running, queue it or steer it — see [Queue or steer](#queue-or-steer) |
| `ctrl-enter` | Send the other way while a turn is running, where your terminal can send this key |
| `shift-enter`, `alt-enter` | Start a new line without sending |
| `tab` | Accept the highlighted suggestion |
| `ctrl-c` | Stop the agent; if it is not running, quit |
| `ctrl-d` | Quit, from anywhere — including a picker, a question, or an approval prompt |
| `ctrl-l` | Clear the display |
| `ctrl-o` | Inspect the most recent truncated tool output, at any detail level; otherwise cycle how much tool output is shown: compact, full, hidden |
| `ctrl-r` | Search what you have sent this session; press it again for the next older match |
| `ctrl-z` | Undo the last draft edit |
| `ctrl-y` | Redo the last undone draft edit |
| `↑` `↓` | Move through your earlier messages; inside a long prompt that wraps, move up and down within it before `↑` recalls history; while a suggestion list is open, move through it instead |
| `enter` `esc` | Confirm or close a box or a suggestion list |

Editing keys: `←` `→` to move, `home` and `end` (or `ctrl-a` and `ctrl-e`) for the ends of the line, `backspace` and `delete`, and `ctrl-u`, `ctrl-k`, `ctrl-w` to delete to the start, to the end, and by word. In a prompt that wraps across rows, `↑` and `↓` also move vertically through the wrapped lines, keeping the column you aimed at across short rows.

`ctrl-z` undoes the last draft edit and `ctrl-y` redoes it. Consecutive typing joins into one undo step; a cursor move, a completion acceptance, a recalled history line, or a submitted prompt each starts a fresh one — history stays history, and a sent prompt is never reachable through undo.

Pasting several lines inserts all of them and sends them as a single message.

### Images

`/image <path>` stages a PNG, JPEG, WebP, or GIF for the next ordinary prompt. The whole command remainder is the path, so spaces need no escaping:

```text
/image screenshots/error state.png
/image screenshots/result.webp
/image                     list staged images
/image --remove 2          remove one by its listed number
/image --clear             remove them all
```

Staging reads no file and creates no attachment. On the next prompt, dshline resolves and reads each path through the active Harness filesystem with the deployment's byte limit, then asks `ctx.attachments` to validate and durably commit the complete batch before sending it. A failed or cancelled admission keeps the staged paths and restores the prompt; `ctrl-c` cancels admission without quitting. Successfully sending the prompt clears the draft.

The empty composer reports the staged count. Once sent, the transcript shows each durable image's display name, dimensions, and size; the opaque attachment id, bytes, and storage path are never printed. Reopening a session reconstructs those rows from the durable `ImageBlock` references in its log. Unsent drafts are process-local to the attached session and are discarded when you start or reopen another session.

An explicitly text-only selected model is refused before any image is read. When a provider does not declare its input modalities, dshline does not guess from its name: Harness receives the image and remains the authority. Registered slash commands accept staged images only when their command descriptor declares `input.images`; an error keeps both the command text and images for correction or retry.

`@path` itself remains a textual file reference. It tells the model which workspace path to inspect with its filesystem tools; it never reads or attaches the file. This distinction matters for source files and directories, which are not Harness image attachments.

### Input history

When no suggestion list is open, `↑` steps back through the lines you sent this session — prompts and slash commands alike — and `↓` steps forward again. A half-typed line is kept for you: step back to look at an earlier message, and stepping forward past the newest one restores your unfinished line exactly as it was.

Consecutive identical submissions are remembered once, so running `run tests` three times in a row does not fill the history with three copies of it.

### Searching your input with ctrl-r

Stepping back one line at a time is fine for the last few. `ctrl-r` opens a search over the same history, so a prompt from an hour ago is a few characters away rather than fifty presses.

```
╭─ dshline ────────────────────────────────────── History 2/3 ─╮
│ ⌕ auth█                                                      │
│                                                              │
│   fix token refresh after auth retry                         │
│ ❯ investigate why auth state disappears after resume         │
│   ↳ include the subscription-provider case                   │
│                                                              │
│   /permission read-only                                      │
╰─ type to search · ctrl-r/↓ older · ↑ newer · ↵ recall · esc ─╯
```

| | |
| --- | --- |
| `ctrl-r` | Open the search, then move to the next older match |
| type | Filter, newest match first |
| `↑` `↓` | Move to a newer or an older match |
| `home` `end` | Jump to the newest or the oldest match |
| `backspace`, `ctrl-w`, `ctrl-u` | Delete a character, the last word, or the whole query |
| `↵` | Put the selected line back in the input box — it is **not** sent |
| `esc`, `ctrl-c` | Close the search and leave everything as it was |

Matching is a plain case-insensitive substring: what you type is looked for literally, anywhere in the line, so `auth` finds `reauthorize` and `AUTH` finds the same lines `auth` does. Spaces count. There is no fuzzy matching and no ranking — results are simply the matching lines, newest first.

`↵` recalls the line without sending it, so you can edit it first and press `enter` when you mean it. A recalled line keeps its place in your history: `↑` from there continues to the line before it, and `↓` walks forward and eventually restores the half-typed line you had before you searched. `esc` leaves the input box exactly as it was, cursor included.

The search covers this session's input only: your prompts and slash commands, the same lines `↑` walks. It does not search replies, tool output, or other sessions — [`/sessions`](#sessions) is where you look for a past conversation.

A long or multiline prompt is previewed around the line that matched, rather than by its first line, so you can see why a result is in the list. Pressing `ctrl-r` while a session is still being reopened is fine: the search says the history is still loading, and whatever you have typed resolves against it the moment it lands.

Reopening a session restores the history the saved log recorded: every prompt and every resolved slash command whose input was recorded. The commands this interface handles itself (`/image`, `/model`, `/reasoning`, `/usage`, `/timing`, `/enter`, `/new`, `/clear`, `/sessions`, `/work`, `/todos`, `/skills`, `/exit`, `/quit`) and mistyped commands are remembered while the session is open but are not written to the session log, so they are not restored after a resume.

### Queue or steer

Two things can happen when you press `enter` while the agent is working, and they
are genuinely different:

| | |
| --- | --- |
| Queue | Handle this as a separate follow-up turn, once the current one is done |
| Steer | Give this to the running turn, at its next usable step |

Queue is for the next thing — "and then update the changelog". Steer is for the
turn in front of you — "stop using that file". Steering joins reasoning that is
already under way, which is what makes it powerful and what makes it the one you
do not want by accident.

**Plain `enter` queues, by default.** `/enter` changes that:

```text
/enter          ask, with both described
/enter queue    plain enter queues while a turn runs
/enter steer    plain enter steers while a turn runs
```

This changes `enter` only *while a turn is running*. With nothing running there is
no choice to make — there is no step for steering to reach — so `enter` simply
sends.

The empty composer says which one is in force, so you never have to remember:

```text
› type to queue
› type to steer
```

`ctrl-enter` sends the other way for one message, without changing the setting.
It is listed last here because it is the one key in this interface that cannot be
promised: a terminal sends the same bytes for `ctrl-enter` as for `enter` unless
it supports the extra keyboard mode described below, and nothing can ask it
which. Where it is not supported, `ctrl-enter` does exactly what `enter` does —
your preference — which is why the composer never advertises it. `node
tools/keyprobe.mjs` says whether your terminal sends it.

The choice is stored with your other settings, so it survives reopening a session
and restarting. On a profile with no settings provider it still applies for as
long as the session runs, and `/enter` says it could not be stored.

### About shift-enter

By default, a terminal sends exactly the same bytes for `shift-enter` as for `enter`, so no program can tell them apart. To make the difference visible, this interface asks your terminal for one extra keyboard feature on startup: the lowest option of the kitty keyboard protocol, called *disambiguate escape codes*. Terminals that support it (kitty, Ghostty, WezTerm, foot, recent iTerm2 and Alacritty, Konsole) then report a modified `enter` as its own sequence.

That request has a side effect worth knowing about. On a terminal that supports it, `esc`, `alt`, and `ctrl` combinations also stop arriving in their old form: `ctrl-c` becomes the sequence `CSI 99 ; 5 u` instead of the single byte `0x03`. This project reads both forms, so every shortcut in the table above works either way. The details are in [Design → Keyboard input is read in both formats](design.md#keyboard-input-is-read-in-both-formats).

On a terminal that ignores the request, `shift-enter` still sends the message. That is why the status line suggests `alt-enter` instead: `alt-enter` works everywhere. The extra mode is switched off when the interface exits, so the next program reads your keyboard normally.

If a key does nothing, `node tools/keyprobe.mjs` shows what your terminal sends and how this project reads it. That output is exactly what a bug report needs.

## Commands

Type `/` to see the commands your agent actually has. They come from two places.

**Handled by this interface:**

| | |
| --- | --- |
| `/model` | Change the model. Takes a name (`/model deepseek-v4-pro`) or opens a picker you can type in |
| `/reasoning` | Change how hard the model thinks. Takes a level (`/reasoning max`) or opens a picker |
| `/setup` | Check this installation and walk from a provider to a working model. Runs by itself on a launch that would otherwise open a composer with no usable model |
| `/connect` | Configure and authenticate the providers Harness can talk to. Takes a route name (`/connect openai`) to open filtered on it |
| `/plugins` | Browse, search, and customize the running agent's Harness preset composition |
| `/profiles` | Browse Harness profiles and the bundles each one composes; install, update, or remove one |
| `/usage` | Inspect what this session has consumed. `cost`, `tokens`, or `off` sets what the status line reports; bare opens the inspector |
| `/timing` | `on` or `off` for the persistent live turn-timing panel; bare flips it |
| `/enter` | What plain `enter` does while a turn is running: `queue` or `steer`; bare asks. See [Queue or steer](#queue-or-steer) |
| `/theme` | Choose the colour palette. Takes a name (`/theme ember`) or opens a picker |
| `/work` | Open a bounded live view of active Harness workflows, subagents, and jobs |
| `/context` | Open a bounded view of what is occupying the model's context, and the largest entries in it |
| `/new` | Start a fresh session in the current workspace; the previous one remains reopenable when the active Harness profile provides session persistence |
| `/clear` | Wipe the screen and start a fresh session in the current workspace, as `/new` does; the previous one remains reopenable when the active Harness profile provides session persistence |
| `/sessions` | Browse, search, and reopen past sessions without leaving the window |
| `/todos` | Open a bounded read-only view of the current Harness Todo list |
| `/skills` | Browse the skills available to the running agent, and put one in the prompt |
| `/exit`, `/quit` | Leave, the same as `ctrl-d` |

Each of the first three works the same way: **name the value and it changes, type the command alone and it asks.** You rarely have to do either from memory, because the suggestion list offers the values as soon as the command name is followed by a space:

```
› /reasoning
    › /reasoning off      no thinking at all
      /reasoning high     the usual level
      /reasoning max      as hard as it goes
      /reasoning default  whatever the provider does when nothing is set
      tab complete · esc dismiss
```

`tab` on `/rea` completes the name and leaves the cursor after a space, and the values appear there without another keystroke. The picker is the fallback for when you want to read the descriptions, not the only way in.

**Coming from the harness**, so the list depends on which plugins your profile loads. With the standard set:

| | |
| --- | --- |
| `/compact` | Summarize older conversation history to free up context |
| `/plan`, `/plan off` | Enter or leave planning mode |
| `/goal` | Show or set the goal for a long task |
| `/permission` | Change the permission preset (see below) |
| `/feedback` | Record a note about this session |

Every command prints its result into the transcript: a `·` line for normal output, and a `✗` line if it failed. A command name that matches nothing — not a command, and not a skill either — is reported instead of being sent to the model:

```
✗ unknown command: /help · type / to see what there is
```

A leading `/name` is resolved in one fixed order: this interface's own commands, then the harness's registered commands, then the [skills](#skills) your agent can see. **A command always wins a shared name.** If `/review` is both a registered command and a skill, `/review the diff` runs the command; the skill stays visible in `/skills`, listed without a slash so the list never promises a gesture it cannot keep.

The check uses the harness's own rule for what a command line looks like, so the name must either end the line or be followed by a space. This means `/etc/hosts is missing` is treated as an ordinary message and reaches the model unchanged, while `/tmp is full` is treated as a command and reported as unknown. That trade-off is deliberate: a mistyped command is far more common than a message starting with a folder name.

> [!WARNING]
> **`/goal <objective>` does more than record a goal.** It starts the harness's goal driver, which immediately begins working on that objective by itself, for up to 256 rounds, using tools in your folder. Use `/goal` with no text to just view the current goal, and `/goal pause` or `/goal clear` to stop one. Nothing warns you before it begins — but once it has, the status line says so, by name, for as long as it runs.
>
> **A goal can also start without you.** The harness gives the model a `create_goal` tool and tells it that it may infer a long-running objective from what you asked, without you saying the word "goal". The status line is how you find out; `/goal` shows it in full and `/goal pause` stops it. See [What the session is about to do](#what-the-session-is-about-to-do).

### Setup

`/setup` is the guided path from an installed dshline to a model that answers.
It **runs by itself** on a launch that would otherwise reach the composer
without a model it could send to. Three states count, and all three are read
from what the window already holds — no adapter is asked anything, so this
costs no network:

- no adapter has registered any provider route;
- routes exist, but nothing resolved a model selection;
- a selection exists, but names a route no adapter has registered — a
  remembered default whose provider has since left the profile.

Anything else launches straight into the session, and `/setup` still opens the
flow on demand. The selection is judged by its **provider**, not its model id:
whether a route still serves one exact model is a question only the picker's
own listing can answer, and asking it at startup would mean a possible network
call on every launch.

It writes a reading of your installation into ordinary scrollback, so you can
scroll back to it and paste it into a bug report:

```
Setup

· Node       24.4.0
· dshline    0.17.0
✓ Harness    0.1.2-rc.1
✓ Profile    dshline
✓ Connecting API key · account sign-in
⚠ Models     no provider route is active, so /model has nothing to offer
  ChatGPT (Codex) is signed in, but its openai route is not active
```

Then it offers what the mounted seams would actually accept: **Choose a model**
first once a route is registered — by then it is the step between you and a
working session — then **Connect a provider**, then a way out. Backing out at
any point writes nothing; there is no saved "already set up" flag anywhere,
because each run re-reads Harness from scratch.

It also takes the obvious step for you rather than describing it. When
`/connect` closes having produced the first usable route while no model is
selected, setup opens the model picker directly instead of returning you to a
checklist that would only say to open it. That happens **only** when the model
is the missing piece: a selection that already works is never replaced, because
connecting a second provider is not a request to change models. Dismissing the
picker returns you to the checklist rather than dropping you at a composer that
still cannot send.

Three of those rows are worth explaining.

**Node carries no verdict.** dshline is already running on the version it
prints, so a tick would be circular, and deciding whether it satisfies the
supported range means evaluating a semver range — a version-compatibility
engine this project deliberately does not have. The version is what a bug
report asks for, so it is stated and nothing is claimed about it.

**Harness compares two exact versions.** dshline supports one Harness
generation at a time: the version it targets is the one every `dsh-*`
dependency is pinned to, and the version you have is read from the
`@deepseek-ai/dsh-base` your profile composes. A mismatch is a `⚠` naming both,
and both commands that would bring them together:

```
⚠ Harness    0.1.3-alpha.1 installed · dshline targets 0.1.2-rc.1
  dshline supports one Harness generation at a time.
  Install the generation this dshline targets: npm install -g @deepseek-ai/dsh@0.1.2-rc.1
  Or move to a dshline release that targets 0.1.3-alpha.1, if one exists — updating dshline
  does not by itself land on the installed generation, and this report cannot tell you which release would.
```

Only the first of those is deterministic, and the wording says so. The version
this build targets is a fact the report already holds; whether any *released*
dshline targets the version you have installed is not, and establishing it
would mean resolving releases against their peer pins. So the second direction
is offered as a condition rather than as a fix. **It never refuses to
continue.** By the time
this can be printed, both halves have already booted together far enough to
draw it; a genuinely incompatible pair fails earlier and much more loudly, in
Harness's own loader, which is the authority for that diagnosis. Harness
publishes no runtime version service, so a version either side could not be
read is marked `·` and nothing is claimed in either direction.

**`Connecting` is about what you can do, not which services are mounted.** It
names `API key`, `account sign-in`, or both, and warns only when this profile
mounts nothing that could configure a provider at all.

### Connect

`/model` chooses among models that already exist. `/connect` is how a model
comes to exist.

It opens a bounded overlay listing what Harness says can be configured, in two
sections:

```
╭─ dshline ────────────────────────────────────────────────────────────── Connect ─╮
│ ⌕                                                          9 rows               │
│                                                                                  │
│ Provider routes                                                                  │
│ ❯ ● OpenAI  openai                        active · 41 models · key from          │
│       llm-pi-ai · providers.openai · credential field apiKeyEnv                  │
│   · Anthropic  anthropic                                        dormant           │
│   ● DeepSeek  deepseek-official     active · DEEPSEEK_API_KEY unset              │
│                                                                                  │
│ Sign-ins                                                                         │
│   · ChatGPT (Codex)                                     not signed in             │
╰─ ↑↓ move · ctrl-r refresh · ↵ configure · esc close ──────────────────────────────╯
```

Type to filter, `↵` to see what Harness will let you do to the selected row,
`esc` to clear the query and `esc` again to close. `/connect openai` opens on
that filter — naming a route says which one you mean, and the completion list
offers every route name after a space, the same way `/reasoning` offers levels.
It does not act on it: what to do with a route is still a choice between storing
a key, activating it, and removing it. `ctrl-r` asks Harness again,
which is what you want after editing `settings.yaml` by hand or storing a key
from the web interface in another window.

**Provider routes** are every route a mounted adapter declares configurable,
whether or not it is live. A bare-mounted `llm-pi-ai` publishes its whole
installed catalog this way, so OpenAI, Anthropic, Google, OpenRouter, and the
rest are listed before anything has been configured for them. `active` means an
adapter has registered the route and `/model` can already offer its models;
`dormant` means nothing is configured for it yet.

**Sign-ins** are the authorization flows Harness has registered — the logins
that *obtain* a credential instead of reading one from configuration. They stay
separate rows rather than being folded into the provider rows: Harness
publishes no general contract that a flow's credential record and a provider
route correspond, so merging them would be this interface inventing a
relationship.

What it does say, for the one adapter family that documents the correspondence
itself, is which route a sign-in authenticates. `llm-pi-ai` keys every flow it
registers at `llm-pi-ai/<route>` and publishes that same route at
`providers.<route>` in its own settings — so a signed-in account whose route is
not active reads as exactly that:

```
Sign-ins
  ● ChatGPT (Codex)                    signed in · openai route not active
```

Nothing else is joined. A sign-in from any other plugin is listed alone, as
before.

The dot in front of a row is deliberately quiet. Green means a named credential
is confirmed present, red means a named credential is confirmed missing, and
everything else is unmarked — a route authenticating through its provider's own
discovery, or a deployment with no credential store to ask, is not
misconfigured.

#### What `↵` offers

Only what the mounted seams will actually accept, so nothing on the list
answers with a refusal:

| | |
| --- | --- |
| Connect with an API key | Stores the key through Harness's credential store and records the reference in the provider's settings profile |
| Activate this route | Writes a minimal profile so the adapter registers the route; a catalog route inherits its endpoint, protocol, and models |
| Forget the stored API key | Clears the value; the reference stays, so the route keeps naming where its key belongs |
| Remove this route from your settings | Unsets the profile *your* settings document carries, leaving any composition default in place |
| Sign in | Runs the owning plugin's own flow through Harness's authorization seam |
| Forget this sign-in | Deletes the local credential record — see the warning below |

A typed key never reaches `settings.yaml`. It goes to the credential store, and
the settings document records only the *reference* — `OPENAI_API_KEY` for a
route called `openai` — which is the same convention the web Models page uses,
so a key stored here is the one the web interface reads.

Once a route is live, `/model` sees its models with no further step: Harness
re-registers the route on the settings commit, and the browser re-reads itself.

Closing the browser withdraws a sign-in it started, including one waiting on a
browser callback with no question on screen. Nothing from a withdrawn attempt
appears afterwards; the transcript says it was withdrawn and that is the end of
it.

#### Signing in is not the same as activating a route

This is the one thing about provider setup that catches people out, and it is
not a bug in either half. A login writes a **credential**; a route is a
**settings profile**. They are separate stores and separate writes, so a
successful sign-in on its own leaves `/model` with nothing to offer.

So after a sign-in succeeds, `/connect` asks:

```
Signed in · ChatGPT (Codex)

  This account is authorized, but the openai model route is not active,
  so /model still offers nothing from it.

❯ Activate the openai route   Writes a profile in llm-pi-ai so the adapter registers it
  Not now                     Writes nothing
```

**Nothing is written unless you choose it.** Authenticating is not consent to
change your provider configuration, so `Not now`, `esc`, and closing the
browser all leave your settings exactly as they were — the route stays in the
list and `Activate this route` is there whenever you want it. The question is
asked against a fresh reading, so a route something else activated in the
meantime is reported as active instead of being offered and overwritten.

> [!WARNING]
> **"Forget this sign-in" is local.** It deletes the stored credential record on
> this machine. Harness has no way for a provider to declare a server-side
> revoke, so the issuer is never told and the grant remains valid until it
> expires or you revoke it with the provider.

#### Declaring and editing a route

`+ Add custom provider` declares a route the adapter ships nothing about — a
private gateway, a self-hosted server, a local OpenAI-compatible endpoint —
through `llm-pi-ai`, the one configuration domain whose settings profile can
describe a whole route. It walks a provider id, an endpoint, a protocol, an
optional API key, request headers, and a model catalog, and writes nothing at
all until you choose **Create provider** on the final review. A route already
declared this way gains **Edit route**, which opens the same fields on what is
already there.

**Request headers** are sent with every request the route makes, and are how a
gateway that authenticates with something other than an API key is reached at
all — a tenant id, a signed proxy token, an `Authorization` bearer, a routing
tag your egress requires. Treat a value as sensitive: nothing in the settings
seam marks these as credentials, so they are stored and shown as ordinary
configuration even when what you put there is a token. The route menu lists
their names only, so passing through it never puts one on screen; a value is
shown once you open **Request headers** and move onto that header's own row,
which is the only place you asked to see it. Harness's own attribution wins a
reserved name.

**Fetch available models** asks the endpoint what it advertises and lets you
adopt what you want, and nothing fetched is written until you save. For a route
that already exists, the owning adapter resolves that route's stored headers
and credential itself, so a gateway behind header auth answers. For a route you
are still declaring there is nothing stored yet to resolve, so the fetch goes
out without them and says so — add the models by hand, create the route, then
re-open **Edit route** and fetch with the headers in place.

What stays settings work: `compat`, retry policy, timeouts, and per-model
reasoning live in `settings.yaml`. Editing what `/connect` shows never disturbs
a field it does not render. See
[Reaching DeepSeek through a gateway](#reaching-deepseek-through-a-gateway).

### Plugins

`/plugins` opens a bounded overlay on the running agent's Harness preset — the
named composition of tools, prompt sections, and delegation backends the
agent was actually joined to, not a fixed list this interface keeps:

```
╭─ dshline ───────────────────────────────────────────────────────────── Plugins ─╮
│ Preset: Standard mode                              default: Standard mode       │
│                                                                                 │
│ ⌕ codex                                                            1 row        │
│                                                                                 │
│ ❯ ○   tool-subagent-codex               @deepseek-ai/dsh-tool-subagent          │
╰─ ↑↓ navigate · / search · space toggle · p presets · d default · esc close ─────╯
```

Type `/` to search a large composition by row id or package name; `space` on
the selected row turns it on or off. **A built-in preset is never edited in
place.** Harness ships those files read-only, so toggling a row on one offers
to copy it to a locally authored preset first — the same "copy, then edit
the copy" path the official web interface's own preset settings use — and
applies the toggle to the new copy in the same step. `p` opens the full
roster (whatever presets the deployment actually has, not a fixed four) to
switch to a different one or set the default for new sessions; `d` sets the
one currently shown as that default outright.

**A preset switch here follows the same rule a running session already
does.** A session's composition is a fact recorded once it has produced a
turn, not a setting this interface can rewrite after the fact: picking a
preset for a session that has already started is refused, and offered
instead as the default for the *next* session — never a silent no-op, and
never a bypass of that lock. The same applies to a row you toggle: the file
is written either way, but only a session still blank *and* running that
preset picks the change up live. Anything else is reported as a customization
waiting for the next session, so a change never appears to have taken effect
on a conversation it did not touch.

Reopening a session composes it from the preset its own log recorded, not
from whatever the default is today. Sessions from before dshline adopted
presets recorded none; those resume under the shipped `standard`, which is
the preset built to mean exactly the tool set they originally ran with. If
your deployment ships no usable `standard`, such a session still opens — on
your own default — and the transcript says its tools may differ from the ones
its history was produced with.

### Profiles

`/profiles` opens Harness's own profile roster — the layer *above* presets:

```
╭─ dshline ──────────────────────────────────────────────────────────── Profiles ─╮
│ Host: dshline                                                  3 profiles       │
│ /Users/you/.dsh/profiles                                                        │
│                                                                                 │
│ ⌕ / to search                                                     6 rows        │
│                                                                                 │
│ ❯ ● dshline                                                       current       │
│       Bundles                                                                   │
│   ✓   @deepseek-ai/dsh-base                       from the installation         │
│   ✓   @dshline/dshline                                             0.8.0        │
│   ○ web                                                                         │
╰─ ↑↓ navigate · a add · u update · U update all · n new · / search · esc close ──╯
```

A **profile** is what a launcher boots: `dsh --profile <name>` reads
`$DSH_HOME/profiles/<name>`, whose `package.json` lists the ordered *bundles*
whose patch layers compose the Host. `●` marks the profile this session is
running. Under each profile are its bundle layers, with the installed version
where pnpm's state already records one; `from the installation` means an in-box
bundle that comes with `dsh` itself rather than being one of this profile's
dependencies.

`a` installs a bundle, `u` updates the selected one, `U` updates every
dependency-managed bundle, `r` removes one (after a confirmation, since it takes
a capability away from every later session), and `n` creates a profile. Each of
those runs Harness's own `dsh plugin --profile <name> …`, which is a thin pnpm
forwarder that reconciles the bundle list afterwards — this interface adds no
installer, resolver, or lockfile behavior of its own. `U` names the bundles
explicitly rather than running a bare `pnpm update`, which would also update
plain libraries that are not bundle layers and are not shown here.

The launcher is found the same four ways `dshline` itself finds it — `DSH_BIN`,
a `DSH_HARNESS` source checkout, `dsh` on `PATH`, then the installed
`@deepseek-ai/dsh` package — so these operations work wherever the interface
does. Where none of them finds one, the exact command is named so you can run it
yourself. If the failure output matters, its last few lines are committed to the
transcript rather than lost with the overlay; a spec that could carry a token in
a URL is withheld from that record rather than preserved in it.

**While an operation runs, the frame says so.** A pnpm install takes minutes, so
a running operation is shown as a turning spinner beside `<profile>: <what>…`
for as long as it runs, not as a message that expires — and the row disappears
the moment it finishes, because a spinner over completed work says the opposite
of the truth. Once a change to the profile you are
running has landed, `↻ restart required to pick up: <profile>` stays on screen
until you close the browser — and closing it does not stop anything: work still
running, and any restart still owed, are written to the transcript on the way
out. Other keys keep working throughout; only a second operation *on the same
profile* is refused, and it says so rather than doing nothing.

**Bundle, layer, dependency.** Three words for three different things, and the
difference is what decides whether an install does anything:

| | |
| --- | --- |
| **dependency** | anything in the profile's `package.json` — installed, nothing more implied |
| **bundle** | a package whose own manifest declares `dsh.bundle`, pointing at a `cordis.patch.yml` it exports. A property of the *package*, decided by whoever published it |
| **layer** | an entry in the profile's `dsh.profile.bundles` list. The launcher applies each listed bundle's patch, in order, to build the Host composition |

So a bundle is a package that *has* a patch to contribute, and a layer is a
patch actually being *applied*. `dsh plugin` keeps the layer list in step with
what is installed: a dependency that declares `dsh.bundle` is appended to it,
and one that stops declaring it is dropped. A dependency that never declares one
is installed and composes nothing — forever, correctly.

That is why a version matters. The same package name can be a bundle at one
version and not at another, because the declaration was added at some point; an
older copy is a plain dependency, and updating it makes it a layer.

`/profiles` lists dependencies that are not layers under `Installed, composes
nothing`, with `not a bundle` beside each, so a package that changed nothing is
visible rather than absent. One marked `⚠ declares dsh.bundle` is the case worth
acting on: the installed copy *is* a bundle and the layer list has not caught up
yet, which any `dsh plugin` run reconciles — that reconciliation is skipped
whenever pnpm exits non-zero, which is how the state arises. `r` removes a
non-layer dependency the same way it removes a bundle.

**Adding a bundle is not a search.** The field takes an exact package name (or
any spec `pnpm add` accepts) and forwards it verbatim, so a partial or
misremembered name is a failed install rather than a list of candidates. When it
fails, the reason pnpm gave is the headline — `ERR_PNPM_FETCH_404` for a name
that does not exist, `ERR_PNPM_GIT_RESOLVE_FAILED` and git's own `fatal:` line
for a repository this machine cannot reach — with the last few lines of output
committed to the transcript. Those are pnpm's errors and pnpm's fixes: a git
dependency that needs SSH here, for instance, is a `git config
url."git@github.com:".insteadOf` on your machine, not something this interface
can decide.

One of them is worth knowing about because it blocks *every* operation on a
profile until you answer it, and `/profiles` therefore warns about it before you
press anything: such a profile is tagged `builds pending`, and selecting it
names the packages and the file to answer them in. `ERR_PNPM_IGNORED_BUILDS`
means a dependency wants to run a build script and pnpm will not run it
unattended; pnpm writes a placeholder for each into that profile's
`pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@google/genai': set this to true or false
  protobufjs: set this to true or false
```

Set each to `true` or `false` and the operation proceeds. `/profiles` names that
file when it sees the error but never edits it: allowing a build script runs
arbitrary install-time code from a dependency, which is a decision for you and
not for a terminal browser. Harness does not answer it either — it writes the
base `pnpm-workspace.yaml` when a profile is created and never touches it again.
Note that `dsh plugin` on its own can *hang* here rather than fail, because pnpm
tries to ask interactively; `/profiles` gives its child no terminal to ask on, so
it reports the error instead.

**Two things it deliberately will not do.** It will not remove or update an
in-box bundle, because `dsh plugin` would not either — those come from the
installation, and turning their rows off belongs in the profile's own
`cordis.patch.yml`. And it will not switch profiles. A Host composes its
plugins once, at boot, and nothing re-links a running Host's bundle layers, so
`enter` on another profile names the command that boots it instead of
pretending to swap it in.

**Removing a bundle cannot break a shipped profile.** Only a bundle this profile
*depends on* can be removed or updated — the layers that come with `dsh` itself
are refused, which is why `web` and `headless` have nothing removable in them at
all. Deleting a whole profile is not offered: `dsh plugin` forwards pnpm
arguments and nothing in Harness removes a profile, so `enter` names the
directory and leaves that to you.

**Restart boundaries are stated, not implied.** Installing, updating, or
removing a bundle changes what the *next* Host composes. On the profile you are
running, the result says `restart required`; on any other profile, it names the
command that will pick it up. Nothing here claims to have changed the session
you are in.

### Sessions

`/sessions` opens a bounded overlay listing the sessions Harness knows about,
newest first. It is the same browser `--resume` opens before the first agent
exists, so there is one place to learn and one set of keys.

| | |
| --- | --- |
| type | Filter the list by title, workspace, or id, as you type |
| `tab` | Search what sessions *said*, through Harness's own session index |
| `↑` `↓` | Move; the list wraps at both ends |
| `home` `end` | Jump to the newest or oldest row |
| `↵` | Reopen the selected session |
| `→` | Show the selected session's details and its own actions; `←` or `esc` goes back |
| `ctrl-f` | Narrow the corpus: workspace, origin, age |
| `ctrl-w` `ctrl-u` | Delete the last query word, or the whole query |
| `esc` | Clear the query; press it again on an empty query to close |
| `ctrl-d` | Leave, as everywhere else |

Typing filters the rows you can see. `tab` is a different question: it hands the
same words to `ctx.sessionQuery`'s full-text surface, which searches the contents
of every session log and shows the excerpt it matched. Editing the query drops
back to filtering, because a content result answers the words you typed *before*
the edit. A deployment whose session-query backend implements no full-text search
says so and keeps filtering — that path is supported, not broken.

A row is a title and a relative age, and that is deliberate: the list answers
which session, and a workspace repeated down every row competes with the answer
instead of adding to it. The one exception on the right is `open`, marking the
session this window is already driving — the row reopening refuses. Everything
else about a session is one keystroke away: `→` shows its workspace, when it
was created, when it was last active, how many events its log holds, whether it
is delegated, whether Harness holds it live or persisted, its fork or delegation
parent, and its id. Nothing there is read until you open it, so moving through
the list costs no session-log reads at all.

Reopening retires the agent driving the current session and resumes the one you
chose, in the same window and the same terminal. Everything already in your
scrollback stays there: the reopened transcript is appended under it, exactly as
`--resume` would draw it at launch.

It refuses, and says which reason applies, when reopening would mean guessing:

| | |
| --- | --- |
| the session is already open here | nothing to do |
| the session is live in this process | resume would collide with the live id |
| there is no persisted log | reopening loads through Harness session persistence |
| a turn is running | finish or interrupt it first (`ctrl-c`) |
| jobs or subagents are attached | retiring their owner is not a lifecycle Harness defines |

Under the facts, the same surface offers what can be done to that one session,
and nothing that addresses the whole corpus:

| | |
| --- | --- |
| `Find in this session` | Search what *one* session said through `searchEvents`, with its own query line (`tab` to search) |
| `Lineage` | Browse the selected session's known parents and children through `traceSession`; `↵` returns the list focus to that session |
| `Rename` | Rename the session this window is driving (the `open` row) through `ctx.sessionTitle`, offered only when a session-title service is mounted |

Filters are the corpus question, so they have their own key rather than a place
under one session's title: `ctrl-f` opens workspace (`all`/`current`), origin
(`all`/`own`/`delegated`) and age (`all`/`today`/`7 days`/`30 days`). It is a
ctrl gesture because a bare letter here is search input.

Workspace and age become exact Harness clauses (`cwd` matching, `created-at`
inclusive windows), so the narrowing happens inside Harness. Origin is applied
presentation-only because Harness publishes no origin predicate; each row's
classification comes from the authoritative observed header Harness returns for
the same session — a search backend whose own hit projection omits `origin`
still yields the immutable header through the batched title observation, so a
persisted delegated child's hit is not mislabelled `own`. The filter title
gains `· filtered` while one is active, and changing a filter restarts paging.

Both content scopes (the `tab` corpus search and `Find in this session`) page
through opaque Harness cursors. A trailing `Load more…` row appends the next
page (`↵`); `Refresh (results changed)` appears when the corpus moved under a
cursor, and the counter says how many results there are (`· more available` or
`· end`) — never a page number, which Harness does not publish.

Renaming appends a `session/title` event with the explicit `user` source: it
pins the session's title (automatic generation stops) and the browser
re-reads its title observations from the log. It never reopens the session —
rename is only offered on the session already open in this window, because the
generic title service acts on live session objects only, and renaming a closed
persisted session would require resuming it first.

If reopening fails anyway — an unreadable log, an incompatible format version, no
persistence backend — the window prints the reason and opens the browser again so
you can pick something else. `esc` there starts a new session instead. It never
ends the process, and never quietly substitutes a session you did not ask for.

### Work

`/work` opens a temporary bounded overlay: dshline's live view of what Harness
is running for this session. It reads the generic Harness `ctx.jobs` and
`ctx.subagents` capabilities when the profile mounted them, plus the workflow
records the `workflow` tool writes into this session's own log; a profile with
neither of those two capabilities still boots, and the overlay says Work is
unavailable. It never
switches screens or rewrites the transcript, so closing it returns to the same
native terminal scrollback.

Workflows, subagents, and jobs stay in separate sections because they are
separate Harness authorities, and dshline does not guess that two capability
records describe the same operation. The one relationship it does show is
published rather than guessed: a workflow member carries the `childId` of the
subagent it started, so that child appears under its workflow instead of a
second time in the flat Subagents section. Jobs are inspect/status only;
cancellation remains available to the model through Harness `job_kill`. A
workflow run has no control here at all, because `ctx.workflowEngine` hands a
run handle only to the caller that started it. The status line's `work` segment
counts what this overlay shows, so a child presented under its workflow is not
also counted as a loose subagent there.

A row's mark says how much dshline actually knows about it:

| Mark | Meaning |
| --- | --- |
| `◜◠◝◞◟◡` | Observed execution: a live in-process child Agent that Harness says is running |
| `●` | An active lifecycle whose internals are not observable |
| `•` | A background job record exists |
| `◐` | A job is stopping |
| `✓` `✗` `⊘` | Completed, failed, cancelled |

Only the arc spinner animates, and it is the same one the status line uses.
That is the whole rule: animation means evidence of running computation. A Job
in `running` is a registry record rather than an observation, so it stays
quiet — and so does a subagent run whose provider published no in-process
child. An external provider such as Codex or Claude Code manages its own model
and tool traffic and does not expose it through the generic subagent seam, so
dshline shows that run's lifecycle and elapsed time and invents no activity
for it.

A live in-process child does carry a semantic activity word — `waiting`,
`thinking`, `responding`, `reading`, `searching`, `fetching`, `editing`,
`running`, `working` — and, when the running tool's own presentation titled it,
a short operation such as `overlay.ts`. Both are folded from the exact Harness
session events and tool presentation the status line reads; nothing is guessed
from tool names.

A subagent row is built to answer one question first — what is this worker
doing — so it reads task, then activity, then which LLM is actually powering
it:

```
◜ Fix OAuth flow · reading route-editor.ts · openai-codex/gpt-x 18s
● Native review · codex 18s
```

The child's durable label leads and never yields; a narrowing terminal drops
the clock, then the model route, then the operation target, then the activity
word, always as whole facts. The **backend** — the `ctx.subagents` provider
that owns the lifecycle, such as `spawn` or `codex` — takes overview space only
for a child whose work is not observable, because there it is the fact that
explains the silence.

Backend and model are two different authorities and never one word: a `spawn`
child can be powered by any registered LLM route at all. The model comes from
the child's own latest logged request envelope once it has made a request, and
from the options it was created with before that; a route change is simply a
later envelope. A run with no in-process child gets no model row at all.

A workflow row names the run, its newest `phase(...)` narration, how many of
its members are still open, and how many it has started. There is no
denominator: `meta.phases` declares progress vocabulary, not how many
subagents a script will start, so there is no truthful total to divide by, and
calls a script has not made yet are not listed as pending.

`↵` opens the selected row. Everything below the overview is a list too: `↑`
and `↓` move the highlight through the facts of a detail view, `home` and `end`
jump to its ends, and the view scrolls to follow the cursor. A focused row does
not have to be actionable — `↵` on a plain fact does nothing rather than
inventing an action — while a workflow member whose child is still live opens
that child's own subagent view. `esc` returns exactly one level, so a member
reached from a workflow returns to that workflow; `esc` from the overview
closes Work, leaving the transcript untouched.

A workflow view shows the run's description when the live engine published it,
its state, its newest narration, and its members grouped under the exact phase
each was recorded with. The phases come from the member records, not from the
script's declared `meta.phases`: a declared phase no member has entered would
read as pending work, and no such work has been published. A member whose child
is live shows that child's own activity and model route, from the child's state
rather than from anything the script declared about the phase. A subagent view
leads with what
the child is doing and what it is doing it to, then its model and reasoning
effort when its route carries them, its backend, how long it has worked, its
token total when that figure is attributable to it, and its mode
(`continuable`/`one-shot`), then its workflow, phase, and member label
when that relationship is authoritative, and finally the identities a report
needs: durable session id, live Agent status, session residency, child
sessions, lifecycle run id, and whether the run published an in-process child.

`tokens` is Harness's `tokenUsage` projection, which folds provider-reported
usage over the child's complete log. It appears only for a child whose Session
carries no fork-inherited history, because that is when the whole projection is
attributable to that worker: a forked child's log opens with its parent's
completed turns, and their usage is in the same figure. `active time` stays
available for such a child, because `subagentTiming` resets at the child's own
descriptor and `tokenUsage` has no equivalent reset.

The clock is labelled because there is more than one honest answer.
`active time` is Harness's own `subagentTiming` projection: the child's
completed turns plus an open one, advancing only while the child is genuinely
running and freezing where the projection last folded when it is not.
`elapsed` is the weaker fallback — how long this lifecycle epoch has been open
— shown for a child whose timing the profile does not project. Only ever one
of them appears.
A job view shows its status, kind, producer detail, elapsed time, owner, and
job id — and no row announcing an action it does not have.

A continuable subagent may offer `k interrupt`, which asks Harness to
interrupt that child's current turn — keeping its conversation, inbox, and
descendants intact. A one-shot subagent does not. Interrupt failures,
including authorization failures, are shown briefly in the overlay rather
than discarded.

A workflow leaves the view when Harness says it is finished: the engine's stop
reason appears on the row, and the row itself goes when the tool closes its
durable record, after the run and its children are quiescent. `/work` is a live
surface rather than a workflow history — the durable records stay in the
session log, where a reopened session replays them.

### Todos

`/todos` opens a temporary read-only view of the current Todo projection. The
list is owned, persisted, and cleared by Harness's `dsh-tool-todo` capability;
the terminal only presents its current snapshot. `✓` is completed, `●` is in
progress, and `○` is pending. Closing the overlay leaves native scrollback
unchanged. A profile without session projections or the Todo projection remains
usable and says which reading is unavailable.

### Skills

A **skill** is a reusable set of task-specific instructions your agent can
load. Harness owns all of it — where skills come from, which one wins a
duplicate name, who is allowed to invoke it, and what loading one does. This
interface only shows you the ones your agent can actually see, and helps you
type the line that invokes one.

**Invoking a skill is just typing.** A message that starts with the skill's
name after a slash invokes it:

```
› /review-pr inspect PR #126, especially lifecycle cleanup
```

The whole line is sent as your message, exactly as you wrote it. Harness
recognizes the `/review-pr` reference at its own boundary and puts that skill's
instructions into the same step, so the model has them before it answers.
Nothing about the line is rewritten here, and your prompt is what the transcript
shows.

**They are in the `/` list.** A skill you can invoke this way appears in the
suggestion list beside the commands, marked as a skill:

```
› /plugins       Browse the running agent's preset composition
    /review-pr     skill · Review a pull request
    /security      skill · Review code for security issues
    /sessions      Browse past sessions
    /skills        Browse available skills
```

Accepting one inserts `/review-pr ` and leaves the cursor after the space. It
does not send anything: what you write after the name is the request, and you
send it when you are ready.

**`/skills` is the browser.** It lists every skill the running agent can see,
including the ones only the model may load, with what each one is for:

```
Skills · 12 available

  /api-review       Review API changes and compatibility
  /debug-ci         Investigate failing CI
› /review-pr        Review a pull request
  /review-tests     Review test coverage
  architecture      Architecture decision guidance
  internal-router   Internal routing guidance
    … 6 more

review-pr
Review pull requests for correctness, regressions, architecture violations,
and missing tests.

Available to   you + model
Source         project
When to use    Before approving or merging a meaningful code change
```

The slash is a promise, so it appears only where it works: `architecture` above
is one the model loads on its own, and a skill whose name a command already
claims is shown without one too. `↑↓` selects, typing filters, and `enter` puts
the selected skill's name in the prompt — it never sends it, and never loads
anything. `esc` clears the filter and `esc` again closes, as it does in
`/connect` and `/sessions`.

A profile that composes no skill registry says so rather than showing an empty
list, and a discovery that has not finished says that instead of claiming your
agent has none. If a skill provider fails while you are working, the last
complete list stays on screen rather than blinking empty.

> [!NOTE]
> In a custom Harness composition, a skill can be visible in the catalog even
> when invoking it directly with `/name` is not enabled. Harness exposes no
> separate signal for that, so this list cannot warn you; the standard preset
> enables it, and `/plugins` shows what the running agent composes.

### Context

Four commands answer four different questions, and none of them is a longer way
of asking another:

| | |
| --- | --- |
| `/context` | What is occupying the model's context **right now** |
| `/usage` | What this session has **consumed**, cumulatively |
| `/timing` | Where **this turn** spent its time |
| `/compact` | **Reduce** the current context |

`/context` is the first of those. The status line has room for one number; this
has room for the answer.

```
╭─ dshline ──────────────────────────────────────── Context ─╮
│                                                            │
│  184k / 1.0M · 18% · projected                             │
│  ████▎░░░░░░░░░░░░░░░░░░░░░░░░░░░░                         │
│                                                            │
│  Composition · estimated                                   │
│      system      ~12k  ━───────────   7%                   │
│      tools       ~48k  ━━━━────────  26%                   │
│      messages   ~124k  ━━━━━━━━━━━─  67%                   │
│                                                            │
│  Largest entries · estimated · 5 of 128                    │
│  ❯   ~42k  22%  tool result · run_shell_command            │
│      ~28k  15%  tool result · read_file                    │
│      ~18k  10%  assistant reply                            │
│      ~14k   8%  your message                               │
│       ~9k   5%  injected context · instructions            │
│                                                            │
╰─ ↑↓ select · ↵ inspect · c compact · esc close ────────────╯
```

**The figure at the top is the next request's prompt, not the session's total,**
and `projected` is the word for what it is: the provider's own count of the last
prompt it was sent, plus an estimate of everything the conversation has gained or
lost since. It is one kind of figure, labelled once, rather than a mark that
switches on and off — several changes can cancel out to no net estimate while the
conversation has in fact moved, so a bare number would sometimes have claimed a
precision it did not have. If no route advertised a context window there is no
percentage and no bar, because there is nothing truthful to divide by.

**Composition is an estimate throughout, and it is a composition rather than a
total.** Harness prices the system prompt, the tool schemas, and the
conversation with one fixed density estimate; that estimate systematically
underprices CJK text and JSON schemas, which is why the occupancy figure above
is anchored to the provider instead. So the three shares divide their own sum,
and they will not add up to the figure at the top. That is the honest
arrangement, not a rounding error.

**The largest entries are what makes this more than a progress bar.** Harness
prices every entry the model is currently carrying, and dshline sorts them and
names them from the session log: a tool result is paired with its own call by
call id, so the name is the tool Harness really ran rather than whichever call
happened to sit next to it in a parallel batch. These prices are estimates too —
Harness's per-entry meter is route-priced or heuristic, never a provider's
tokenizer — so every one of them carries a `~`, and their percentages divide the
measured total of the current context.

**The list is the model's current context, not the session's history.** An
exchange a compaction replaced is not in it: the summary that stands in for it
is, named `compaction summary` — and named that only when it carries
compaction's own record of the transaction that wrote it, because the harness
lets any plugin replace part of a conversation and dshline will not guess which
one did. Anything else that stood in for earlier history says just that,
`replaced`. That is worth knowing either way: the card in your scrollback still
shows what was there, and the model no longer sees it.

`↵` opens one entry: what kind of context it is, how much of the conversation it
accounts for, where in the session it came from, and a bounded preview of what
the model is actually carrying. `share` says **of message context**, and means
it: the denominator is the conversation alone, because that is what the per-entry
meter prices. The system prompt and the tool schemas are counted by the other
estimator above, and adding two different estimates together to reach one
whole-context percentage would be inventing a number neither of them states.

```
╭─ dshline ────────────────────────────────── Context entry ─╮
│                                                            │
│  type       tool result                                    │
│  tool       run_shell_command                              │
│  context    ~42.0k estimated                               │
│  share      22% of message context                         │
│  position   41 of 128                                      │
│  turn       31 · step 4                                    │
│  log entry  seq 418                                        │
│                                                            │
│  Preview                                                   │
│  PASS packages/dshline/tests/context-model.spec.ts         │
│  PASS packages/renderer/tests/rendered.spec.ts             │
│  …                                                         │
│                                                            │
╰─ ↑↓ scroll · esc back ─────────────────────────────────────╯
```

`c` compacts, when your agent has the `/compact` command — it runs that command,
not a private copy of it, so the footer offers the key only when the command is
really there. The figures refresh once the compaction lands.

A profile without session projections, without the token meter, or without a
compaction backend still opens `/context`: it reports which reading is
unavailable and shows the rest. Nothing is invented to fill a gap.

### Compaction

`/compact` belongs to Harness, not to this interface. It takes no arguments, and
it is the harness's decision what to summarize, when a summary is good enough,
and whether the session is idle enough to try. dshline dispatches it and
presents the result.

What it prints comes from the compaction's own durable record rather than from
the command's sentence, which means an **automatic** compaction — one the agent
ran on its own because context was filling up — says so too:

```
› /compact
· compacted 27 entries · ~95k replaced

· context compacted automatically · 27 entries · ~95k replaced
```

`~` again: the replaced amount is Harness's estimate of the content it shadowed.
Both lines are ordinary transcript history, committed once and never rewritten,
so reopening the session shows them where they happened.

Three consequences worth knowing, in the order they will affect you:

1. **Older conversation is replaced by a summary.** The model can no longer
   quote what it no longer has. If something matters, it is worth restating.
2. **Context pressure drops**, which is the point — `/context` shows the new
   figure immediately.
3. **Cached prompt reuse is invalidated from the first replaced token onward.**
   The next request pays a cache miss for everything after that point, so the
   turn straight after a compaction is more expensive than its size suggests,
   and cheaper turns follow.

Oversized tool output is a separate mechanism: Harness shortens one result in
place, without touching the conversation around it. That gets no transcript line
of its own — it changes no exchange you can read — and shows up in `/context` as
a `replaced` entry instead. `replaced` rather than `shortened`: the session log
records that the result was stood in for, not that the replacement was smaller,
and this file does not claim more than the log does.

### Themes

`/theme` picks the palette this window draws with. Name one and it switches, or run it bare for a list with a line about each:

| | |
| --- | --- |
| `default` | The palette dshline has always shipped |
| `high-contrast` | Bright sixteen-colour palette that avoids dim and grey entirely |
| `ember` | Warm palette for a dark terminal |
| `tide` | Cool palette for a dark terminal |
| `paper` | For a light terminal, where bright black and dim stop meaning the same thing |

**A theme reaches new rows only.** Finished output is committed to your real terminal scrollback and is never rewritten, so everything above the input box keeps the colours it was printed with. That is the same rule that lets you scroll, select, and copy normally, and it is not something a theme can opt out of. Applying one is confirmed by a single line drawn in the new palette; the input box, the status line, and everything else still live redraw with it.

The last three are authored in 24-bit colour. On a terminal that cannot show that, each falls back to a sixteen-colour form its author chose rather than to an approximation, and the command says which fallback you are looking at instead of leaving you to wonder why it resembles the palette you just left.

`NO_COLOR` disables colour entirely, whatever its value, as does a `TERM` of `dumb`. `FORCE_COLOR` overrides both: `1` for sixteen colours, `2` for 256, `3` for 24-bit.

A theme you pick is stored in Harness's own settings document, under the `dshline` namespace this frontend registers:

```yaml
# ~/.dsh/settings.yaml
dshline:
  theme: ember
  attentionBell: false
```

`attentionBell` defaults to `true`. When enabled, dshline writes one terminal BEL when it presents a question or approval; the terminal decides whether that is audible or visible. Set it to `false` to keep your terminal's bell behavior for other programs while silencing dshline.

Harness owns the layering, so there are two places a theme or attention-bell preference can come from and the more specific one wins: a deployment composes a default in the `dshline` row of `~/.dsh/cordis.patch.yml`, and your own `settings.yaml` overrides it. `/theme` writes only the second.

**They apply live.** Editing the theme by hand while a session is running repaints the window — you do not have to reopen anything. Changing `attentionBell` instead controls future BEL writes and needs no repaint. Rows already committed keep the colours they were printed with, as everything committed does.

A name no shipped theme has is refused by the settings schema rather than stored, so a session cannot come back on a palette that does not exist. A profile that mounts no settings provider still runs on whatever it was composed with; only saving is unavailable, and `/theme` says so.

Themes are the five above. A palette is written against an internal vocabulary of roles — what a piece of text IS, rather than what colour it should be — and that vocabulary is not published yet, so there is no way to add your own.

### Tool output

A tool card shows the first rows of what a tool produced, with a marker saying how many it hid. A **command** is the exception: its card keeps the *last* rows and puts the marker above them, because what you ran `pnpm test` to find out is the failure and the summary at the bottom, not the banner at the top.

`ctrl-o` opens the hidden rows. While the newest finished tool card was truncated, it opens an inspector over that card — the same presentation, scrollable, at a much larger budget than the card itself had — and closes on `esc` leaving your scrollback exactly as it was. This works whether you are on `compact` or `full`. With no such card waiting, `ctrl-o` instead cycles how much every *future* card shows: `compact`, `full`, `hidden`. Cards already printed are never redrawn, which is the trade for keeping normal terminal selection and copying.

Inside the inspector, `←` moves to an older retained card and `→` moves to a newer one; `↑`/`↓` scroll the current card, `home`/`end` jump to its top or bottom, and `esc` closes. `ctrl-o` still works there as an older-card shortcut. The title counts your place (`Tool output 2/6`), and navigation stops at either end rather than wrapping. The last dozen truncated cards stay reachable this way, so a result you scrolled past is not lost to the tool calls that followed it. Each card is offered once: after the newest unseen one, `ctrl-o` returns to the detail cycle, which is what keeps that toggle a single keystroke away. The status line lists `ctrl-o output` while a turn is running.

### Plan review

When `exit_plan_mode` submits a plan, the review is a decision to make, not a document to read through the picker: it shows the plan's heading, the choices to approve it or keep planning, and a bounded preview of the plan's start — enough to recognise it, not the whole thing.

`ctrl-o` opens the plan in full, as one continuous scrollable document, exactly like the tool-output inspector: `↑`/`↓` scroll it a line at a time, `home`/`end` jump to the top or bottom, and `ctrl-o` or `esc` returns to the review. Returning changes nothing about the pending decision — whichever choice was selected still is — and only `esc`/`ctrl-c` on the review itself dismisses it to let you speak to the model instead. `ctrl-o` is offered only when the preview does not already show the whole plan *and* the full-plan reader itself fits the terminal — a screen just tall or wide enough for the compact review can still be a row or two short of that.

### What the session is about to do

Two things change what a turn *does* rather than what it says, and both are invisible in a transcript — the command that set one prints a line and scrolls away, and everything after looks like an ordinary session. So the status line carries them:

| | |
| --- | --- |
| `plan` | Plan mode is in force. The agent will propose rather than act |
| `goal armed · ship the release` | A goal is set and will continue by itself. No round has been taken yet |
| `goal 3/256 · ship the release` | Three rounds taken, of a cap of 256 |
| `goal idle · ship the release` | A goal is set, but this session will not continue it. `/goal resume` arms it |
| `goal paused`, `goal blocked`, `goal complete` | A goal that is not running, and why |

The objective is there because **a goal is not always something you set.** The harness publishes `create_goal` as a tool the model itself may call, and its own description says the model may infer that a request is long-running without being asked to create anything. So a session can acquire the authority to keep going on its own, and the status line is where that becomes visible. `/goal` shows the whole objective; `/goal pause` stops it.

`256` is the deployment's cap on automatic continuation rounds, not a target — which is why the count appears only once a round has actually been taken. `goal 0/256` reads as a meter stuck at zero; `goal armed` says the same thing truthfully.

`idle` is what every **reopened** session shows for an active goal. Whether a process may continue a goal is deliberately not saved with the goal, so resuming a conversation does not restart a run you left — the goal is still there, and picking it up again is a thing you ask for.

Neither mode is given up when the terminal narrows. They are dropped only after the model name, the totals, the bar and the context reading have gone, and a running goal is the very last thing to go — after the key hints. A mode is dropped whole rather than shortened: `goal 12/25` is not a smaller truth than `goal 12/256`, it is a different one. The objective is the one exception, and only because it is prose: a shortened objective is still an objective, so it is surrendered on its own before anything else about the goal is.

### Reasoning levels

`/reasoning` lists the levels the provider you are on actually accepts, rather than a fixed set — for the DeepSeek adapter that is `off`, `high`, and `max`, and a deployment configured with thinking switched off offers only `off`. There is also a `default` choice, which is not a level: it clears your selection so the provider does whatever it does when nothing is set.

The change applies from the next step, so pressing it mid-turn does not split a request across two settings, and it is remembered — see below.

The status line names the level next to the model, but only while it differs from the one your setup already defaults to — otherwise it would spend columns every frame on a fact you did not choose.

### Choosing from a long list

A gateway route advertises whatever the gateway serves. OpenRouter and opencode
offer hundreds of models, so `/model` opens a list that no terminal could show
at once — and one you should not have to scroll through.

The picker windows itself to the terminal and grows a query box once there is
more than a screenful to choose from:

```
╭─ dshline ─────────────────────────────────────────────────────────────────────────────── Model ─╮
│ Select a model                                                                                  │
│ ⌕ sonnet                                                    6 of 412                            │
│ current: deepseek-official/deepseek-v4-flash                                                    │
│                                                                                                 │
│ ❯ openrouter/anthropic/claude-sonnet-4                                                          │
│   openrouter/anthropic/claude-sonnet-4-thinking                                                 │
│   opencode/claude-sonnet-4                                                                      │
╰─ ↑↓ move · type to filter · enter confirm · esc clear ──────────────────────────────────────────╯
```

Every row is spelled the way `/model` takes it — `provider/model` — so what you
filter on is what you could have typed after the command, and the provider's own
display name sits under the selection where it disambiguates two similar models
without being the text you have to match. `esc` clears the query, `esc` again
closes the picker, and `home`/`end` jump to either end.

A short list is unchanged: an approval or `/reasoning` has nothing to filter, so
it spends no row on a search box and typed characters stay meaningless there.

### What you pick here is what the web interface opens with

`/model` and `/reasoning` both write your choice to `~/.dsh/settings.yaml`, in the same `agent-default-model` section the web Models page reads and writes. So they are two views of one setting: switch model in the terminal and the web interface opens on it, switch it there and your next terminal session starts on it.

This is worth knowing before you use `/model` to try something for one question, because it is not a session-scoped experiment — the next session starts wherever you left it. The transcript says so when it happens:

```
· model set to deepseek-official / deepseek-v4-pro · also the default for new sessions
```

The two are independent, in that order: the running session switches first and is never rolled back, so if the settings file cannot be written you are told, and the turn you are about to run still uses the model you asked for.

The whole selection is stored together — route and reasoning level — because the section holds one selection. Saving a level without its model would leave a level applying to whichever model the next session happened to open on.

### While a turn is running

```
◜ working 14m 26s · run_shell_command +2 calls · x-preview-f-free · ↑2.3M ↓21k · ▌░░░░░░░ 68k/1.0M · goal armed · todo 5/11 · ctrl-c interrupt
```

Beside the elapsed time is the tool the turn is waiting on. A long turn with nothing named beside it reads the same whether a command is running or the session has stopped responding, so the name is the difference between waiting and worrying. It is the first thing given up when the terminal narrows.

`+2 calls` means two more tools are running alongside it — the harness dispatches calls that are safe to run together in parallel, so several can be outstanding at once. The name is the most recently started of them.

The time is the **turn's**, not that tool's. Nothing here claims how long any one call has been running, because the harness does not publish that.

Text you submit while a turn runs is accepted by the agent and parked until it can be taken — on a long turn that can be a while, and until then nothing else acknowledges it. So the status line says it for you, in one segment whose word says which of the two is waiting:

| | |
| --- | --- |
| `1 queued` | A follow-up turn, waiting for this one to finish |
| `1 steering` | Waiting for the running turn's next step |
| `2 pending` | Some of each |

The count leaves once the agent takes them. See [Queue or steer](#queue-or-steer) for which one `enter` gives you.

`ctrl-c` interrupts the turn, and it also discards whatever was still waiting — stopping means stopping, rather than letting a queued prompt start the agent again on its own. It says how many it dropped, and `↑` brings any of them back.

### Tokens and cost

The status line carries a running total for the session:

```
● ready · deepseek-v4-flash · ↑8.8k ↓1.6k $0.018 · CR 99.8% · ▏░░░░░░░ 14k/1.0M
```

`↑` is every prompt token sent, cached or not; `↓` is every token generated, thinking included. Both come from the provider's own accounting, so they are what you were billed for rather than an estimate, and reopening a session brings its totals back with it.

`CR` is how much of the prompt came from **cache**, to one decimal — 99.8% is
99.8%, not 100%. It reads Harness's own cumulative accounting for the session's
model requests, which is not the same fold as the `↑`/`↓` totals beside it (see
below), so it is a share of that accounting rather than a breakdown of those
numbers. Between an endpoint and that one decimal it states a bound instead of
moving the value: `CR >99.9%` for a share that is not quite all of the prompt,
`CR <0.1%` for one that is not quite none, and `CR 100%` only when the whole
prompt really was a cache read.

It is convenience information rather than a status fact, so it is the first
segment the line gives up as the terminal narrows, whole rather than shortened:
`CR 99` would be a different number, not a smaller one. It says nothing at all
when there is nothing true to say — before the first prompt token, on a profile
without Harness's usage accounting, or when `/usage off` has left the line to the
context reading.

`/usage` chooses how much of that to show — `cost`, `tokens` for the counts
without the money, or `off`. Naming one changes it immediately; there is no menu
in the way of a word you already know.

Bare `/usage` inspects instead, because that is the question the command's name
asks:

```
╭─ dshline ────────────────────────────────────────── Usage ─╮
│                                                            │
│  Usage                                                     │
│  input               2.3M                                  │
│    uncached          317k                                  │
│    cache read        2.0M                                  │
│    cache write        13k                                  │
│                                                            │
│  output               42k                                  │
│  cache read share   85.7%                                  │
│                                                            │
│  cost               $0.84                                  │
│                                                            │
│  Performance                                               │
│  turns                  7                                  │
│  steps                 19                                  │
│  avg first token    640ms                                  │
│  avg output tok/s    42.3                                  │
│  model time        4m 12s                                  │
│  tool time         1m 03s                                  │
│                                                            │
│  status line         cost                                  │
│                                                            │
╰─ s status display · esc close ─────────────────────────────╯
```

The four token figures are Harness's own accounting, in the buckets the provider
reported them in, cumulative across the session's **model requests** — including
requests whose messages a compaction has since replaced, which you still paid
for. One thing is deliberately outside that: the extra provider call a compaction
makes to write its summary reports separately in the session log, and Harness's
accounting does not fold it in, so neither does this. `cache read share` is
deliberately not called a hit rate either: it is one bucket divided by the prompt
total, and no provider here publishes a hit rate to compare it with. It keeps one
decimal because the interesting range is the top of it: at whole percents a long
session that reused one prompt reads `100%` however much of it actually missed.

The money is this interface's own estimate, at the rates below, and it is folded
separately — from the finalized assistant message of each request, which is where
the route and the moment it ran can be read. The two folds are not the same
scope, and are not presented as a breakdown of each other: Harness also counts a
usage sample from an attempt that was retried, which no finalized message
records, so a session that hit a retry can show more prompt tokens above than the
money below was priced on. Nothing here divides one into the other.

`s` opens the same three-choice display picker `/usage` used to open on its own.

The performance figures below them come from a different Harness projection, and
they cover the whole session log rather than the part still on screen — reopen a
session and its counts and times come back with it. `turns` and `steps` are what
Harness counted from the session's own step boundaries: a step that failed before
it produced anything still happened, and so does one you interrupted. `avg first
token` and `avg output tok/s` are averages over the steps Harness actually timed,
which is why they are labelled as averages and not as a live rate. `model time`
is the request wall time from the start of each step to the reply it assembled,
and `tool time` is the wall time of each tool call matched to its result.
They are measured separately and are not two parts of one whole.

A row you cannot see was not measured, and that is different from being zero.
Harness accrues model time only for a step that assembled a reply, and tool time
only for a call whose result came back, so an interrupted reply and an
unanswered tool call can both have taken real time and still contribute nothing.
`/usage` leaves those rows out rather than printing `0ms`, which would claim a
measurement that was never made. `turns` and `steps` are the exception and are
always shown, zero included, because a count of zero is a real count.

The whole section is only there when the profile mounts Harness's
session-statistics plugin, which the shipped `dshline` profile does. A
hand-built profile that leaves it out gets a `/usage` that is otherwise
unchanged — every token figure, the cache split, and the money are all still
there — and one line saying this profile does not mount them. Nothing is
estimated in its place.

What the `$` means depends on the route. On a pay-as-you-go route it estimates what you spent; on OpenCode Go — which you pay for by subscription — it is the dollar-denominated usage counted against the subscription allowance, not a separate bill.

#### Which rates it uses

The routes this interface is built against — DeepSeek's own and OpenCode's (Zen and Go) — are priced out of the box, at the published rates, and each message is charged at the rate that applied **when it ran** rather than at whatever is in force now. That matters because the standard price is roughly twice the discounted one:

| | | cache hit | cache miss | output |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | off-peak | $0.007 | $0.22 | $0.66 |
| | peak | $0.014 | $0.44 | $1.32 |
| `deepseek-v4-pro` | off-peak | $0.022 | $0.66 | $1.98 |
| | peak | $0.044 | $1.32 | $3.96 |

Dollars per million tokens. Peak is 01:00–04:00 and 06:00–10:00 UTC; every other hour is off-peak, which is most of the day.

Three routes are priced this way: `deepseek-official` plus `opencode` and `opencode-go` — OpenCode Zen and OpenCode Go respectively, the two OpenCode routes the installed catalog carries — the routes this interface is built to run against. The OpenCode figures mirror DeepSeek's own list, peak schedule included, which is the accounting OpenCode applies to these models. Treat them as a starting point you can correct; a route that bills differently is one config entry.

Rates move, and this file will not. Both the prices and the peak windows are overridable in `~/.dsh/cordis.patch.yml`, and an entry you write **replaces** the shipped one for that route rather than merging into it — correcting one price should not leave the rest at whatever the release was built with:

```yaml
- id: dshline
  config:
    pricing:
      # Keyed provider/model. The bare fields apply off-peak; `peak` is the
      # exception, because it is the narrower window.
      deepseek-official/deepseek-v4-flash:
        input: 0.22          # cache miss
        cachedInput: 0.007   # cache hit
        output: 0.66
        peak:
          input: 0.44
          cachedInput: 0.014
          output: 1.32
      # A model id on its own covers whatever route serves it, which is how you
      # price one model the same way everywhere.
      deepseek-v4-pro:
        input: 0.66
        cachedInput: 0.022
        output: 1.98
    peakHoursUtc:
      - { from: '01:00', to: '04:00' }
      - { from: '06:00', to: '10:00' }
```

**Nothing is priced by model id alone unless you ask for it.** The same model through a gateway is billed by the gateway, on its own terms, so the shipped rates are pinned to the `deepseek-official` route. A model on a route with no entry is counted but not priced — you get the tokens and no `$`, which is the honest reading — and a total that is missing part of the session is marked `~` so it cannot be mistaken for the whole bill.

### Reaching DeepSeek through a gateway

The models are the point here, not the route to them, and reaching them through an OpenAI-compatible gateway is configuration rather than a code change — the harness's `llm-pi-ai` adapter takes a hand-declared route. This interface needs nothing added for one: `/model` lists whatever the route advertises, `/reasoning` offers whatever levels it declares, and the usage counter follows along.

For [opencode](https://opencode.ai)'s Go endpoint, put your key in the environment as `OPENCODE_API_KEY` and add the route to `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    opencode:
      displayName: opencode
      apiKeyEnv: OPENCODE_API_KEY
      api: openai-completions
      # The chat-completions path is appended by the protocol, so the route
      # stops at /v1.
      baseURL: https://opencode.ai/zen/go/v1
      # The endpoint speaks DeepSeek's thinking dialect but its URL does not say
      # so, so the format has to be named or /reasoning has nothing to send.
      compat:
        thinkingFormat: deepseek
      models:
        # Keys are the levels offered, values their wire spelling; `off` is the
        # one that may be left empty, meaning "supported, send nothing".
        - id: deepseek-v4-flash
          name: DeepSeek V4 Flash
          contextWindow: 1000000
          reasoningEfforts:
            off:
            high: high
            max: max
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro
          contextWindow: 1000000
          reasoningEfforts:
            off:
            high: high
            max: max
```

Two details are worth knowing. `apiKeyEnv` is a *reference* resolved per request, so the key itself never enters the file. And this goes in `settings.yaml` rather than in `cordis.patch.yml` — the settings document is the layer the adapter watches, so routes appear and disappear as you save it, with no restart. Prices are the other way round: they are read from the `dshline` row in `cordis.patch.yml`. This frontend does register a settings section — `dshline`, holding the theme — but prices are composition-time deployment facts rather than something to change from inside a session, so they stay where the rest of this row's configuration lives.

Both models are the same ids the direct route serves, which makes `/model deepseek-v4-pro` ambiguous once both routes are mounted — a bare id resolves to whichever route was discovered first. Say `/model opencode/deepseek-v4-pro` — or `opencode-go/deepseek-v4-pro`, if that is the id the gateway registered under — when you mean a particular one; the picker labels every row with its provider either way.

Costs are reported on the OpenCode routes out of the box, at DeepSeek's rates (see [above](#which-rates-it-uses)). If a route bills differently, one entry corrects it, and it replaces the shipped numbers rather than merging into them:

```yaml
- id: dshline
  config:
    pricing:
      opencode/deepseek-v4-pro:
        input: 0.66
        cachedInput: 0.022
        output: 1.98
```

Any *other* gateway is unpriced until you say otherwise: only routes this interface names carry rates, because a model reached through a reseller is billed by the reseller and inheriting somebody else's price list silently is the one failure worth ruling out.

### Where a turn's time went

`/timing` opens a persistent live breakdown above the status line:

```
  timing · turn 14 · 42.8s · live
  reasoning  ━━━━━━━━━━━━━━ 18.2s
  bash       ━━━━━━━━━━━━━─ 16.4s
  edit       ━━────────────  3.1s
  output     ━━────────────  2.1s
```

It stays there while the agent works and while it is idle. The turn clock and
open tool calls advance in real time; reasoning and output grow as their streamed
events arrive. When the turn ends, the same panel holds its final measurement —
nothing is added to scrollback — until the next turn replaces it. A span that
appears while you are watching eases its bar in over the next few working
heartbeats; the duration beside it is the real measurement from the first frame.
Tool-heavy turns are
capped to a small fixed height and end with an elided row that counts what is
hidden and names its longest call (`… +3 more · max 6.2s` — the longest, not
the sum, because these spans overlap); on a narrow terminal the figure is given
up whole rather than cut into a broken duration, before the
crowding-the-composer rule takes rows away entirely.

On a terminal too short to hold everything, the panel degrades before the input
line does: its span rows go first, then its header, and only on a terminal of a
handful of rows does it disappear entirely — an input line is never pushed off
screen to keep a chart visible. The composer behaves by the same rule, shedding
the blank line above its frame before it takes rows the panel was promised.

The bars are scaled against the **longest** row, not against the turn. These are
spans, not shares: tool calls in a step run at the same time as each other, so
their lengths can add up to more than the turn took, and the difference is not
idle time. The wall clock in the heading is the turn; the bars only compare the
rows with each other.

It is off by default, and while it is off it contributes no live rows at all.
`/timing` on its own flips it — there are only two states, so a list of two would
be a ceremony — and `/timing on` or `/timing off` sets it outright. Enabling it
during a live turn shows the measurement already in progress. Reopening a saved
session starts with `no turn measured yet`: historical replay deliberately omits
the streamed chunks needed for an honest breakdown, so the panel does not invent
one from incomplete data.

It was called `/profile` before, which was a name collision waiting to happen: a Harness **profile** is the composition a launcher boots, and `/profiles` browses those. This command is a stopwatch and now says so.

## Permissions and the sandbox

Read this before pointing a session at code you care about.

In a standard setup, **the agent's ordinary tool calls are not shown to you for approval before they run.** It can create, edit, and delete files inside your working folder and run shell commands there.

This is a property of the harness's standard plugin set, not a decision this interface makes. The approval prompt is implemented here and it does appear — but only when something explicitly asks for approval, and in the standard set only one case does: when the model asks to work outside the sandbox. Ordinary calls inside the folder are simply allowed. Operations outside the folder are refused outright rather than turned into a question.

If you want ordinary tool calls to ask first, add a plugin that makes that decision — `@deepseek-ai/dsh-hooks-claude-code`, or your own `tools/pre-execute` policy. Which calls need approval is a decision about how you deploy the harness, so this interface does not make it for you.

Bare `/permission` opens a bounded picker for the current session. It reads the
current value, names, descriptions, and order from the Harness deployment's
`permissions` projection, then sends the selected value back through Harness's
normal `/permission <preset>` command. `/permission <preset>` remains available
when you already know the deployment-defined name.

The standard `dsh-base` deployment currently supplies `read-only`,
`workspace-write`, and `danger-full-access`:

- `read-only` — the agent can read and search, but not change anything. Use this when you are only asking questions.
- `workspace-write` — the default. The agent can change files inside the folder you opened.
- `danger-full-access` — no sandbox. The name is accurate.

Those are Harness presets, not a dshline enum: another deployment can publish a
different table, labels, descriptions, and order. If its effective sandbox and
approval policy do not match a named preset, the picker shows `custom` as the
current state but does not offer it as a target.

Selecting `danger-full-access` from the picker asks for an explicit confirmation
before it runs the Harness command. This safety step applies only to the picker:
the direct `/permission danger-full-access` command retains Harness's existing
semantics.

## Sessions

When the active profile provides Harness session persistence, conversations can
survive quitting and be reopened:

```sh
dsh --profile dshline --resume          # browse, search, and choose one
dsh --profile dshline --resume <id>     # reopen a session directly
```

A reopened session looks exactly like the one you watched happen — reasoning,
diffs, tool output and all — because its persisted log is redrawn through the
same code that drew it live. Profiles without session persistence still support
fresh conversations, but cannot offer those conversations again after they end.

You do not have to decide at launch. `/sessions` opens the same browser from
inside a running window and reopens a session in place; see
[Commands → Sessions](#sessions). One session is driven at a time, and the
transcript of each stays in your terminal's own scrollback.

## If it refuses to start

This interface needs a real terminal for both input and output. If its input or output is redirected to a file or another program, it exits with an error instead of waiting forever with nothing on screen:

```
dshline: needs a terminal on stdin and stdout; for a piped or scripted run use --profile headless
```

Some wrapper scripts also cause this, because they do not pass a terminal through to the program they start. Run the harness command directly in that case, or use `--profile headless` for scripts.
