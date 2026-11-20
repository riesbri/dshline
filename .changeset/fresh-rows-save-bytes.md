---
"@dshline/renderer": patch
"@dshline/dshline": patch
---

Reuse unchanged live-row wrapping and repaint only damaged rows when the terminal width and live-region height are unchanged, reducing streaming CPU work and terminal output without delaying input or changing native scrollback.
