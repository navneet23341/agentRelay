import { pool, query, closePool } from '../src/config/database.js';
import {
  ProjectModel,
  PhaseModel,
  TaskModel,
  MemoryModel,
} from '../src/models/index.js';

async function verifySchema() {
  console.log('=== agentRelay Schema Verification ===\n');

  try {
    // 1. Connection check
    console.log('[1/5] Checking PostgreSQL connection...');
    const connCheck = await query('SELECT current_database(), current_user, version()');
    console.log(`  ✓ Connected to DB: "${connCheck.rows[0].current_database}" as user "${connCheck.rows[0].current_user}"`);

    // 2. pgvector check
    console.log('\n[2/5] Checking pgvector extension...');
    const vectorCheck = await query(
      "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'"
    );
    if (vectorCheck.rows.length === 0) {
      throw new Error('pgvector extension is not enabled in database!');
    }
    console.log(`  ✓ pgvector extension enabled (version: ${vectorCheck.rows[0].extversion})`);

    // 3. Table verification
    console.log('\n[3/5] Verifying required tables...');
    const requiredTables = ['projects', 'phases', 'tasks', 'memories'];
    for (const table of requiredTables) {
      const res = await query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
        [table]
      );
      if (res.rows.length === 0) {
        throw new Error(`Table "${table}" does not exist!`);
      }
      console.log(`  ✓ Table "${table}" exists`);
    }

    // 4. Memory fields verification
    console.log('\n[4/5] Verifying exact fields in "memories" table...');
    const expectedMemoryColumns = [
      'id',
      'type',
      'content',
      'embedding',
      'confidence_class',
      'confidence_score',
      'status',
      'created_at',
      'invalidated_at',
      'invalidated_by',
      'superseded_by',
      'task_id',
      'semantic_hash',
      'hit_count',
      'last_seen_at',
      'causal_parents',
    ];

    const colRes = await query(
      "SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memories'"
    );
    const existingColumns = new Map(colRes.rows.map((r) => [r.column_name, r]));

    for (const col of expectedMemoryColumns) {
      if (!existingColumns.has(col)) {
        throw new Error(`Missing required column "${col}" in memories table!`);
      }
      const colInfo = existingColumns.get(col);
      console.log(`  ✓ Column "${col}": ${colInfo.data_type} (udt: ${colInfo.udt_name})`);
    }

    // 5. Integration test: create and query Project, Phase, Task, and Memory
    console.log('\n[5/5] Testing model operations (insert, link, vector, causal parents, query)...');

    const project = await ProjectModel.create({
      name: 'AgentRelay Verification Project',
      goal: 'Test Chunk 1 foundation',
      constraints: 'Local test only',
      repository_ref: 'https://github.com/navneet23341/agentRelay',
    });
    console.log(`  ✓ Created project: ${project.id}`);

    const phase = await PhaseModel.create({
      project_id: project.id,
      name: 'Phase 1: Foundation Verification',
      description: 'Verifying models and DB schema',
      order_index: 1,
      status: 'ACTIVE',
    });
    console.log(`  ✓ Created phase: ${phase.id}`);

    const task = await TaskModel.create({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Scaffold and verify database',
      description: 'Test all model interactions',
      status: 'IN_PROGRESS',
    });
    console.log(`  ✓ Created task: ${task.id}`);

    // Create a parent memory (DECISION)
    const parentMemory = await MemoryModel.create({
      type: 'DECISION',
      content: 'Chose node-pg-migrate and TypeScript for Chunk 1',
      confidence_class: 'OBSERVED',
      confidence_score: 1.0,
      status: 'ACTIVE',
      task_id: task.id,
      semantic_hash: 'hash_decision_001',
    });
    console.log(`  ✓ Created parent memory (DECISION): ${parentMemory.id}`);

    // Create 1536-dim vector for testing pgvector insertion
    const dummyVector = new Array(1536).fill(0).map((_, i) => (i % 100) / 100);

    // Create child memory (FAILURE) with causal_parents link to parentMemory.id
    const childMemory = await MemoryModel.create({
      type: 'FAILURE',
      content: 'Simulated failure during schema test',
      embedding: dummyVector,
      confidence_class: 'OBSERVED',
      confidence_score: 0.7,
      status: 'ACTIVE',
      task_id: task.id,
      semantic_hash: 'hash_failure_002',
      hit_count: 1,
      causal_parents: [parentMemory.id],
    });
    console.log(`  ✓ Created child memory with 1536-dim embedding and causal_parents: ${childMemory.id}`);

    // Fetch and verify child memory
    const fetched = await MemoryModel.findById(childMemory.id);
    if (!fetched) {
      throw new Error('Could not fetch created memory!');
    }
    if (!fetched.causal_parents.includes(parentMemory.id)) {
      throw new Error('causal_parents does not match expected parent id!');
    }
    if (fetched.hit_count !== 1 || fetched.type !== 'FAILURE') {
      throw new Error('Memory attributes do not match expected values!');
    }
    console.log(`  ✓ Verified fetched memory: type=${fetched.type}, causal_parents=[${fetched.causal_parents.join(', ')}], hit_count=${fetched.hit_count}`);

    // Clean up test data
    await MemoryModel.deleteById(childMemory.id);
    await MemoryModel.deleteById(parentMemory.id);
    await TaskModel.deleteById(task.id);
    await PhaseModel.deleteById(phase.id);
    await ProjectModel.deleteById(project.id);
    console.log('  ✓ Cleaned up all verification test records.');

    console.log('\n=============================================');
    console.log('🎉 ALL FOUNDATION VERIFICATION CHECKS PASSED!');
    console.log('=============================================\n');
  } catch (error) {
    console.error('\n❌ Verification failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

verifySchema();
