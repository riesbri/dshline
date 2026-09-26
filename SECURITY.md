# Security

English | [中文](SECURITY.zh.md)

## Reporting a vulnerability

Report privately through GitHub's [private vulnerability reporting](https://github.com/riesbri/dshline/security/advisories/new). It goes to the maintainer without becoming public, and it is the only channel — please do not open a public issue for something exploitable.

Expect an acknowledgement within a week. This is a personal project rather than a funded one, so that is a realistic commitment rather than a target with a team behind it. If a report is confirmed, the fix and an advisory land together, and you are credited unless you ask otherwise.

Vulnerabilities in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) itself belong upstream, not here. If you are unsure which side a problem is on, report it here and it will be routed.

## Scope

`dshline` is a terminal-native frontend for an agent. Its exposure follows from that, and these are the things worth looking hardest at.

**Terminal escape injection.** Every string this project draws came from a model, a tool, a file, or a paste, and none of it is trusted. A terminal treats bytes as commands: an escape sequence in a model's reply can reposition the cursor, rewrite lines the user already read, retitle the window, or on some emulators put text into the input buffer. Everything reaching the screen therefore passes through `escapeControls` first and is shown in caret notation, and styling is applied only to text already made safe — never the reverse, because escaping styled output would destroy the styling and escaping only some spans would let a sequence through anywhere else. A path that reaches the terminal without escaping is a vulnerability in this project, not a rendering bug. The renderer's test suite asserts it for prose, code spans, fenced blocks, headings, bullets, links, tool output, pasted text, and the live streaming region.

**Truncation and width.** `displayWidth` ignores escape sequences, so `wrapToWidth` and `truncateToWidth` must too. A cut that lands inside a sequence emits a partial escape, which the terminal then completes with whatever follows — so a width bug is an injection bug with extra steps.

**Bracketed paste.** Paste is sanitised at the point it enters the composer, not at the point it is drawn. Without that, a document containing escape sequences becomes a way to reach the terminal through a user who only meant to paste text. A large paste is then drawn as a compact `[Pasted text #1 +11 lines]` placeholder instead of its contents, which is a second route from untrusted input to the screen and so has the same requirement: the placeholder is assembled entirely from the numbers this project generates, never from a character of the paste, and sanitation is not deferred to that point. What is hidden stays hidden — the submission, the history entry, and the completion source all read the sanitized buffer, not the projection.

**What is out of scope here.** What the agent is permitted to do — which tools exist, which calls need approval, what the sandbox allows — is decided by the profile that mounts this bundle, not by this bundle. That is deliberate: the harness puts policy in composition, and a frontend that decided it for you would be the wrong place to look for it. Reports about a tool executing something it should not belong upstream or with the composition, unless this frontend answered an approval request it should have refused.

## How this repository defends itself

Not a promise of safety, just what is actually wired up and where to look.

| Control | Where |
| --- | --- |
| Advisory scan on every push and weekly | `.github/workflows/security.yml` |
| New-dependency and licence review on every pull request | `.github/workflows/security.yml` |
| Full-history secret scan | `.github/workflows/security.yml` |
| Workflow hardening lint (`zizmor`, pedantic) | `.github/workflows/security.yml` |
| Static analysis (`CodeQL`, `security-extended`) | `.github/workflows/security.yml` |
| Supply-chain posture grade (`OpenSSF Scorecard`) | `.github/workflows/security.yml` |
| Actions pinned to commits, not tags | every workflow |
| Install scripts never run in CI | `--ignore-scripts` |
| Lockfile verified rather than trusted | never `--trust-lockfile` |
| No version younger than two hours is installed | `minimumReleaseAge`, `pnpm-workspace.yaml`; applies to every job with no exception. The bypass that used to exist covered one lane racing an npm dist-tag, and that lane is gone: dshline now targets an exact Harness revision recorded in `HARNESS_TARGET`, so no job needs to install a version the moment it is published. `tools/ci-workflow.spec.mjs` fails the suite if the bypass reappears |
| A consumer's first run installs the version of dshline that asked for it, under the same two-hour window | `packages/dshline/bin/dshline.mjs` names its own exact version and passes `--config.minimum-release-age` to the harness's pnpm. The profile pnpm installs into belongs to the harness and carries no dshline settings, so the window travels on the command line rather than being written into someone else's file. A version still inside the window never installs unasked: pnpm puts the decision to the user on a terminal, and refuses outright where there is nobody to ask. Either way the setup stops and nothing starts, which is the point: unstated, pnpm 11's own default let a bare package name resolve to an OLDER dshline than the wrapper running it, silently |
| A weakening of a package's trust evidence fails the install | `trustPolicy: no-downgrade`, `pnpm-workspace.yaml` |
| Dependency and action bumps proposed for human review | `.github/dependabot.yml` |
| Releases published from CI with a signed provenance attestation | `.github/workflows/publish.yml` |
| npm trusts only the named workflow and exchanges its OIDC identity for short-lived, package-scoped credentials; no npm token is stored in GitHub | `id-token: write` and `tools/check-trusted-publishers.mjs` |
| Both package exchanges are verified before either package is published | `.github/workflows/publish.yml` |
| A GitHub Release can be written only after publishing and registry verification succeed | separate `github-release` job in `.github/workflows/publish.yml` |
| Automated version tags come from a merged generated version PR, or an explicit recovery dispatch verified against that PR's merge commit | `.github/workflows/version.yml` |
| A new automated tag is refused while another release is active, before GitHub can discard a pending intermediate run | `.github/workflows/version.yml` |
| The version-PR token is separate from the read-only job token and limited to Contents and Pull requests write, so required PR checks are triggered without granting the job those scopes | `VERSION_TOKEN` in `.github/workflows/version.yml` |
| The tag-triggering token is distinct and fine-grained Contents-only rather than the broad release credential | `RELEASE_TOKEN` in `.github/workflows/version.yml` |
| A release build restores no cache any branch could have written | `package-manager-cache: false` |
| A tag that disagrees with the versions it would publish is refused before tag creation and rechecked before publishing | `tools/check-release-tag.mjs` |
| A release that only half-landed fails rather than being discovered later | `tools/verify-published.mjs` |

## Verifying what you installed

Releases are built and published by GitHub Actions, which records a signed attestation binding each tarball to this repository, the commit it was built from, and the workflow that built it. So you do not have to trust that the published package matches the source:

```sh
npm audit signatures
```

npm's page for each version links the commit and the workflow run. A version without that attestation was not published by this pipeline.

The published packages declare no runtime dependencies beyond each other, which is the largest single reason the surface is small: `@dshline/renderer` has none at all, and everything the harness provides is a peer the host already has.
