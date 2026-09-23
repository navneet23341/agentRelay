import assert from 'node:assert';
import { query, closePool } from '../src/config/database.js';
import { ProjectModel, TaskModel } from '../src/models/index.js';
import { MemoryService } from '../src/services/index.js';

async function runMemoryReliabilityTests() {
  console.log('=== agentRelay Memory Reliability & Causal Graph Tests (Chunk 4) ===\n');

  try {
    // ------------------------------------------------------------------------
    // Setup Test Project & Task
    // ------------------------------------------------------------------------
    const project = await ProjectModel.create({
      name: 'Chunk 4 Reliability Test Project',
      goal: 'Validate causal graph lineage, parent validation, confidence scoring, and staleness wiring',
    });
    const task = await TaskModel.create({
      project_id: project.id,
      title: 'Reliability and Causal Lineage Task',
      status: 'IN_PROGRESS',
    });
    console.log(`[Setup] Created test project (${project.id}) and task (${task.id})\n`);

    // ------------------------------------------------------------------------
    // 1. Confidence Scoring Auto-Derivation
    // ------------------------------------------------------------------------
    console.log('[Test 1/4] Testing confidence score auto-derivation from confidence_class...');

    const memObserved = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Direct observation of compiler behavior',
      confidence_class: 'OBSERVED',
      task_id: task.id,
    });
    assert.strictEqual(memObserved.memory.confidence_score, 1.0, 'OBSERVED must default to 1.0');
    console.log('  ✓ OBSERVED mapped to confidence_score = 1.0');

    const memInferred = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Inferred behavior from test logs',
      confidence_class: 'INFERRED',
      task_id: task.id,
    });
    assert.strictEqual(memInferred.memory.confidence_score, 0.7, 'INFERRED must default to 0.7');
    console.log('  ✓ INFERRED mapped to confidence_score = 0.7');

    const memSuggested = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Suggested optimization pattern',
      confidence_class: 'SUGGESTED',
      task_id: task.id,
    });
    assert.strictEqual(memSuggested.memory.confidence_score, 0.3, 'SUGGESTED must default to 0.3');
    console.log('  ✓ SUGGESTED mapped to confidence_score = 0.3');

    const memExplicit = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Memory with explicit confidence score override',
      confidence_class: 'SUGGESTED',
      confidence_score: 0.85,
      task_id: task.id,
    });
    assert.strictEqual(memExplicit.memory.confidence_score, 0.85, 'Explicit confidence score must be preserved');
    console.log('  ✓ Explicit confidence score override (0.85) preserved');

    // ------------------------------------------------------------------------
    // 2. Causal Parent Validation on Write
    // ------------------------------------------------------------------------
    console.log('\n[Test 2/4] Testing causal_parents validation on write...');

    const fakeParentId = 'a0000000-0000-0000-0000-000000000001';
    await assert.rejects(
      async () => {
        await MemoryService.createMemory({
          type: 'FAILURE',
          content: 'Failure linked to non-existent parent',
          confidence_class: 'OBSERVED',
          task_id: task.id,
          causal_parents: [fakeParentId],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Invalid causal_parents'));
        assert.ok(err.message.includes(fakeParentId));
        return true;
      },
      'Must reject memory creation when causal_parents do not exist in DB'
    );
    console.log('  ✓ Rejected write with non-existent causal parent ID');

    // Valid causal_parents write
    const validChild = await MemoryService.createMemory({
      type: 'FAILURE',
      content: 'Failure caused by prior decision',
      confidence_class: 'OBSERVED',
      task_id: task.id,
      causal_parents: [memObserved.memory.id],
    });
    assert.strictEqual(validChild.memory.causal_parents.length, 1);
    assert.strictEqual(validChild.memory.causal_parents[0], memObserved.memory.id);
    console.log('  ✓ Valid causal parent accepted and stored');

    // ------------------------------------------------------------------------
    // 3. Causal Graph Traversal via Recursive CTE
    // ------------------------------------------------------------------------
    console.log('\n[Test 3/4] Testing causal graph traversal (linear chain, diamond DAG, cycle guard, depth cap)...');

    // Linear chain: NodeA -> NodeB -> NodeC
    const nodeA = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Linear chain root: Decided on architecture A',
      confidence_class: 'OBSERVED',
      task_id: task.id,
    });
    const nodeB = await MemoryService.createMemory({
      type: 'CHANGE',
      content: 'Linear chain step: Applied change B following decision A',
      confidence_class: 'OBSERVED',
      task_id: task.id,
      causal_parents: [nodeA.memory.id],
    });
    const nodeC = await MemoryService.createMemory({
      type: 'FAILURE',
      content: 'Linear chain leaf: Failure C resulting from change B',
      confidence_class: 'OBSERVED',
      task_id: task.id,
      causal_parents: [nodeB.memory.id],
    });

    const linearLineage = await MemoryService.getCausalLineage(nodeC.memory.id);
    assert.strictEqual(linearLineage.length, 2, 'Lineage of C must contain B (depth 1) and A (depth 2)');
    assert.strictEqual(linearLineage[0].id, nodeB.memory.id);
    assert.strictEqual(linearLineage[0].depth, 1);
    assert.strictEqual(linearLineage[1].id, nodeA.memory.id);
    assert.strictEqual(linearLineage[1].depth, 2);
    console.log('  ✓ Linear chain traversal: Leaf C -> B (depth 1) -> A (depth 2)');

    // includeSelf option
    const selfLineage = await MemoryService.getCausalLineage(nodeC.memory.id, { includeSelf: true });
    assert.strictEqual(selfLineage.length, 3);
    assert.strictEqual(selfLineage[0].id, nodeC.memory.id);
    assert.strictEqual(selfLineage[0].depth, 0);
    console.log('  ✓ includeSelf returns starting node at depth 0');

    // Diamond DAG:
    //      Root
    //     /    \
    //   P1      P2
    //     \    /
    //     DiamondChild
    const diamondRoot = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Diamond Root Decision',
      confidence_class: 'OBSERVED',
      task_id: task.id,
    });
    const diamondP1 = await MemoryService.createMemory({
      type: 'CHANGE',
      content: 'Diamond Branch 1 Change',
      confidence_class: 'OBSERVED',
      task_id: task.id,
      causal_parents: [diamondRoot.memory.id],
    });
    const diamondP2 = await MemoryService.createMemory({
      type: 'CHANGE',
      content: 'Diamond Branch 2 Change',
      confidence_class: 'OBSERVED',
      task_id: task.id,
      causal_parents: [diamondRoot.memory.id],
    });
    const diamondChild = await MemoryService.createMemory({
      type: 'FAILURE',
      content: 'Diamond Child Failure caused by P1 and P2',
      confidence_class: 'OBSERVED',
      task_id: task.id,
      causal_parents: [diamondP1.memory.id, diamondP2.memory.id],
    });

    const diamondLineage = await MemoryService.getCausalLineage(diamondChild.memory.id);
    assert.strictEqual(diamondLineage.length, 3, 'Diamond DAG should contain exactly 3 ancestors (P1, P2, Root)');
    const depth1Ids = diamondLineage.filter((m) => m.depth === 1).map((m) => m.id);
    assert.ok(depth1Ids.includes(diamondP1.memory.id));
    assert.ok(depth1Ids.includes(diamondP2.memory.id));

    const rootEntries = diamondLineage.filter((m) => m.id === diamondRoot.memory.id);
    assert.strictEqual(rootEntries.length, 1, 'Diamond root must be deduplicated to exactly 1 entry');
    assert.strictEqual(rootEntries[0].depth, 2, 'Diamond root depth must be 2');
    console.log('  ✓ Diamond DAG deduplication: Root deduplicated at depth 2 without duplicate rows');

    // Max depth cap:
    const cappedLineage = await MemoryService.getCausalLineage(diamondChild.memory.id, { maxDepth: 1 });
    assert.strictEqual(cappedLineage.length, 2, 'maxDepth=1 should only return direct parents');
    assert.ok(cappedLineage.every((m) => m.depth === 1));
    console.log('  ✓ Max depth cap enforced: maxDepth = 1 returned only depth 1 ancestors');

    // Cycle guard test:
    // Create cycle directly in database: CycleA -> CycleB -> CycleA
    const cycleA = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Cycle node A',
      confidence_class: 'OBSERVED',
      task_id: task.id,
    });
    const cycleB = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Cycle node B',
      confidence_class: 'OBSERVED',
      task_id: task.id,
      causal_parents: [cycleA.memory.id],
    });
    // Introduce artificial cycle in DB
    await query('UPDATE memories SET causal_parents = $1 WHERE id = $2', [
      [cycleB.memory.id],
      cycleA.memory.id,
    ]);

    // Query lineage for CycleB — cycle guard must prevent infinite loop and terminate cleanly
    const cycleLineage = await MemoryService.getCausalLineage(cycleB.memory.id);
    assert.ok(cycleLineage.length > 0, 'Cycle traversal completed without hanging');
    console.log('  ✓ Cycle guard: WHERE NOT id = ANY(path) terminated recursion cleanly on circular graph');

    // ------------------------------------------------------------------------
    // 4. Staleness Wiring in listMemories
    // ------------------------------------------------------------------------
    console.log('\n[Test 4/4] Testing staleness wiring in listMemories (ACTIVE default)...');

    const stalenessTask = await TaskModel.create({
      project_id: project.id,
      title: 'Staleness Test Task',
      status: 'TODO',
    });

    const activeMem = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Active architectural decision',
      confidence_class: 'OBSERVED',
      task_id: stalenessTask.id,
      status: 'ACTIVE',
    });

    const supersededMem = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Old superseded architectural decision',
      confidence_class: 'OBSERVED',
      task_id: stalenessTask.id,
      status: 'SUPERSEDED',
    });

    const invalidatedMem = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Invalidated observation',
      confidence_class: 'OBSERVED',
      task_id: stalenessTask.id,
      status: 'INVALIDATED',
    });

    // 1. listMemories with no status filter -> must return ONLY active memories
    const defaultList = await MemoryService.listMemories({ taskId: stalenessTask.id });
    assert.strictEqual(defaultList.length, 1, 'Default listMemories must return only ACTIVE memories');
    assert.strictEqual(defaultList[0].id, activeMem.memory.id);
    console.log('  ✓ listMemories default: returned only ACTIVE memory (stale excluded)');

    // 2. listMemories with status = 'SUPERSEDED'
    const supersededList = await MemoryService.listMemories({
      taskId: stalenessTask.id,
      status: 'SUPERSEDED',
    });
    assert.strictEqual(supersededList.length, 1);
    assert.strictEqual(supersededList[0].id, supersededMem.memory.id);
    console.log('  ✓ listMemories with status = SUPERSEDED returned only superseded memory');

    // 3. listMemories with status array ['SUPERSEDED', 'INVALIDATED']
    const staleList = await MemoryService.listMemories({
      taskId: stalenessTask.id,
      status: ['SUPERSEDED', 'INVALIDATED'],
    });
    assert.strictEqual(staleList.length, 2);
    console.log('  ✓ listMemories with status array returned expected stale memories');

    // 4. listMemories with status = 'ALL'
    const allList = await MemoryService.listMemories({
      taskId: stalenessTask.id,
      status: 'ALL',
    });
    assert.strictEqual(allList.length, 3);
    console.log('  ✓ listMemories with status = ALL returned all 3 memories');

    // ------------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------------
    console.log('\n[Cleanup] Cleaning up test project...');
    await query('DELETE FROM projects WHERE id = $1', [project.id]);
    console.log('  ✓ Test project and cascading entities cleaned up.');

    console.log('\n=============================================');
    console.log('🎉 ALL CHUNK 4 RELIABILITY TESTS PASSED!');
    console.log('=============================================\n');
  } catch (error) {
    console.error('\n❌ Chunk 4 test failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

runMemoryReliabilityTests();
