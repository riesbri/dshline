---
'@dshline/dshline': minor
---

Attach generic files to prompts with `/attach`.

`/attach <path>` stages any file — a log, a JSON trace, a PDF, a binary — for
the next ordinary prompt. The bytes are stored exactly as they are through
`ctx.attachments.saveFileStream()` and the model receives a durable file
handle; nothing is pasted into the prompt text, and dshline adds no file size
limit, extension list, parser, or cache of its own.

It is deliberately a different command from `/image`. `/image picture.png`
sends the picture as an image the model can see; `/attach picture.png` sends
the same file verbatim, as a file. `@path` remains a textual workspace
reference and never becomes an upload.

Staging order is message order. `/image a.png /attach trace.json /image b.png
/attach report.pdf` sends text, `a.png`, `trace.json`, `b.png`, and `report.pdf`
in that order, and one submission is all or nothing: either every intended
attachment is delivered, or nothing is sent and every draft stays staged.
Enter on an empty composer sends the attachments alone, with no fabricated
blank line.

Bytes are read through bounded `ctx.fs.readByteRange()` windows only when the
prompt is sent, and the file's `FsInfo.version` is compared around the stream
so a file rewritten mid-attachment is reported rather than sent. Transcripts
and resumed sessions render each durable file by name and size and read no
bytes while drawing history.

Registered Harness commands are not yet given staged files: the adopted command
contract admits a generic file only as an upload receipt produced by Harness's
own file-upload flow, which this frontend does not mount. Such an invocation is
refused with an explanation and every draft survives, rather than silently
omitting the files.
