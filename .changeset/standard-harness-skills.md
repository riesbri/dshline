---
'@dshline/dshline': minor
---

Expose DeepSeek Harness's first-party Cordis authoring skills in the standard preset while preserving Harness-native skill discovery and precedence.

The `standard` preset now also mounts the skills that ship inside
`@deepseek-ai/dsh-agent-preset`: `cordis-composition-reference`,
`editing-cordis-compositions`, and `cordis-plugin-development`. A terminal
session previously had no way to reach them — upstream's own `standard` leaves
the `skill-filesystem` row bare, and only its `cordis` (Creator) preset points
the same provider at that directory, because upstream reaches the skills
through `tool-cordis`, which dshline does not mount. A skill is text the agent
can read rather than a capability it needs mounted, so exposing the knowledge
does not require the Creator tool set.

Nothing about skill ownership changes. The one change is a
`config.customSkillDirs` entry on the existing `skill-filesystem` row, using
the same resolution expression upstream's Creator preset uses, so the files are
read from the installed package: Harness still owns the skill bodies and their
versioning, the discovery, the precedence between roots, and the loading.
`includeDefaultRoots` stays at Harness's own default of `true`, so
`<project>/.dsh/skills`, `<project>/.agents/skills`, `~/.dsh/skills`, and
`~/.agents/skills` keep working and a project-local skill still outranks a
packaged one of the same name. `/skills` lists the packaged skills through the
existing catalog with the source `custom`; no name is hard-coded in the
interface, and no special-cased row is added. Because the bodies come from the
package, the next adopted Harness generation's reworded or added skills arrive
through the Harness migration itself.

This is first-party skill knowledge, not Creator capability. `tool-cordis`
(`cordis_inspect_list`, `cordis_inspect_query`) stays absent and
`tool-plugin-manager` stays disabled, so a packaged skill may describe an
operation this preset cannot perform. The skill text is Harness's and is shown
as written rather than trimmed to hide that. The `minimal` preset is unchanged
and gains no packaged root.
