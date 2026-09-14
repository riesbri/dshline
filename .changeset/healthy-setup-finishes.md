---
'@dshline/dshline': patch
---

Let a healthy `/setup` finish at `✓ Ready.` instead of opening the action
picker, and stop a warning with no interactive repair from forcing a one-item
picker. A manual `/setup` on a session that can already send now prints its
report and returns to the composer; a Harness generation mismatch or a profile
that mounts nothing to configure a provider stays in the report and closes with
its own line. A warning setup can repair — missing model, missing credential, no
active route, a provider configuration diagnostic — still opens the picker and
leads with that repair, and the step list no longer offers optional changes as
if they were repairs. `/model` and `/connect` remain the commands for optional
changes, and the way out reads `Continue` rather than `Start the session`,
because `/setup` can run mid-session.
