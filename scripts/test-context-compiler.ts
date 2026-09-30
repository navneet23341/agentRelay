import assert from 'node:assert';
import {
  computeMemoryDecay,
  computeHitBoost,
  scoreMemory,
  DEFAULT_DECAY_CONFIG,
  DEFAULT_SCORING_CONFIG,
  renderCandidateMemory,
  packCandidateMemories,
  getCompiledContext,
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

    // ------------------------------------------------------------------------
    // 5. Test HANDOFF Memory Exclusion from Candidate Pool
    // ------------------------------------------------------------------------
    console.log('\n[Test 5/5] Testing HANDOFF exclusion from candidate retrieval...');
    const targetHandoff = (
      await MemoryService.createMemory({
        type: 'HANDOFF',
        content: '# Direct Task Handoff\n\n## Next Action\nProceed to next milestone.',
        confidence_class: 'OBSERVED',
        confidence_score: 1.0,
        task_id: targetTask.id,
      })
    ).memory;

    const refreshedCandidates = await retrieveCandidateMemories(targetTask.id);

    assert.ok(
      !refreshedCandidates.some((c) => c.type === 'HANDOFF'),
      'No HANDOFF-type memory should ever enter the candidate memory pool'
    );
    assert.ok(
      !refreshedCandidates.some((c) => c.id === targetHandoff.id),
      'Target task handoff memory must be strictly excluded from candidate memories'
    );
    console.log('  ✓ HANDOFF memory strictly excluded from candidate retrieval pool.');

    console.log('\n======================================================');
    console.log('🎉 ALL STEP 3 COMPILER RETRIEVAL TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    if (project) {
      console.log('[Cleanup] Cleaning up test project...');
      await query('DELETE FROM projects WHERE id = $1', [project.id]);
      console.log('  ✓ Test project cleaned up.');
    }
  }
}

