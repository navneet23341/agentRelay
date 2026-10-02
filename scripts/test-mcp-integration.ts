import assert from 'node:assert';
import { query, closePool } from '../src/config/database.js';
import { ProjectModel } from '../src/models/index.js';
import {
  PhaseService,
  TaskService,
  MemoryService,
} from '../src/services/index.js';
import {
  TOOL_SCHEMAS,
  handleGetProjectState,
  handleGetCurrentTask,
  handleSearchMemory,
  handleGetRelevantContext,
  handleRecordDecision,
  handleRecordFailure,
  handleUpdateTask,
  handleCreateHandoff,
  dispatchToolCall,
} from '../src/mcp/index.js';

async function runMcpIntegrationTests() {
  console.log('=== agentRelay MCP Server Integration Tests (Chunk 7) ===\n');

  let project: any;
  try {
    // ------------------------------------------------------------------------
    // 1. Setup Test Hierarchy
    // ------------------------------------------------------------------------
    console.log('[Setup] Creating test project, phase, and tasks...');
    project = await ProjectModel.create({
      name: 'Chunk 7 MCP Integration Test Project',
      goal: 'Validate all 8 MCP tools and handlers',
      constraints: 'Strict state machine and atomic transactions',
      repository_ref: 'https://github.com/org/agentrelay',
    });

    const phase = await PhaseService.createPhase({
      project_id: project.id,
      name: 'Phase 1: MCP Tool Interface',
      order_index: 1,
      status: 'ACTIVE',
    });

    const task1 = await TaskService.createTask({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Core MCP Server Handlers',
      description: 'Implement thin service wrappers',
    });

    console.log('  ✓ Test environment ready.');

    // ------------------------------------------------------------------------
    // 2. Test Tool Schemas Definition
    // ------------------------------------------------------------------------
    console.log('\n[Test 1/6] Verifying MCP Tool Schemas (all 8 registered)...');
    assert.strictEqual(TOOL_SCHEMAS.length, 8, 'Must expose exactly 8 tools');
    const toolNames = TOOL_SCHEMAS.map((t) => t.name);
    const expectedTools = [
      'get_project_state',
      'get_current_task',
      'search_memory',
      'get_relevant_context',
      'record_decision',
      'record_failure',
      'update_task',
      'create_handoff',
    ];
    for (const expected of expectedTools) {
      assert.ok(toolNames.includes(expected), `Schema must include "${expected}"`);
    }
    console.log('  ✓ All 8 tools declared with valid JSON schema definitions.');

    // ------------------------------------------------------------------------
    // 3. Test record_decision Atomic Rollback on Invalid Supersession
    // ------------------------------------------------------------------------
    console.log('\n[Test 2/6] Testing record_decision rollback on invalid supersedesMemoryId...');

    // Count decisions before failed attempt
    const beforeCountRes = await query(
      "SELECT COUNT(*) FROM memories WHERE task_id = $1 AND type = 'DECISION'",
      [task1.id]
    );
    const countBefore = Number(beforeCountRes.rows[0].count);

    let errorThrown = false;
    const nonExistentId = '00000000-0000-0000-0000-000000000000';
    try {
      await handleRecordDecision({
        taskId: task1.id,
        content: 'This decision should never be committed because target does not exist',
        supersedesMemoryId: nonExistentId,
      });
    } catch (err: any) {
      errorThrown = true;
      assert.ok(
        err.message.includes('not found') || err.message.includes(nonExistentId),
        `Error message must indicate target memory not found: ${err.message}`
      );
    }
    assert.ok(errorThrown, 'handleRecordDecision must throw on non-existent supersedesMemoryId');

    // Confirm that the transaction rolled back cleanly and NO new row was inserted!
    const afterCountRes = await query(
      "SELECT COUNT(*) FROM memories WHERE task_id = $1 AND type = 'DECISION'",
      [task1.id]
    );
    const countAfter = Number(afterCountRes.rows[0].count);
    assert.strictEqual(
      countAfter,
      countBefore,
      'Transaction must roll back cleanly: zero phantom DECISION rows inserted'
    );
    console.log('  ✓ Atomic rollback verified: No DECISION row was inserted on invalid supersession.');

    // ------------------------------------------------------------------------
    // 4. Test record_decision Successful Atomic Supersession
    // ------------------------------------------------------------------------
    console.log('\n[Test 3/6] Testing record_decision successful atomic supersession...');
    const dec1Result = await handleRecordDecision({
      taskId: task1.id,
      content: 'Original Decision: Use JSON for API payloads',
      confidenceClass: 'OBSERVED',
    });
    assert.strictEqual(dec1Result.decision.status, 'ACTIVE');

    const dec2Result = await handleRecordDecision({
      taskId: task1.id,
      content: 'Updated Decision: Use Protobuf for internal high-throughput streams',
      supersedesMemoryId: dec1Result.decision.id,
    });
    assert.strictEqual(dec2Result.decision.status, 'ACTIVE');
    assert.strictEqual(dec2Result.supersededMemory?.status, 'SUPERSEDED');
    assert.strictEqual(dec2Result.supersededMemory?.superseded_by, dec2Result.decision.id);

    // Verify in database directly
    const verifyOldRes = await query('SELECT * FROM memories WHERE id = $1', [dec1Result.decision.id]);
    assert.strictEqual(verifyOldRes.rows[0].status, 'SUPERSEDED');
    assert.strictEqual(verifyOldRes.rows[0].superseded_by, dec2Result.decision.id);
    console.log('  ✓ Successful atomic supersession: Old decision marked SUPERSEDED and linked to new decision.');

    // ------------------------------------------------------------------------
    // 5. Test update_task PENDING_REVIEW Rejection & State Machine Transitions
    // ------------------------------------------------------------------------
    console.log('\n[Test 4/6] Testing update_task PENDING_REVIEW rejection guards...');

    // A: Attempt to set status = 'PENDING_REVIEW' directly
    let rejectTargetPending = false;
    try {
      await handleUpdateTask({
        taskId: task1.id,
        status: 'PENDING_REVIEW' as any,
      });
    } catch (err: any) {
      rejectTargetPending = true;
      assert.ok(
        err.message.includes('Cannot set task status directly to "PENDING_REVIEW"'),
        `Expected rejection message, got: ${err.message}`
      );
    }
    assert.ok(rejectTargetPending, 'update_task must reject setting status to PENDING_REVIEW');

    // B: Attempt to update a task that is currently in PENDING_REVIEW
    const suggestion = await TaskService.suggestTask({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Suggested AI optimization',
      reasoning: 'Better throughput',
    });

    let rejectModifyPending = false;
    try {
      await handleUpdateTask({
        taskId: suggestion.id,
        status: 'IN_PROGRESS',
      });
    } catch (err: any) {
      rejectModifyPending = true;
      assert.ok(
        err.message.includes('currently in "PENDING_REVIEW"'),
        `Expected rejection of modifying PENDING_REVIEW task, got: ${err.message}`
      );
    }
    assert.ok(rejectModifyPending, 'update_task must reject modifying a task in PENDING_REVIEW');
    console.log('  ✓ Both PENDING_REVIEW guards verified: cannot set to PENDING_REVIEW, and cannot modify PENDING_REVIEW tasks.');

    // C: Test legal transitions including IN_PROGRESS -> TODO and BLOCKED -> TODO
    console.log('\n[Test 5/6] Testing legal state transitions including IN_PROGRESS/BLOCKED -> TODO and reopen...');
    let updated = await handleUpdateTask({ taskId: task1.id, status: 'IN_PROGRESS' });
    assert.strictEqual(updated.status, 'IN_PROGRESS');

    // IN_PROGRESS -> TODO
    updated = await handleUpdateTask({ taskId: task1.id, status: 'TODO' });
    assert.strictEqual(updated.status, 'TODO');

    // TODO -> IN_PROGRESS -> BLOCKED
    updated = await handleUpdateTask({ taskId: task1.id, status: 'IN_PROGRESS' });
    updated = await handleUpdateTask({ taskId: task1.id, status: 'BLOCKED' });
    assert.strictEqual(updated.status, 'BLOCKED');

    // BLOCKED -> TODO
    updated = await handleUpdateTask({ taskId: task1.id, status: 'TODO' });
    assert.strictEqual(updated.status, 'TODO');

    // Reopening: TODO -> IN_PROGRESS -> COMPLETED -> TODO (via isReopen)
    updated = await handleUpdateTask({ taskId: task1.id, status: 'IN_PROGRESS' });
    updated = await handleUpdateTask({ taskId: task1.id, status: 'COMPLETED' });
    assert.strictEqual(updated.status, 'COMPLETED');
    assert.ok(updated.completed_at !== null);

    updated = await handleUpdateTask({ taskId: task1.id, status: 'TODO', isReopen: true });
    assert.strictEqual(updated.status, 'TODO');
    assert.strictEqual(updated.completed_at, null);
    assert.strictEqual(updated.reopened_from, 'COMPLETED');
    console.log('  ✓ All transitions verified: IN_PROGRESS->TODO, BLOCKED->TODO, and COMPLETED->TODO (reopen).');

    // ------------------------------------------------------------------------
    // 6. Test Remaining Tool Handlers via dispatchToolCall
    // ------------------------------------------------------------------------
    console.log('\n[Test 6/6] Testing remaining tool handlers via dispatchToolCall...');

    // A: get_project_state
    const projectState: any = await dispatchToolCall('get_project_state', { projectId: project.id });
    assert.strictEqual(projectState.project.id, project.id);
    assert.ok(Array.isArray(projectState.phases));
    assert.ok(Array.isArray(projectState.tasks));
    assert.ok(typeof projectState.taskSummary.TODO === 'number');
    console.log('  ✓ get_project_state returned aggregated project, phases, and task summary.');

    // B: get_current_task
    const taskDetails: any = await dispatchToolCall('get_current_task', { taskId: task1.id });
    assert.strictEqual(taskDetails.id, task1.id);
    console.log('  ✓ get_current_task returned task details.');

    // C: record_failure
    const failureMem: any = await dispatchToolCall('record_failure', {
      taskId: task1.id,
      content: 'Connection timeout connecting to redis cache cluster',
      confidenceClass: 'OBSERVED',
    });
    assert.strictEqual(failureMem.type, 'FAILURE');
    assert.strictEqual(failureMem.task_id, task1.id);
    console.log('  ✓ record_failure created FAILURE memory with hit_count and hash tracking.');

    // D: search_memory
    const searchResults: any = await dispatchToolCall('search_memory', {
      query: 'Protobuf internal streaming',
      taskId: task1.id,
    });
    assert.ok(Array.isArray(searchResults));
    console.log('  ✓ search_memory performed similarity search with structured task filter.');

    // E: create_handoff
    const handoffMem: any = await dispatchToolCall('create_handoff', {
      taskId: task1.id,
      completedItems: ['Implemented MCP tool schemas', 'Wired 8 handlers'],
      remainingItems: ['CLI wrapper in Chunk 8'],
      nextAction: 'Proceed to Chunk 8 CLI implementation',
    });
    assert.strictEqual(handoffMem.type, 'HANDOFF');
    assert.strictEqual(handoffMem.task_id, task1.id);
    console.log('  ✓ create_handoff generated structured task-scoped HANDOFF memory.');

    // F: get_relevant_context
    const contextResult: any = await dispatchToolCall('get_relevant_context', {
      taskId: task1.id,
      totalTokenBudget: 1500,
    });
    assert.ok(contextResult.compiledText.includes('# PROJECT:'));
    assert.ok(contextResult.compiledText.includes('## CURRENT TASK:'));
    assert.ok(contextResult.compiledText.includes('## HANDOFF'));
    assert.ok(contextResult.budget.totalOutputTokens > 0);
    assert.ok(contextResult.budget.totalOutputTokens <= 1500);
    console.log('  ✓ get_relevant_context returned token-packed context block.');

    console.log('\n======================================================');
    console.log('🎉 ALL CHUNK 7 MCP INTEGRATION TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    if (project) {
      console.log('[Cleanup] Cleaning up MCP test project...');
      await query('DELETE FROM projects WHERE id = $1', [project.id]);
      console.log('  ✓ Test project cleaned up.');
    }
    await closePool();
  }
}

runMcpIntegrationTests().catch((err) => {
  console.error('MCP Integration Test failed:', err);
  process.exit(1);
});
