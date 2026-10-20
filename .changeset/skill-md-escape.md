---
"@slate/web": patch
---

The API skill zip's markdown can no longer be broken by a value from the
OpenAPI document. A table cell doubles every backslash before it escapes a pipe,
so a description ending in `\`, or holding a `\|` of its own, can no longer turn
the escape back into a real pipe and split the row. An inline code span uses a
fence longer than any run of backticks in its value, so a backtick in a value no
longer closes it early. Both helpers now live in one place and also cover the
route and version cells of `SKILL.md`. For today's document the five files in
the zip are byte for byte the same. This clears the CodeQL
`js/incomplete-sanitization` alert on the release PR (#240).