function runTokenPackingTests() {
  console.log('=== Context Compiler Token Packing Tests (Chunk 6 - Step 4) ===\n');

  // ------------------------------------------------------------------------
  // 1. Shared Causal Parent Deduplication Test
  // ------------------------------------------------------------------------
  console.log('[Test 1/2] Testing shared causal parent deduplication across candidates...');

  const sharedParent = {
    id: 'mem-parent-1',
    type: 'CHANGE' as const,
    confidence_class: 'OBSERVED' as const,
    confidence_score: 1.0,
    status: 'ACTIVE' as const,
    created_at: new Date('2026-09-20T10:00:00Z'),
    last_seen_at: new Date('2026-09-20T10:00:00Z'),
    task_id: 'task-1',
    semantic_hash: null,
    hit_count: 1,
    causal_parents: [],
    embedding: null,
    invalidated_at: null,
    invalidated_by: null,
    superseded_by: null,
    content: 'Updated Dockerfile base image to Alpine 3.20 without installing postgresql-contrib package.',
    depth: 1,
  };

  const candA: any = {
    id: 'mem-cand-A',
    type: 'FAILURE' as const,
    confidence_score: 0.95,
    score: 1.4,
    content: 'Migration 003 failed due to pgvector extension missing in container environment.',
    causal_parents: [sharedParent.id],
    causal_lineage: [sharedParent],
    created_at: new Date('2026-09-20T11:00:00Z'),
  };

  const candB: any = {
    id: 'mem-cand-B',
    type: 'FAILURE' as const,
    confidence_score: 0.90,
    score: 1.2,
    content: 'pg_dump backup job failed because pgvector types were not recognized by CLI tool.',
    causal_parents: [sharedParent.id],
    causal_lineage: [sharedParent],
    created_at: new Date('2026-09-20T11:30:00Z'),
  };

  // Pack with sufficient budget (200 tokens)
  const sharedParentResult = packCandidateMemories([candA, candB], 200);

  assert.strictEqual(sharedParentResult.packed.length, 2, 'Both candidates must be packed');

  // Candidate A (first encounter): full causal parent line rendered
  assert.ok(
    sharedParentResult.packed[0].rendered.includes(sharedParent.content),
    'First candidate must render full causal parent content'
  );
  assert.ok(
    sharedParentResult.packed[0].rendered.includes('↳ Caused by: [CHANGE] (Conf: 1.00):'),
    'First candidate must include formatted parent header'
  );

  // Candidate B (subsequent encounter): terse reference rendered
  assert.ok(
    sharedParentResult.packed[1].rendered.includes('↳ Caused by: [CHANGE] (see above)'),
    'Second candidate sharing parent must render terse reference "(see above)"'
  );
  assert.ok(
    !sharedParentResult.packed[1].rendered.includes(sharedParent.content),
    'Second candidate must NOT duplicate full causal parent content'
  );

  // Verify the shared parent content appears EXACTLY ONCE across the entire combined output
  const combinedOutput = sharedParentResult.packed.map((p) => p.rendered).join('\n');
  const parentContentOccurrences = combinedOutput.split(sharedParent.content).length - 1;
  assert.strictEqual(
    parentContentOccurrences,
    1,
    `Shared causal parent content must appear exactly once in final output, but appeared ${parentContentOccurrences} times`
  );

  // Verify token savings: Cand B token cost is smaller than Cand A
  assert.ok(
    sharedParentResult.packed[1].tokenCount < sharedParentResult.packed[0].tokenCount,
    'Second candidate must consume fewer tokens due to causal parent deduplication'
  );
  console.log('  ✓ Shared causal parent rendered in full once and tersely referenced as "(see above)" on second candidate.');
  console.log(`  ✓ Confirmed parent content appears exactly once across final output (saved ${sharedParentResult.packed[0].tokenCount - sharedParentResult.packed[1].tokenCount} tokens).`);

  // ------------------------------------------------------------------------
  // 2. Greedy Non-Halting Packing & Token-Counting Test (Fix 1 & Fix 2)
  // ------------------------------------------------------------------------
  console.log('\n[Test 2/2] Testing greedy non-halting scan with candidate skipping...');

  const candidates: any[] = [
    {
      id: 'mem-1',
      type: 'DECISION' as const,
      confidence_score: 1.0,
      score: 1.50,
      content: 'Adopt PostgreSQL with pgvector for relational task state, vector embeddings, and causal lineage graphs instead of a separate graph DB.',
      causal_lineage: [],
      created_at: new Date('2026-09-20T10:00:00Z'),
    },
    {
      id: 'mem-2',
      type: 'FAILURE' as const,
      confidence_score: 0.95,
      score: 1.35,
      content: 'Migration 003 failed due to pgvector extension missing in container environment.',
      causal_lineage: [sharedParent],
      created_at: new Date('2026-09-20T10:15:00Z'),
    },
    {
      id: 'mem-3',
      type: 'OBSERVATION' as const,
      confidence_score: 0.80,
      score: 1.15,
      content: 'Significant database connection pool exhaustion observed during parallel integration test runner execution across 8 worker threads; recommend tuning max_connections from 10 to 30 and lowering idle connection timeout to prevent socket leaks.',
      causal_lineage: [],
      created_at: new Date('2026-09-20T10:30:00Z'),
    },
    {
      id: 'mem-4',
      type: 'CHANGE' as const,
      confidence_score: 1.0,
      score: 1.00,
      content: 'Added composite index on memories(task_id, status, created_at).',
      causal_lineage: [],
      created_at: new Date('2026-09-20T10:45:00Z'),
    },
    {
      id: 'mem-5',
      type: 'DECISION' as const,
      confidence_score: 1.0,
      score: 0.90,
      content: 'Use UTC timestamps across all database models.',
      causal_lineage: [],
      created_at: new Date('2026-09-20T11:00:00Z'),
    },
  ];

  // Budget: 150 tokens
  // mem-1 = 37 tokens (fits, rem=113)
  // mem-2 = 62 tokens (fits, rem=51)
  // mem-3 = 53 tokens (53 > 51 -> skipped!)
  // mem-4 = 25 tokens (fits, rem=26)
  // mem-5 = 21 tokens (fits, rem=5)
  const result = packCandidateMemories(candidates, 150);

  assert.strictEqual(result.tokensUsed, 145, `Tokens used must be 145, got ${result.tokensUsed}`);
  assert.strictEqual(result.tokensRemaining, 5, `Tokens remaining must be 5, got ${result.tokensRemaining}`);
  assert.deepStrictEqual(
    result.packed.map((p) => p.memory.id),
    ['mem-1', 'mem-2', 'mem-4', 'mem-5'],
    'Must pack mem-1, mem-2, mem-4, and mem-5'
  );
  assert.strictEqual(result.skipped.length, 1, 'Exactly one candidate must be skipped');
  assert.strictEqual(result.skipped[0].memory.id, 'mem-3', 'mem-3 must be the skipped candidate');
  assert.ok(
    result.skipped[0].reason.includes('Exceeds remaining budget'),
    'Skipped reason must indicate budget exceeded'
  );

  console.log('  ✓ Greedy non-halting scan successfully skipped mem-3 (53 tokens > 51 remaining) and packed smaller mem-4 & mem-5.');

  console.log('\n======================================================');
  console.log('🎉 ALL STEP 4 TOKEN PACKING TESTS PASSED!');
  console.log('======================================================\n');
}

