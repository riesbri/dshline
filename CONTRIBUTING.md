# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thank you for looking. Bug reports, terminal evidence, documentation fixes, and
focused pull requests all help make dshline a dependable terminal presentation
layer for the DeepSeek Harness plugin ecosystem.

Please read this page before opening a pull request. It is short.

## What is most useful right now

- **Generic Harness capability adapters.** Prefer a standard capability surface
  to a provider-specific integration, and keep Harness as the authority for
  state, runtime, persistence, and policy.
- **Terminal robustness.** Reports and fixes for keyboard decoding, resize and
  geometry behavior, terminal restoration, or unreadable output are especially
  valuable. Include your terminal, operating system, width in columns, and a
  screenshot where useful.
- **Cross-platform and Unicode evidence.** macOS terminals other than Ghostty,
  Windows terminals other than Windows Terminal, Linux PTY coverage, and
  CJK/wide-character correctness all protect the native terminal model.
- **Sessions, attachments, and focused UX.** Improvements should use Harness
  authority rather than add a parallel database, provider connection, or
  full-screen transcript.
- **Documentation that did not match reality**, or that you had to read twice
  to understand. Clear writing is a correctness concern, not a matter of taste.

The canonical [Roadmap](ROADMAP.md) gives product direction and limitations;
please do not duplicate it in an issue or pull request description.

## Reporting a bug

Open an [issue](https://github.com/riesbri/dshline/issues) with:

- What you did, what you expected, and what happened instead.
- Your terminal program and version, your operating system, and the output of
  `node --version`.
- The output of `dsh --profile dshline --dump-config`, if the problem is about
  installing or about which plugins loaded.

**For a key that does nothing,** the most useful thing you can send is what
your terminal actually sends. This prints it:

```sh
pnpm build && node tools/keyprobe.mjs
```

Press the key that misbehaves. Each line shows the raw bytes and the key this
project decodes them into. An empty `[]` means the key was not recognised — copy
those lines into the issue, along with your terminal's name.

**Do not report security vulnerabilities in a public issue.** See
[`SECURITY.md`](SECURITY.md) for the private route.

## Sending a change

1. **Open an issue first for anything larger than a focused fix**, so you do not
   spend time on something that does not fit the architecture or roadmap.
2. **Read [`AGENTS.md`](AGENTS.md).** It lists the rules that are easy to break
   by accident and explains why the renderer, Harness wiring, and terminal
   model stay separate.
3. **Add a test that fails without your change.** Then break your own fix on
   purpose and confirm the test notices. A test that also passes against the
   broken version does not protect anything.
4. **For a user-visible package change, run `pnpm changeset` and commit its
   Markdown file.** Documentation, CI, and internal-only changes do not need
   one. [`AGENTS.md`](AGENTS.md#preparing-a-release) explains the version PR and
   tag flow.
5. **Do not add dependencies.** The renderer has none, and that is a deliberate
   feature. A change that needs a new package needs a discussion first.
6. **Explain the reason in the commit message.** Say what a user saw, why the
   obvious fix is wrong, and how you checked yours. Long commit messages are
   normal here.

```sh
pnpm install
pnpm build        # also required before testing by hand; see AGENTS.md
pnpm test         # the full suite, no terminal and no model needed
pnpm typecheck
pnpm security     # the dependency and workflow checks that CI runs
```

All of these must pass. CI runs them on Node 22.19, 24, and 26, plus the
Harness target lane (the adopted upstream revision in `HARNESS_TARGET`) and
the Harness published consumer path, and every check is required before a
merge.

### Opt-in real Codex acceptance

The generic Work adapter also has a real-provider acceptance check. It is not
part of normal CI: it starts the package-managed Codex app server and requires
your local Codex authentication. Run it from the repository root with:

```sh
pnpm test:codex
```

It uses a temporary empty workspace, verifies generic `subagent/start` and
`subagent/end` through Work and its existing overlay, then waits for the
managed process tree to exit. Do not set the variable in CI.

## What may be declined

Being honest about this saves your time:

- **A new dependency**, unless it replaces something clearly worse.
- **A provider-specific implementation** where a standard Harness capability
  surface can supply the same fact.
- **A rewrite onto a UI framework.** The append-plus-live-region terminal model
  is intentional; see [Design](docs/design.md).
- **Features that need a full-screen layout**, such as split panes or side
  panels. This interface prints into native terminal scrollback, which
  deliberately rules those out.

## What to expect

This is not a funded project, and reviews may take a few days. A pull request
sitting without a reply has not been rejected — please comment on it again.

By contributing, you agree that your contribution is licensed under the [MIT
License](LICENSE), like the rest of the project.
