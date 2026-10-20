---
"@slate/web": patch
---

The API skill zip's markdown can no longer be broken by a value from the
OpenAPI document. A table cell doubles every backslash before it escapes a pipe,
so a description ending in `\`, or holding a `\|` of its own, can no longer turn
the escape back into a real pipe and split the row; it also joins its lines on
any line ending, a lone CR included. Parameter names, their `in` and body field
names go through the same cell escaping. An inline code span uses a fence longer
than any run of backticks in its value and shows a line ending in the value as a
space, so neither can end the span, its heading or its line early. Both helpers
now live in one place and also cover the route and version cells of `SKILL.md`.
For today's document the five files in the zip are byte for byte the same. This
clears the CodeQL `js/incomplete-sanitization` alert on the release PR (#240).
