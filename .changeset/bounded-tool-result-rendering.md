---
'@dshline/dshline': patch
---

Reduce large tool-result rendering allocations by selecting the card's raw head or tail lines before escaping and formatting them. Omitted lines are counted without materializing them, preserving existing card output, detail budgets, and exact elision counts.
