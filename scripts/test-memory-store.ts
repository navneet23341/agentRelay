import assert from 'node:assert';
import { closePool, query } from '../src/config/database.js';
import {
  ProjectModel,
  PhaseModel,
  TaskModel,
} from '../src/models/index.js';
import {
  MemoryService,
  normalizeContent,
  computeSemanticHash,
} from '../src/services/index.js';

async function runMemoryStoreTests() {
  console.log('=== agentRelay Memory Store Core Tests (Chunk 2) ===\n');

  try {
    // ------------------------------------------------------------------------
    // 1. Normalization and Semantic Hashing Tests
    // ------------------------------------------------------------------------
    console.log('[Test 1/6] Testing content normalization & semantic hashing...');

    const failureA = `
      Error: connect ECONNREFUSED 127.0.0.1:5432
        at /home/mint/agentRelay/src/db.ts:42:15
        at pointer 0x7ffee1b0
        at 2026-09-22T01:15:00.123Z
        uuid: 12345678-1234-1234-1234-123456789abc
    `;

    const failureB = `
      Error: connect ECONNREFUSED 127.0.0.1:5432
        at /home/alice/agentRelay/src/db.ts:89:22
        at pointer 0x0000a12f
        at 2026-09-22 01:20:00Z
        uuid: 87654321-4321-4321-4321-cba987654321
    `;

    const normalizedA = normalizeContent(failureA, 'FAILURE');
    const normalizedB = normalizeContent(failureB, 'FAILURE');
    const hashA = computeSemanticHash(failureA, 'FAILURE');
    const hashB = computeSemanticHash(failureB, 'FAILURE');

    assert.strictEqual(normalizedA, normalizedB, 'Normalized outputs for identical failure root causes must match');
    assert.strictEqual(hashA, hashB, 'Semantic hashes for noisy failure instances must match');
    console.log('  ✓ Noisy failure traces normalized and hashed identically:');
    console.log(`    Hash: ${hashA}`);

    // Verify DECISION preserves numbers and code specifics
    const decisionText = 'Set max_connections = 50 and pool timeout to 5000ms';
    const normDecision = normalizeContent(decisionText, 'DECISION');
    assert.strictEqual(normDecision, 'set max_connections = 50 and pool timeout to 5000ms');
    console.log('  ✓ DECISION memory preserved numerical parameters correctly.');

    // ------------------------------------------------------------------------
    // 2. Setup Hierarchy (Project, Phase, Tasks)
    // ------------------------------------------------------------------------
    console.log('\n[Test 2/6] Creating test project hierarchy...');

    const project = await ProjectModel.create({
      name: 'Chunk 2 Test Project',
      goal: 'Validate Memory Store core',
    });

    const phase = await PhaseModel.create({
      project_id: project.id,
      name: 'Phase 1: Memory Validation',
      order_index: 1,
    });

    const task1 = await TaskModel.create({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Task 1: Testing Memory Dedup',
    });

    const task2 = await TaskModel.create({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Task 2: Independent Session Task',
    });

    console.log(`  ✓ Created test entities: Project=${project.id}, Phase=${phase.id}, Task1=${task1.id}, Task2=${task2.id}`);

    // ------------------------------------------------------------------------
    // 3. Dedup-on-write Tests within Task
    // ------------------------------------------------------------------------
    console.log('\n[Test 3/6] Testing semantic hash deduplication on write...');

    // First write to Task 1
    const write1 = await MemoryService.createMemory({
      type: 'FAILURE',
      content: failureA,
      confidence_class: 'OBSERVED',
      task_id: task1.id,
    });
    assert.strictEqual(write1.isDuplicate, false, 'First write must not be flagged as duplicate');
    assert.strictEqual(write1.memory.hit_count, 1, 'Initial hit_count must be 1');
    const firstMemoryId = write1.memory.id;
    console.log(`  ✓ First write succeeded (id: ${firstMemoryId}, hit_count: 1)`);

    // Second write to Task 1 with noisy failureB (same root cause)
    const write2 = await MemoryService.createMemory({
      type: 'FAILURE',
      content: failureB,
      confidence_class: 'OBSERVED',
      task_id: task1.id,
    });
    assert.strictEqual(write2.isDuplicate, true, 'Second write must be flagged as duplicate');
    assert.strictEqual(write2.memory.id, firstMemoryId, 'Duplicate write must return existing memory ID');
    assert.strictEqual(write2.memory.hit_count, 2, 'Duplicate write must increment hit_count to 2');
    console.log(`  ✓ Second write collapsed to same row (id: ${write2.memory.id}, hit_count: 2)`);

    // Third write to Task 2 (different task) -> must NOT dedup across different tasks
    const writeTask2 = await MemoryService.createMemory({
      type: 'FAILURE',
      content: failureA,
      confidence_class: 'OBSERVED',
      task_id: task2.id,
    });
    assert.strictEqual(writeTask2.isDuplicate, false, 'Write to different task must create a new row');
    assert.notStrictEqual(writeTask2.memory.id, firstMemoryId, 'Memory IDs across tasks must differ');
    assert.strictEqual(writeTask2.memory.hit_count, 1);
    console.log(`  ✓ Write to Task 2 created independent row (id: ${writeTask2.memory.id})`);

    // Invalidate the memory in Task 1, then write again -> must create new row because old is not ACTIVE
    await MemoryService.updateMemoryStatus(firstMemoryId, 'INVALIDATED', {
      invalidated_by: 'human_tester',
    });
    const invalidatedMem = await MemoryService.getMemoryById(firstMemoryId);
    assert.strictEqual(invalidatedMem?.status, 'INVALIDATED');
    assert.strictEqual(invalidatedMem?.invalidated_by, 'human_tester');
    assert.ok(invalidatedMem?.invalidated_at, 'invalidated_at must be populated');

    const writeAfterInvalidation = await MemoryService.createMemory({
      type: 'FAILURE',
      content: failureA,
      confidence_class: 'OBSERVED',
      task_id: task1.id,
    });
    assert.strictEqual(writeAfterInvalidation.isDuplicate, false, 'Write after invalidation must create new row');
    assert.notStrictEqual(writeAfterInvalidation.memory.id, firstMemoryId);
    console.log('  ✓ Invalidation correctly prevented old memory from intercepting new write');

    // ------------------------------------------------------------------------
    // 4. Concurrent Write Test (Race Condition Prevention)
    // ------------------------------------------------------------------------
    console.log('\n[Test 4/6] Testing concurrent createMemory writes (race condition prevention)...');

    const concurrentTask = await TaskModel.create({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Task for Concurrent Dedup Test',
    });

    const concurrentFailure = 'Fatal: out of memory during heap dump at runtime';

    // Fire two near-simultaneous writes for the exact same failure
    const [resA, resB] = await Promise.all([
      MemoryService.createMemory({
        type: 'FAILURE',
        content: concurrentFailure,
        confidence_class: 'OBSERVED',
        task_id: concurrentTask.id,
      }),
      MemoryService.createMemory({
        type: 'FAILURE',
        content: concurrentFailure,
        confidence_class: 'OBSERVED',
        task_id: concurrentTask.id,
      }),
    ]);

    // Check that both returned the exact same row ID
    assert.strictEqual(resA.memory.id, resB.memory.id, 'Concurrent writes must resolve to the exact same row ID');

    // Exactly one was the initial insert, the other was the dedup update
    const insertedCount = (resA.isDuplicate ? 0 : 1) + (resB.isDuplicate ? 0 : 1);
    const duplicateCount = (resA.isDuplicate ? 1 : 0) + (resB.isDuplicate ? 1 : 0);
    assert.strictEqual(insertedCount, 1, 'Exactly one write must be flagged as non-duplicate');
    assert.strictEqual(duplicateCount, 1, 'Exactly one write must be flagged as duplicate');

    // Query database directly to confirm exactly one row exists for this task and hit_count = 2
    const concurrentRows = await query(
      "SELECT * FROM memories WHERE task_id = $1 AND status = 'ACTIVE'",
      [concurrentTask.id]
    );
    assert.strictEqual(concurrentRows.rows.length, 1, 'Exactly one row must exist in the database');
    assert.strictEqual(concurrentRows.rows[0].hit_count, 2, 'Row hit_count must be exactly 2');
    console.log(`  ✓ Concurrent writes successfully resolved: exactly 1 row in DB with hit_count = 2 (id: ${concurrentRows.rows[0].id})`);

    // ------------------------------------------------------------------------
    // 5. Memory List & Filtering Tests
    // ------------------------------------------------------------------------
    console.log('\n[Test 5/6] Testing list and filter functionality...');

    // Create a DECISION memory
    const decisionMem = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Chose PostgreSQL over SQLite for vector operations',
      confidence_class: 'OBSERVED',
      confidence_score: 1.0,
      task_id: task1.id,
    });

    // Create a CHANGE memory
    const changeMem = await MemoryService.createMemory({
      type: 'CHANGE',
      content: 'Updated schema to include semantic_hash and hit_count',
      confidence_class: 'OBSERVED',
      confidence_score: 0.9,
      task_id: task1.id,
    });

    // Filter by taskId
    const task1Memories = await MemoryService.listMemories({ taskId: task1.id });
    assert.ok(task1Memories.length >= 3, 'Must return all memories for task1');

    // Filter by phaseId
    const phaseMemories = await MemoryService.listMemories({ phaseId: phase.id });
    assert.ok(phaseMemories.length >= 4, 'Must return all memories linked to phase via tasks');

    // Filter by type
    const decisionList = await MemoryService.listMemories({
      taskId: task1.id,
      type: 'DECISION',
    });
    assert.strictEqual(decisionList.length, 1);
    assert.strictEqual(decisionList[0].id, decisionMem.memory.id);

    // Filter by status array
    const activeMemories = await MemoryService.listMemories({
      taskId: task1.id,
      status: 'ACTIVE',
    });
    assert.ok(activeMemories.every((m) => m.status === 'ACTIVE'));
    console.log('  ✓ Filter by task_id, phase_id, type, and status passed.');

    // ------------------------------------------------------------------------
    // 6. Manual Supersession Tests
    // ------------------------------------------------------------------------
    console.log('\n[Test 6/6] Testing manual supersession...');

    // Create replacement decision
    const newDecisionMem = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Decided to use PostgreSQL with pgvector and node-pg-migrate',
      confidence_class: 'OBSERVED',
      confidence_score: 1.0,
      task_id: task1.id,
    });

    const supersedeResult = await MemoryService.supersedeMemory(
      decisionMem.memory.id,
      newDecisionMem.memory.id
    );

    assert.strictEqual(supersedeResult.oldMemory.status, 'SUPERSEDED');
    assert.strictEqual(supersedeResult.oldMemory.superseded_by, newDecisionMem.memory.id);

    const reFetchedOld = await MemoryService.getMemoryById(decisionMem.memory.id);
    assert.strictEqual(reFetchedOld?.status, 'SUPERSEDED');
    assert.strictEqual(reFetchedOld?.superseded_by, newDecisionMem.memory.id);
    console.log(`  ✓ Supersession complete: Old memory ${decisionMem.memory.id} superseded by ${newDecisionMem.memory.id}`);

    // Verify error when old memory does not exist
    await assert.rejects(
      async () => {
        await MemoryService.supersedeMemory(
          '00000000-0000-0000-0000-000000000000',
          newDecisionMem.memory.id
        );
      },
      /not found/,
      'Must reject if old memory does not exist'
    );
    console.log('  ✓ Error handling for missing memory in supersession verified.');

    // ------------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------------
    console.log('\n[Cleanup] Cleaning up test data...');
    await query('DELETE FROM projects WHERE id = $1', [project.id]);
    console.log('  ✓ Test project and cascading entities cleaned up.');

    console.log('\n=============================================');
    console.log('🎉 ALL CHUNK 2 MEMORY STORE TESTS PASSED!');
    console.log('=============================================\n');
  } catch (error) {
    console.error('\n❌ Chunk 2 test failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

runMemoryStoreTests();
