---
'@dshline/dshline': patch
---

Wrap long question titles in the prompt, single-select, and multi-select overlays
instead of truncating them. A model-authored `ask_user_question` question now
stays readable to its last word, and an option-less question keeps its text when
the terminal is too small to draw the frame.
