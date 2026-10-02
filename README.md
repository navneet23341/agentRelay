# agentRelay

> **A continuity layer for autonomous coding agents.**  
> agentRelay solves context window exhaustion, cross-session amnesia, and redundant failure loops by compiling high-signal, causal-aware project memory into strict token budgets.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-teal.svg)](https://github.com/pgvector/pgvector)
[![MCP Compatible](https://img.shields.io/badge/MCP-1.31-purple.svg)](https://modelcontextprotocol.io/)

---

## 1. The Problem

Autonomous coding agents (e.g. Claude Code, Devin, Gemini CLI, Cursor) face fundamental limits when tackling multi-hour or multi-day software engineering tasks:

1. **Context Window Exhaustion & Amnesia**: As an agent performs research, runs tests, and edits files, raw logs and conversational history consume tens of thousands of prompt tokens. When the context window fills or a session times out, the incoming agent starts completely cold with zero memory of architectural reasoning.
2. **Naive History Dumps**: Simply dumping raw conversation logs or database tables into subsequent agent prompts blows through token budgets, slows down inference, and contaminates prompts with stale or contradictory decisions.
3. **Infinite Failure Loops**: When an agent hits a repeated build or runtime failure (e.g. coordinator timeout or missing package), un-deduplicated agents record dozens of identical error traces, wasting precious prompt space and hallucinating redundant fixes.
4. **Ungated Autonomous Drift**: Agents often spawn speculative background tasks or modify project scope without human-in-the-loop validation, leading to wasted compute on dead-end branches.

---

## 2. The Solution & Architecture

**agentRelay** acts as an externalized, persistent hippocampus and continuity orchestrator for AI agents.

Detailed architectural specifications and mathematical models are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
                                  ┌────────────────────────┐
                                  │   Human Developer /    │
                                  │   Incoming Agent B     │
                                  └──────────┬─────────────┘
                                             │
                       relay context <taskId>│ (or MCP get_relevant_context)
                                             ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          agentRelay Context Compiler                            │
│                                                                                 │
│   1. Retrieve Candidates: Filter ACTIVE task, phase & recent change memories    │
│   2. pgvector Semantic Search: Hybrid cosine similarity + metadata filtering   │
│   3. Scoring & Time Decay: confidence × decay(type, age) × hit_count_boost     │
│   4. Causal Lineage Enrichment: 1-hop causal parents attached to top memories   │
│   5. Deduplication & Caching: Shared causal parents rendered once               │
│   6. Greedy Token Packing: Non-halting scan fitting within 80% memory budget    │
│   7. Block Rendering: Render clean HANDOFF markdown block                       │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
   ┌───────────────────────────┐                   ┌───────────────────────────┐
   │ PostgreSQL 16 + pgvector  │                   │     MCP Stdio Server      │
   │ - Memories (Hashed & Dedup│                   │ - 8 standard tools        │
   │ - Tasks (State Machine)   │                   │ - Human-gated suggestions │
   │ - Phases & Projects       │                   │ - Atomic supersessions    │
   └───────────────────────────┘                   └───────────────────────────┘
```

### Core Components

1. **Memory Store with Semantic Hash Deduplication**:
   - Every memory has a deterministic semantic hash (`sha256(type + normalized_content)`).
   - Identical errors or observations collapse into a single row on write, bumping `hit_count` and updating `last_seen_at` rather than duplicating rows.
2. **Confidence Scoring & Memory Staleness**:
   - Explicit confidence levels: `OBSERVED` (1.0), `INFERRED` (0.7), `SUGGESTED` (0.3).
   - Atomic supersession: When a decision or architecture pattern changes, the old memory is atomically marked `SUPERSEDED` and linked via `superseded_by`, guaranteeing old decisions never pollute future contexts.
3. **Causal Lineage Graph**:
   - Memories can cite `causal_parents` (e.g. a `FAILURE` citing the `CHANGE` that caused it). The compiler pulls in 1-hop causal parents so incoming agents understand *why* an error occurred.
4. **Type-Specific Time Decay**:
   - `DECISION` and `CHANGE`: Flat relevance over time ($\lambda = 0.0$).
   - `FAILURE`: Half-life $\approx 4\text{ hours}$ on closed tasks; open tasks (`IN_PROGRESS`, `BLOCKED`) maintain relevance immunity.
   - `OBSERVATION`: Half-life $\approx 24\text{ hours}$.
   - Hit count multiplier: $1 + 0.1 \times \min(\max(\text{hit\_count} - 1, 0), 5)$, where $\text{hit\_count} = 1$ receives zero boost ($1.0\times$) and recurring findings scale up to $+50\%$ ($1.5\times$ cap for $\text{hit\_count} \ge 6$).
5. **Greedy Token Budget Packing**:
   - Token accounting uses `js-tiktoken` with OpenAI's `cl100k_base` BPE tokenizer.
   - Fixed scaffolding (Project, Phase, Task, Handoff) is accounted upfront; candidate memories are greedy-packed into the remaining 80% budget, reserving 20% for the incoming agent's scratchpad.

---

## 3. Real-World Benchmark Results

We benchmarked a multi-agent scenario simulating **Agent A** performing complex distributed systems engineering (configuring Kafka streaming, testing compression, hitting a repeated heartbeat timeout 15 times, altering decisions, and hitting context limits) followed by **Agent B** starting cold.

Benchmark script: [scripts/simulate-multi-agent.ts](scripts/simulate-multi-agent.ts).

```bash
$ npm run benchmark
```

### Benchmark Metrics

| Metric | Naive History Dump | agentRelay Compiled Context | Delta / Impact |
| :--- | :--- | :--- | :--- |
| **Lifecycle Events Emitted** | **25 raw events** (pre-dedup) | **11 stored database rows** | 15 repeated errors collapsed to 1 row (`hit_count = 15`) |
| **Prompt Token Cost** | **1,946 tokens** | **687 tokens** | **64.7% Token Reduction** |
| **Tokens Saved** | 0 tokens | **1,259 tokens** | Freed for agent reasoning |
| **Failure-Loop Redundancy** | 15 repeated traces | **1 consolidated trace** | **15 → 1 row collapse** (`hit_count = 15`) |
| **Stale Decision Leakage** | 1 contradictory decision | **0 stale decisions** | 100% filtered via `SUPERSEDED` state |
| **Causal Graph Context** | Disconnected logs | **Enriched lineage** | `↳ Caused by: [CHANGE] ...` automatically attached |
| **Budget Compliance** | Unbounded (overflows) | **57.3% of 1,200 budget** | Strict reserve for scratchpad |

> **Note on Event Count**: The 25 raw lifecycle events emitted by Agent A pre-deduplication comprise: 16 failure occurrences (1 unique causal failure + 15 occurrences of the repeated heartbeat timeout error), 3 decisions (2 active, 1 superseded), 3 architectural code changes, 2 runtime observations, and 1 handoff. agentRelay's semantic hash engine collapses the 15 identical failures into 1 row, yielding 11 unique database rows.

> **Takeaway**: agentRelay reduces prompt payload size by **64.7%** on a single task handoff while eliminating failure-loop noise and completely preventing contradictory instructions from reaching the next agent.

<details>
<summary><b>View Raw Benchmark Output (Click to Expand)</b> — also saved in <code>docs/benchmark-output.txt</code></summary>

```text
> agentrelay@0.1.0 benchmark
> tsx scripts/simulate-multi-agent.ts

================================================================
🤖 agentRelay Multi-Agent Continuity & Benchmarking Suite (Chunk 9)
================================================================

--- Step 1: Agent A Initializes Workspace & Begins Task ---
✓ Agent A started Task: "Implement robust partition rebalance & offset commit pipeline" [IN_PROGRESS] (ID: a3e5ae98-f7b5-442b-881b-51d3577466ac)

--- Step 2: Agent A Executes, Encounters Errors, and Adapts ---
  ✓ Recorded 3 architectural code changes.
  ✓ Recorded initial decisions (including Decision 50ca4183).
  ✓ Decision 50ca4183 atomically SUPERSEDED by Decision fd90c097.
  ✓ Recorded failure linked to causal parent (Change: batch.size=65536).
  ✓ Recorded performance observations.

--- Step 3: Failure-Loop Stress Test (15 Identical Failures) ---
  ✓ Verified failure-loop dedup: 15 identical failures collapsed into 1 row with hit_count = 15.

--- Step 4: Agent A Reaches Context Limit, Creates Handoff, Cuts Off ---
  ✓ Agent A saved structured Handoff memory.
  ⚡ Agent A context window exhausted! Mid-task cutoff. Task remains [IN_PROGRESS].

--- Step 5: Agent B Starts Cold & Compiles Context ---

================================================================
📄 AGENT B RECEIVED CONTEXT BLOCK:
================================================================
# PROJECT: Distributed Stream Ingestion Engine
Goal: High-throughput Kafka streaming with partition rebalancing and zero data loss
Constraints: Node.js 22, PostgreSQL 16 pgvector, Apache Kafka 3.7
Repository: https://github.com/org/stream-engine

## CURRENT PHASE: Phase 1: Consumer Group Architecture [ACTIVE]
Description: Implement backpressure queueing, partition rebalancing, and offset management

## CURRENT TASK: Implement robust partition rebalance & offset commit pipeline [IN_PROGRESS]
Description: Prevent coordinator group eviction during intensive batch decompression

## RELEVANT DECISIONS
- [DECISION] (Conf: 1.00): Commit offsets directly to Kafka __consumer_offsets topic using synchronous commitSync with exponential retry; eliminated RocksDB cache due to partition reassignment desynchronization.
  ↳ Caused by: [CHANGE] (Conf: 1.00): Configured partitioned consumer group with auto.offset.reset=earliest and session.timeout.ms=45000.
- [DECISION] (Conf: 1.00): Use librdkafka C-bindings via kafkajs driver for high throughput partition commits.

## RELEVANT FAILURES
- [FAILURE] (Conf: 1.00): CommitFailedException: Broker coordinator dropped consumer group due to heartbeat timeout on rebalance. The group has rebalanced and assigned partitions to another member.
- [FAILURE] (Conf: 1.00): OutOfMemoryError: Java heap space exhausted during large batch decompression under snappy codec.
  ↳ Caused by: [CHANGE] (Conf: 1.00): Configured snappy compression and elevated batch.size=65536 on buffer producer.

## RECENT CHANGES
- [CHANGE] (Conf: 1.00): Increased max.poll.interval.ms to 300000 to prevent premature group eviction during batch processing.
- [CHANGE] (Conf: 1.00): Configured snappy compression and elevated batch.size=65536 on buffer producer.
- [CHANGE] (Conf: 1.00): Configured partitioned consumer group with auto.offset.reset=earliest and session.timeout.ms=45000.

## RELEVANT OBSERVATIONS
- [OBSERVATION] (Conf: 1.00): Network egress saturation observed on interface eth0 during uncompressed message fallback.
- [OBSERVATION] (Conf: 1.00): Kafka consumer lag spiked to 45,000 messages during initial cluster rebalance phase.

## HANDOFF
# Task Handoff

## Completed Items
- [x] Configured partition consumer group with session.timeout.ms=45000
- [x] Configured snappy compression and batch limits
- [x] Switched from RocksDB local offset caching to direct Kafka __consumer_offsets commitSync
- [x] Mitigated heartbeat coordinator timeout by raising max.poll.interval.ms to 300000

## Remaining Items
- [ ] Tune fetch.min.bytes for steady throughput under variable partition load
- [ ] Add integration tests verifying consumer group recovery after network partition
- [ ] Profile heap allocation under snappy decompression bursts

## Current Issue
Intermittent heap memory spikes during sudden 50k batch decompression bursts

## Next Action
Adjust snappy decompression buffer pool size and implement streaming payload chunks
================================================================

--- Step 6: Invariant & Correctness Checks ---
  ✓ Stale-memory correctness: Superseded decision is 100% excluded; active decision is present.
  ✓ Failure-loop correctness: 15-hit failure rendered exactly once.
  ✓ Handoff correctness: Clear immediate next action delivered directly to Agent B.

--- Step 7: Token Savings Benchmark Analysis ---
┌─────────────────────────────────────────────────────────────┬────────────────┐
│ Benchmark Metric                                            │ Value          │
├─────────────────────────────────────────────────────────────┼────────────────┤
│ Total Lifecycle Events Emitted by Agent A (Raw / Pre-dedup) │ 25 raw events  │
│ Stored Unique Database Rows (15-failure loop collapsed)      │ 11 rows        │
│ Naive Full History Token Count (Uncompiled)                 │ 1946           │
│ agentRelay Compiled Context Token Count (Agent B Received)  │ 687            │
│ Net Token Savings                                           │ 1259           │
│ Token Context Window Reduction                              │ 64.7%          │
│ Failure Loop Redundant Events Collapsed                     │ 15 -> 1        │
│ Stale / Superseded Memories Filtered                        │ 1              │
│ Budget Compliance (687 of 1200 tokens)                      │ 57.3%          │
└─────────────────────────────────────────────────────────────┴────────────────┘

================================================================
🎉 MULTI-AGENT SIMULATION & BENCHMARK COMPLETE: 64.7% TOKEN REDUCTION
================================================================
```

Raw file output: [docs/benchmark-output.txt](docs/benchmark-output.txt)
</details>

---

## 4. Quick Start & Setup

### Prerequisites
- **Node.js** >= 20.x
- **PostgreSQL** 16+ with the **`pgvector`** extension installed:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  ```

### Installation

```bash
# Clone the repository
git clone https://github.com/navneet23341/agentRelay.git
cd agentRelay

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit DATABASE_URL in .env (defaults to postgresql://postgres:postgres@localhost:5432/agentrelay)

# Run database migrations
npm run migrate:up

# Verify schema and vector indexes
npm run db:verify
```

---

## 5. CLI Usage

The `relay` CLI is a thin wrapper calling the exact same service layer as the MCP tools.

### Workspace Setup & Task Creation

```bash
# Initialize project in current repository (writes .relay.json, adds .relay.local.json to .gitignore)
relay init "My Project" --goal "Autonomous microservice build"

# Create an execution phase
relay phase create "Phase 1: API Scaffolding" --order 1

# Create a task in the active project and phase
relay task create "Implement user authentication endpoints"

# Start the task (sets status to IN_PROGRESS and saves active task to .relay.local.json)
relay task start <taskId>
```

### Recording Memories

```bash
# Record an architectural decision
relay memory add decision "Use Argon2id for password hashing instead of bcrypt"

# Record a decision that supersedes a prior one
relay memory add decision "Switch to Ed25519 JWT signing keys" --supersedes <oldMemoryId>

# Record a failure or error
relay memory add failure "Database connection pool timeout under 500 concurrent requests"
```

### Handoff & Continuity

```bash
# Create structured task handoff before logging off or ending session
relay handoff create \
  -c "Implemented JWT validation middleware" \
  -c "Added password hashing tests" \
  -r "Configure refresh token rotation" \
  -i "PostgreSQL pool exhaustion under burst load" \
  -n "Tune connection pool max clients in database.ts"

# View the exact compiled context block that incoming agents will receive
relay context <taskId>
```

The output of `relay context` prints the exact markdown block received by downstream LLMs:

```markdown
# PROJECT: My Project
Goal: Autonomous microservice build

## CURRENT PHASE: Phase 1: API Scaffolding [ACTIVE]

## CURRENT TASK: Implement user authentication endpoints [IN_PROGRESS]

## RELEVANT DECISIONS
- [DECISION] (Conf: 1.00): Switch to Ed25519 JWT signing keys.
- [DECISION] (Conf: 1.00): Use Argon2id for password hashing instead of bcrypt.

## RELEVANT FAILURES
- [FAILURE] (Conf: 1.00): Database connection pool timeout under 500 concurrent requests.

## HANDOFF
# Task Handoff

## Completed Items
- [x] Implemented JWT validation middleware
- [x] Added password hashing tests

## Remaining Items
- [ ] Configure refresh token rotation

## Current Issue
PostgreSQL pool exhaustion under burst load

## Next Action
Tune connection pool max clients in database.ts
```

---

## 6. MCP Server Integration

agentRelay exposes 8 standard tools conforming to the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/):

| Tool | Purpose |
| :--- | :--- |
| `get_project_state` | Retrieve project goal, constraints, phase pipeline, and task status summary counts. |
| `get_current_task` | Inspect detailed task metadata, descriptions, and reopen status. |
| `search_memory` | Semantic vector search using cosine distance + structured metadata filters. |
| `get_relevant_context` | Execute the full Context Compiler pipeline and retrieve token-budgeted markdown block. |
| `record_decision` | Record decision memory with optional causal parents and atomic supersession. |
| `record_failure` | Record failure memory with semantic deduplication and hit-count tracking. |
| `update_task` | Transition task state (`TODO`, `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, `FAILED`, `CANCELLED`). |
| `create_handoff` | Publish structured handoff record scoped to active task. |

### Connecting to Claude Desktop / Cursor / AI IDEs

Add to your MCP configuration (`claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "agentrelay": {
      "command": "node",
      "args": ["/path/to/agentRelay/dist/src/mcp/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/agentrelay"
      }
    }
  }
}
```

---

## 7. Running Tests

agentRelay maintains 100% test pass rates across 9 comprehensive test suites:

```bash
# Run all test suites
npm test

# Run individual test suites
npm run db:verify         # Database schema, foreign keys & pgvector indexes
npm run test:memory       # Semantic hash deduplication and CRUD
npm run test:lifecycle    # Task state machine & transitions
npm run test:reliability  # Confidence scoring, supersession, causal graph CTEs
npm run test:retrieval    # pgvector embedding similarity & structured queries
npm run test:compiler     # Time decay, hit boost, greedy token packer
npm run test:mcp          # MCP server tool schemas & atomic rollbacks
npm run test:cli          # CLI subcommands & workspace config tests
npm run benchmark         # Multi-agent simulation & token reduction benchmark
```

---

## 8. License

MIT License. See [LICENSE](LICENSE) for details.

---

## 9. Real-World A/B Validation

Beyond the synthetic benchmark above, I ran a real-world A/B test using
two live coding agent sessions (OpenAI Codex CLI) building an identical
multi-chunk backend project — once without agentRelay (baseline) and
once with it connected via MCP.

**Setup:** Agent A built Chunks 1-3 of a project in one condition, hit
its session limit, and a fresh Agent B (new account, zero prior
context) continued with Chunks 4-6. Repeated identically in the
agentRelay condition, with agentRelay's MCP tools available to both
agents.

**Result: ~23% token reduction for Agent B's cold continuation**
(108,127 tokens baseline vs. 82,954 tokens with agentRelay) for
equivalent completed work — lower than the synthetic benchmark's 64.7%,
which tracks: real repositories have messier signal than a scripted
simulation, and this result reflects that honestly rather than
re-running until the number looked better.

**What I learned along the way (the useful part):**
- agentRelay's value is real but *not automatic* — in testing, the
  coding agent only reached for agentRelay's tools proactively when
  explicitly told to in the prompt. Left alone, it defaulted to
  re-reading source files, the same way it would without agentRelay at
  all. This is a known pattern with MCP tool adoption generally, not
  unique to this project, and the fix is onboarding, not architecture:
  an `AGENTS.md` convention file in the repo (which Codex and similar
  agents read automatically at session start) that tells the agent
  this project uses agentRelay and when to call it. Next step on my
  list.
- Recording memories has a real token cost, not just a retrieval
  benefit — the full picture is a trade: more expensive while an agent
  is actively working and writing memories, cheaper when the next
  agent picks up cold. Worth measuring both sides, not just the win.

I'd rather ship a documented, honest 23% with a clear next step than a
cherry-picked number — and figuring out *why* the real number differs
from the synthetic one taught me more about agent tool adoption than
the benchmark itself did.

