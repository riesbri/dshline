---
'@dshline/dshline': patch
---

Harden install, bootstrap, and profile upgrade recovery.

An independent clean-room Windows audit walked the published install as a new
user and found four ways the wrapper turned a recoverable state into one nobody
could act on. Each is fixed where it is dshline's to fix.

**A failed setup could leave a profile that hung every later launch.** `dsh
plugin` writes the profile manifest *before* it installs anything, so "the
manifest exists" only ever meant a setup began. The wrapper read it as "the
profile is ready" and handed over to a frontend that had never been installed,
which is a blank terminal with no message and no exit. It now reads one thing —
whether its own package is recorded in its own profile, and at which release —
and reports the two states that have no working frontend behind them instead of
launching into them: a profile a failed setup left *half set up*, and a profile
recording a *different release* from the wrapper starting it. Each is reported
with its cause and with `dshline --setup` as the repair, and on a terminal the
wrapper offers to run that repair, which is the same question first run already
asked. Everything else about a profile — bundle list, `node_modules`, another
plugin — stays the harness's judgement, so this is not a second profile health
checker.

**Setup no longer starts without pnpm.** The harness installs a profile's
plugins with pnpm, so a machine without it created the profile and stopped with
`'pnpm' is not recognized`, leaving exactly the half-made profile above. pnpm is
now checked *before* anything is created, for `--setup` and before the first-run
question is even asked, so the answer is a sentence rather than a mutation. The
remedy names the mechanism the harness actually came from: `corepack enable
pnpm` for a harness checkout, which declares the pnpm version it wants in its own
`packageManager`, and `npm install -g pnpm` for a package install.

**A wrapper and a profile that disagreed now say so.** `npm install -g
@dshline/dshline@latest` moves the global command; it does not move the frontend
inside the profile, which is the part that actually runs. The launch then died
inside the harness with `cannot get property "agent" without inject`. The
wrapper now compares the profile's recorded release with its own and reports the
mismatch in plain language, pointing at `dshline --setup` to reconcile it.

**A profile installed from a checkout is left alone.** Its recorded spec is a
path, not a release, so there is nothing for it to be out of step with.
Subjecting it to npm-version equality would have broken source-checkout
development outright — the mode the comparison must not touch — so the state
model tells a source spec from a registry release rather than reading "not this
exact version" as "wrong".

Also fixed:

- **`dshline --help` works with no profile, no harness, and no terminal**, like
  `--version` already did, and names `dshline` instead of leaking the harness's
  own `Usage: dsh --profile dshline`. It documents what the wrapper owns and
  points at `dsh --profile dshline --help` for the rest rather than restating a
  CLI reference that would drift.
- **A checkout command line is split the way a shell reads it.** A `dsh` script
  naming its interpreter in full — `"C:\Program Files\nodejs\node.exe"
  apps/cli.ts`, the default Windows shape — was split on whitespace into
  `C:\Program` and `Files\nodejs\node.exe`, and the launch failed with ENOENT
  beside a checkout that worked from a shell. Both copies of the launcher policy
  learned quoting, and a test asserts they agree.
- **A failed setup says what to do next.** The message keeps naming
  `dshline --setup`, and now also says where the reason is and how to inspect the
  profile without starting a session.

`dshline --dump-config` is not a wrapper flag and this does not add one. The
harness owns the profile dump, `dsh --profile dshline --dump-config` is the one
canonical spelling, and the installation documentation now agrees with the issue
template and `CONTRIBUTING.md` instead of contradicting them.
