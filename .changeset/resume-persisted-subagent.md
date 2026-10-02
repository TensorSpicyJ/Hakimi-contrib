---
"@bhjia-phys/hakimi": patch
---

Fix resuming a subagent after a session restart, which reported it as missing even though its history was preserved. A subagent removed while it was running now reports as stopped instead of failing with an internal error.
