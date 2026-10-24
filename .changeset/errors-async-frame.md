---
"@slate/shared": patch
---

Error reporting reads an unnamed async callback frame (`at async /app/dist/x.js:3:51`) as a file, so its path is reported relative to the app root instead of absolute, and such errors group the same on every machine. Stack parsing stops after the 50 frames it keeps, and the no-crypto fallback id is UUID-shaped.
