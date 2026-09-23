agentRelay — Unified Architecture & Build Plan

One-line definition: agentRelay is a continuity layer for coding agents. It stores project knowledge, decisions, failures, changes, and task state; manages staleness, confidence, and causal lineage between memories; and compiles a token-budgeted, deduplicated context so the next agent can continue work without rediscovering the project.

This document merges your original architecture (Project → Phases → Tasks → Memory → Context Compiler → Human-in-the-loop) with the four additions from the Gemini review (causal lineage, semantic-hash dedup, temporal decay, knapsack packing), resolves overlaps, and breaks the whole thing into buildable chunks.
1. What each layer contributed
Layer 	Contribution
Your architecture 	The skeleton: Project/Phase/Task hierarchy, Memory types (DECISION/FAILURE/CHANGE/OBSERVATION/HANDOFF), staleness via SUPERSEDED/INVALIDATED, confidence via OBSERVED/INFERRED/SUGGESTED, human approval gate, Context Compiler as a retrieval+ranking step, MCP as the agent interface.
Gemini's additions 	Mechanics for how the Memory Store and Context Compiler actually do their job at scale: causal graph links between memories, a dedup layer for repeated identical failures, exponential time-decay for volatile memory types, and a token-budgeted packing algorithm instead of "just rank and truncate."

None of these conflict — Gemini's additions are implementation detail for components you'd already named (MEMORY MANAGEMENT and CONTEXT COMPILER). The merge below keeps your naming and hierarchy as the source of truth and slots the new mechanics into the existing boxes rather than adding new top-level boxes.

