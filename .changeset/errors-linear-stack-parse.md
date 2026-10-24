---
"@slate/shared": patch
---

Error reporting reads a stack with string scans instead of two backtracking patterns, so a crafted stack costs time linear in its length (one took 38 s before). A fresh event or request id comes from `crypto.randomUUID`, else `crypto.getRandomValues`, never `Math.random`.
