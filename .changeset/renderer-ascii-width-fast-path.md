---
'@dshline/renderer': patch
---

Stop measuring printable ASCII through the Unicode width tables. Every
printable ASCII character already measured one column, but each one paid two
failing binary searches over the wide and zero-width ranges first. The width
primitive now answers space through `~` directly and consults the tables only
past ASCII. Rendering is unchanged; the searches are gone.
