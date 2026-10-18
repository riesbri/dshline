# PR #304 — emitted-byte headroom follow-up

## Scope and fixed live protocol

This follows the completed pacing experiment, but **does not use pacing**.
Compare unchanged production source `2393f1f` against the compact-padding TS
candidate. Public APIs, dependencies, Unicode widths, logical rows, synchronous
commits and production scheduling remain unchanged. No merge, release or working
profile installation is authorized or performed.

Before any provider calls: audit the frozen archives, implement one encoding
factor, check deterministic terminal parity and focused regressions. Then collect
six excluded warm-ups and exactly 30 attempted measured turns per arm per workload
(Latin, CJK, styled): 186 maximum main requests, plus up to 186 ancillary title
requests. No separate live pilots or interrupt turns, replacements, sample-size
extension or sampling until significance. A warm-up is also a reachability gate;
stop immediately on admission failure or runaway resource cost. Same real Harness,
provider `opencode-go/deepseek-v4.1-flash`, controlling 90×24 PTY and seed 303
workload rotation/adjacent alternating AB/BA as before. Type `UXPROBE304` during
the stream, without Enter; input-cell/cursor/scrollback validation is retained.

Use `ux-run.py --unpaced --workloads latin,cjk,styled --samples 30` so both arms
retain real production scheduling. Private source-linked profiles/homes only;
compiled modules and observers are hashed before and after. Archive all attempts;
failures are not admitted or silently replaced. No builds or tests during live
collection. Whole turn ends at the final measured PTY receipt, not at provider EOF
or Screen return. Renderer/composition intervals, provider-await overlap and the
disjoint accounting split are independently verified. Provider await includes
adapter, scheduling and local rendering overlap, not just remote inference.

Report per-cell n, median, p95, p99, sample SD/variance, output/chunk/token volumes,
renderer-only and provider-await separately, exact producing/received byte lengths
and SHA-256, observed first-content/input delay and paired intervals. Quantiles
interpolate at `(n−1)p`; n=30 p99 is near a maximum, not a stable population tail.
Independent replies and a single host do not establish a causal latency gain.

## Quota-free frozen byte partition

Source: unchanged `results/frozen-20261017/{raw.jsonl.gz,pty.tar.gz}`; historical
stock `8b91e0e`, candidate `43f0ff0`. These are not current-head live measurements.
`byte-classes.py` verifies admission and SHA-256 before classifying each original
Screen byte span. It streams records and spools PTY members to bound RAM.

Disjoint classes within each Screen method: printable UTF-8, CR/LF, SGR, erase,
synchronized-output brackets, cursor/other sequences. Commit printable bytes are
further divided at original clear-line row boundaries into newly committed rows
and repeated live rows. Model text/reasoning UTF-8 is a separate denominator,
not a subset of emitted bytes; repeated text and chrome are real printable bytes.
Component medians need not sum to the median total. Detailed distributions,
per-turn partitions and original input hashes are in
`results/byte-headroom-304/frozen-byte-classes.json`.

Per-turn medians (bytes):

| Workload | Arm | n | Active total | Commit total | New commit printable | Commit live repaint printable | setLive printable |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Latin | historical stock | 69 | 170,602 | 39,956 | 3,060 | 26,401 | 93,448 |
| Latin | historical candidate | 70 | 63,999 | 39,909 | 3,076 | 26,444 | 11,630 |
| CJK | historical stock | 84 | 221,268 | 41,042 | 3,524 | 27,014 | 129,698 |
| CJK | historical candidate | 84 | 73,986 | 41,044 | 3,570 | 27,028 | 15,684 |
| Styled | historical stock | 69 | 447,056 | 49,820 | 4,513 | 30,677 | 284,033 |
| Styled | historical candidate | 69 | 155,359 | 49,220 | 4,518 | 30,271 | 63,288 |

All-method byte classes, medians stock → candidate:

