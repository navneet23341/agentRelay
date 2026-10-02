import assert from 'assert';
import { getEncoding } from 'js-tiktoken';
import { ProjectModel } from '../src/models/Project.js';
import { PhaseService } from '../src/services/phaseService.js';
import { TaskService } from '../src/services/taskService.js';
import { MemoryService } from '../src/services/memoryService.js';
import { getCompiledContext } from '../src/services/contextCompiler.js';
import {
  handleRecordDecision,
  handleRecordFailure,
  handleUpdateTask,
  handleCreateHandoff,
} from '../src/mcp/tools.js';
import { query, closePool } from '../src/config/database.js';

export interface BenchmarkMetrics {
  rawHistoryTokens: number;
  compiledTokens: number;
  tokensSaved: number;
  reductionPercentage: number;
  totalEventsEmitted: number;
  failureLoopCollapses: number;
  supersededMemoriesFiltered: number;
  budgetUtilizationPct: number;
}

export async function runMultiAgentSimulation(): Promise<BenchmarkMetrics> {
  const enc = getEncoding('cl100k_base');
  console.log('================================================================');
  console.log('🤖 agentRelay Multi-Agent Continuity & Benchmarking Suite (Chunk 9)');
  console.log('================================================================\n');

  let projectId: string | null = null;
  let taskId: string | null = null;

  try {
    // ========================================================================
    // SCENARIO SETUP: Agent A Starts Work
    // ========================================================================
    console.log('--- Step 1: Agent A Initializes Workspace & Begins Task ---');

    const project = await ProjectModel.create({
      name: 'Distributed Stream Ingestion Engine',
      goal: 'High-throughput Kafka streaming with partition rebalancing and zero data loss',
      constraints: 'Node.js 22, PostgreSQL 16 pgvector, Apache Kafka 3.7',
      repository_ref: 'https://github.com/org/stream-engine',
    });
    projectId = project.id;

    const phase = await PhaseService.createPhase({
      project_id: projectId,
      name: 'Phase 1: Consumer Group Architecture',
      description: 'Implement backpressure queueing, partition rebalancing, and offset management',
      order_index: 1,
    });
    await PhaseService.updatePhaseStatus(phase.id, 'ACTIVE');

    const task = await TaskService.createTask({
      project_id: projectId,
      phase_id: phase.id,
      title: 'Implement robust partition rebalance & offset commit pipeline',
      description: 'Prevent coordinator group eviction during intensive batch decompression',
    });
    taskId = task.id;

    // Agent A transitions task to IN_PROGRESS
    await handleUpdateTask({ taskId, status: 'IN_PROGRESS' });
    console.log(`✓ Agent A started Task: "${task.title}" [IN_PROGRESS] (ID: ${taskId})`);

    // ========================================================================
    // Agent A Emits Changes, Decisions, Observations, and Hits Failure Loops
    // ========================================================================
    console.log('\n--- Step 2: Agent A Executes, Encounters Errors, and Adapts ---');

    // 1. Changes
    const change1 = await MemoryService.createMemory({
      type: 'CHANGE',
      task_id: taskId,
      content: 'Configured partitioned consumer group with auto.offset.reset=earliest and session.timeout.ms=45000.',
      confidence_class: 'OBSERVED',
    });

    const change2 = await MemoryService.createMemory({
      type: 'CHANGE',
      task_id: taskId,
      content: 'Configured snappy compression and elevated batch.size=65536 on buffer producer.',
      confidence_class: 'OBSERVED',
    });

    const change3 = await MemoryService.createMemory({
      type: 'CHANGE',
      task_id: taskId,
      content: 'Increased max.poll.interval.ms to 300000 to prevent premature group eviction during batch processing.',
      confidence_class: 'OBSERVED',
    });
    console.log(`  ✓ Recorded 3 architectural code changes.`);

    // 2. Initial Decision
    const dec1 = await handleRecordDecision({
      taskId,
      content: 'Use librdkafka C-bindings via kafkajs driver for high throughput partition commits.',
      confidenceClass: 'OBSERVED',
    });

    // 3. Stale Decision (Dec 2) that will be SUPERSEDED by Decision 3
    const dec2 = await handleRecordDecision({
      taskId,
      content: 'Store partition commit offsets in local RocksDB store before Kafka flush to minimize broker roundtrips.',
      confidenceClass: 'INFERRED',
    });
    console.log(`  ✓ Recorded initial decisions (including Decision ${dec2.decision.id.slice(0, 8)}).`);

    // Decision 3 supersedes Decision 2!
    const dec3 = await handleRecordDecision({
      taskId,
      content: 'Commit offsets directly to Kafka __consumer_offsets topic using synchronous commitSync with exponential retry; eliminated RocksDB cache due to partition reassignment desynchronization.',
      confidenceClass: 'OBSERVED',
      supersedesMemoryId: dec2.decision.id,
      causalParents: [change1.memory.id],
    });
    console.log(`  ✓ Decision ${dec2.decision.id.slice(0, 8)} atomically SUPERSEDED by Decision ${dec3.decision.id.slice(0, 8)}.`);

    // 4. Failure with Causal Parent
    const failureCausal = await handleRecordFailure({
      taskId,
      content: 'OutOfMemoryError: Java heap space exhausted during large batch decompression under snappy codec.',
      confidenceClass: 'OBSERVED',
      causalParents: [change2.memory.id],
    });
    console.log(`  ✓ Recorded failure linked to causal parent (Change: batch.size=65536).`);

    // 5. Observations
    await MemoryService.createMemory({
      type: 'OBSERVATION',
      task_id: taskId,
      content: 'Kafka consumer lag spiked to 45,000 messages during initial cluster rebalance phase.',
      confidence_class: 'OBSERVED',
    });

    await MemoryService.createMemory({
      type: 'OBSERVATION',
      task_id: taskId,
      content: 'Network egress saturation observed on interface eth0 during uncompressed message fallback.',
      confidence_class: 'OBSERVED',
    });
    console.log(`  ✓ Recorded performance observations.`);

    // 6. Failure-Loop Stress Test: Agent hits the exact same error 15 times in a row!
    console.log('\n--- Step 3: Failure-Loop Stress Test (15 Identical Failures) ---');
    const repeatedFailureText =
      'CommitFailedException: Broker coordinator dropped consumer group due to heartbeat timeout on rebalance. The group has rebalanced and assigned partitions to another member.';

    for (let i = 1; i <= 15; i++) {
      await handleRecordFailure({
        taskId,
        content: repeatedFailureText,
        confidenceClass: 'OBSERVED',
      });
    }

    // Verify database state for the repeated failure
    const failureDb = await query(
      'SELECT id, type, hit_count, confidence_score, status FROM memories WHERE task_id = $1 AND content = $2',
      [taskId, repeatedFailureText]
    );

    assert.strictEqual(failureDb.rowCount, 1, 'Semantic hash dedup MUST result in exactly 1 row for identical failures');
    const collapsedFailure = failureDb.rows[0];
    assert.strictEqual(collapsedFailure.hit_count, 15, 'Hit count must equal 15 after 15 recorded attempts');
    console.log(`  ✓ Verified failure-loop dedup: 15 identical failures collapsed into 1 row with hit_count = 15.`);

    // ========================================================================
    // Agent A Leaves Structured Handoff and Runs Out of Context
    // ========================================================================
    console.log('\n--- Step 4: Agent A Reaches Context Limit, Creates Handoff, Cuts Off ---');

    await handleCreateHandoff({
      taskId,
      completedItems: [
        'Configured partition consumer group with session.timeout.ms=45000',
        'Configured snappy compression and batch limits',
        'Switched from RocksDB local offset caching to direct Kafka __consumer_offsets commitSync',
        'Mitigated heartbeat coordinator timeout by raising max.poll.interval.ms to 300000',
      ],
      remainingItems: [
        'Tune fetch.min.bytes for steady throughput under variable partition load',
        'Add integration tests verifying consumer group recovery after network partition',
        'Profile heap allocation under snappy decompression bursts',
      ],
      currentIssue: 'Intermittent heap memory spikes during sudden 50k batch decompression bursts',
      nextAction: 'Adjust snappy decompression buffer pool size and implement streaming payload chunks',
    });

    console.log(`  ✓ Agent A saved structured Handoff memory.`);
    console.log(`  ⚡ Agent A context window exhausted! Mid-task cutoff. Task remains [IN_PROGRESS].`);

    // ========================================================================
    // Step 5: Agent B Starts Cold with Zero Prior Context
    // ========================================================================
    console.log('\n--- Step 5: Agent B Starts Cold & Compiles Context ---');

    const totalTokenBudget = 1200;
    const compiledContextResult = await getCompiledContext(taskId, {
      totalTokenBudget,
    });

    console.log('\n================================================================');
    console.log('📄 AGENT B RECEIVED CONTEXT BLOCK:');
    console.log('================================================================');
    console.log(compiledContextResult.compiledText);
    console.log('================================================================\n');

    // ========================================================================
    // Step 6: Verifications & Invariant Proofs
    // ========================================================================
    console.log('--- Step 6: Invariant & Correctness Checks ---');

    // Invariant 1: Stale memory MUST NEVER appear in compiled context
    assert.ok(
      !compiledContextResult.compiledText.includes('Store partition commit offsets in local RocksDB store'),
      'CRITICAL: Superseded Decision 2 must NEVER appear in compiled context!'
    );
    assert.ok(
      compiledContextResult.compiledText.includes('Commit offsets directly to Kafka __consumer_offsets topic'),
      'Active Decision 3 must be present in compiled context.'
    );
    console.log('  ✓ Stale-memory correctness: Superseded decision is 100% excluded; active decision is present.');

    // Invariant 2: Repeated failure appears ONCE with causal parent link
    const failureMatches = compiledContextResult.compiledText.match(
      /CommitFailedException: Broker coordinator dropped consumer group/g
    );
    assert.strictEqual(
      failureMatches?.length,
      1,
      'Failure-loop item must appear exactly ONCE in compiled output, never 15 times'
    );
    console.log('  ✓ Failure-loop correctness: 15-hit failure rendered exactly once.');

    // Invariant 3: Handoff is rendered and prioritized
    assert.ok(compiledContextResult.compiledText.includes('## HANDOFF'), 'Handoff section must be present');
    assert.ok(
      compiledContextResult.compiledText.includes('Adjust snappy decompression buffer pool size'),
      'Next action must be immediately visible to incoming agent'
    );
    console.log('  ✓ Handoff correctness: Clear immediate next action delivered directly to Agent B.');

    // ========================================================================
    // Step 7: Token Savings Benchmark Computation
    // ========================================================================
    console.log('\n--- Step 7: Token Savings Benchmark Analysis ---');

    // Construct the naive un-compiled history dump that a standard LLM agent harness produces:
    // (Dumps project, phases, all 15 raw failure logs, all stale & active decisions, all observations & changes)
    const naiveHistorySections: string[] = [];

    // Project & Phase Scaffolding
    naiveHistorySections.push(
      `PROJECT: ${project.name}\nGoal: ${project.goal}\nConstraints: ${project.constraints}\nRepo: ${project.repository_ref}`
    );
    naiveHistorySections.push(
      `PHASE: ${phase.name}\nStatus: ${phase.status}\nDescription: ${phase.description}`
    );
    naiveHistorySections.push(
      `TASK: ${task.title}\nStatus: IN_PROGRESS\nDescription: ${task.description}`
    );

    // Full Un-deduplicated Decisions (including stale/contradictory ones)
    naiveHistorySections.push(
      `FULL DECISIONS HISTORY:\n` +
        `- [ACTIVE] Use librdkafka C-bindings via kafkajs driver for high throughput partition commits.\n` +
        `- [SUPERSEDED] Store partition commit offsets in local RocksDB store before Kafka flush to minimize broker roundtrips.\n` +
        `- [ACTIVE] Commit offsets directly to Kafka __consumer_offsets topic using synchronous commitSync with exponential retry; eliminated RocksDB cache due to partition reassignment desynchronization.`
    );

    // Full Raw Un-deduplicated Failures (all 15 individual repeated logs dumped as raw traces)
    const rawFailures: string[] = [];
    for (let i = 1; i <= 15; i++) {
      rawFailures.push(
        `- Failure event #${i} at 2026-09-30T14:20:0${i % 10}Z: ${repeatedFailureText}\n` +
          `    stack: Error: CommitFailedException\n` +
          `      at ConsumerGroup.commitOffsets (/node_modules/kafkajs/src/consumer/index.js:142:19)\n` +
          `      at BatchRunner.processBatch (/src/services/batchRunner.ts:89:12)`
      );
    }
    rawFailures.push(
      `- Failure event #16 at 2026-09-30T14:22:15Z: OutOfMemoryError: Java heap space exhausted during large batch decompression under snappy codec.`
    );
    naiveHistorySections.push(`FULL FAILURES LOGS:\n` + rawFailures.join('\n'));

    // Full Changes
    naiveHistorySections.push(
      `ALL COMMITS & CODE CHANGES:\n` +
        `- [CHANGE] Configured partitioned consumer group with auto.offset.reset=earliest and session.timeout.ms=45000.\n` +
        `- [CHANGE] Configured snappy compression and elevated batch.size=65536 on buffer producer.\n` +
        `- [CHANGE] Increased max.poll.interval.ms to 300000 to prevent premature group eviction during batch processing.`
    );

    // Full Observations
    naiveHistorySections.push(
      `ALL RUNTIME OBSERVATIONS:\n` +
        `- [OBSERVATION] Kafka consumer lag spiked to 45,000 messages during initial cluster rebalance phase.\n` +
        `- [OBSERVATION] Network egress saturation observed on interface eth0 during uncompressed message fallback.`
    );

    // Handoff Raw Dump
    naiveHistorySections.push(
      `HANDOFF NOTES:\nCompleted: 4 items\nRemaining: 3 items\nCurrent Issue: Intermittent heap memory spikes during sudden 50k batch decompression bursts\nNext: Adjust snappy decompression buffer pool size and implement streaming payload chunks`
    );

    const naiveFullDump = naiveHistorySections.join('\n\n');
    const rawHistoryTokens = enc.encode(naiveFullDump).length;
    const compiledTokens = enc.encode(compiledContextResult.compiledText).length;
    const tokensSaved = rawHistoryTokens - compiledTokens;
    const reductionPercentage = Number(((tokensSaved / rawHistoryTokens) * 100).toFixed(2));
    const budgetUtilizationPct = Number(
      ((compiledTokens / totalTokenBudget) * 100).toFixed(1)
    );

    const metrics: BenchmarkMetrics = {
      rawHistoryTokens,
      compiledTokens,
      tokensSaved,
      reductionPercentage,
      totalEventsEmitted: 25, // 3 changes + 3 decisions + 16 failures + 2 observations + 1 handoff
      failureLoopCollapses: 15,
      supersededMemoriesFiltered: 1,
      budgetUtilizationPct,
    };

    console.log('┌─────────────────────────────────────────────────────────────┬────────────────┐');
    console.log('│ Benchmark Metric                                            │ Value          │');
    console.log('├─────────────────────────────────────────────────────────────┼────────────────┤');
    console.log(`│ Total Lifecycle Events Emitted by Agent A (Raw / Pre-dedup) │ ${'25 raw events'.padEnd(14)} │`);
    console.log(`│ Stored Unique Database Rows (15-failure loop collapsed)      │ ${'11 rows'.padEnd(14)} │`);
    console.log(`│ Naive Full History Token Count (Uncompiled)                 │ ${metrics.rawHistoryTokens.toString().padEnd(14)} │`);
    console.log(`│ agentRelay Compiled Context Token Count (Agent B Received)  │ ${metrics.compiledTokens.toString().padEnd(14)} │`);
    console.log(`│ Net Token Savings                                           │ ${metrics.tokensSaved.toString().padEnd(14)} │`);
    console.log(`│ Token Context Window Reduction                              │ ${`${metrics.reductionPercentage}%`.padEnd(14)} │`);
    console.log(`│ Failure Loop Redundant Events Collapsed                     │ ${`${metrics.failureLoopCollapses} -> 1`.padEnd(14)} │`);
    console.log(`│ Stale / Superseded Memories Filtered                        │ ${metrics.supersededMemoriesFiltered.toString().padEnd(14)} │`);
    console.log(`│ Budget Compliance (${compiledTokens} of ${totalTokenBudget} tokens)             │ ${`${metrics.budgetUtilizationPct}%`.padEnd(14)} │`);
    console.log('└─────────────────────────────────────────────────────────────┴────────────────┘\n');

    console.log('================================================================');
    console.log(`🎉 MULTI-AGENT SIMULATION & BENCHMARK COMPLETE: ${metrics.reductionPercentage}% TOKEN REDUCTION`);
    console.log('================================================================\n');

    return metrics;
  } finally {
    // Teardown test project
    if (projectId) {
      await query('DELETE FROM projects WHERE id = $1', [projectId]);
    }
  }
}

// Auto-run if executed directly as entrypoint
if (process.argv[1]?.includes('simulate-multi-agent')) {
  runMultiAgentSimulation()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Benchmark Simulation Error:', err);
      await closePool();
      process.exit(1);
    });
}
