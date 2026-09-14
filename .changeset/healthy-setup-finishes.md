---
'@dshline/dshline': patch
---

Let a healthy `/setup` finish at `✓ Ready.` instead of opening the action
picker. A manual `/setup` on a session that can already send now prints its
report and returns to the composer; `/model` and `/connect` remain the commands
for optional changes. A report with a warning — including a provider
configuration diagnostic — still gets the picker and its repair step, and the
step list no longer offers optional changes as if they were repairs. The way out
reads `Continue` rather than `Start the session`, because `/setup` can run
mid-session.