| Workload | Printable | SGR | Cursor/other | Erase | Sync brackets | CR/LF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Latin | 123,842 → 41,272 | 32,113 → 12,740 | 4,676 → 4,094 | 4,896 → 1,918 | 2,672 → 2,608 | 2,106 → 869 |
| CJK | 160,942 → 46,961 | 41,693 → 14,364 | 6,104 → 5,578 | 6,342 → 2,188 | 3,488 → 3,592 | 2,733 → 1,001 |
| Styled | 319,853 → 95,890 | 89,575 → 34,519 | 12,208 → 10,372 | 12,904 → 4,720 | 6,976 → 6,640 | 5,580 → 2,137 |

Styled remains exploratory from the abandoned confirmatory workload. Unequal n
and original arm identities are preserved; the unmatched Latin candidate is not
discarded. The detailed JSON also gives raw model text/reasoning UTF-8 bytes.

The largest apparent encoding class was repeated spaces plus horizontal border
runs: about 18–20 KB/turn in commits and 3.5–30.9 KB/turn in setLive. **Reject the
border variant:** xterm parity passed, but actual tmux 3.3a failed Unicode REP.
The final candidate compresses ASCII spaces only; Unicode borders stay literal.
The smaller retained per-turn median opportunity is:

| Workload | Commit padding bytes | setLive padding bytes |
| --- | ---: | ---: |
| latin | 2,304 | 494 |
| cjk | 2,304 | 558 |
| styled | 2,496 | 4,014 |

This is an encoding-only opportunity, not scheduler replay or predicted live
savings. No incremental writes are removed or reordered. General commit
suppression, moving old terminal rows or delaying commits were not introduced:
those would change the lifecycle/scrollback contract for a much larger experiment.

## One-factor implementation and parity

`Screen` encodes already-wrapped rows only at its terminal sink. Seven or more
identical ASCII spaces use one literal seed, REP for the interior, then a
literal last glyph. No cursor motion, erase, commit timing, row contents, SGR
reset or scheduler ownership changes. Unicode borders and other characters remain literal. The original rows remain the
frame-equality/damage baseline; encoded strings are cached for only the current
frame and reused by synchronous commit repaints. Other glyphs, short runs and
rows with controls other than recognized SGR retain the literal path. No package
API, dependency, formatter or golden is changed.

The final literal glyph matters: a bare REP clears xterm's preceding-character
state and loses a following combining mark. An initial prototype failed that
regression and was corrected before any live collection. A deliberate off-by-one
REP count causes named cell/scrollback, encoding and combining-mark tests to fail;
the source is restored. Tests cover padding/borders, unchanged-frame skips,
commit repaint encoding, explicit/hidden cursor, right margin, styles/background,
scrollback and unknown/incomplete escape payloads.

ECMA-48 REP is an additional terminal output primitive. Emulator and tmux coverage
are evidence for the tested implementations, not a claim that every terminal
implements REP correctly. Physical display timing is not measured.

## Offline verification

- Six frozen traces (two per workload), **1,636 operations**: baseline versus
  candidate full buffer cells, attributes, wrap flags and cursor match after
  every reconstructed operation. Final padding-only emitted bytes fall 3.8–4.7%; this is deterministic
  Screen evidence, not a live latency claim. See `screen-replay.json`.
- Final focused Screen/rendered/streaming tests: 73 passed. Deliberate count fault: three named failures;
  bare-REP combining fault also reproduced and restored.
- Build, typecheck, bilingual docs pairing pass. Initial full suite (before
  narrowing Unicode compression back to literal borders): 5,550 passed,
  26 skipped, three launcher prerequisite failures. All three reproduce at
  unchanged baseline: local `/usr/bin/pnpm` violates those tests' assumption
  that `/bin:/usr/bin` contains no pnpm. No unrelated launcher change is made.
- Stock and candidate unmodified tmux acceptance both fail during daemon startup,
  before the fixture runs, on this host's tmux 3.3a. The failure is isolated to `set -g window-size manual` before session creation.
  A private harness copy omitting that one setting passes **18/18** checks,
  including actual Unicode border cells and REP-space placement. The rejected
  Unicode-REP variant fails the border check in that same harness. No host
  configuration or repository acceptance rule is weakened; the repository
  fixture gains the two REP-specific checks.

## Live results

Not collected yet. The protocol above is fixed before collection.
