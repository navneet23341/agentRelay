import assert from 'node:assert';
import {
  computeMemoryDecay,
  computeHitBoost,
  scoreMemory,
  DEFAULT_DECAY_CONFIG,
  DEFAULT_SCORING_CONFIG,
} from '../src/services/index.js';

function runDecayTests() {
  console.log('=== Context Compiler Decay Function Tests (Chunk 6 - Step 1) ===\n');

  const baseDate = new Date('2026-09-20T10:00:00Z');
  // 4 hours later
  const fourHoursLater = new Date('2026-09-20T14:00:00Z');
  // 24 hours later
  const oneDayLater = new Date('2026-09-21T10:00:00Z');

  // ------------------------------------------------------------------------
  // 1. DECISION and CHANGE never decay
  // ------------------------------------------------------------------------
  console.log('[Test 1/6] Testing zero decay for DECISION and CHANGE types...');

  const decisionMemory = {
    id: 'mem-dec-1',
    type: 'DECISION' as const,
    confidence_score: 1.0,
    created_at: baseDate,
    last_seen_at: baseDate,
    task_id: 'task-closed',
  };

  const changeMemory = {
    id: 'mem-chg-1',
    type: 'CHANGE' as const,
    confidence_score: 0.9,
    created_at: baseDate,
    last_seen_at: baseDate,
    task_id: 'task-closed',
  };

  // Even for closed tasks 30 days later, DECISION and CHANGE stay flat
  const thirtyDaysLater = new Date('2026-10-20T10:00:00Z');
  const decScore = computeMemoryDecay(decisionMemory, {
    taskStatus: 'COMPLETED',
    now: thirtyDaysLater,
  });
  const chgScore = computeMemoryDecay(changeMemory, {
    taskStatus: 'COMPLETED',
    now: thirtyDaysLater,
  });

  assert.strictEqual(decScore, 1.0, 'DECISION must never decay');
  assert.strictEqual(chgScore, 0.9, 'CHANGE must never decay');
  console.log('  ✓ DECISION and CHANGE maintain flat confidence_score indefinitely.');

  // ------------------------------------------------------------------------
  // 2. FAILURE and OBSERVATION decay for closed tasks
  // ------------------------------------------------------------------------
  console.log('\n[Test 2/6] Testing exponential decay on closed tasks (COMPLETED/FAILED/CANCELLED)...');

  const failureMemory = {
    id: 'mem-fail-1',
    type: 'FAILURE' as const,
    confidence_score: 1.0,
    created_at: baseDate,
    last_seen_at: baseDate,
    task_id: 'task-closed',
  };

  const observationMemory = {
    id: 'mem-obs-1',
    type: 'OBSERVATION' as const,
    confidence_score: 1.0,
    created_at: baseDate,
    last_seen_at: baseDate,
    task_id: 'task-closed',
  };

  // At 4h (1 half-life for FAILURE), FAILURE should drop to ~0.50
  const failScore4h = computeMemoryDecay(failureMemory, {
    taskStatus: 'COMPLETED',
    now: fourHoursLater,
  });
  assert.ok(
    Math.abs(failScore4h - 0.5) < 0.01,
    `FAILURE at 4h half-life should be ~0.50, got ${failScore4h}`
  );

  // At 24h (1 half-life for OBSERVATION), OBSERVATION should drop to ~0.50
  const obsScore24h = computeMemoryDecay(observationMemory, {
    taskStatus: 'FAILED',
    now: oneDayLater,
  });
  assert.ok(
    Math.abs(obsScore24h - 0.5) < 0.01,
    `OBSERVATION at 24h half-life should be ~0.50, got ${obsScore24h}`
  );
  console.log('  ✓ FAILURE decayed by 50% at 4h; OBSERVATION decayed by 50% at 24h.');

  // ------------------------------------------------------------------------
  // 3. last_seen_at decay anchor (recurring failure retains relevance)
  // ------------------------------------------------------------------------
  console.log('\n[Test 3/6] Testing last_seen_at as decay anchor for recurring events...');

  // Failure created 24h ago, but last seen 10 minutes ago (actively recurring)
  const recurringFailure = {
    id: 'mem-fail-rec',
    type: 'FAILURE' as const,
    confidence_score: 1.0,
    created_at: baseDate,
    last_seen_at: new Date('2026-09-21T09:50:00Z'), // 10 mins before oneDayLater
    task_id: 'task-closed',
  };

  const recurringScore = computeMemoryDecay(recurringFailure, {
    taskStatus: 'COMPLETED',
    now: oneDayLater,
  });

  // 10 minutes elapsed = 600s. e^(-4.81e-5 * 600) ~ 0.97
  assert.ok(
    recurringScore > 0.95,
    `Recurring failure seen 10m ago must retain >0.95 score, got ${recurringScore}`
  );
  console.log(`  ✓ Recurring failure seen 10m ago preserved high relevance (${recurringScore.toFixed(4)}) despite created_at 24h ago.`);

  // ------------------------------------------------------------------------
  // 4. Open task immunity (IN_PROGRESS and BLOCKED bypass decay)
  // ------------------------------------------------------------------------
  console.log('\n[Test 4/6] Testing open task immunity (IN_PROGRESS / BLOCKED)...');

  const inProgressScore = computeMemoryDecay(failureMemory, {
    taskStatus: 'IN_PROGRESS',
    now: oneDayLater, // 24h later
  });
  assert.strictEqual(
    inProgressScore,
    1.0,
    'IN_PROGRESS task memories must NOT decay even after 24h'
  );

  const blockedScore = computeMemoryDecay(failureMemory, {
    taskStatus: 'BLOCKED',
    now: oneDayLater,
  });
  assert.strictEqual(
    blockedScore,
    1.0,
    'BLOCKED task memories must NOT decay even after 24h'
  );
  console.log('  ✓ IN_PROGRESS and BLOCKED tasks are completely immune to decay across multi-hour/day gaps.');

  // ------------------------------------------------------------------------
  // 5. Fail-loud enforcement when taskStatus is omitted for task-linked memory
  // ------------------------------------------------------------------------
  console.log('\n[Test 5/6] Testing fail-loud enforcement when taskStatus is omitted...');

  assert.throws(
    () => {
      // Caller forgot to look up or provide taskStatus for a memory with task_id
      computeMemoryDecay(failureMemory, {} as any);
    },
    (err: any) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('Missing required taskStatus'));
      assert.ok(err.message.includes('task-closed'));
      return true;
    },
    'Must throw loud error if memory.task_id is non-null and taskStatus is not passed'
  );
  console.log('  ✓ Loudly rejected decay evaluation when taskStatus was omitted for a task-linked memory.');

  // ------------------------------------------------------------------------
  // 6. Unparented memories (task_id: null) decay normally without taskStatus
  // ------------------------------------------------------------------------
  console.log('\n[Test 6/6] Testing unparented memory (task_id: null) decay...');

  const unparentedFailure = {
    id: 'mem-unparented',
    type: 'FAILURE' as const,
    confidence_score: 1.0,
    created_at: baseDate,
    last_seen_at: baseDate,
    task_id: null,
  };

  const unparentedScore = computeMemoryDecay(unparentedFailure, {
    now: fourHoursLater,
  });
  assert.ok(
    Math.abs(unparentedScore - 0.5) < 0.01,
    `Unparented failure should decay normally to ~0.50 at 4h, got ${unparentedScore}`
  );
  console.log('  ✓ Unparented memory decays normally without requiring taskStatus.');

  // ------------------------------------------------------------------------
  // 7. Hit count boost calculation (capped at 1.5x)
  // ------------------------------------------------------------------------
  console.log('\n[Test 7/8] Testing computeHitBoost multiplier...');

  assert.strictEqual(computeHitBoost(1), 1.0, 'hit_count=1 must have 1.0x boost (no boost)');
  assert.strictEqual(computeHitBoost(2), 1.1, 'hit_count=2 must have 1.1x boost (+10%)');
  assert.strictEqual(computeHitBoost(4), 1.3, 'hit_count=4 must have 1.3x boost (+30%)');
  assert.strictEqual(computeHitBoost(6), 1.5, 'hit_count=6 must have 1.5x boost (+50% cap)');
  assert.strictEqual(computeHitBoost(20), 1.5, 'hit_count=20 must be capped at 1.5x');
  assert.strictEqual(computeHitBoost(0), 1.0, 'hit_count=0 must default gracefully to 1.0x');
  console.log('  ✓ computeHitBoost verified: hit_count 1=1.0x, 2=1.1x, 4=1.3x, 6+=1.5x cap.');

  // ------------------------------------------------------------------------
  // 8. Full scoring pipeline & worked examples validation
  // ------------------------------------------------------------------------
  console.log('\n[Test 8/8] Testing full scoreMemory pipeline and worked example ranking...');

  const eightHoursLater = new Date('2026-09-20T18:00:00Z');

  // Mem B: Active Blocker on IN_PROGRESS task (hit_count = 7)
  const memB = {
    id: 'mem-b',
    type: 'FAILURE' as const,
    confidence_score: 1.0,
    created_at: baseDate,
    last_seen_at: baseDate,
    hit_count: 7,
    task_id: 'task-in-progress',
  };

  // Mem A: Architectural Decision from COMPLETED task (hit_count = 1)
  const memA = {
    id: 'mem-a',
    type: 'DECISION' as const,
    confidence_score: 1.0,
    created_at: baseDate,
    last_seen_at: baseDate,
    hit_count: 1,
    task_id: 'task-completed-old',
  };

  // Mem D: Active Suggestion on IN_PROGRESS task (hit_count = 3, SUGGESTED = 0.3)
  const memD = {
    id: 'mem-d',
    type: 'OBSERVATION' as const,
    confidence_score: 0.3,
    created_at: baseDate,
    last_seen_at: baseDate,
    hit_count: 3,
    task_id: 'task-in-progress',
  };

  // Mem C: Stale One-off Failure from COMPLETED task 8h ago (hit_count = 1)
  const memC = {
    id: 'mem-c',
    type: 'FAILURE' as const,
    confidence_score: 1.0,
    created_at: baseDate,
    last_seen_at: baseDate,
    hit_count: 1,
    task_id: 'task-completed-old',
  };

  const scoreB = scoreMemory(memB, { taskStatus: 'IN_PROGRESS', now: eightHoursLater });
  const scoreA = scoreMemory(memA, { taskStatus: 'COMPLETED', now: eightHoursLater });
  const scoreD = scoreMemory(memD, { taskStatus: 'IN_PROGRESS', now: eightHoursLater });
  const scoreC = scoreMemory(memC, { taskStatus: 'COMPLETED', now: eightHoursLater });

  // Score B = 1.0 * 1.5 = 1.5
  assert.strictEqual(scoreB, 1.5);
  // Score A = 1.0 * 1.0 = 1.0
  assert.strictEqual(scoreA, 1.0);
  // Score D = 0.3 * 1.2 = 0.36
  assert.ok(Math.abs(scoreD - 0.36) < 0.001);
  // Score C = 0.25 * 1.0 = 0.25
  assert.ok(Math.abs(scoreC - 0.25) < 0.01);

  // Assert rank order: B > A > D > C
  const scores = [
    { name: 'Mem B', score: scoreB },
    { name: 'Mem A', score: scoreA },
    { name: 'Mem D', score: scoreD },
    { name: 'Mem C', score: scoreC },
  ];
  scores.sort((a, b) => b.score - a.score);

  assert.strictEqual(scores[0].name, 'Mem B');
  assert.strictEqual(scores[1].name, 'Mem A');
  assert.strictEqual(scores[2].name, 'Mem D');
  assert.strictEqual(scores[3].name, 'Mem C');

  console.log(`  ✓ Score ranking verified: Mem B (${scoreB}) > Mem A (${scoreA}) > Mem D (${scoreD.toFixed(3)}) > Mem C (${scoreC.toFixed(3)})`);

  console.log('\n======================================================');
  console.log('🎉 ALL STEP 1 & 2 DECAY AND SCORING TESTS PASSED!');
  console.log('======================================================\n');
}