One correction worth making explicit: the Python "knapsack" in the Gemini doc is actually a greedy fit (sort by score, add while it fits), not an optimal knapsack solve. That's fine and it's what you should actually build — true 0/1 knapsack is unnecessary complexity for this. Call it a "greedy token packer," not "knapsack," in your own docs/code so you're not overclaiming in interviews.
2. Unified system diagram

                         HUMAN
                (project direction, phase & suggestion approval)
                           │
                           ▼
                        PROJECT
              (name, goal, constraints, repository ref)
                           │
                           ▼
                         PHASES
                  (Phase 1, Phase 2, ...)
                           │
                           ▼
                    TASK / SUBTASKS
        (TODO, IN_PROGRESS, BLOCKED, COMPLETED, FAILED, CANCELLED)
                           │
                           ▼
                     CODING AGENT
             (reads context, works repo, emits events)
                           │
              ┌────────────┼────────────┐
              ▼            ▼             ▼
          DECISION      FAILURE       CHANGE / OBSERVATION
              │            │             │
              └────────────┼─────────────┘
                           ▼
                     MEMORY STORE
        (id, type, content, embedding, confidence,
         status, created_at, causal_parents, semantic_hash, hit_count)
                           │
                           ▼
                 SEMANTIC HASH COMPACTOR
     (hash incoming failure/observation text → if seen this
      task session, bump hit_count + last_seen, don't duplicate row)
                           │
                           ▼
                  MEMORY MANAGEMENT
       staleness (SUPERSEDED/INVALIDATED) · confidence
       (OBSERVED/INFERRED/SUGGESTED) · temporal decay for
       volatile types · causal graph (parent → child links)
                           │
                           ▼
                  CONTEXT COMPILER
     retrieve (structured filters + pgvector similarity)
     → drop stale/invalidated → score (confidence × decay ×
     hit_count boost) → traverse causal graph for cited
     memories → greedy pack into token budget → HANDOFF summary
                           │
                           ▼
                       NEXT AGENT
                  (via MCP tool calls)

Two invariants carried over unchanged from your design, because they're the actual thesis of the project:

    Repository = what exists. Memory = what happened and why. agentRelay never becomes a second source of truth for code.
    Human owns project direction and phase/suggestion approval. Agents can propose (TASK_SUGGESTION, status = PENDING_REVIEW, evidence = SUGGESTED); only the human promotes a suggestion to a real TODO task.

3. Merged data model
Project / Phase / Task

Unchanged from your design. Task gains no new fields from Gemini's additions — it's Memory that gets richer.
Memory (merged schema)

Memory
├── id
├── type              DECISION | FAILURE | CHANGE | OBSERVATION | HANDOFF
├── content            (text)
├── embedding           (vector, pgvector — for semantic retrieval)
├── confidence_class    OBSERVED | INFERRED | SUGGESTED
├── confidence_score    (derived numeric: 1.0 / 0.7 / 0.3, tunable)
├── status              ACTIVE | SUPERSEDED | INVALIDATED
├── created_at
├── invalidated_at / invalidated_by / superseded_by
├── task_id             (FK — which task produced this)
├── semantic_hash        NEW — hash of normalized content, for dedup
├── hit_count             NEW — default 1, incremented on hash collision
├── last_seen_at          NEW — updated on hash collision
└── causal_parents[]       NEW — IDs of memories that caused this one

Why hash + causal_parents are separate concerns, not the same feature: the hash catches identical repeated events (same failing test 15 times). Causal links capture distinct events that caused each other (a decision → a change → a different failure). Both are needed; they solve different noise problems.

Decay applies by type, not globally — this matches your own "structured vs. embedded" instinct from the project description:

    DECISION, CHANGE: no decay. Architectural facts don't go stale with time, only with supersession.
    OBSERVATION, FAILURE: decay applies. A stale terminal error from 4 days ago is noise once the code has moved on; use relevance = confidence_score × e^(−λt), with λ tuned per type (failures decay faster than observations, both faster than nothing).

4. Component breakdown (what to actually build in each box)
4.1 Memory Store

    CRUD for all memory types, Postgres-backed, pgvector column for embeddings.
    On write: compute semantic_hash (normalize whitespace/case, hash the error signature or normalized content — not a raw string hash of the whole message, since two failures with the same root cause rarely have byte-identical text). If a matching hash exists within the same task's active session, update hit_count/last_seen_at instead of inserting.
    On write: if content declares a supersession relationship (or the agent/CLI says "this replaces memory X"), set old row status = SUPERSEDED, superseded_by = new_id.

4.2 Causal Graph

    causal_parents is enough for v1 — you don't need a separate graph database. Store as an array/junction table in Postgres; traverse with a recursive CTE when the compiler needs lineage for a cited memory.
    Populated either explicitly (agent/CLI says "this failure followed from change X") or heuristically later (same task, temporal adjacency) — start explicit, add heuristics only if you have time.

4.3 Memory Management

    Staleness: unchanged from your design (SUPERSEDED/INVALIDATED).
    Confidence: unchanged (OBSERVED/INFERRED/SUGGESTED → numeric weight).
    Decay: new — computed at query time, not stored, so λ can be tuned without rewriting history.

4.4 Context Compiler

Pipeline, in order:

    Filter to status = ACTIVE and relevant to current task/phase.
    If a semantic query is given ("why did we choose X"), run pgvector similarity search; otherwise use structured filters (current task, current phase, recent N changes).
    Score each candidate: confidence_score × decay_factor(type, age) × (1 + 0.1 × min(hit_count, cap)).
    Pull in causal parents of top-scored items (1 hop) so cited memories have their "why" attached, budget permitting.
    Greedy-pack by score into the token budget (reserve ~20% of budget for the agent's own scratchpad/task description).
    Render as the HANDOFF-style block your original design already specified (PROJECT / CURRENT PHASE / CURRENT TASK / RELEVANT DECISIONS / RELEVANT FAILURES / RECENT CHANGES / HANDOFF).

4.5 MCP Server

Exposes the tools you already listed: get_project_state, get_current_task, search_memory, get_relevant_context, record_decision, record_failure, update_task, create_handoff. No changes needed from the merge — this is the stable interface regardless of internal scoring changes.
4.6 CLI

Unchanged from your plan: relay init, relay phase create, relay task create/start, relay memory add <type>, relay handoff create, relay context.
5. Build chunks (sequenced, not fixed to weeks — build to completion, not a calendar)

Chunk 1 — Foundation Project, Phase, Task, Memory models (including the new fields: semantic_hash, hit_count, causal_parents, embedding column). Postgres schema + migrations. No logic yet, just structure.

Chunk 2 — Memory Store core CRUD for all memory types. Semantic hash computation + dedup-on-write. Basic supersession (manual, via explicit superseded_by).

Chunk 3 — Task / Phase / Handoff lifecycle Task state machine (TODO→IN_PROGRESS→BLOCKED/COMPLETED/FAILED/CANCELLED). Handoff record creation tied to a task. Human approval gate for TASK_SUGGESTION.

Chunk 4 — Memory reliability Staleness (SUPERSEDED/INVALIDATED) fully wired through writes and reads. Confidence scoring. Causal graph storage + recursive-CTE traversal for "what caused this."

Chunk 5 — Retrieval pgvector integration, embedding generation on memory write, search_memory semantic query path. Structured retrieval path (by task/phase/type) as the non-embedded alternative, per your original "not everything needs vector search" instinct.

Chunk 6 — Context Compiler Decay function by memory type. Scoring pipeline (confidence × decay × hit_count boost). Greedy token-budget packer with the 80/20 reserve split. Causal-parent pull-in for top items. Render into the HANDOFF-format block.

Chunk 7 — MCP integration Wire all 8 tools to the above. This is the point where an actual coding agent can call in and get real output — treat this as your first end-to-end milestone.

Chunk 8 — CLI Thin wrapper over the same service layer MCP uses, so behavior never diverges between "agent calls it" and "you call it by hand."

Chunk 9 — Testing, benchmarking, polish Multi-agent simulation (script that plays Agent A doing work, cutting off, then Agent B calling relay context). Measure: token count of compiled context vs. naive full-history dump; time-to-first-code-change proxy. Failure-loop test (feed 15 identical failures, confirm hash dedup collapses them to one row with hit_count=15). Stale-memory test (supersede a decision, confirm compiler never surfaces the old one).
6. What's still genuinely open (worth deciding before Chunk 6, not before Chunk 1)

    λ (decay rate) per memory type — you won't know good values until you have real session data; start with rough guesses (failures decay over hours, observations over ~1 day) and make it a config value, not a constant.
    Hash normalization strategy — how aggressively to normalize failure text before hashing (strip file paths/line numbers? stack trace vs. message only?) determines whether real duplicate failures actually collapse. Worth a few manual test cases before trusting it.
    Token counting — decide early whether you're counting tokens with a real tokenizer (tiktoken-equivalent for Node) or a word-count heuristic; the packer's correctness depends on this being accurate, not approximate.

Everything else in both documents is consistent and ready to build against as-is.
We're starting Chunk 1 (Foundation) only. Don't touch anything past this chunk.

Scaffold a Node.js + Express project for agentRelay with:
- Postgres connection setup (assume local Postgres, use env vars for connection string)
- pgvector extension enabled in the schema
- Migration files (use whatever migration tool you think is standard for
  a Node/Postgres project — tell me your choice before generating them)
- Models/tables for: Project, Phase, Task, Memory

Memory table must include these exact fields:
id, type (DECISION|FAILURE|CHANGE|OBSERVATION|HANDOFF), content, embedding
(vector column), confidence_class (OBSERVED|INFERRED|SUGGESTED),
confidence_score, status (ACTIVE|SUPERSEDED|INVALIDATED), created_at,
invalidated_at, invalidated_by, superseded_by, task_id, semantic_hash,
hit_count, last_seen_at, causal_parents (array of memory ids).

No business logic yet — no dedup, no scoring, no compiler. Just clean
models, migrations, and a way to confirm the schema applies to a real
Postgres instance. Ask me before assuming anything not specified above.