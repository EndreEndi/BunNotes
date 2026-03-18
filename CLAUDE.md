# BunNotes — CLAUDE.md

## Memory Index Protocol (MANDATORY)
1. FIRST — call `list_all_memories()` to get the complete key directory
2. THEN — call `retrieve_memory(exact_key)` using the exact key from step 1
Only use `search_memories()` for content-based searches, NOT for key lookup.
