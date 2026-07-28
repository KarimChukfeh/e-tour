# Canonical V3 storage layout

`ETourStorage` is the sole owner of game-independent instance storage. Every
instance implementation and every delegatecall module inherits it. The
storage-free `ETourModuleGuard` may be inherited by modules after
`ETourStorage`; its immutable delegatecall sentinel consumes no storage slot.

## Layout

| Slot | Field | Notes |
| ---: | --- | --- |
| 0 | `ReentrancyGuard._status` | Inherited first for identical instance/module layout |
| 1 | `_initialized`, `factory` | Solidity-packed V2 fields |
| 2–6 | `creator`, module addresses | V2 order preserved |
| 7–16 | `tierConfig` | V2 struct layout preserved |
| 17–33 | `tournament` | V2 struct layout preserved |
| 34–40 | enrolled players, rounds, matches, timeouts, prizes, draws | V2 order preserved |
| 41–43 | entropy state, entropy nonce, payout reasons | V2 order preserved |
| 44 | `SESSION_REGISTRY` | First append-only V3 field |

The compiler comparison performed during this refactor found no semantic
label, slot, offset, or type-shape changes across the 20 V2 entries.
`SESSION_REGISTRY` is the only appended entry.

## Rules

- Never declare shared instance storage in `ETourInstance_Base` or a module.
- Never reorder fields or insert a field before the append-only V3 section.
- Add future game-independent state only after the current final field.
- Game-specific instance fields continue after canonical storage.
- Run `npm run storage:check` for every change.
- Update the reviewed baseline with `npm run storage:capture` only after
  inspecting the compiler output and confirming the change is intentional.
