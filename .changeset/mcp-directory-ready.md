---
"@slate/api": patch
"@slate/web": patch
---

MCP tools ready for the Claude and ChatGPT connector directories:

- `reschedule_booking` is marked destructive (`destructiveHint: true`): it
  replaces the original booking with one under a new uid, so clients ask before
  running it, as they already do for `cancel_booking` and `decline_booking`.
  The web's tool list (API docs, "What an agent can do") shows it as destructive
  too.
- Tool descriptions, argument descriptions and the server instructions are
  descriptive: they say what a tool does, takes and changes, recommend
  confirming with the person before a booking or a destructive change instead of
  ordering it, and name sign-in next to API keys wherever both work.
- The server announces itself as `dcal`, and the protected-resource metadata
  (built-in and external modes) names the resource `dCal`.
- New `directory-review.spec.ts` pins the review rules: a title and all four
  hints on every tool, read-only exactly for tools that do not write, the
  destructive and open-world sets, and no imperative orders (ALWAYS, NEVER,
  MUST, IMPORTANT, Do NOT, "call this first", "ignore previous instructions")
  in any description, schema or the instructions.