async function runEndToEndCompilerTests() {
  console.log('=== Context Compiler End-to-End Pipeline Tests (Chunk 6 - Step 5) ===\n');

  const { closePool, query } = await import('../src/config/database.js');
  const { ProjectModel } = await import('../src/models/index.js');
  const { PhaseService, TaskService, MemoryService, HandoffService } = await import(
    '../src/services/index.js'
  );

  let project: any;
  try {
    // ------------------------------------------------------------------------
    // 1. Setup real project hierarchy
    // ------------------------------------------------------------------------
    project = await ProjectModel.create({
      name: 'agentRelay Core (Chunk 6 E2E Test)',
      goal: 'Continuity layer for autonomous coding agents',
      constraints: 'PostgreSQL 16 with pgvector extension',
      repository_ref: 'https://github.com/org/agentrelay',
    });

    const priorPhase = await PhaseService.createPhase({
      project_id: project.id,
      name: 'Phase 1: Base Container Scaffolding',
      order_index: 1,
      status: 'COMPLETED',
    });

    const priorTask = await TaskService.createTask({
      project_id: project.id,
      phase_id: priorPhase.id,
      title: 'Initial Container Dockerfile Configuration',
    });
    await TaskService.updateTaskStatus(priorTask.id, 'IN_PROGRESS');
    await TaskService.updateTaskStatus(priorTask.id, 'COMPLETED');

    const phase = await PhaseService.createPhase({
      project_id: project.id,
      name: 'Phase 2: Context Compiler & Token Packing',
      description: 'Greedy token-budget packing with decay, causal deduplication, and block rendering',
      order_index: 2,
      status: 'ACTIVE',
    });

    const targetTask = await TaskService.createTask({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Wire greedy token packer into getCompiledContext',
      description: 'Ensure full rendered token cost counting and causal parent deduplication',
    });
    await TaskService.updateTaskStatus(targetTask.id, 'IN_PROGRESS');

    const siblingTask = await TaskService.createTask({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Database connection pool optimization',
    });
    await TaskService.updateTaskStatus(siblingTask.id, 'IN_PROGRESS');
    await TaskService.updateTaskStatus(siblingTask.id, 'BLOCKED');

    // ------------------------------------------------------------------------
    // 2. Create real memories in DB with causal parent relationships
    // ------------------------------------------------------------------------
    // Root causal change in prior phase (not in current phase candidate pool)
    const rootChange = (
      await MemoryService.createMemory({
        type: 'CHANGE',
        content: 'Updated Dockerfile base image to Alpine 3.20 without postgresql-contrib package.',
        confidence_class: 'OBSERVED',
        confidence_score: 1.0,
        task_id: priorTask.id,
      })
    ).memory;

    // Failure 1 (under target task) pointing to rootChange
    const failure1 = (
      await MemoryService.createMemory({
        type: 'FAILURE',
        content: 'Migration 003 failed: pgvector extension missing in alpine container environment.',
        confidence_class: 'OBSERVED',
        confidence_score: 1.0,
        task_id: targetTask.id,
        causal_parents: [rootChange.id],
      })
    ).memory;

    // Failure 2 (under sibling blocked task) pointing to SAME rootChange
    const failure2 = (
      await MemoryService.createMemory({
        type: 'FAILURE',
        content: 'pg_dump backup job failed: pgvector data types unrecognized by client binaries.',
        confidence_class: 'OBSERVED',
        confidence_score: 0.95,
        task_id: siblingTask.id,
        causal_parents: [rootChange.id],
      })
    ).memory;

    // Architectural Decision across phase
    const decision1 = (
      await MemoryService.createMemory({
        type: 'DECISION',
        content: 'Adopt PostgreSQL with pgvector for relational task state and vector embeddings instead of graph DB.',
        confidence_class: 'OBSERVED',
        confidence_score: 1.0,
        task_id: targetTask.id,
      })
    ).memory;

    // Recent change across phase
    const change2 = (
      await MemoryService.createMemory({
        type: 'CHANGE',
        content: 'Added composite B-Tree index on memories(task_id, status, created_at) to accelerate retrieval.',
        confidence_class: 'OBSERVED',
        confidence_score: 1.0,
        task_id: targetTask.id,
      })
    ).memory;

    // ------------------------------------------------------------------------
    // 3. Create real task-scoped handoff record
    // ------------------------------------------------------------------------
    const handoffData = {
      completedItems: [
        'Implemented candidate memory scoring with exponential decay and hit_count boost',
        'Implemented greedy non-halting candidate packing with cl100k_base tokenizer',
      ],
      remainingItems: [
        'Expose getCompiledContext via MCP server tools in Chunk 7',
        'Build CLI wrapper in Chunk 8',
      ],
      currentIssue: 'Ensure prompt tokens stay within tight context window budgets',
      nextAction: 'Verify end-to-end context compilation and prepare MCP tool schemas',
    };

    await HandoffService.createHandoff(targetTask.id, handoffData);

    // ------------------------------------------------------------------------
    // 4. Execute getCompiledContext E2E pipeline
    // ------------------------------------------------------------------------
    console.log('[E2E Test] Executing getCompiledContext pipeline on target task...');
    const result = await getCompiledContext(targetTask.id, {
      totalTokenBudget: 600,
      scratchpadReserveRatio: 0.20,
    });

    // ------------------------------------------------------------------------
    // 5. Assertions on Budget (Option a: scaffolding subtracted first, then 80/20)
    // ------------------------------------------------------------------------
    console.log('[E2E Test] Validating Option (a) budget breakdown...');
    assert.strictEqual(result.budget.totalBudget, 600, 'Total budget must be 600');
    assert.ok(result.budget.scaffoldingTokens > 0, 'Scaffolding tokens must be positive');

    const expectedAvailable = 600 - result.budget.scaffoldingTokens;
    const expectedReserve = Math.floor(expectedAvailable * 0.20);
    const expectedMemoryBudget = expectedAvailable - expectedReserve;

    assert.strictEqual(
      result.budget.scratchpadReserveTokens,
      expectedReserve,
      `Scratchpad reserve must be ${expectedReserve}`
    );
    assert.strictEqual(
      result.budget.memoryBudget,
      expectedMemoryBudget,
      `Memory budget must be ${expectedMemoryBudget}`
    );
    assert.ok(
      result.budget.memoryTokensUsed <= result.budget.memoryBudget,
      'Memory tokens used must not exceed memory budget'
    );
    assert.strictEqual(
      result.budget.memoryTokensRemaining,
      expectedMemoryBudget - result.budget.memoryTokensUsed,
      'Tokens remaining must match memory budget minus used'
    );
    assert.ok(
      result.budget.totalOutputTokens <= 600,
      'Total output tokens must stay strictly within total budget when budget is sufficient'
    );
    console.log(
      `  ✓ Option (a) Budget verified: Total=600, Scaffolding=${result.budget.scaffoldingTokens}, Reserve(20%)=${result.budget.scratchpadReserveTokens}, MemoryBudget(80%)=${result.budget.memoryBudget}, Used=${result.budget.memoryTokensUsed}, OutputTokens=${result.budget.totalOutputTokens}`
    );

    // ------------------------------------------------------------------------
    // 6. Assertions on Compiled Multi-Section Context Output
    // ------------------------------------------------------------------------
    console.log('\n[E2E Test] Validating block template sections and content...');
    const text = result.compiledText;

    // Check Section Headers
    assert.ok(text.includes('# PROJECT: agentRelay Core (Chunk 6 E2E Test)'), 'Must include PROJECT section');
    assert.ok(text.includes('Goal: Continuity layer for autonomous coding agents'), 'Must include Goal');
    assert.ok(text.includes('Constraints: PostgreSQL 16 with pgvector extension'), 'Must include Constraints');
    assert.ok(text.includes('## CURRENT PHASE: Phase 2: Context Compiler & Token Packing [ACTIVE]'), 'Must include CURRENT PHASE section');
    assert.ok(text.includes('## CURRENT TASK: Wire greedy token packer into getCompiledContext [IN_PROGRESS]'), 'Must include CURRENT TASK section');
    assert.ok(text.includes('## RELEVANT DECISIONS'), 'Must include RELEVANT DECISIONS section');
    assert.ok(text.includes('## RELEVANT FAILURES'), 'Must include RELEVANT FAILURES section');
    assert.ok(text.includes('## RECENT CHANGES'), 'Must include RECENT CHANGES section');
    assert.ok(text.includes('## HANDOFF'), 'Must include HANDOFF section');
    assert.ok(text.includes('## Completed Items'), 'Must include handoff completed items');
    assert.ok(text.includes('## Remaining Items'), 'Must include handoff remaining items');
    assert.ok(text.includes('## Next Action'), 'Must include handoff next action');
    console.log('  ✓ All 7 required sections (PROJECT, CURRENT PHASE, CURRENT TASK, RELEVANT DECISIONS, RELEVANT FAILURES, RECENT CHANGES, HANDOFF) present.');

    // ------------------------------------------------------------------------
    // 7. Assertions on Shared Causal Parent Deduplication in Live Pipeline
    // ------------------------------------------------------------------------
    console.log('\n[E2E Test] Validating shared causal parent deduplication in compiled output...');
    const parentMatches = text.split(rootChange.content).length - 1;
    assert.strictEqual(
      parentMatches,
      1,
      `Shared causal parent content must appear exactly once in the compiled output, found ${parentMatches}`
    );
    assert.ok(
      text.includes('↳ Caused by: [CHANGE] (see above)'),
      'Subsequent citation of shared parent must render terse reference "(see above)"'
    );
    console.log('  ✓ Shared causal parent rendered in full once and tersely referenced as "(see above)" for second citing failure.');

    // ------------------------------------------------------------------------
    // 8. Test Tiny Budget Overflow (Scaffolding exceeds totalTokenBudget)
    // ------------------------------------------------------------------------
    console.log('\n[E2E Test] Validating tiny totalTokenBudget overflow behavior...');
    const tinyBudget = 50; // Headers + handoff is ~170 tokens, far exceeding 50
    const tinyResult = await getCompiledContext(targetTask.id, {
      totalTokenBudget: tinyBudget,
      scratchpadReserveRatio: 0.20,
    });

    // Available budget clamps to 0
    assert.strictEqual(tinyResult.budget.memoryBudget, 0, 'Memory budget must clamp to 0');
    assert.strictEqual(tinyResult.budget.scratchpadReserveTokens, 0, 'Scratchpad reserve must be 0');
    assert.strictEqual(tinyResult.budget.memoryTokensUsed, 0, 'No memory tokens used');
    assert.strictEqual(tinyResult.packedMemories.length, 0, 'Zero memories packed');

    // Surfaced honestly: totalOutputTokens exceeds totalBudget without being hidden or clamped
    assert.ok(
      tinyResult.budget.totalOutputTokens > tinyResult.budget.totalBudget,
      `totalOutputTokens (${tinyResult.budget.totalOutputTokens}) must exceed totalBudget (${tinyResult.budget.totalBudget})`
    );
    assert.ok(
      tinyResult.budget.scaffoldingTokens > tinyResult.budget.totalBudget,
      `scaffoldingTokens (${tinyResult.budget.scaffoldingTokens}) must exceed totalBudget (${tinyResult.budget.totalBudget})`
    );
    assert.strictEqual(
      tinyResult.budget.totalOutputTokens,
      tinyResult.budget.scaffoldingTokens,
      'When zero memories pack, total output tokens must equal scaffolding tokens'
    );
    console.log(
      `  ✓ Correctly surfaced overflow honestly: TotalBudget=${tinyResult.budget.totalBudget}, Scaffolding=${tinyResult.budget.scaffoldingTokens}, OutputTokens=${tinyResult.budget.totalOutputTokens}, MemoryBudget=0, PackedCount=0.`
    );

    console.log('\n======================================================');
    console.log('--- COMPILED CONTEXT OUTPUT PREVIEW ---');
    console.log('======================================================');
    console.log(text);
    console.log('======================================================\n');

    console.log('======================================================');
    console.log('🎉 ALL STEP 5 END-TO-END CONTEXT COMPILER TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    if (project) {
      console.log('[Cleanup] Cleaning up E2E test project...');
      await query('DELETE FROM projects WHERE id = $1', [project.id]);
      console.log('  ✓ E2E test project cleaned up.');
    }
  }
}

async function main() {
  const { closePool } = await import('../src/config/database.js');
  try {
    runDecayTests();
    runTokenPackingTests();
    await runCompilerRetrievalTests();
    await runEndToEndCompilerTests();
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});



