import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { query, closePool } from '../src/config/database.js';

const execFileAsync = promisify(execFile);

// Helper to invoke relay CLI in a specific working directory
async function runRelay(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = path.resolve('bin/relay.js');
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      exitCode: err.code || 1,
    };
  }
}

async function runCliTests() {
  console.log('=== agentRelay CLI Integration Tests (Chunk 8) ===\n');

  // Create isolated temp workspace for test session
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-test-'));
  let projectId: string | null = null;
  let phaseId: string | null = null;
  let taskId: string | null = null;

  try {
    // ------------------------------------------------------------------------
    console.log('[Test 1/8] Testing relay init...');
    // ------------------------------------------------------------------------
    const initRes = await runRelay(
      [
        'init',
        'CLI Test Project',
        '--goal',
        'Testing CLI wrapper parity',
        '--constraints',
        'Postgres and Commander',
        '--repo',
        'https://github.com/org/test-repo',
      ],
      testDir
    );

    assert.strictEqual(initRes.exitCode, 0, `relay init failed: ${initRes.stderr}`);
    assert.ok(initRes.stdout.includes('Initialized agentRelay project successfully'));
    assert.ok(initRes.stdout.includes('Written to .relay.json'));
    assert.ok(initRes.stdout.includes('Added .relay.local.json to .gitignore'));

    // Check .relay.json
    const relayJsonPath = path.join(testDir, '.relay.json');
    assert.ok(fs.existsSync(relayJsonPath), '.relay.json must exist');
    const relayConfig = JSON.parse(fs.readFileSync(relayJsonPath, 'utf-8'));
    assert.ok(relayConfig.projectId, 'projectId must be in .relay.json');
    projectId = relayConfig.projectId;

    // Check .gitignore
    const gitignorePath = path.join(testDir, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist');
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(gitignoreContent.includes('.relay.local.json'), '.gitignore must ignore .relay.local.json');
    console.log('  ✓ relay init created project, .relay.json, and updated .gitignore.');

    // ------------------------------------------------------------------------
    console.log('\n[Test 2/8] Testing relay phase create <name>...');
    // ------------------------------------------------------------------------
    const phaseRes = await runRelay(
      ['phase', 'create', 'Phase 1: Architecture', '--desc', 'Bootstrap service layer and CLI', '--order', '1'],
      testDir
    );

    assert.strictEqual(phaseRes.exitCode, 0, `relay phase create failed: ${phaseRes.stderr}`);
    assert.ok(phaseRes.stdout.includes('Phase created successfully'));
    assert.ok(phaseRes.stdout.includes('Phase 1: Architecture'));
    assert.ok(phaseRes.stdout.includes('Status:       PLANNED'));

    // Verify in database
    const phaseDb = await query('SELECT * FROM phases WHERE project_id = $1', [projectId]);
    assert.strictEqual(phaseDb.rowCount, 1);
    phaseId = phaseDb.rows[0].id;
    assert.strictEqual(phaseDb.rows[0].name, 'Phase 1: Architecture');
    console.log('  ✓ relay phase create successfully created phase in active project.');

    // ------------------------------------------------------------------------
    console.log('\n[Test 3/8] Testing relay task create <title>...');
    // ------------------------------------------------------------------------
    const taskRes = await runRelay(
      ['task', 'create', 'Build CLI wrapper', '--desc', 'Implement 8 subcommands matching spec'],
      testDir
    );

    assert.strictEqual(taskRes.exitCode, 0, `relay task create failed: ${taskRes.stderr}`);
    assert.ok(taskRes.stdout.includes('Task created successfully'));
    assert.ok(taskRes.stdout.includes('Status:       TODO'));

    // Verify in database
    const taskDb = await query('SELECT * FROM tasks WHERE project_id = $1', [projectId]);
    assert.strictEqual(taskDb.rowCount, 1);
    taskId = taskDb.rows[0].id;
    assert.strictEqual(taskDb.rows[0].title, 'Build CLI wrapper');
    assert.strictEqual(taskDb.rows[0].phase_id, phaseId);
    console.log('  ✓ relay task create created TODO task tied to active project and phase.');

    // ------------------------------------------------------------------------
    console.log('\n[Test 4/8] Testing relay task start <id>...');
    // ------------------------------------------------------------------------
    const startRes = await runRelay(['task', 'start', taskId!], testDir);
    assert.strictEqual(startRes.exitCode, 0, `relay task start failed: ${startRes.stderr}`);
    assert.ok(startRes.stdout.includes('Task started and set as active session task'));
    assert.ok(startRes.stdout.includes('Status:       IN_PROGRESS'));
    assert.ok(startRes.stdout.includes('.relay.local.json'));

    // Check .relay.local.json
    const localJsonPath = path.join(testDir, '.relay.local.json');
    assert.ok(fs.existsSync(localJsonPath), '.relay.local.json must exist');
    const localConfig = JSON.parse(fs.readFileSync(localJsonPath, 'utf-8'));
    assert.strictEqual(localConfig.activeTaskId, taskId);

    // Verify status in DB
    const startedTaskDb = await query('SELECT status FROM tasks WHERE id = $1', [taskId]);
    assert.strictEqual(startedTaskDb.rows[0].status, 'IN_PROGRESS');
    console.log('  ✓ relay task start transitioned task to IN_PROGRESS and wrote .relay.local.json.');

    // ------------------------------------------------------------------------
    console.log('\n[Test 5/8] Testing relay memory add decision <content>...');
    // ------------------------------------------------------------------------
    // A: Add first decision using implicit active task
    const decRes1 = await runRelay(
      ['memory', 'add', 'decision', 'Use Commander for CLI framework', '--confidence', 'OBSERVED'],
      testDir
    );
    assert.strictEqual(decRes1.exitCode, 0, `relay memory add decision 1 failed: ${decRes1.stderr}`);
    assert.ok(decRes1.stdout.includes('Decision memory recorded'));
    assert.ok(decRes1.stdout.includes('Use Commander for CLI framework'));

    const decDb1 = await query('SELECT * FROM memories WHERE task_id = $1 AND type = $2', [taskId, 'DECISION']);
    assert.strictEqual(decDb1.rowCount, 1);
    const oldDecId = decDb1.rows[0].id;
    assert.strictEqual(decDb1.rows[0].status, 'ACTIVE');

    // B: Add superseding decision with --supersedes
    const decRes2 = await runRelay(
      [
        'memory',
        'add',
        'decision',
        'Standardize on Commander v15 with ESM and typed subcommands',
        '--supersedes',
        oldDecId,
      ],
      testDir
    );
    assert.strictEqual(decRes2.exitCode, 0, `relay memory add decision 2 failed: ${decRes2.stderr}`);
    assert.ok(decRes2.stdout.includes('Superseded:'));

    // Verify in DB that old decision is SUPERSEDED and new decision is ACTIVE
    const oldCheck = await query('SELECT status, superseded_by FROM memories WHERE id = $1', [oldDecId]);
    assert.strictEqual(oldCheck.rows[0].status, 'SUPERSEDED');
    assert.ok(oldCheck.rows[0].superseded_by);

    console.log('  ✓ relay memory add decision recorded decision and performed atomic supersession.');

    // ------------------------------------------------------------------------
    console.log('\n[Test 6/8] Testing relay memory add failure <content>...');
    // ------------------------------------------------------------------------
    const failRes1 = await runRelay(
      ['memory', 'add', 'failure', 'CLI subcommands failed when run with raw node without dist'],
      testDir
    );
    assert.strictEqual(failRes1.exitCode, 0, `relay memory add failure failed: ${failRes1.stderr}`);
    assert.ok(failRes1.stdout.includes('Failure memory recorded'));
    assert.ok(failRes1.stdout.includes('Hit Count:    1'));

    // Record identical failure to verify hit_count increment and deduplication
    const failRes2 = await runRelay(
      ['memory', 'add', 'failure', 'CLI subcommands failed when run with raw node without dist'],
      testDir
    );
    assert.strictEqual(failRes2.exitCode, 0, `relay memory add failure dedup failed: ${failRes2.stderr}`);
    assert.ok(failRes2.stdout.includes('Hit Count:    2'));

    console.log('  ✓ relay memory add failure recorded error and correctly collapsed duplicates.');

    // ------------------------------------------------------------------------
    console.log('\n[Test 7/8] Testing relay handoff create...');
    // ------------------------------------------------------------------------
    const handoffRes = await runRelay(
      [
        'handoff',
        'create',
        '-c',
        'Implemented CLI commands',
        '-c',
        'Created test suite',
        '-r',
        'Multi-agent simulation in Chunk 9',
        '-i',
        'None currently active',
        '-n',
        'Proceed to Chunk 9 benchmarking',
      ],
      testDir
    );

    assert.strictEqual(handoffRes.exitCode, 0, `relay handoff create failed: ${handoffRes.stderr}`);
    assert.ok(handoffRes.stdout.includes('Handoff record created successfully'));
    assert.ok(handoffRes.stdout.includes('Implemented CLI commands'));
    assert.ok(handoffRes.stdout.includes('Proceed to Chunk 9 benchmarking'));

    const handoffDb = await query('SELECT * FROM memories WHERE task_id = $1 AND type = $2', [taskId, 'HANDOFF']);
    assert.strictEqual(handoffDb.rowCount, 1);
    assert.ok(handoffDb.rows[0].content.includes('Task Handoff'));
    console.log('  ✓ relay handoff create generated structured task-scoped HANDOFF memory.');

    // ------------------------------------------------------------------------
    console.log('\n[Test 8/8] Testing relay context <taskId> exact output...');
    // ------------------------------------------------------------------------
    // Call relay context with active task resolution
    const contextRes = await runRelay(['context'], testDir);
    assert.strictEqual(contextRes.exitCode, 0, `relay context failed: ${contextRes.stderr}`);

    const contextText = contextRes.stdout;

    // Verify raw exact block output without CLI decorators or JSON
    assert.ok(contextText.startsWith('# PROJECT: CLI Test Project'), 'Must start directly with # PROJECT:');
    assert.ok(contextText.includes('## CURRENT PHASE: Phase 1: Architecture'));
    assert.ok(contextText.includes('## CURRENT TASK: Build CLI wrapper [IN_PROGRESS]'));
    assert.ok(contextText.includes('## RELEVANT DECISIONS'));
    assert.ok(contextText.includes('Standardize on Commander v15'));
    assert.ok(contextText.includes('## RELEVANT FAILURES'));
    assert.ok(contextText.includes('CLI subcommands failed when run with raw node'));
    assert.ok(contextText.includes('## HANDOFF'));
    assert.ok(contextText.includes('Proceed to Chunk 9 benchmarking'));

    // Ensure it does not have JSON formatting
    assert.ok(!contextText.trim().startsWith('{'), 'relay context must NOT be raw JSON');

    console.log('  ✓ relay context printed raw compiled context block matching agent prompt format exactly.');

    // ------------------------------------------------------------------------
    // Extra validation: override flags
    // ------------------------------------------------------------------------
    console.log('\n[Validation] Testing --task override flag in isolated empty directory...');
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-empty-'));
    try {
      const overrideRes = await runRelay(['context', taskId!], emptyDir);
      assert.strictEqual(overrideRes.exitCode, 0);
      assert.ok(overrideRes.stdout.includes('# PROJECT: CLI Test Project'));
      console.log('  ✓ Explicit <taskId> parameter works even without local config files.');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    console.log('\n======================================================');
    console.log('🎉 ALL CHUNK 8 CLI INTEGRATION TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    // Cleanup DB and temp workspace
    if (projectId) {
      console.log('[Cleanup] Cleaning up test project and DB records...');
      await query('DELETE FROM projects WHERE id = $1', [projectId]);
      console.log('  ✓ Test project deleted.');
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    await closePool();
  }
}

runCliTests().catch(async (err) => {
  console.error('\n❌ CLI TEST FAILED:', err);
  await closePool();
  process.exit(1);
});
