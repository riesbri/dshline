# Design

English | [中文](design.zh.md)

How this interface is built, and the reason behind each decision. Every heading below is a choice where the obvious alternative turned out to be wrong.

> Changing the code? [`AGENTS.md`](../AGENTS.md) turns these decisions into short rules you can follow without reading this page.

## Contents

- [Two packages](#two-packages)
- [It prints and updates one small area](#it-prints-and-updates-one-small-area)
- [Future views still become bounded terminal rows](#future-views-still-become-bounded-terminal-rows)
- [A reply is printed as it arrives](#a-reply-is-printed-as-it-arrives)
- [Reasoning is shown while it happens](#reasoning-is-shown-while-it-happens)
- [Suggestions come from what the agent really has](#suggestions-come-from-what-the-agent-really-has)
- [Tool output is drawn the way the tool asks](#tool-output-is-drawn-the-way-the-tool-asks)
- [The status line drops details instead of cutting them](#the-status-line-drops-details-instead-of-cutting-them)
- [Prices are shipped, and every one of them is wrong eventually](#prices-are-shipped-and-every-one-of-them-is-wrong-eventually)
- [A command that takes a value offers its values](#a-command-that-takes-a-value-offers-its-values)
- [The profiler stays live without inventing history](#the-profiler-stays-live-without-inventing-history)
- [Character widths follow the Unicode standard](#character-widths-follow-the-unicode-standard)
- [Measuring and cutting agree about escape sequences](#measuring-and-cutting-agree-about-escape-sequences)
- [Untrusted text is made safe before it is drawn](#untrusted-text-is-made-safe-before-it-is-drawn)
- [Colour is chosen by role, not by name](#colour-is-chosen-by-role-not-by-name)
- [Markdown is rendered, and made safe while it is parsed](#markdown-is-rendered-and-made-safe-while-it-is-parsed)
- [Pasted text is untrusted too](#pasted-text-is-untrusted-too)
- [Keyboard input is read in both formats](#keyboard-input-is-read-in-both-formats)
- [Queue and steer are the reader's choice, not the agent's status](#queue-and-steer-are-the-readers-choice-not-the-agents-status)
- [The empty composer answers three questions in one row](#the-empty-composer-answers-three-questions-in-one-row)
- [Image paths become durable references only at send](#image-paths-become-durable-references-only-at-send)
- [Commands report what they did](#commands-report-what-they-did)
- [What a turn will do outranks what it costs](#what-a-turn-will-do-outranks-what-it-costs)
- [The model you pick is one setting, not one session's](#the-model-you-pick-is-one-setting-not-one-sessions)
- [The interface is made of plugins too](#the-interface-is-made-of-plugins-too)
- [Sessions and resuming](#sessions-and-resuming)

## Two packages

The two halves are split so that the drawing code never learns about agents:

| Package | Responsible for |
| --- | --- |
| [`@dshline/renderer`](../packages/renderer) | Character widths, keyboard decoding, the input line, boxes, and the screen. Imports nothing from the harness, so it can be tested with no terminal and no model. |
| [`@dshline/dshline`](../packages/dshline) | The plugin: the session loop, turning session events into transcript lines, the harness integration points, and the view registry. |

That boundary earns its keep twice. The renderer has no dependencies of its own, which is what lets this plugin add nothing to a user's setup. And because it knows nothing about agents, every rule on this page about widths, cutting, and escaping can be tested directly.

## It prints and updates one small area

A chat transcript only ever grows, so the renderer keeps no copy of the whole screen. Finished output is printed into the terminal's own scroll history and never touched again. Only the bottom area — a reply still arriving, a question, the input line — is redrawn in place.

Because of that, the scroll position is never something this code has to track, and nothing has to be re-laid-out when the window is resized.

One rule makes it correct: the live area must always be the last thing on screen, so every write goes through `Screen`.

This is also why the interface never switches to the alternate screen. Scrolling, selecting text with the mouse, and copying all keep working exactly as they do for any other command, instead of being rebuilt inside the interface.

## Future views still become bounded terminal rows

dshline deliberately will not replace `Screen` with a reconciler that owns
historical terminal output, or adopt an alternate-screen/full-screen transcript
model. React + Ink can make different terminal trade-offs; this project keeps
its append-and-live-region model because the terminal's own scrollback is part
of the product.

A future view abstraction may be declarative, but it must resolve to a bounded
list of rows for `TuiSlots` and `Screen`. It cannot acquire an in-memory
transcript, rewrite committed rows, or bypass `Screen` to draw its own area.

## A reply is printed as it arrives

Each finished line is printed into the scroll history as soon as its line break arrives. Only the last, unfinished line stays in the live area.

An unfinished line that fits the live region is drawn through the same inline formatter as the committed transcript, against the same block state — so a closed `**bold**` span is styled the moment its markers arrive, a partial line inside a fence reads as code, and committing the line changes nothing about its shape. A clipped suffix is left literal: it has neither the start of the source line nor earlier delimiter context, and guessing at either would hide text. The live region is the committed path, one newline earlier, rather than a second rendering of the same text.

That has two benefits. Redrawing cost stays constant instead of growing with the length of the answer. And a reply longer than the window scrolls the terminal normally, rather than being trimmed to whatever fits.

When the complete message arrives at the end of the reply, it contributes only what streaming could not already show. That is what stops a reply being printed twice.

## Reasoning is shown while it happens

Models that reason send their thinking as a separate kind of output, sometimes for most of a turn. By default it is printed quietly above the answer, dimmed, so the screen shows the model working instead of showing a spinner over an empty space. `/thinking` changes only that terminal projection: hiding it still consumes and reconciles the reasoning, and showing it again mid-turn shows only reasoning that arrives afterwards. Already committed scrollback is never rewritten, and replay applies the current window preference to stored reasoning while leaving the assembled answer visible.

## Suggestions come from what the agent really has

Typing `/` lists the commands this agent actually registered. Typing `@` lists real entries from the folder. `tab` accepts the highlighted suggestion; `enter` accepts it when it completes the current token, otherwise it submits normally. `ctrl-enter` is adjudicated identically, because that modifier chooses how a submission is delivered and must not change what is submitted — left out, it fell past the list and sent the half-typed token. The arrow keys move, `esc` closes.

The suggestion list is deliberately not a modal box. A modal box takes every keystroke, and suggestions have to coexist with typing — so the list claims only its own keys, and it narrows as you type instead of trapping the line. An exact command, path, or argument is already complete, so `enter` still belongs to the composer and preserves the command's bare behavior.

Only the text before the cursor is considered. Completing against text after the cursor would rewrite characters nobody asked about. And `/` only starts a command at the beginning of a line, because `/help` is a command while `see /etc/hosts` is a path.

An accepted suggestion is made safe exactly as pasted text is. A file name can contain any character the filesystem allows, and the input line's contents are drawn without being escaped a second time.

## Tool output is drawn the way the tool asks

Each tool describes how its calls and results should be presented, through two functions the harness documents as safe to call at any time.

So a shell command becomes a framed box, headed by the folder it ran in, with its exit code on the output frame. A file change becomes a red-and-green diff. A search groups its matches under each file. A file read keeps the file's own line numbers. A tool that describes nothing still displays correctly, because every presentation type is documented to fall back to raw text — and no special case is ever added for a particular tool's name.

File-changing tools return their diff from both functions, because in most interfaces the finished card replaces the pending one. Here, where output is never redrawn, the diff is printed once, at the end. That is also the more truthful of the two: it is what actually happened, not what was proposed.

`ctrl-o` has a first duty before it cycles anything: a card that elided output has already committed those rows into scrollback, where no detail level can recover them (the level only affects cards drawn from now on). So while the most recent completed tool card was truncated, `ctrl-o` opens an inspector — a live-region overlay that re-renders that card's presentation, scrolls to the omitted rows, then disappears without touching the committed transcript. Inside it, `↑`/`↓` scroll one card and `←`/`→` switch between the retained cards; `ctrl-o` remains an older-card shortcut. That applies at `full` detail as well as `compact`, because the inspector has its own, far larger row budget: a card's rows are committed permanently and so are capped at a couple of hundred, where the inspector's are windowed and scrolled, and can run to thousands. Otherwise `ctrl-o` cycles how much of each card is shown: `compact`, `full`, `hidden`. Even `hidden` still shows that the call happened and still shows a non-zero exit code, because a transcript that hid those would misrepresent what ran.

Which END of a body survives the budget is decided per presentation, not once. A file read, a search, and a diff keep their first rows, because that is what was asked for. A command keeps its LAST rows: what `pnpm test` was run to find out is the failure and the summary at the bottom, and head-anchoring it kept the banner and threw away the answer. Its elision marker leads the frame rather than closing it, so it sits above the rows it speaks for.

## The status line drops details instead of cutting them

Context usage is shown as a bar next to the numbers — `██████░░ 6.2k/8.0k` — but only once at least one block of the bar would be filled. A DeepSeek context window holds a million tokens, so for any realistic session a proportional bar is empty, and an always-empty bar uses space to say nothing. A non-proportional bar would fill sooner but would misrepresent how full the window is. The filled part is rounded down, because a bar that looks full at 94% overstates the one thing it exists to report.

As the terminal gets narrower, whole hints are dropped rather than cut in half — a hint reading `ctrl-d qui` looks like a bug, not like help. The model name is dropped before the context numbers are, because the model does not change during a session and the numbers do.

The session's token and cost total sits between them, and is given up after the model name and before the context reading. Both halves of that follow the same argument: the total is an accounting of what the session has already spent, while the reading governs whether the session still works, so of the two the reading is the one you cannot be without. The reasoning level is drawn as part of the model's name rather than beside it, and goes when that name does — a level left behind after the model it qualified was dropped would read as belonging to whatever came next.

A model name is pinned to the right edge in some interfaces, which reads well and is not what happens here: the right edge is where the key hints go, and hints that appear and vanish with the width are worth more than a column of alignment.

Room for one hint is held back before any of that is decided, so a richer reading can never be the reason the last hint disappears. Without that, adding the session total was enough to leave an eighty-column terminal — the width most of them open at — showing every number and no help at all. What gets given up instead is the bar, which is a picture of numbers printed beside it; a hint is the only place this interface says how to leave it.

## Prices are shipped, and every one of them is wrong eventually

Tokens are counted by the provider and read out of the session log, so `↑` and `↓` are what you were billed for. They are folded in the same projection that draws the transcript, which is why reopening a session brings its totals back: the replay walks the same events past the same counter, and there is no second restore path to fall out of step with the first.

Prices cannot work that way, because no published rate stays true and a table baked into a release keeps reporting the number it was built with. The answer is not to ship none — an interface for two models that cannot price either is a worse trade — but to ship them where correcting one is a two-line edit, and to be exact about what they cover.

They are keyed to a **provider route**, never to a model id on its own. The same model reached through a gateway is billed by the gateway, so a bare-model default would quietly put one company's price list against another's invoice. Three routes are named — DeepSeek's own and the two OpenCode routes the installed catalog carries, `opencode` for OpenCode Zen and `opencode-go` for OpenCode Go — and they share one set of numbers written once, which is a deliberate approximation on the OpenCode pair: a reseller's invoice is its own document. Naming the routes is what keeps that approximation visible and confined to the three we made it about. A route nobody has priced shows its tokens with no money beside them, which is the rule the context bar already follows: nothing is drawn until there is something true to draw. A session only partly priced is marked, because a total quietly missing half its traffic reads exactly like a complete one. Keying an entry by model id alone is still possible, and is something you have to ask for.

One word on what the dollar figure *is*. On a pay-as-you-go route `$` estimates money spent; on OpenCode Go the same figure is the dollar-denominated usage counted against the subscription allowance, not a separate bill. The UI cannot tell which from the log — it reports the accounting the route is priced at — so this doc says it plainly rather than letting one reading of the number look universally true.

Two things vary underneath a single number, and both are settled per message rather than over the totals. **Which model** — changing model mid-session is one command here, so pricing the whole conversation at whichever one it happened to finish on would be wrong in both directions. And **when** — DeepSeek charges roughly double inside two windows of the morning, so a session priced at the moment somebody reopened it would bill a night's work at the morning rate. Every event carries its own timestamp, which is what makes the honest version no harder than the wrong one. The windows are read in UTC, because that is the timezone a provider publishes a schedule in; reading them locally would move everyone's prices by their own offset.

## A command that takes a value offers its values

Three commands here change a setting, and each of them accepts the value directly — `/reasoning max`, `/model deepseek-v4-pro`, `/usage tokens` — or opens a picker when typed alone. A picker is a good way to read four descriptions and a bad way to set something you already know, and making it the only way in would put an overlay between the user and a single word.

So the suggestion list carries the values too. Once a command name is followed by a space, what it accepts appears under the cursor, and accepting one is the same gesture as accepting the command name was. Since the list already reopens on an accepted candidate, completing `/rea` puts the levels on screen without a second keystroke — the picker becomes the fallback for when you want the descriptions rather than the route everyone takes.

Where the values come from is the part worth being careful about. They are asked of the runner rather than listed here, because they are live: which reasoning levels exist depends on the route currently selected, and a deployment with thinking switched off advertises exactly one. Only this interface's own commands offer any. A command registered with the harness describes its argument as a free-text hint, not as a set, so there is nothing to enumerate — and inventing candidates for one would advertise a vocabulary its handler never agreed to.

An argument completes only while it is a single word. `/tmp is full` is a sentence about a folder, and a list that opened inside it would be claiming a line the user is writing as prose.

## The profiler stays live without inventing history

`/timing` draws where a turn's time is going, not only where it went. While it is
enabled, a small indented panel remains in the live region through the turn and
the idle time after it. It is plain rather than boxed because it is persistent
chrome beside the composer and status line, not a modal card asking for focus.
It is capped at six rows, with omitted spans counted in one final row, so a turn
that invokes dozens of tools cannot grow the redraw area past the terminal. The
cap is also what makes its persistence honest: the composer budgets against a
header row for it, and on a terminal too short for both, instrumentation yields
to interaction — body rows first, then the header, never the input line.

The panel is the only presentation. Committing a second finished chart below the
reply would duplicate the same fact and turn optional instrumentation into
permanent transcript noise, so a completed measurement stays in place until the
next turn replaces it. When timing is off, the slot contributes no rows at all.

The interesting decision is what its bars are measured against.

The obvious choice is the turn: every row a fraction of the whole, adding to one. It is also false. Tool calls within a step run at the same time as each other, and thinking interleaves with them across steps, so these are overlapping spans — two ten-second tools inside a ten-second turn are both correct. Drawn against the total they would be half-full bars implying twenty seconds of something else happened; drawn against each other they say what actually happened, which is that both took ten seconds.

So the bars are scaled against the longest row, and the turn's wall clock is printed in the heading where it makes no claim about the rows beneath it. What the chart supports is "which of these took the time", which is the question anyone types the command to ask. What it deliberately does not support is "what fraction of the turn was thinking", because the log cannot answer that.

Each row is drawn as a mid-height stroke over a dim track rather than as full blocks over blank space. Two misreadings had to be prevented at once. A blank remainder hid where a row's scale ended, so a partial bar floated inside its row; and full-height blocks stacked on adjacent lines fused into one slab wherever neighbouring spans measured alike, hiding where one span's bar stopped and the next began. The stroke keeps whitespace between the rows whatever their lengths, and the track marks every row's end of scale. This departs from the status line's block bar on purpose: that gauge stands alone, while these rows stack.

The elided row reports the longest span it hides, labeled `max`, never their sum. These spans overlap, so a sum is work done rather than time passed — it can exceed the very turn printed in the heading, and a figure that contradicts the clock above it would read as a broken panel, not as an abstraction.

A span that arrives while the panel is already live eases its bar in over the next few working heartbeats instead of flashing to full width — which is what pure measurement draws, since the first span is always the longest. The ease counts those heartbeats, never time and never raw redraws: streamed frames redraw the panel many times inside one heartbeat, and those renders refresh measurement without spending the effect. It advances on the heartbeat the working spinner already drives, adds no timer of its own, and lives entirely inside the view, with the duration beside a growing bar showing the real measured value from the first frame. Anything the panel has no arrival to decorate — a preference toggled on mid-turn, a retained finished turn — draws at full width at once, because decoration must never replay history.

It reads two live authorities rather than the shared projection, and that is not
symmetry with the usage counter but the opposite of it on purpose. Turn
boundaries and tool call/result pairs are durable log events. Model stream time
is not in the log at all: the harness publishes each delivered chunk as a
process-local frame and stores only the compacted stream inside the settlement
that ends the attempt. A reopened session therefore has turn timings it could
chart and no model stream time to go with them, and half a profile is worse than
none — so a reopened attachment shows an honest `no turn measured yet`
placeholder instead of walking every past reply's compacted stream to
reconstruct one.

Finished spans use those timestamps and never change afterwards, whichever
authority supplied them: a tool span from its `tool/call` and `tool/result`, a
reasoning or output span from the timestamp each live frame carries — the same
value the durable settlement embeds for that chunk. An open turn and an open
tool have no ending event yet, so their provisional durations tick against the
wall clock already driving the working spinner. Once a result or turn end lands,
its log timestamp replaces the provisional clock reading. Keeping that exception
explicit is more truthful than either freezing active work between events or
pretending a renderer clock was part of the saved log.

Stream spans are separated per model ATTEMPT rather than per step. A request
that fails and is retried streams its reasoning twice, and merging the two would
count the failure and the retry decision between them as time the model spent
thinking. Each attempt's own span is real, and the panel adds them up.

## Character widths follow the Unicode standard

The harness is used in more than one language, and its bundled agent presets are named in Chinese. A character that is two columns wide but measured as one shifts every following row, not only its own — so widths follow the Unicode East Asian Width property, and the redraw arithmetic counts *drawn* rows so that a wrapped or East Asian line is still counted correctly.

## Measuring and cutting agree about escape sequences

`displayWidth` ignores escape sequences, so wrapping and truncating must ignore them too. Both split text into zero-width escape sequences and visible characters, never cut in the middle of a sequence, and re-open any active color on a continuation row. A colored line that measures wider than it draws would wrap too early, and would take every framed row with it.

Cutting also closes what it opened. Discarding the reset code at the end of a shortened line left its color switched on, and the next thing drawn inherited it — a dimmed reasoning line bleeding into the input line below.

## Untrusted text is made safe before it is drawn

A terminal treats some byte sequences as commands rather than as text. Anything produced by a model, a tool, or a session log is therefore untrusted: an escape sequence in tool output could repaint the live area, and a carriage return could move the cursor.

All such text is converted to a visible form first, with control characters shown in caret notation. Adding color is a separate step, applied only to text this project composed itself.

A path that reaches the terminal without being made safe is a security bug here, not a cosmetic one.

## Colour is chosen by role, not by name

A call site that asks for red has made a decision nobody can revisit. `style(text, 'red')` was written the same way for a failed tool and for a removed line of a diff, so no second palette could ever move one without moving the other — and four unrelated meanings, a warning, the spinner, context pressure, and every overlay border, shared yellow the same way. That, rather than the absence of a theme picker, is why there was only ever one palette.

So a call site names a ROLE — what the text is — and a palette says what that looks like. Only the second is a theme's to choose. Two roles that happen to share a colour today stay separate whenever they mean different things, because a palette can always give two roles the same value, and nothing can split a role back apart once the call sites have forgotten which one they meant. `muted` and `subdued` are held apart for a concrete version of that reason: one is an absolute grey and the other is an attribute that composes with whatever foreground is already active, so a palette written for a light terminal has to move the first and leave the second alone.

Every appearance is a list of SGR parameters, which is what lets a palette be authored in 24-bit colour without changing anything that draws. A whole escape sequence is already one zero-width token to the width arithmetic, however many parameters it carries. Each role also declares its own sixteen-colour form, so what a basic terminal shows is a decision somebody made rather than a nearest-colour approximation nobody looked at.

The closer is always the full reset. The foreground-only reset renders identically, and would be read as an opening sequence by every wrap — replayed onto each continuation row and never clearing what it had accumulated, which is the colour-into-the-composer bleed described above.

The palette is process-global, for the reason raw mode is: there is one terminal. Installing one returns the disposer that puts the previous one back, and calling that disposer twice is safe.

**Each layer owns its own roles.** The renderer declares the ones it draws itself — markdown structure and generic emphasis — and nothing more, because it must not learn what a reply, a tool call, or context pressure is; that is the same rule that keeps it free of dependencies. The frontend adds its own by augmenting the renderer's role vocabulary from its own package, so there is still one `paint` and one palette, and a palette is checked for completeness across both halves.

How much colour a terminal can show is Node's answer, not one this project keeps. `getColorDepth` already honours `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, and `TERM`, along with the CI variables and Windows build numbers a hand-written table forgets. Owning that policy would mean maintaining it, and being quietly wrong about it; deferring costs one mapping, from Node's monochrome `1` to the depth at which nothing is emitted at all.

## Markdown is rendered, and made safe while it is parsed

Replies arrive with headings, emphasis, inline and fenced code, lists, quotes, rules, and links. A deliberately small subset is supported, written by hand in `packages/renderer/src/markdown.ts`, because using a parser library would cost the no-dependencies property.

Emphasis follows the CommonMark rules about which characters may open and close it, with one deliberate difference. A marker followed by a space cannot open, and one preceded by a space cannot close, so `2 * 3 * 4` stays arithmetic. Underscores may not touch a word, so `snake_case_name` and `file_name.ts` stay intact. The difference is that `__init__` is left as written instead of being read as bold: in a reply about code, that is a Python name far more often than it is emphasis, and corrupting a name the reader may need to type costs more than losing the formatting. `__bold text__` and `_italic_` both still work.

The order of operations is the security rule: every piece of text is made safe *before* color is added, never after. The function that makes text safe also neutralizes the escape character itself, so running it over already-colored output would destroy the color — and running it over only some pieces would let a control sequence through everywhere else. A model can put one in ordinary prose, in a heading, in a link target, or inside a code fence, and all four are covered.

## Pasted text is untrusted too

People paste logs, which makes a paste the most likely source of terminal control characters in the whole interface.

Pasted text is cleaned up when it is inserted, rather than at each place it is later measured or drawn: line endings become `\n`, tab characters become spaces, and any remaining control characters become caret notation.

Tabs are expanded everywhere, not only here. A tab is a single character that moves the terminal to the next tab stop, so leaving one in place makes every width calculation disagree with the screen — a framed row is padded to the wrong width and its right border moves. Keeping one representation in the buffer means every width, cursor, and drawing calculation reads the same text the terminal receives.

Terminals can mark the beginning and end of a paste, and that is what makes a multi-line paste one message instead of a burst of `enter` presses. A paste that arrives in pieces is held until its end marker, however long that takes: a slow paste and an abandoned one look identical, and cutting a real one short would send the rest of the document as separate messages.

## Keyboard input is read in both formats

Telling `shift-enter` apart from `enter` needs the terminal's cooperation, so on startup the renderer asks for the lowest option of the kitty keyboard protocol, *disambiguate escape codes*.

That request is not additive. A terminal that supports it stops sending the old byte values for `esc`, `alt`, and **`ctrl`** combinations entirely: `ctrl-c` becomes `CSI 99 ; 5 u` and never `0x03` again.

So both formats are decoded, and the table for the new format is *derived* from the table for the old one rather than written out beside it. A `ctrl` shortcut's new code is its old byte value plus `0x60`, so adding a shortcut to one table gives it to both. A shortcut known only by its old byte value is completely dead on exactly the terminals where the new mode works — which is not a graceful fallback but a regression.

`enter`, `tab`, and `backspace` are the protocol's own exceptions and keep their old values when unmodified. The older xterm format for the same information is read as well, because which format a terminal chooses is not the user's problem. The mode is switched off when the interface exits, so the next program reads its input as it expects to.

A lone `esc` byte at the end of what was read is held rather than decided immediately, because it is the first byte of every sequence the decoder recognizes, including the paste markers. A brief pause resolves it: once the terminal has stopped sending, that byte was the Escape key.

## Queue and steer are the reader's choice, not the agent's status

Harness has always had two destinations for something you type. `followup` puts
it on the agent's `next-turn` list, where it becomes a turn of its own at the
next turn boundary. `steer` puts it on `next-step`, where the turn already
running takes it at its nearest step boundary and keeps stepping.

This interface used to pick between them by accident. `enter` called whichever
one the agent's status made available — `steer` while a turn ran, `followup`
otherwise — so every busy submission joined the reasoning already under way, and
nothing could ever ask for a follow-up. That is a real difference presented as an
implementation detail: "and then update the changelog" and "stop using that file"
are not the same instruction, and only one of them belongs inside the turn in
front of you.

So it is a preference, and its default is **queue**. Two reasons, in order. The
adopted Harness generation's own Web client ships `queue` as its busy-`enter`
default, and two surfaces of one agent disagreeing about what the same key does
is worse for a reader than either choice on its own. And queue is the safer one
to be wrong about: a follow-up that should have been steering arrives one turn
late, while steering that should have been a follow-up has already been merged
into a turn that was reasoning about something else, and cannot be taken back.

Only `enter` *while a turn is running* is affected. Idle, there is no step for
steering to reach — Harness resolves an idle steer into a woken prompt turn
anyway — so inventing a distinction there would be this interface's own, not
Harness's.

`ctrl-enter` sends the other way for one message. It is the one key here that is
deliberately never advertised, and the reason is the same one that makes
`alt-enter` the newline this interface suggests: a terminal not in an enhanced
keyboard mode sends the identical bytes for `ctrl-enter` and `enter`, and there
is no query that would tell them apart in time to draw a hint. A composer that
named it would be telling most readers to press a key that quietly does the
opposite of what it said. Where the terminal cannot send it, the press is
`enter` — the reader's own preference, never a third behaviour — and `/enter`
and the usage guide teach the gesture instead.

What this interface does NOT own is the queue. Harness holds the lists, their
order, their durability, and their claiming; the choice here is which of two
existing verbs one line is delivered with, called once. The status line reads
those lists live rather than counting what was submitted, because a count kept
here would drift the moment anything else moved the inbox — a claim at a step
boundary, a cancellation, a plugin's own insertion — and would have to be rebuilt
on resume from events it does not own.

One consequence is worth stating because it is a choice and not an oversight.
`ctrl-c` discards pending input along with the turn, because Harness's cancel
clears both lists unless it is told to keep them. Keeping them is what the Web
client does, and there it is right: cancelling is a button beside a visible queue
the reader can then edit. In a terminal, `ctrl-c` means stop — and queued work
that survived would start the agent again on its own the moment the aborted turn
converged to idle, which is not an interrupt. So the pending prompts go, and the
line that says the turn was interrupted says how many went with it. They are
still one `↑` away: a submitted line is in the window's input history whatever
the agent did with it.

## The empty composer answers three questions in one row

An empty input line should say that you can type in it, what `enter` will do
right now, and how to find everything else. It should say all of that quietly,
and it must not cost a row.

```text
› ask anything · / menu      idle
› type to queue              a turn is running, and enter queues
› type to steer              a turn is running, and enter steers
```

The hint is presentation and nothing else: it is produced from the agent's state
at paint time and handed straight to the frame, so it never enters the buffer,
the history, the undo stacks, a submission, or the text a completion is computed
from. The branch that draws it is the one gated on the buffer being empty, which
is what makes that structural rather than a promise.

It says `/ menu` rather than `/ commands` because that surface is not only
commands: it carries this interface's own, the agent's registered ones, and the
user-invocable skills — and a skill is not a command.

Segments are dropped whole, in one order, exactly as the status line drops its
own: `› ask anything · / me` reads as a rendering fault rather than as help. The
prompt itself is never dropped, because it is the actual affordance and the
cursor is placed just past it at every width.

The part that had been wrong is subtler. This text used to be fitted with the
wrapping helper, which returns as many rows as it needs — so below nineteen
columns the empty composer already drew a fifth row, and the empty branch is the
one view in the live region that spends none of its own row budget. On a short
terminal that pushed the region past the screen, where rows that have scrolled
off can no longer be reached or erased, which is the one thing the append-plus-
live-region model cannot survive. A longer hint would have moved that cliff into
ordinary split-pane widths. So the ladder returns a single row by construction
and the frame is handed exactly one, at every width, in both states.

## Image paths become durable references only at send

An image draft begins as a path owned by the current session attachment. Staging
does no I/O: the reader can list, remove, or clear drafts, and changing sessions
cannot leak them into another Agent. Only submission resolves and reads each path
through `ctx.fs`, using the deployment's byte limit, then publishes the complete
batch through `ctx.attachments`. A successful publication yields opaque,
content-addressed `ImageBlock` references; dshline never invents an id or stores
base64, image bytes, or a host path in the log.

That admission is one cancellable user operation even though durable publication
itself is atomic and has no cancellation signal. `ctrl-c` owns the operation from
the first read through command dispatch, and a completion that arrives after
cancellation or session teardown cannot enqueue into the old Agent. Failures keep
both the prompt and drafts so retrying cannot silently change a multimodal request
into a text-only one.

`@path` remains text because source files and directories are references for model
tools, not image bytes. `/image` is deliberately explicit, and registered commands
receive its drafts only when their Harness descriptor declares
`input.attachments` — the harness's own generic admission for composer
attachments, not an image-specific flag. dshline consumes that flag and still
authors only the attachment kind it owns, so a command that declares it is sent
discriminated image submissions and nothing else.
Model names are never used as a vision allowlist: an explicit text-only modality
refuses before I/O, while absent metadata remains unknown and is left to Harness.

## Commands report what they did

A command does not produce a model reply, so what it says about itself is the only evidence that anything happened. The command line is echoed, and its result is printed as a note — or with a `✗` when it failed, because a command that fails silently looks exactly like a command that is broken.

Both come from the harness's own record of the command starting and finishing, not from the moment you pressed enter. That matters for reopening a session: those two records are saved in the log, so a resumed session shows its commands exactly as the live one did. Printing directly to the screen instead would have made every command result disappear on resume.

A command may also succeed with no text at all. That is a valid result, and the commands that return it are the ones whose effect this interface cannot otherwise show — so instead of passing over it, the command is acknowledged by name. The harness also lets a result point at another event that presents the same information more richly. That hint is deliberately ignored here, because this interface does not display those events, and honoring it would leave the command invisible.

A line that is rejected as an unknown command is different: nothing ran, so the harness records nothing, and the message comes from this interface alone. It is not part of the saved conversation and does not reappear when the session is reopened.

`/exit`, `/quit`, `/model`, `/reasoning`, `/usage`, `/timing`, `/new`, and `/clear` are answered by this interface rather than registered with the harness. `/clear` is `/new` plus one piece of presentation intent: its fresh-session transition wipes the visible display once the fresh session is actually created — a failed or resumed transition never does — using the same display-clear path as `ctrl-l`, which does not explicitly purge the terminal's scrollback. The harness's command registry is shared by every interface in the process, and a web page or an automation server has no terminal to leave, no picker to open, and no status line to switch a reading on and off in. They still appear in the `/` list next to the others, because someone typing `/` wants to see what they can type, not which registry it came from.

A line that looks like a command but names nothing is reported as unknown, using the harness's own rule for what a command line is, so the two cannot disagree.

## What a turn will do outranks what it costs

Plan mode and a running goal are the two states here that change what the agent *does* rather than what it says, and a transcript hides both. The command that set one printed a line that has long scrolled away; everything after it looks like an ordinary session while the agent quietly refuses to edit files, or quietly takes another round on its own. That is the case a status line exists for, so both states sit in it; the goal's objective remains in the explicit `/goal` report rather than persistent footer chrome.

They are read by different means, each the one its owner documents, and the difference is not an inconsistency. Plan mode is folded out of the log, because the controller says outright that it keeps no live mirror and that interfaces observe committed flips through the event feed — which has the happy consequence that a reopened session recovers the state from its replay, the same way the session totals do. A goal is asked of its service instead, because the log cannot answer the question that matters. The durable record says a goal is active; whether *this process* holds authority to take another round is process-local and deliberately never persisted, so a reopened session holding an active goal is not a session about to run one. Reading only the log would have reported a run that was not going to happen, on every resume.

That distinction is why the reading has three shapes rather than two. A goal that will continue is a count of rounds against its cap, coloured like the working spinner because that is what it is. A goal that is set and going nowhere says so. A goal that is paused, blocked or finished shows its phase instead of its count, because the round number of a stopped goal is history rather than progress.

Both are the last things given up as the terminal narrows — after the model name, the totals, the bar, the context reading, and the key hints. The hint reservation described above is spent *within* each level rather than across all of them, which is the whole ordering in one sentence: help matters more than a richer reading, and less than knowing the session is about to act by itself. And a mode is dropped whole, never shortened, for the reason every other segment here is: `goal 12/25` is not a smaller truth than `goal 12/256`, it is a different one. The status carries that state only; `/goal` is where the objective is read in full.

## The model you pick is one setting, not one session's

Switching model is two separate acts that are easy to mistake for one. The first writes a mutable ref the agent reads as each step enters prompt assembly; that is what makes the switch take effect, and it is entirely in memory. The second stores the selection in the harness's settings document, which is the same section the web interface's Models page reads and writes.

Only doing the first is defensible and was what happened for a while: a terminal is where you try things, and an experiment that quietly changed a setting for every other surface would be a surprise. What settled it the other way is that the read was already asymmetric. This interface has always *read* that section at startup, so a model chosen in the web interface arrived here on the next launch — and one chosen here went nowhere. A setting that syncs in one direction is harder to reason about than one that syncs in both, because there is no rule a user can hold: it depended on where you last touched it.

So it syncs both ways, and the command says so on the line where it happens rather than leaving it to be discovered. The ordering is the part with a rule: the ref is written first and unconditionally, and storing is allowed to fail. The turn about to run has already been promised a model, and a settings document that could not be written is a reason to say so, not a reason for that turn to quietly use the old one.

The selection is stored whole, route and reasoning level together, even when only one of them changed. The section holds one selection; writing half of it would leave a level applying to whichever model the next session happened to open on.

## The interface is made of plugins too

The banner, input line, status line, and every box are separate registrations in `ctx.tuiSlots` — the terminal's equivalent of the web interface's view registry. Positions are named (`stream`, `composer`, `completion`, `timing`, `status`), so an internal view chooses where it appears by naming one, and whichever view owns text entry reports where the cursor belongs.

```ts
ctx.tuiSlots.register('status', { render: () => ['my widget'] })
ctx.tuiSlots.pushOverlay(myPrompt)   // takes the whole area and every keystroke
```

This is an illustration of the current internal composition model, not a
third-party integration recipe: `TuiSlots` and `TuiOverlay` are experimental
pre-1.0 vocabulary, not a stable public SDK. Boxes stack, and only the top one
draws and receives keys, so a question raised while an approval is waiting does
not get mixed into it. `ctrl-d` is handled before the box gets the keystroke,
because quitting means the same thing everywhere.

## Sharing a frame is not sharing a state machine

The composer is the interface's one fixed anchor, and a temporary browser —
Work, Sessions, Plugins, the tool inspector, a picker — is the same anchor seen
expanded. Both draw through one shared frame: the left border label is always
`dshline`, the right label says what is on screen (the workspace while
composing, the view's identity while a browser is open), and a browser's
navigation help lives inside the bottom border rather than in a row beneath a
detached box.

The sharing is deliberately presentation only. A mounted overlay still replaces
the whole live region and takes every keystroke, exactly as before — there is
no composer underneath it, a searchable picker's typed query still belongs to
the picker, and closing the overlay restores the composer untouched. The
obvious alternative, letting the overlay actually grow out of the composer,
would merge two things that must not merge: the composer owns a buffer and a
cursor, the overlay owns a temporary interaction, and coupling them is how a
browser starts eating text typed for the input line. So the visual continuity
is bought with one shared drawing helper and nothing else shared: no state, no
keys, no lifetime, no view of Harness.

The frame itself is a renderer primitive that knows nothing about agents:
labels at either end of the top border, help in the bottom border, and divider
rows. When the two labels collide the right one yields first — the `dshline`
anchor is the point of the whole arrangement — and help drops whole segments
rather than half instructions, so a narrow terminal reads `esc`, never
`esc clo`. Because the help row moved INTO the border, a browser spends one
fewer live row than a box with a help line beneath it used to; every browser's
row budget was re-derived from its actual geometry rather than nudged until
its tests happened to pass.

## Sessions and resuming

When the active profile provides Harness session persistence, `--resume` rebuilds
the transcript from the persisted log and redraws it through the *same* code that
drew it live, so a reopened session looks exactly like the one you watched
happen. Two separate drawing paths would have drifted apart the first time either
changed. Profiles without persistence can still run fresh sessions; dshline does
not add another store.

What gets replayed is the record of what was actually said, not the version the model currently sees. Those differ: when history is summarized to save context, the model's view hides the messages that were replaced. Replaying that view would erase parts of the conversation you had already read. They are gone from the model's memory, but they still happened.

A reopened session keeps the folder it was created in. That folder is recorded in the session file and treated as authoritative, so `-C` is ignored when resuming rather than quietly moving an old conversation somewhere new.

Reopening from inside a running window — `/sessions` — draws the same way, and that is the constraint it has to satisfy: the transcript already in your terminal is committed scrollback, so the reopened one is *appended under it* rather than replacing it. Nothing already printed is rewritten, which is why one window can move between sessions without an alternate screen. What changes is who owns the live region: the window keeps the terminal and the keyboard, and the attached session's views, log listener, and capability adapters are torn down and rebuilt around the new agent.

The browser's 2.0 capabilities stay on the same authority line. Corpus filters, lineage navigation, within-session search, and cursor-backed paging are all projections of `ctx.sessionQuery` — `filterSessions` clauses for workspace and age, `traceSession` for ancestry, `searchEvents` for one session's hits, opaque cursors for both paged scopes — and rename is the single mutation, delegated to `ctx.sessionTitle` for the session this window drives, whose log-only `session/title` event carries the explicit `user` source. The browser opens small child overlays (filter picker, lineage, event search, rename prompt) from one keystroke each; each child owns its own selection, query, and viewport, and closing it restores the parent's exact state because the two never share live-region state. Which keystroke follows the scope of the question: `ctrl-f` for the filters, which narrow the corpus, and `→` for the surface that discloses one session — its facts, and the actions that only make sense for it. The list keeps only cheap identity cues — title, age, `open`, and `delegated` for child sessions — while the bounded log read behind an event count and a last-activity time happens when that surface is opened, so moving the cursor still costs no session-log reads.

Paging treats Harness's cursor as pure request state: it is valid only for the exact normalized request it came from, so editing the query or changing a filter restarts the chain, a loaded page appends exactly once, and a corpus that moved under a cursor surfaces as an explicit refresh rather than a silent splice. Origin classification is presentation-only by necessity — Harness publishes no origin predicate — and is applied over the authoritative observed headers Harness returns: the batch title observation of a search page resolves the same session's live-preferred header, restoring an `origin` a backend's own hit projection may have omitted, which is why the counter can say "matched of returned" instead of pretending the backend ranked by origin.
