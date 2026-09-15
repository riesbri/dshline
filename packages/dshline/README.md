# dshline

**A terminal-native frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

dshline is an in-process Harness presentation adapter, not a separate client or agent runtime. Finished output stays in the terminal's real scrollback while only a bounded live region is redrawn.

`Harness plugin → standard capability → dshline presentation adapter → native terminal UI`

Harness owns capabilities, state, runtime, and policy; dshline presents supported Harness capabilities natively in the terminal. It prefers generic capability contracts over provider-specific integrations, so a provider that participates in a supported Harness seam can share the same terminal presentation.

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline
dshline
```

The first run asks once before letting Harness create the `dshline` profile and install this package into it; `dshline --setup` does that install explicitly, for a script or a source checkout. `pnpm` has to be on your `PATH` for either, because the harness installs profile plugins with pnpm — `dshline` checks first and says so rather than leaving a half-made profile behind.

dshline supports one Harness generation at a time. If installation reports a dependency conflict, do not bypass it with `--force` or `--legacy-peer-deps`; see the repository's [installation guide](https://github.com/riesbri/dshline/blob/main/docs/install.md#harness-version-mismatch).

The presentation core is small and dependency-light; its renderer has no runtime dependencies and knows nothing about agents or providers.

For installation requirements, usage, architecture, security guidance, and the canonical roadmap, see the [dshline repository](https://github.com/riesbri/dshline).

## License

MIT
