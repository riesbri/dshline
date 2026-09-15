---
'@dshline/dshline': patch
---

State both differentiators in the package description and README opening, before
the install command.

The old description — "Terminal-native frontend for the DeepSeek Harness plugin
ecosystem" — named the ecosystem but neither of the two things that distinguish
this frontend: finished output becomes ordinary terminal scrollback and is never
rewritten, and dshline consumes Harness capabilities in-process rather than
standing up a parallel agent runtime or state layer. npm and third-party DSH
directories reuse this string, so it is the one line many readers see.

Messaging and metadata only. The architecture, the Harness target, dependencies,
release configuration and every deeper document are unchanged; the deeper docs
already described the boundary correctly.
