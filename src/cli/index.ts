import { Command } from 'commander';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { pathToFileURL } from 'url';

import { ProjectModel } from '../models/Project.js';
import { PhaseService } from '../services/phaseService.js';
import { TaskService } from '../services/taskService.js';
import { getCompiledContext } from '../services/contextCompiler.js';
import { closePool } from '../config/database.js';
import { ConfidenceClass } from '../models/types.js';
import {
  handleRecordDecision,
  handleRecordFailure,
  handleUpdateTask,
  handleCreateHandoff,
} from '../mcp/tools.js';
import {
  saveProjectConfig,
  saveLocalConfig,
  ensureGitignoreEntry,
  resolveProjectId,
  resolveTaskId,
  PROJECT_CONFIG_FILE,
  LOCAL_CONFIG_FILE,
} from './config.js';

function parseList(val: string | string[] | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  }
  return val.split(',').map((v) => v.trim()).filter(Boolean);
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('relay')
    .description('agentRelay CLI - Continuity layer for coding agents')
    .version('0.1.0');

  // ==========================================================================
  // relay init [name]
  // ==========================================================================
  program
    .command('init [name]')
    .description('Initialize a new agentRelay project in the current directory')
    .option('-g, --goal <goal>', 'Project goal or high-level purpose')
    .option('-c, --constraints <constraints>', 'Project constraints')
    .option('-r, --repo <repo>', 'Repository URL or reference')
    .action(async (nameArg, options) => {
      try {
        const projectName = nameArg?.trim() || path.basename(process.cwd());
        const project = await ProjectModel.create({
          name: projectName,
          goal: options.goal ?? null,
          constraints: options.constraints ?? null,
          repository_ref: options.repo ?? null,
        });

        saveProjectConfig(project.id);
        const addedToGitignore = ensureGitignoreEntry(LOCAL_CONFIG_FILE);

        console.log(`\n✓ Initialized agentRelay project successfully!`);
        console.log(`  Project ID:   ${project.id}`);
        console.log(`  Name:         ${project.name}`);
        if (project.goal) console.log(`  Goal:         ${project.goal}`);
        if (project.constraints) console.log(`  Constraints:  ${project.constraints}`);
        if (project.repository_ref) console.log(`  Repository:   ${project.repository_ref}`);
        console.log(`  Config:       Written to ${PROJECT_CONFIG_FILE}`);
        if (addedToGitignore) {
          console.log(`  Gitignore:    Added ${LOCAL_CONFIG_FILE} to .gitignore`);
        }
        console.log('');
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  // ==========================================================================
  // relay phase create <name>
  // ==========================================================================
  const phaseCmd = program.command('phase').description('Phase management commands');

  phaseCmd
    .command('create <name>')
    .description('Create a new phase in the active project')
    .option('-p, --project <projectId>', 'Project UUID (defaults to .relay.json)')
    .option('-d, --desc <description>', 'Phase description')
    .option('-o, --order <order>', 'Order index for the phase', '0')
    .action(async (name, options) => {
      try {
        const projectId = resolveProjectId(options.project);
        const orderIndex = Number(options.order) || 0;

        const phase = await PhaseService.createPhase({
          project_id: projectId,
          name: name.trim(),
          description: options.desc ?? null,
          order_index: orderIndex,
        });

        console.log(`\n✓ Phase created successfully!`);
        console.log(`  Phase ID:     ${phase.id}`);
        console.log(`  Project ID:   ${phase.project_id}`);
        console.log(`  Name:         ${phase.name}`);
        console.log(`  Status:       ${phase.status}`);
        console.log(`  Order Index:  ${phase.order_index}`);
        if (phase.description) console.log(`  Description:  ${phase.description}`);
        console.log('');
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  // ==========================================================================
  // relay task create <title> & relay task start <id>
  // ==========================================================================
  const taskCmd = program.command('task').description('Task management commands');

  taskCmd
    .command('create <title>')
    .description('Create a new task in the active project')
    .option('-p, --project <projectId>', 'Project UUID (defaults to .relay.json)')
    .option('--phase <phaseId>', 'Phase UUID')
    .option('-d, --desc <description>', 'Task description')
    .action(async (title, options) => {
      try {
        const projectId = resolveProjectId(options.project);
        let phaseId = options.phase ?? null;
        if (!phaseId) {
          const phases = await PhaseService.listPhases(projectId);
          const activeOrPlanned = phases.find((p) => p.status === 'ACTIVE' || p.status === 'PLANNED') || phases[0];
          if (activeOrPlanned) {
            phaseId = activeOrPlanned.id;
          }
        }

        const task = await TaskService.createTask({
          project_id: projectId,
          phase_id: phaseId,
          title: title.trim(),
          description: options.desc ?? null,
        });

        console.log(`\n✓ Task created successfully!`);
        console.log(`  Task ID:      ${task.id}`);
        console.log(`  Project ID:   ${task.project_id}`);
        if (task.phase_id) console.log(`  Phase ID:     ${task.phase_id}`);
        console.log(`  Title:        ${task.title}`);
        console.log(`  Status:       ${task.status}`);
        if (task.description) console.log(`  Description:  ${task.description}`);
        console.log('');
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  taskCmd
    .command('start <id>')
    .description('Start a task (set status to IN_PROGRESS and mark as active in .relay.local.json)')
    .action(async (id) => {
      try {
        const updatedTask = await handleUpdateTask({
          taskId: id.trim(),
          status: 'IN_PROGRESS',
        });

        saveLocalConfig({ activeTaskId: updatedTask.id, activePhaseId: updatedTask.phase_id ?? undefined });

        console.log(`\n✓ Task started and set as active session task!`);
        console.log(`  Task ID:      ${updatedTask.id}`);
        console.log(`  Title:        ${updatedTask.title}`);
        console.log(`  Status:       ${updatedTask.status}`);
        console.log(`  Local Session: Recorded active task in ${LOCAL_CONFIG_FILE}`);
        console.log('');
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  // ==========================================================================
  // relay memory add decision <content> & relay memory add failure <content>
  // ==========================================================================
  const memoryCmd = program.command('memory').description('Memory recording commands');
  const memoryAddCmd = memoryCmd.command('add').description('Add memory to the active task');

  memoryAddCmd
    .command('decision <content>')
    .description('Record an architectural or implementation decision')
    .option('-t, --task <taskId>', 'Task UUID (defaults to active task in .relay.local.json)')
    .option(
      '--confidence <class>',
      'Confidence class: OBSERVED, INFERRED, or SUGGESTED',
      'OBSERVED'
    )
    .option('--causal-parent <ids...>', 'UUIDs of causal parent memories')
    .option('--supersedes <memoryId>', 'UUID of previous decision memory to supersede')
    .action(async (content, options) => {
      try {
        const taskId = resolveTaskId(options.task);
        const confidenceClass = (options.confidence?.toUpperCase() ||
          'OBSERVED') as ConfidenceClass;
        const causalParents = parseList(options.causalParent);

        const result = await handleRecordDecision({
          taskId,
          content: content.trim(),
          confidenceClass,
          causalParents,
          supersedesMemoryId: options.supersedes?.trim(),
        });

        console.log(`\n✓ Decision memory recorded!`);
        console.log(`  Memory ID:    ${result.decision.id}`);
        console.log(`  Task ID:      ${result.decision.task_id}`);
        console.log(
          `  Confidence:   ${result.decision.confidence_class} (${Number(result.decision.confidence_score).toFixed(2)})`
        );
        console.log(`  Hit Count:    ${result.decision.hit_count}`);
        console.log(`  Content:      ${result.decision.content}`);
        if (result.supersededMemory) {
          console.log(`  Superseded:   ${result.supersededMemory.id} (status: SUPERSEDED)`);
        }
        if (causalParents.length > 0) {
          console.log(`  Causal Parents: [${causalParents.join(', ')}]`);
        }
        console.log('');
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  memoryAddCmd
    .command('failure <content>')
    .description('Record an encountered failure or error')
    .option('-t, --task <taskId>', 'Task UUID (defaults to active task in .relay.local.json)')
    .option(
      '--confidence <class>',
      'Confidence class: OBSERVED, INFERRED, or SUGGESTED',
      'OBSERVED'
    )
    .option('--causal-parent <ids...>', 'UUIDs of causal parent memories')
    .action(async (content, options) => {
      try {
        const taskId = resolveTaskId(options.task);
        const confidenceClass = (options.confidence?.toUpperCase() ||
          'OBSERVED') as ConfidenceClass;
        const causalParents = parseList(options.causalParent);

        const memory = await handleRecordFailure({
          taskId,
          content: content.trim(),
          confidenceClass,
          causalParents,
        });

        console.log(`\n✓ Failure memory recorded!`);
        console.log(`  Memory ID:    ${memory.id}`);
        console.log(`  Task ID:      ${memory.task_id}`);
        console.log(
          `  Confidence:   ${memory.confidence_class} (${Number(memory.confidence_score).toFixed(2)})`
        );
        console.log(`  Hit Count:    ${memory.hit_count}`);
        console.log(`  Content:      ${memory.content}`);
        if (causalParents.length > 0) {
          console.log(`  Causal Parents: [${causalParents.join(', ')}]`);
        }
        console.log('');
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  // ==========================================================================
  // relay handoff create
  // ==========================================================================
  const handoffCmd = program.command('handoff').description('Handoff management commands');

  handoffCmd
    .command('create')
    .description('Create a structured task handoff record for the incoming agent')
    .option('-t, --task <taskId>', 'Task UUID (defaults to active task in .relay.local.json)')
    .option('-c, --completed <items...>', 'Completed items (repeatable or comma-separated)')
    .option('-r, --remaining <items...>', 'Remaining items (repeatable or comma-separated)')
    .option('-n, --next <action>', 'Immediate next action instruction')
    .option('-i, --issue <issue>', 'Active bug, blocker, or unexpected behavior')
    .action(async (options) => {
      try {
        const taskId = resolveTaskId(options.task);
        let completedItems = parseList(options.completed);
        let remainingItems = parseList(options.remaining);
        let nextAction = options.next?.trim();
        let currentIssue = options.issue?.trim() || undefined;

        // If running in an interactive terminal and essential inputs were omitted, prompt the user
        const isInteractive = Boolean(process.stdin.isTTY);
        if (isInteractive && (completedItems.length === 0 || remainingItems.length === 0 || !nextAction)) {
          console.log(`\n--- Interactive Handoff Creation ---`);
          const rl = readline.createInterface({ input, output });
          try {
            if (completedItems.length === 0) {
              const comp = await rl.question('Completed items (comma-separated): ');
              completedItems = parseList(comp);
            }
            if (remainingItems.length === 0) {
              const rem = await rl.question('Remaining items (comma-separated): ');
              remainingItems = parseList(rem);
            }
            if (!currentIssue) {
              const issue = await rl.question('Current issue (optional, press Enter to skip): ');
              if (issue.trim()) currentIssue = issue.trim();
            }
            if (!nextAction) {
              const next = await rl.question('Next action for incoming agent: ');
              nextAction = next.trim();
            }
          } finally {
            rl.close();
          }
        }

        if (completedItems.length === 0) {
          throw new Error('Handoff requires at least one completed item (--completed).');
        }
        if (remainingItems.length === 0) {
          throw new Error('Handoff requires at least one remaining item (--remaining).');
        }
        if (!nextAction) {
          throw new Error('Handoff requires a next action instruction (--next).');
        }

        const handoffMemory = await handleCreateHandoff({
          taskId,
          completedItems,
          remainingItems,
          currentIssue,
          nextAction,
        });

        console.log(`\n✓ Handoff record created successfully!`);
        console.log(`  Memory ID:        ${handoffMemory.id}`);
        console.log(`  Task ID:          ${handoffMemory.task_id}`);
        console.log(`  Completed Items:`);
        for (const item of completedItems) {
          console.log(`    - ${item}`);
        }
        console.log(`  Remaining Items:`);
        for (const item of remainingItems) {
          console.log(`    - ${item}`);
        }
        if (currentIssue) {
          console.log(`  Current Issue:    ${currentIssue}`);
        }
        console.log(`  Next Action:      ${nextAction}`);
        console.log('');
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  // ==========================================================================
  // relay context [taskId]
  // ==========================================================================
  program
    .command('context [taskId]')
    .description('Print compiled context block for a task exactly as an agent receives it')
    .option('-b, --budget <tokens>', 'Total token budget', '600')
    .option('-q, --query <query>', 'Semantic search query')
    .option('--recent-limit <limit>', 'Maximum recent changes to retrieve', '10')
    .action(async (taskIdArg, options) => {
      try {
        const taskId = resolveTaskId(taskIdArg);
        const totalTokenBudget = options.budget ? Number(options.budget) : 600;
        const recentChangesLimit = options.recentLimit ? Number(options.recentLimit) : 10;
        const semanticQuery = options.query?.trim() || undefined;

        const result = await getCompiledContext(taskId, {
          totalTokenBudget,
          semanticQuery,
          recentChangesLimit,
        });

        // Exact requirement: print the compiled context block EXACTLY as an agent would receive it
        process.stdout.write(result.compiledText + '\n');
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } finally {
    await closePool();
  }
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
}
