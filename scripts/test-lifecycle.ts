import assert from 'node:assert';
import { closePool, query } from '../src/config/database.js';
import { ProjectModel } from '../src/models/index.js';
import {
  PhaseService,
  TaskService,
  HandoffService,
  InvalidStateTransitionError,
} from '../src/services/index.js';

async function runLifecycleTests() {
  console.log('=== agentRelay Lifecycle Tests (Chunk 3) ===\n');

  try {
    // Setup test Project
    const project = await ProjectModel.create({
      name: 'Chunk 3 Lifecycle Test Project',
      goal: 'Validate Phase, Task, Suggestion, and Handoff workflows',
    });
    console.log(`[Setup] Created test project: ${project.id}`);

    // ------------------------------------------------------------------------
    // 1. Phase Lifecycle & CRUD
    // ------------------------------------------------------------------------
    console.log('\n[Test 1/4] Testing Phase CRUD and state transitions...');

    const phase = await PhaseService.createPhase({
      project_id: project.id,
      name: 'Phase 1: Architecture & Prototyping',
      description: 'Initial design phase',
      order_index: 1,
      status: 'PLANNED',
    });
    assert.strictEqual(phase.status, 'PLANNED');
    console.log(`  ✓ Created phase in PLANNED state: ${phase.id}`);

    // Transition PLANNED -> ACTIVE
    const activePhase = await PhaseService.updatePhaseStatus(phase.id, 'ACTIVE');
    assert.strictEqual(activePhase.status, 'ACTIVE');
    console.log('  ✓ Transitioned phase to ACTIVE');

    // Transition ACTIVE -> COMPLETED
    const completedPhase = await PhaseService.updatePhaseStatus(phase.id, 'COMPLETED');
    assert.strictEqual(completedPhase.status, 'COMPLETED');
    console.log('  ✓ Transitioned phase to COMPLETED');

    // List phases
    const phaseList = await PhaseService.listPhases(project.id);
    assert.strictEqual(phaseList.length, 1);
    assert.strictEqual(phaseList[0].id, phase.id);
    console.log('  ✓ Phase listing verified.');

    // ------------------------------------------------------------------------
    // 2. Task State Machine Transitions
    // ------------------------------------------------------------------------
    console.log('\n[Test 2/4] Testing Task state machine & illegal transition rejections...');

    const task = await TaskService.createTask({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Implement state machine verification',
      description: 'Validating task transitions',
    });
    assert.strictEqual(task.status, 'TODO', 'Tasks created via createTask must default to TODO');
    console.log(`  ✓ Created task in TODO state: ${task.id}`);

    // Illegal jump: TODO -> COMPLETED without starting must fail
    await assert.rejects(
      async () => {
        await TaskService.updateTaskStatus(task.id, 'COMPLETED');
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidStateTransitionError);
        assert.strictEqual(err.from, 'TODO');
        assert.strictEqual(err.to, 'COMPLETED');
        return true;
      },
      'TODO -> COMPLETED must throw InvalidStateTransitionError'
    );
    console.log('  ✓ Rejected illegal transition: TODO -> COMPLETED');

    // Legal: TODO -> IN_PROGRESS
    const inProgressTask = await TaskService.updateTaskStatus(task.id, 'IN_PROGRESS');
    assert.strictEqual(inProgressTask.status, 'IN_PROGRESS');
    console.log('  ✓ Legal transition: TODO -> IN_PROGRESS');

    // Legal: IN_PROGRESS -> BLOCKED
    const blockedTask = await TaskService.updateTaskStatus(task.id, 'BLOCKED');
    assert.strictEqual(blockedTask.status, 'BLOCKED');
    console.log('  ✓ Legal transition: IN_PROGRESS -> BLOCKED');

    // Legal: BLOCKED -> IN_PROGRESS
    const resumedTask = await TaskService.updateTaskStatus(task.id, 'IN_PROGRESS');
    assert.strictEqual(resumedTask.status, 'IN_PROGRESS');
    console.log('  ✓ Legal transition: BLOCKED -> IN_PROGRESS');

    // Legal: IN_PROGRESS -> COMPLETED (completed_at should be populated)
    const completedTask = await TaskService.updateTaskStatus(task.id, 'COMPLETED');
    assert.strictEqual(completedTask.status, 'COMPLETED');
    assert.ok(completedTask.completed_at, 'completed_at must be populated on COMPLETED');
    console.log(`  ✓ Legal transition: IN_PROGRESS -> COMPLETED (completed_at: ${completedTask.completed_at})`);

    // Illegal: COMPLETED -> IN_PROGRESS directly must fail
    await assert.rejects(
      async () => {
        await TaskService.updateTaskStatus(task.id, 'IN_PROGRESS');
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidStateTransitionError);
        assert.strictEqual(err.from, 'COMPLETED');
        assert.strictEqual(err.to, 'IN_PROGRESS');
        return true;
      },
      'COMPLETED -> IN_PROGRESS must fail unless explicitly reopened'
    );
    console.log('  ✓ Rejected illegal transition: COMPLETED -> IN_PROGRESS');

    // Illegal: COMPLETED -> TODO via updateTaskStatus must fail (requires reopenTask)
    await assert.rejects(
      async () => {
        await TaskService.updateTaskStatus(task.id, 'TODO');
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidStateTransitionError);
        return true;
      },
      'COMPLETED -> TODO via updateTaskStatus must fail (must use reopenTask)'
    );
    console.log('  ✓ Rejected standard update for reopening (must call reopenTask)');

    // Explicit Reopen: reopenTask() -> TODO (completed_at must be cleared, reopened_from = COMPLETED)
    const reopenedTask = await TaskService.reopenTask(task.id);
    assert.strictEqual(reopenedTask.status, 'TODO');
    assert.strictEqual(reopenedTask.completed_at, null, 'completed_at must be null when reopened');
    assert.strictEqual(reopenedTask.reopened_from, 'COMPLETED', 'reopened_from must be set to COMPLETED');
    console.log('  ✓ Explicit reopen succeeded: COMPLETED -> TODO (completed_at cleared, reopened_from = COMPLETED)');

    // Path out of FAILED test:
    // Move reopened task: TODO -> IN_PROGRESS -> FAILED
    await TaskService.updateTaskStatus(task.id, 'IN_PROGRESS');
    const failedTask = await TaskService.updateTaskStatus(task.id, 'FAILED');
    assert.strictEqual(failedTask.status, 'FAILED');
    console.log('  ✓ Legal transition: IN_PROGRESS -> FAILED');

    // Illegal: FAILED -> IN_PROGRESS directly must fail
    await assert.rejects(
      async () => {
        await TaskService.updateTaskStatus(task.id, 'IN_PROGRESS');
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidStateTransitionError);
        assert.strictEqual(err.from, 'FAILED');
        assert.strictEqual(err.to, 'IN_PROGRESS');
        return true;
      },
      'FAILED -> IN_PROGRESS must fail (must reopen first)'
    );
    console.log('  ✓ Rejected illegal transition: FAILED -> IN_PROGRESS');

    // Illegal: FAILED -> TODO via standard updateTaskStatus must fail
    await assert.rejects(
      async () => {
        await TaskService.updateTaskStatus(task.id, 'TODO');
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidStateTransitionError);
        return true;
      },
      'FAILED -> TODO via updateTaskStatus must fail (must call reopenTask)'
    );
    console.log('  ✓ Rejected standard update for reopening FAILED task');

    // Legal path out of FAILED: reopenTask() -> TODO
    const reopenedFailedTask = await TaskService.reopenTask(task.id);
    assert.strictEqual(reopenedFailedTask.status, 'TODO');
    assert.strictEqual(reopenedFailedTask.reopened_from, 'FAILED', 'reopened_from must be set to FAILED');
    console.log('  ✓ Explicit reopen of FAILED task succeeded: FAILED -> TODO via reopenTask() (reopened_from = FAILED)');

    // Reopen from CANCELLED test:
    // Move task: TODO -> CANCELLED
    await TaskService.updateTaskStatus(task.id, 'CANCELLED');
    const reopenedCancelledTask = await TaskService.reopenTask(task.id);
    assert.strictEqual(reopenedCancelledTask.status, 'TODO');
    assert.strictEqual(reopenedCancelledTask.reopened_from, 'CANCELLED', 'reopened_from must be set to CANCELLED');
    console.log('  ✓ Explicit reopen of CANCELLED task succeeded: CANCELLED -> TODO via reopenTask() (reopened_from = CANCELLED)');

    // Query by reopened_from filter
    const cancelledReopenedTasks = await TaskService.listTasks({
      projectId: project.id,
      reopened_from: 'CANCELLED',
    });
    assert.strictEqual(cancelledReopenedTasks.length, 1);
    assert.strictEqual(cancelledReopenedTasks[0].id, task.id);
    console.log('  ✓ Filtered query by reopened_from succeeded.');

    // ------------------------------------------------------------------------
    // 3. TASK_SUGGESTION Flow (Human-in-the-loop Gate)
    // ------------------------------------------------------------------------
    console.log('\n[Test 3/4] Testing TASK_SUGGESTION flow and human approval gate...');

    // Trying to create a PENDING_REVIEW task via standard createTask() must fail
    await assert.rejects(
      async () => {
        await TaskService.createTask({
          project_id: project.id,
          title: 'Direct suggestion attempt',
          status: 'PENDING_REVIEW',
        });
      },
      /Cannot create a PENDING_REVIEW task via createTask/,
      'Must reject PENDING_REVIEW via createTask'
    );
    console.log('  ✓ Standard createTask() rejected direct creation of PENDING_REVIEW task');

    // Agent proposes a suggestion via suggestTask()
    const suggestion = await TaskService.suggestTask({
      project_id: project.id,
      phase_id: phase.id,
      title: 'Add Redis cache layer',
      description: 'Cache compiled contexts for faster startup',
      reasoning: 'Reduces database load during heavy context retrieval',
    });
    assert.strictEqual(suggestion.status, 'PENDING_REVIEW');
    assert.ok(suggestion.description?.includes('[Suggestion Reasoning]'));
    console.log(`  ✓ Created suggestion in PENDING_REVIEW: ${suggestion.id}`);

    // Agent cannot start or complete a PENDING_REVIEW task directly
    await assert.rejects(
      async () => {
        await TaskService.updateTaskStatus(suggestion.id, 'IN_PROGRESS');
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidStateTransitionError);
        return true;
      },
      'Cannot start a task while still in PENDING_REVIEW'
    );
    console.log('  ✓ Agent prevented from starting a task in PENDING_REVIEW');

    // Human approves the suggestion with overrides
    const approvedTask = await TaskService.approveSuggestion(suggestion.id, {
      title: 'Add Redis Cache Layer (Approved with human edits)',
      description: 'Approved: Cache compiled contexts with 5-minute TTL',
    });
    assert.strictEqual(approvedTask.status, 'TODO', 'Approved suggestion must be promoted to TODO');
    assert.strictEqual(approvedTask.title, 'Add Redis Cache Layer (Approved with human edits)');
    console.log('  ✓ Human approved suggestion -> successfully promoted to TODO');

    // Human rejection test
    const suggestionToReject = await TaskService.suggestTask({
      project_id: project.id,
      title: 'Rewrite everything in Rust',
      reasoning: 'Blazingly fast',
    });
    const rejectedTask = await TaskService.rejectSuggestion(
      suggestionToReject.id,
      'Out of project scope and unnecessary rewrite'
    );
    assert.strictEqual(rejectedTask.status, 'CANCELLED');
    assert.ok(rejectedTask.description?.includes('[Rejection Reason]'));
    console.log('  ✓ Human rejected suggestion -> marked CANCELLED with logged reason');

    // ------------------------------------------------------------------------
    // 4. Handoff Record Creation
    // ------------------------------------------------------------------------
    console.log('\n[Test 4/4] Testing Handoff creation tied to task...');

    const handoffData = {
      completedItems: [
        'Scaffolded Node.js + Express with pgvector',
        'Implemented Memory Store core with atomic dedup',
        'Implemented Task state machine and human approval gate',
      ],
      remainingItems: [
        'Implement Chunk 4: Memory reliability & Causal Graph',
        'Implement Chunk 5: pgvector similarity retrieval',
      ],
      currentIssue: 'Need to tune decay parameter lambda in Chunk 6',
      nextAction: 'Proceed to Chunk 4 build',
    };

    const handoffResult = await HandoffService.createHandoff(approvedTask.id, handoffData);
    assert.strictEqual(handoffResult.task.id, approvedTask.id);
    assert.strictEqual(handoffResult.handoffMemory.type, 'HANDOFF');
    assert.strictEqual(handoffResult.handoffMemory.task_id, approvedTask.id);
    assert.strictEqual(handoffResult.handoffMemory.confidence_class, 'OBSERVED');
    assert.strictEqual(Number(handoffResult.handoffMemory.confidence_score), 1.0);
    assert.ok(handoffResult.handoffMemory.content.includes('## Completed Items'));
    assert.ok(handoffResult.handoffMemory.content.includes('## Next Action'));
    console.log(`  ✓ Created HANDOFF memory: ${handoffResult.handoffMemory.id} tied to task ${approvedTask.id}`);

    // Verify latest handoff retrieval
    const retrievedHandoff = await HandoffService.getLatestHandoff(approvedTask.id);
    assert.ok(retrievedHandoff);
    assert.strictEqual(retrievedHandoff.id, handoffResult.handoffMemory.id);
    console.log('  ✓ Retrieved latest handoff record for task successfully.');

    // ------------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------------
    console.log('\n[Cleanup] Cleaning up test data...');
    await query('DELETE FROM projects WHERE id = $1', [project.id]);
    console.log('  ✓ Test project and cascading entities cleaned up.');

    console.log('\n=============================================');
    console.log('🎉 ALL CHUNK 3 LIFECYCLE TESTS PASSED!');
    console.log('=============================================\n');
  } catch (error) {
    console.error('\n❌ Chunk 3 test failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

runLifecycleTests();
