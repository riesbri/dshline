---
'@dshline/dshline': minor
---

Ask `ask_user_question` questions with the full Harness answer contract: multi-select questions present a bounded checkbox list (space toggles, enter confirms), every option question gains an `Other…` route into the existing single-line editor, and a question with no options is answered as free text instead of through a stand-in `OK` choice. Custom answers encode exactly as Harness defines them — replacing the selection for single-select, supplementing it for multi-select — and option-less answers arrive as `custom` text.
