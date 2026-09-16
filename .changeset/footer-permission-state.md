---
'@dshline/dshline': patch
---

Show the attached Session's effective Harness permission in the status line.

The footer previously had no persistent indication of what the current turn was
allowed to do. It now carries the `permissions` projection's raw `currentValue`
beside the model — a deployment-defined preset id, `auto`, or the derived
`custom` — read from the attachment's existing shared projection snapshot. A
`/permission <preset>` switch, an independent `sandbox/mode` or
`approval/policy` change, and a change in live preset availability (an added or
withdrawn `auto`) all repaint it live, with no restart or reattachment, and a
reopened Session shows the permission restored from its own log. The segment is
one opaque, escaped id with no inferred risk treatment, and it is omitted
entirely when the deployment composes no permission capability.
