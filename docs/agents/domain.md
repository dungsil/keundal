# Domain Docs

How engineering skills should utilize this repository's domain documentation when exploring the codebase.

## Read Before Exploring

- **`CONTEXT.md`** at repository root, or
- If **`CONTEXT-MAP.md`** exists at repository root — points to one `CONTEXT.md` per context. Read each file relevant to the subject.
- **`docs/adr/`** — Read ADRs relevant to the area you are about to work on. In multi-context repositories, also check `src/<context>/docs/adr/` for context-specific decisions.

If any of these files do not exist, **proceed quietly**. Do not point out their absence or suggest creating them in advance. The `/vibe-modeling` skill (invoked via `/vibe-plan` and `/vibe-refactor`) creates them just-in-time as terms or decisions are genuinely established.

## File Structure

Single-context repository (most repositories):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repository (when `CONTEXT-MAP.md` is at root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← System-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← Context-specific decisions
    └── billing/
```

## Using Glossary Vocabulary

When naming domain concepts in outputs (issue titles, refactor proposals, hypotheses, test names), use terms defined in `CONTEXT.md` as-is. Do not drift into synonyms that the glossary explicitly avoids.

Do not translate, transliterate, explain away, generalize, neutralize, or replace a term with a synonym, whether its form is Korean, English, or mixed. Protect narrower forms established by relevant ADRs or `docs/agents/` in the same way.

If a needed concept is not yet in the glossary, that is a signal — either you invented vocabulary the project does not use (rethink), or an actual gap exists (record in `/vibe-modeling`).

## Flagging ADR Conflicts

If an output contradicts an existing ADR, surface it explicitly rather than quietly overwriting:

> _Contradicts ADR-0007 (Event-sourced orders) — but worth reopening because..._