async function runCompilerRetrievalTests() {
  console.log('=== Context Compiler Candidate Retrieval Tests (Chunk 6 - Step 3) ===\n');
  const { closePool, query } = await import('../src/config/database.js');
  const { ProjectModel } = await import('../src/models/index.js');
  const { PhaseService, TaskService, MemoryService, retrieveCandidateMemories } = await import(
    '../src/services/index.js'
  );

  let project: any;
  try {
    // ------------------------------------------------------------------------
    // Setup test hierarchy: 1 Project, 2 Phases, multiple Tasks
    // ------------------------------------------------------------------------
    project = await ProjectModel.create({
      name: 'Chunk 6 Compiler Retrieval Test Project',
      goal: 'Validate candidate memory filtering, scoring, and causal enrichment',
    });

    const phase1 = await PhaseService.createPhase({
      project_id: project.id,
      name: 'Phase 1: Active Execution',
      order_index: 1,
      status: 'ACTIVE',
    });

    const phase2 = await PhaseService.createPhase({
      project_id: project.id,
      name: 'Phase 2: Distant Future Phase',
      order_index: 2,
      status: 'PLANNED',
    });

    // Task 1: Target task (IN_PROGRESS in Phase 1)
    const targetTask = await TaskService.createTask({
      project_id: project.id,
      phase_id: phase1.id,
      title: 'Target Task: Core Feature',
    });
    await TaskService.updateTaskStatus(targetTask.id, 'IN_PROGRESS');

    // Task 2: Active sibling task (IN_PROGRESS in Phase 1)
    const activeSiblingTask = await TaskService.createTask({
      project_id: project.id,
      phase_id: phase1.id,
      title: 'Active Sibling Task',
    });
    await TaskService.updateTaskStatus(activeSiblingTask.id, 'IN_PROGRESS');

    // Task 3: Completed sibling task (COMPLETED in Phase 1)
    const completedSiblingTask = await TaskService.createTask({
      project_id: project.id,
      phase_id: phase1.id,
      title: 'Completed Sibling Task',
    });
    await TaskService.updateTaskStatus(completedSiblingTask.id, 'IN_PROGRESS');
    await TaskService.updateTaskStatus(completedSiblingTask.id, 'COMPLETED');

    // Task 4: Unrelated task in Phase 2 (IN_PROGRESS in Phase 2)
    const phase2Task = await TaskService.createTask({
      project_id: project.id,
      phase_id: phase2.id,
      title: 'Unrelated Task in Phase 2',
    });
    await TaskService.updateTaskStatus(phase2Task.id, 'IN_PROGRESS');

    console.log(`[Setup] Created project (${project.id}) with Phase 1, Phase 2, and 4 test tasks.\n`);

    // ------------------------------------------------------------------------
    // Seed memories
    // ------------------------------------------------------------------------
    // Root parent memory for causal lineage test
    const { memory: rootFailure } = await MemoryService.createMemory({
      type: 'FAILURE',
      content: 'Underlying network socket reset in driver',
      confidence_class: 'OBSERVED',
      task_id: targetTask.id,
    });

    // Target task decision citing the root failure
    const { memory: targetDecision } = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Use automatic exponential backoff for driver reconnection',
      confidence_class: 'OBSERVED',
      task_id: targetTask.id,
      causal_parents: [rootFailure.id],
    });

    // Phase 1 Decision on completed sibling task
    const { memory: phase1Decision } = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Chose PostgreSQL JSONB for unstructured schema attributes',
      confidence_class: 'OBSERVED',
      task_id: completedSiblingTask.id,
    });

    // Phase 1 Active Sibling Failure (should be included by pool 4)
    const { memory: activeSiblingFailure } = await MemoryService.createMemory({
      type: 'FAILURE',
      content: 'Port 5432 conflict during migration',
      confidence_class: 'OBSERVED',
      task_id: activeSiblingTask.id,
    });

    // Phase 1 Active Sibling Observation (should NOT be included by pool 4: FAILURE only!)
    const { memory: activeSiblingObservation } = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Node 20 CPU usage was 12%',
      confidence_class: 'OBSERVED',
      task_id: activeSiblingTask.id,
    });

    // Phase 1 Completed Sibling Failure (should NOT be included: task is COMPLETED, not open!)
    const { memory: closedSiblingFailure } = await MemoryService.createMemory({
      type: 'FAILURE',
      content: 'Old syntax error that was already resolved',
      confidence_class: 'OBSERVED',
      task_id: completedSiblingTask.id,
    });

    // Phase 2 Decision on Phase 2 Task (should NOT be included: wrong phase!)
    const { memory: phase2Decision } = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Phase 2 distant architectural decision',
      confidence_class: 'OBSERVED',
      task_id: phase2Task.id,
    });

    // Stale superseded memory in Phase 1 (should NOT be included: status != ACTIVE)
    const { memory: supersededMem } = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Temporary deprecated caching decision',
      confidence_class: 'OBSERVED',
      task_id: targetTask.id,
    });
    await MemoryService.supersedeMemory(supersededMem.id, targetDecision.id);

    // 12 CHANGE memories in Phase 1 (to test recentChangesLimit = 10 capping)
    const changeMemoryIds: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const { memory: chg } = await MemoryService.createMemory({
        type: 'CHANGE',
        content: `Applied migration change #${i}`,
        confidence_class: 'OBSERVED',
        task_id: completedSiblingTask.id,
      });
      changeMemoryIds.push(chg.id);
    }

    // ------------------------------------------------------------------------
    // 1. Test Candidate Scoping & Pool Filtering
    // ------------------------------------------------------------------------
    console.log('[Test 1/4] Testing candidate scoping and pool filtering...');
    const candidates = await retrieveCandidateMemories(targetTask.id);
    const candidateIds = new Set(candidates.map((c) => c.id));

    // Target task memories must be included
    assert.ok(candidateIds.has(rootFailure.id), 'Target task root failure must be retrieved');
    assert.ok(candidateIds.has(targetDecision.id), 'Target task decision must be retrieved');

    // Phase 1 decision on completed sibling task must be included
    assert.ok(candidateIds.has(phase1Decision.id), 'Phase 1 decision must be retrieved');

    // Active sibling failure must be included
    assert.ok(candidateIds.has(activeSiblingFailure.id), 'Active sibling failure must be retrieved');

    // Negative assertions:
    assert.ok(
      !candidateIds.has(activeSiblingObservation.id),
      'Active sibling non-failure (OBSERVATION) must NOT be retrieved (Pool 4 restricted to FAILURE)'
    );
    assert.ok(
      !candidateIds.has(closedSiblingFailure.id),
      'Failure from closed sibling task must NOT be retrieved'
    );
    assert.ok(
      !candidateIds.has(phase2Decision.id),
      'Decision from unrelated Phase 2 must NOT be retrieved'
    );
    assert.ok(
      !candidateIds.has(supersededMem.id),
      'Stale SUPERSEDED memory must NOT be retrieved'
    );
    console.log('  ✓ Scope filtering strictly enforced: unrelated phase, stale, and invalid sibling types excluded.');

    // ------------------------------------------------------------------------
    // 2. Test Recent Changes Cap (Fix 2)
    // ------------------------------------------------------------------------
    console.log('\n[Test 2/4] Testing recent changes limit (capped at 10)...');
    const retrievedChanges = candidates.filter((c) => c.type === 'CHANGE');
    assert.strictEqual(
      retrievedChanges.length,
      10,
      `Expected exactly 10 CHANGE memories, got ${retrievedChanges.length}`
    );
    // The two oldest changes (index 0 and 1) should have been omitted by the limit
    assert.ok(!candidateIds.has(changeMemoryIds[0]), 'Oldest change #1 must be omitted');
    assert.ok(!candidateIds.has(changeMemoryIds[1]), 'Second oldest change #2 must be omitted');
    assert.ok(candidateIds.has(changeMemoryIds[11]), 'Newest change #12 must be included');
    console.log('  ✓ Recent changes correctly capped to most recent 10.');

    // ------------------------------------------------------------------------
    // 3. Test Task Status Join & Scoring
    // ------------------------------------------------------------------------
    console.log('\n[Test 3/4] Testing task status join and non-null scoring values...');
    for (const cand of candidates) {
      assert.ok(cand.task_status !== undefined, `task_status must be present on memory ${cand.id}`);
      assert.ok(typeof cand.decayed_relevance === 'number', 'decayed_relevance must be a number');
      assert.ok(typeof cand.score === 'number', 'score must be a number');
      assert.ok(cand.score > 0, 'score must be positive');
    }

    // Verify ordering: score DESC
    for (let i = 0; i < candidates.length - 1; i++) {
      assert.ok(
        candidates[i].score >= candidates[i + 1].score,
        `Candidates must be sorted by score DESC (index ${i}: ${candidates[i].score} vs ${candidates[i + 1].score})`
      );
    }
    console.log('  ✓ Every candidate successfully joined with task_status and sorted by score DESC.');

    // ------------------------------------------------------------------------
    // 4. Test 1-Hop Causal Lineage Enrichment
    // ------------------------------------------------------------------------
    console.log('\n[Test 4/4] Testing 1-hop causal lineage enrichment...');
    const targetDecisionCand = candidates.find((c) => c.id === targetDecision.id);
    assert.ok(targetDecisionCand, 'Target decision must be among candidates');
    assert.ok(
      targetDecisionCand.causal_lineage && targetDecisionCand.causal_lineage.length > 0,
      'Target decision must have enriched causal_lineage'
    );
    assert.strictEqual(
      targetDecisionCand.causal_lineage[0].id,
      rootFailure.id,
      'Causal lineage must contain rootFailure as direct parent'
    );
    assert.strictEqual(
      targetDecisionCand.causal_lineage[0].depth,
      1,
      'Causal parent depth must be 1'
    );
    console.log('  ✓ 1-hop causal parents successfully enriched on top-scored memories.');

    console.log('\n======================================================');
    console.log('🎉 ALL STEP 3 COMPILER RETRIEVAL TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    if (project) {
      console.log('[Cleanup] Cleaning up test project...');
      await query('DELETE FROM projects WHERE id = $1', [project.id]);
      console.log('  ✓ Test project cleaned up.');
    }
    await closePool();
  }
}

async function main() {
  runDecayTests();
  await runCompilerRetrievalTests();
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

