---
'@dshline/dshline': minor
---

Expose DeepSeek Harness's first-party Cordis authoring skills in the standard preset while preserving Harness-native skill discovery and precedence.

The `standard` preset now also exposes the skills that ship inside
`@deepseek-ai/dsh-agent-preset`: `cordis-composition-reference`,
`editing-cordis-compositions`, and `cordis-plugin-development`. dshline's
shipped `standard` preset previously did not expose these package-owned skills
by default; a profile that had already mounted that directory itself already had
them, and this changes nothing for such a profile.

Upstream's own `standard` mounts `skill-filesystem` bare; only its `cordis`
(Creator) preset points that provider at the packaged directory. Upstream
Creator mounts those authoring skills *and* Creator capabilities such as
`tool-cordis` and Plugin Manager side by side, because its authoring workflow
needs both — `tool-cordis` does not load these skills. `skill-filesystem`
discovers them and `tool-skill` exposes and loads them; `tool-cordis` is a
separate inspection capability that some of those instructions refer to. dshline
wants the knowledge without the capability, so this is first-party skill
knowledge rather than Creator capability.

The skills are contributed by a **separate, dedicated** provider
(`skill-harness-authoring`), not by configuring the ordinary one. A second
instance of `@deepseek-ai/dsh-skill-filesystem` runs with
`includeDefaultRoots: false` and a `bundledSkillDir` pointing at the package's
own `skills/` directory, which is how the adopted Harness generation models
package-owned skills: `source: bundled`, `BUNDLED_SKILL_RANK` (600), and a
Host-trusted read that bypasses the workspace `ctx.fs`. Two consequences, both
intended:

- those skills rank **below** project and user skills, so a
  `cordis-composition-reference` of your own — in the project or in
  `~/.dsh/skills` — wins the name and only an unclaimed name resolves to the
  shipped copy;
- `/plugins` lists `skill-filesystem` and `skill-harness-authoring` as
  independent rows, so switching the latter off removes exactly these three and
  leaves every project and user skill in place. The deployment's own bundled
  channel (`$DSH_BUNDLED_SKILL_DIR`) stays on the ordinary provider and is
  untouched.

`/skills` labels the three `bundled`, which is the source Harness resolved
rather than a dshline category, and they are reachable by `/<skill-name>` and by
the model exactly like any other skill.

Nothing about skill ownership changes: the bodies are read from the installed
package, Harness still owns the files, discovery, precedence and loading, and
the next adopted generation's reworded or added skills arrive through the
Harness migration itself. Because all three are model-invocable, each new
`standard` session also receives their names and descriptions in Harness's
durable `<available_skills>` catalog — a few lines of context, not zero; the
full bodies load only on an explicit invocation or a skill-tool call.
`minimal` is unchanged, and `tool-cordis` / `cordis_inspect_*` and an enabled
`tool-plugin-manager` remain absent, so a packaged skill may describe an
operation this preset cannot perform. The bodies are not filtered to hide that.
