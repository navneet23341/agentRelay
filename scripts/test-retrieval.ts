import assert from 'node:assert';
import { query, closePool } from '../src/config/database.js';
import { ProjectModel, PhaseModel, TaskModel } from '../src/models/index.js';
import { MemoryService } from '../src/services/index.js';

// Helper to generate normalized 1536-dimensional mock vector
function createMockVector(primaryIndex: number, magnitude: number = 1.0): number[] {
  const vec = new Array(1536).fill(0);
  vec[primaryIndex] = magnitude;
  return vec;
}

function createNormalizedBlend(i1: number, w1: number, i2: number, w2: number): number[] {
  const vec = new Array(1536).fill(0);
  const norm = Math.sqrt(w1 * w1 + w2 * w2);
  vec[i1] = w1 / norm;
  vec[i2] = w2 / norm;
  return vec;
}

async function runRetrievalTests() {
  console.log('=== agentRelay Retrieval Tests (Chunk 5) ===\n');

  try {
    // ------------------------------------------------------------------------
    // Setup Test Hierarchy
    // ------------------------------------------------------------------------
    const project = await ProjectModel.create({
      name: 'Chunk 5 Retrieval Test Project',
      goal: 'Validate pgvector semantic search and clean separation from structured retrieval',
    });
    const phase = await PhaseModel.create({
      project_id: project.id,
      name: 'Phase 1: Retrieval Validation',
      order_index: 1,
      status: 'ACTIVE',
    });
    const task1 = await TaskModel.create({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Database indexing task',
      status: 'IN_PROGRESS',
    });
    const task2 = await TaskModel.create({
      project_id: project.id,
      phase_id: phase.id,
      title: 'UI layout task',
      status: 'TODO',
    });
    console.log(`[Setup] Created test project: ${project.id}, tasks: ${task1.id}, ${task2.id}\n`);

    // ------------------------------------------------------------------------
    // 1. Clean Separation: Structured Path (listMemories)
    // ------------------------------------------------------------------------
    console.log('[Test 1/5] Testing structured retrieval path (listMemories without embeddings)...');

    const structMem1 = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Chose B-tree index for primary keys',
      confidence_class: 'OBSERVED',
      task_id: task1.id,
      embedding: null, // explicit null embedding
    });

    const structMem2 = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'B-tree index query latency benchmarked at 2ms',
      confidence_class: 'OBSERVED',
      task_id: task1.id,
      embedding: null,
    });

    const structList = await MemoryService.listMemories({
      taskId: task1.id,
      type: 'DECISION',
    });

    assert.strictEqual(structList.length, 1);
    assert.strictEqual(structList[0].id, structMem1.memory.id);
    assert.strictEqual(structList[0].embedding, null);
    console.log('  ✓ listMemories operates cleanly on relational filters without requiring embeddings.');

    // ------------------------------------------------------------------------
    // 2. Failure Tolerance: Missing Key / API Failure Does Not Block Writes
    // ------------------------------------------------------------------------
    console.log('\n[Test 2/5] Testing embedding failure tolerance during memory creation...');

    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY; // Simulate missing API key

    const safeWriteMem = await MemoryService.createMemory({
      type: 'CHANGE',
      content: 'Added composite foreign key without OpenAI API key configured',
      confidence_class: 'OBSERVED',
      task_id: task1.id,
    });

    assert.ok(safeWriteMem.memory.id, 'Memory must be created successfully');
    assert.strictEqual(safeWriteMem.memory.embedding, null, 'Embedding must be null when API key is missing');
    console.log('  ✓ Write succeeded gracefully with embedding = null when embedding generation is unavailable.');

    // Restore key if it was present
    if (origKey) process.env.OPENAI_API_KEY = origKey;

    // ------------------------------------------------------------------------
    // 3. Semantic Similarity Search via pgvector <=> (Cosine Distance)
    // ------------------------------------------------------------------------
    console.log('\n[Test 3/5] Testing semantic similarity search via pgvector <=> operator...');

    // Vector definitions:
    // queryVec: axis 0
    // vecTarget: exact match on axis 0 -> cosine distance = 0, similarity = 1.0
    // vecNear: blend of axis 0 (0.8) and axis 1 (0.6) -> cosine distance ~ 0.2, similarity ~ 0.8
    // vecFar: axis 2 -> orthogonal, cosine distance = 1.0, similarity = 0.0
    const queryVec = createMockVector(0);
    const vecTarget = createMockVector(0);
    const vecNear = createNormalizedBlend(0, 0.8, 1, 0.6);
    const vecFar = createMockVector(2);

    const memTarget = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Target decision on Postgres vector extension',
      confidence_class: 'OBSERVED',
      task_id: task1.id,
      embedding: vecTarget,
    });

    const memNear = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Near match on Postgres indexing',
      confidence_class: 'OBSERVED',
      task_id: task1.id,
      embedding: vecNear,
    });

    const memFar = await MemoryService.createMemory({
      type: 'OBSERVATION',
      content: 'Far match on frontend color palettes',
      confidence_class: 'OBSERVED',
      task_id: task1.id,
      embedding: vecFar,
    });

    // Execute semantic search with queryVec
    const searchResults = await MemoryService.searchMemory(queryVec, {
      taskId: task1.id,
    });

    assert.ok(searchResults.length >= 3, 'Must return matching memories with embeddings');
    assert.strictEqual(searchResults[0].id, memTarget.memory.id, 'Exact match must rank first');
    assert.ok(
      Math.abs(searchResults[0].similarity_score - 1.0) < 0.001,
      `Exact match similarity must be ~1.0, got ${searchResults[0].similarity_score}`
    );

    assert.strictEqual(searchResults[1].id, memNear.memory.id, 'Near match must rank second');
    assert.ok(
      Math.abs(searchResults[1].similarity_score - 0.8) < 0.01,
      `Near match similarity must be ~0.8, got ${searchResults[1].similarity_score}`
    );

    assert.strictEqual(searchResults[2].id, memFar.memory.id, 'Orthogonal match must rank third');
    assert.ok(
      Math.abs(searchResults[2].similarity_score - 0.0) < 0.001,
      `Orthogonal match similarity must be ~0.0, got ${searchResults[2].similarity_score}`
    );
    console.log('  ✓ pgvector <=> cosine distance correctly ranks exact (1.0), near (0.8), and far (0.0) matches.');

    // ------------------------------------------------------------------------
    // 4. Layered Structured Filters on Semantic Search
    // ------------------------------------------------------------------------
    console.log('\n[Test 4/5] Testing layered structured filters on searchMemory (reused filter logic)...');

    // Create memory on Task 2 with identical target vector
    const memTask2 = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Task 2 decision with identical vector',
      confidence_class: 'OBSERVED',
      task_id: task2.id,
      embedding: vecTarget,
    });

    // Filter by taskId = task1
    const task1Search = await MemoryService.searchMemory(queryVec, {
      taskId: task1.id,
    });
    assert.ok(task1Search.every((r) => r.task_id === task1.id), 'All results must belong to task1');
    assert.ok(task1Search.some((r) => r.id === memTarget.memory.id));
    assert.ok(!task1Search.some((r) => r.id === memTask2.memory.id));
    console.log('  ✓ taskId filter strictly applied to semantic search.');

    // Filter by type = 'DECISION'
    const typeSearch = await MemoryService.searchMemory(queryVec, {
      taskId: task1.id,
      type: 'DECISION',
    });
    assert.strictEqual(typeSearch.length, 1);
    assert.strictEqual(typeSearch[0].id, memTarget.memory.id);
    console.log('  ✓ type filter strictly applied to semantic search.');

    // Filter with minSimilarity threshold (e.g. >= 0.5)
    const thresholdSearch = await MemoryService.searchMemory(queryVec, {
      taskId: task1.id,
      minSimilarity: 0.5,
    });
    assert.ok(thresholdSearch.every((r) => r.similarity_score >= 0.5));
    assert.ok(!thresholdSearch.some((r) => r.id === memFar.memory.id));
    console.log('  ✓ minSimilarity threshold filter strictly applied to semantic search.');

    // ------------------------------------------------------------------------
    // 5. Staleness Wiring in Semantic Search
    // ------------------------------------------------------------------------
    console.log('\n[Test 5/5] Testing staleness handling in searchMemory (ACTIVE default)...');

    const supersededVecMem = await MemoryService.createMemory({
      type: 'DECISION',
      content: 'Superseded decision with high vector match',
      confidence_class: 'OBSERVED',
      task_id: task1.id,
      status: 'SUPERSEDED',
      embedding: vecTarget,
    });

    // Default search -> should NOT include supersededVecMem
    const defaultSearch = await MemoryService.searchMemory(queryVec, {
      taskId: task1.id,
    });
    assert.ok(
      !defaultSearch.some((r) => r.id === supersededVecMem.memory.id),
      'Default search must exclude SUPERSEDED memories'
    );
    console.log('  ✓ Default searchMemory excludes stale SUPERSEDED memories.');

    // Explicit status = 'SUPERSEDED' -> should include it
    const supersededSearch = await MemoryService.searchMemory(queryVec, {
      taskId: task1.id,
      status: 'SUPERSEDED',
    });
    assert.strictEqual(supersededSearch.length, 1);
    assert.strictEqual(supersededSearch[0].id, supersededVecMem.memory.id);
    console.log('  ✓ Explicit status: SUPERSEDED returns matching stale memory.');

    // Explicit status = 'ALL' -> includes both active and superseded
    const allStatusSearch = await MemoryService.searchMemory(queryVec, {
      taskId: task1.id,
      status: 'ALL',
    });
    assert.ok(allStatusSearch.some((r) => r.id === supersededVecMem.memory.id));
    assert.ok(allStatusSearch.some((r) => r.id === memTarget.memory.id));
    // Confirm rows with embedding IS NULL are strictly excluded from searchMemory
    assert.ok(!allStatusSearch.some((r) => r.id === structMem1.memory.id));
    assert.ok(!allStatusSearch.some((r) => r.id === structMem2.memory.id));
    assert.ok(!allStatusSearch.some((r) => r.id === safeWriteMem.memory.id));
    console.log('  ✓ Explicit status: ALL returns active and superseded memories, while strictly excluding rows with embedding IS NULL.');

    // ------------------------------------------------------------------------
    // 6. Backfill Missing Embeddings
    // ------------------------------------------------------------------------
    console.log('\n[Test 6/6] Testing backfillMissingEmbeddings()...');

    // structMem1, structMem2, safeWriteMem currently have embedding = null and status = 'ACTIVE'
    const backfillResult = await MemoryService.backfillMissingEmbeddings({
      generator: async (text) => createMockVector(3),
    });

    assert.ok(backfillResult.processed >= 3, 'Must have processed memories with null embeddings');
    assert.ok(backfillResult.updated >= 3, 'Must have updated memories with new embeddings');
    assert.strictEqual(backfillResult.failed, 0);

    // Verify in database that structMem1 now has an embedding
    const updatedMem1 = await MemoryService.getMemoryById(structMem1.memory.id);
    assert.ok(updatedMem1?.embedding !== null, 'Backfilled memory must now have an embedding');

    // Semantic search for vector 3 should now find the backfilled memory
    const backfilledSearch = await MemoryService.searchMemory(createMockVector(3), {
      taskId: task1.id,
    });
    assert.ok(backfilledSearch.some((r) => r.id === structMem1.memory.id));
    console.log('  ✓ backfillMissingEmbeddings() successfully regenerated embeddings and made memories searchable.');

    // ------------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------------
    console.log('\n[Cleanup] Cleaning up test project...');
    await query('DELETE FROM projects WHERE id = $1', [project.id]);
    console.log('  ✓ Test project and cascading entities cleaned up.');

    console.log('\n=============================================');
    console.log('🎉 ALL CHUNK 5 RETRIEVAL TESTS PASSED!');
    console.log('=============================================\n');
  } catch (error) {
    console.error('\n❌ Chunk 5 test failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

runRetrievalTests();
