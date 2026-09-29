# Native method-distillation orchestration — retired record

> **Retired.** This proposal described a possible Hakimi-native coordinator around AITP method distillation. It was never a current product capability, and it will not be implemented as part of Hakimi's retired AITP integration.

## Historical value

The proposal preserved a useful boundary: external Skill instructions own their method-review semantics, while product code should not claim a review, approval, publication, or recovery guarantee it cannot establish.

## Current boundary

Hakimi has no AITP coordinator, ledger adapter, automatic write, or special plugin path. Independently installed AITP Skills participate only through ordinary plugin discovery, system-prompt visibility, and the `Skill` tool. This record does not modify or describe a modification to an external AITP checkout.
