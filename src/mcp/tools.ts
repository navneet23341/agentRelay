import { getClient } from '../config/database.js';
import {
  ProjectService,
  TaskService,
  MemoryService,
  HandoffService,
  getCompiledContext,
  EmbeddingService,
  computeSemanticHash,
} from '../services/index.js';
import {
  ConfidenceClass,
  CONFIDENCE_CLASS_SCORES,
  MemoryStatus,
  MemoryType,
  TaskStatus,
} from '../models/types.js';

export const TOOL_SCHEMAS = [
  {
    name: 'get_project_state',
    description:
      'Retrieve the high-level state of a project, including its goal, constraints, repository reference, the ordered sequence of phases with their statuses, and task counts grouped by status. Call this at session start to understand project-wide scope, conventions, and progress.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the project to inspect.',
        },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_current_task',
    description:
      'Retrieve detailed metadata for a specific task by its UUID, including title, full description, current status, associated phase ID, project ID, and whether it was reopened from a prior state (reopened_from).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the task to retrieve.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_memory',
    description:
      "Perform semantic similarity search across project memories using pgvector cosine distance, with optional structured filters for task, phase, memory type, or status. Use this for ad-hoc semantic research (e.g. 'why did we choose PostgreSQL over SQLite', 'auth migration failures').",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural language query describing the knowledge, architectural reasoning, or errors you are searching for.',
        },
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'Optional: Restrict search to memories produced under a specific task UUID.',
        },
        phaseId: {
          type: 'string',
          format: 'uuid',
          description: 'Optional: Restrict search to memories belonging to tasks in a specific phase UUID.',
        },
        type: {
          type: 'string',
          enum: ['DECISION', 'FAILURE', 'CHANGE', 'OBSERVATION', 'HANDOFF'],
          description: 'Optional: Filter results to a specific memory type.',
        },
        status: {
          type: 'string',
          enum: ['ACTIVE', 'SUPERSEDED', 'INVALIDATED', 'ALL'],
          default: 'ACTIVE',
          description: 'Optional: Filter by memory lifecycle status. Defaults to ACTIVE.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Optional: Maximum number of memories to return (default 10).',
        },
        minSimilarity: {
          type: 'number',
          minimum: 0.0,
          maximum: 1.0,
          default: 0.5,
          description: 'Optional: Minimum cosine similarity threshold between 0.0 and 1.0 (default 0.5).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_relevant_context',
    description:
      'Compile a token-budgeted, deduplicated context block for continuing work on a task without rediscovering the repository. Returns formatted sections (PROJECT, CURRENT PHASE, CURRENT TASK, RELEVANT DECISIONS, RELEVANT FAILURES, RECENT CHANGES, HANDOFF) with exponential time-decay on failures, hit-boosted scoring, 1-hop causal parents (deduplicated), and full token budget accounting.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the task you are currently working on.',
        },
        totalTokenBudget: {
          type: 'integer',
          minimum: 100,
          default: 4000,
          description:
            'Total token budget allocated for the context block (default 4000). Fixed scaffolding (headers + handoff) is subtracted first, and the remaining tokens are packed 80% for memories and 20% reserved for scratchpad.',
        },
        semanticQuery: {
          type: 'string',
          description:
            'Optional query to search and merge relevant vector memories into the candidate pool from outside the immediate task/phase scope.',
        },
        recentChangesLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          default: 10,
          description: 'Maximum number of recent changes across the current phase to include (default 10).',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_decision',
    description:
      'Record an architectural or design decision made during task execution. Decisions never decay over time. Use this whenever adopting a library, selecting an algorithm, designing a schema, or establishing conventions so future agents maintain continuity.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the task in which this decision is being made.',
        },
        content: {
          type: 'string',
          description: 'Clear statement of the decision and its technical rationale.',
        },
        confidenceClass: {
          type: 'string',
          enum: ['OBSERVED', 'INFERRED', 'SUGGESTED'],
          default: 'OBSERVED',
          description:
            'Confidence level: OBSERVED (verified/explicit choice, score 1.0), INFERRED (derived from code/system, score 0.7), or SUGGESTED (proposed idea, score 0.3).',
        },
        causalParents: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Optional: UUIDs of prior memories (e.g. failures or observations) that directly led to this decision.',
        },
        supersedesMemoryId: {
          type: 'string',
          format: 'uuid',
          description: 'Optional: If this decision replaces or updates a prior decision, provide the UUID of the old memory to mark it SUPERSEDED.',
        },
      },
      required: ['taskId', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_failure',
    description:
      'Record a test failure, build error, exception, or blocker encountered during task execution. Failures decay exponentially over time unless the task remains active. Repeated identical errors within the same task automatically increment hit_count via semantic hashing instead of duplicating rows.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the task where the failure occurred.',
        },
        content: {
          type: 'string',
          description: 'The error message, failure signature, stack trace, or symptoms observed.',
        },
        confidenceClass: {
          type: 'string',
          enum: ['OBSERVED', 'INFERRED', 'SUGGESTED'],
          default: 'OBSERVED',
          description: 'Confidence level of the failure observation (default OBSERVED).',
        },
        causalParents: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Optional: UUIDs of memories (e.g. recent CHANGE memories) that caused or introduced this failure.',
        },
      },
      required: ['taskId', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_task',
    description:
      'Update the status of a task according to the task state machine rules.\n\nValid standard transitions:\n- From TODO: IN_PROGRESS, CANCELLED\n- From IN_PROGRESS: COMPLETED, FAILED, BLOCKED, CANCELLED, TODO\n- From BLOCKED: IN_PROGRESS, TODO, CANCELLED\n\nTo reopen a finished task (COMPLETED, FAILED, CANCELLED) back to TODO, set isReopen=true (this records reopened_from and clears completed_at).\n\nRestrictions: Tasks in PENDING_REVIEW cannot be updated with this tool (they must be reviewed by a human), and status cannot be set to PENDING_REVIEW directly.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the task to update.',
        },
        status: {
          type: 'string',
          enum: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'],
          description: 'The target status for the task.',
        },
        isReopen: {
          type: 'boolean',
          default: false,
          description: 'Set to true if explicitly reopening a previously completed, failed, or cancelled task back to TODO.',
        },
      },
      required: ['taskId', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_handoff',
    description:
      'Create a structured handoff record tied to the current task before ending your session. Summarizes completed items, remaining work, active issues, and the exact next action for the incoming agent. Stored as an active HANDOFF memory scoped to this task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the task being handed off.',
        },
        completedItems: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of milestones, features, fixes, or tests completed during this session.',
        },
        remainingItems: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of remaining items or pending requirements for this task.',
        },
        currentIssue: {
          type: 'string',
          description: 'Optional: Description of any active bug, blocker, or unexpected behavior currently impeding progress.',
        },
        nextAction: {
          type: 'string',
          description: 'Clear, imperative instruction detailing the immediate next action the incoming agent should execute.',
        },
      },
      required: ['taskId', 'completedItems', 'remainingItems', 'nextAction'],
      additionalProperties: false,
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

export async function handleGetProjectState(args: { projectId: string }) {
  if (!args.projectId) {
    throw new Error('[get_project_state] Missing required parameter "projectId"');
  }
  return await ProjectService.getProjectState(args.projectId);
}

export async function handleGetCurrentTask(args: { taskId: string }) {
  if (!args.taskId) {
    throw new Error('[get_current_task] Missing required parameter "taskId"');
  }
  const task = await TaskService.getTaskById(args.taskId);
  if (!task) {
    throw new Error(`[get_current_task] Task with ID "${args.taskId}" not found`);
  }
  return task;
}

export async function handleSearchMemory(args: {
  query: string;
  taskId?: string;
  phaseId?: string;
  type?: MemoryType;
  status?: MemoryStatus | 'ALL';
  limit?: number;
  minSimilarity?: number;
}) {
  if (!args.query) {
    throw new Error('[search_memory] Missing required parameter "query"');
  }
  return await MemoryService.searchMemory(args.query, {
    taskId: args.taskId,
    phaseId: args.phaseId,
    type: args.type,
    status: args.status ?? 'ACTIVE',
    limit: args.limit ?? 10,
    minSimilarity: args.minSimilarity ?? 0.5,
  });
}

export async function handleGetRelevantContext(args: {
  taskId: string;
  totalTokenBudget?: number;
  semanticQuery?: string;
  recentChangesLimit?: number;
}) {
  if (!args.taskId) {
    throw new Error('[get_relevant_context] Missing required parameter "taskId"');
  }
  return await getCompiledContext(args.taskId, {
    totalTokenBudget: args.totalTokenBudget,
    semanticQuery: args.semanticQuery,
    recentChangesLimit: args.recentChangesLimit,
  });
}

export async function handleRecordDecision(args: {
  taskId: string;
  content: string;
  confidenceClass?: ConfidenceClass;
  causalParents?: string[];
  supersedesMemoryId?: string;
}) {
  const {
    taskId,
    content,
    confidenceClass = 'OBSERVED',
    causalParents = [],
    supersedesMemoryId,
  } = args;

  if (!taskId) {
    throw new Error('[record_decision] Missing required parameter "taskId"');
  }
  if (!content) {
    throw new Error('[record_decision] Missing required parameter "content"');
  }

  // 1. Upfront task validation
  const task = await TaskService.getTaskById(taskId);
  if (!task) {
    throw new Error(`[record_decision] Task with ID "${taskId}" not found`);
  }

  const confidenceScore = CONFIDENCE_CLASS_SCORES[confidenceClass] ?? 1.0;
  const semanticHash = computeSemanticHash(content, 'DECISION');

  // 2. Generate embedding outside of DB transaction to avoid holding open locks
  const embeddingVector = await EmbeddingService.generateEmbedding(content);
  const formattedEmbedding = Array.isArray(embeddingVector)
    ? `[${embeddingVector.join(',')}]`
    : embeddingVector ?? null;

  // 3. Atomic execution wrapped in a single database transaction
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // If supersedesMemoryId is provided, lock and verify old memory inside transaction
    if (supersedesMemoryId) {
      const oldCheck = await client.query(
        'SELECT id, type, status FROM memories WHERE id = $1 FOR UPDATE',
        [supersedesMemoryId]
      );

      if (oldCheck.rowCount === 0) {
        throw new Error(
          `[record_decision] Target memory to supersede "${supersedesMemoryId}" not found`
        );
      }

      if (oldCheck.rows[0].status !== 'ACTIVE') {
        throw new Error(
          `[record_decision] Cannot supersede memory "${supersedesMemoryId}" because its status is "${oldCheck.rows[0].status}" (must be ACTIVE)`
        );
      }
    }

    // Validate causal parents inside transaction
    if (causalParents.length > 0) {
      const parentIds = [...new Set(causalParents)];
      const parentCheck = await client.query(
        'SELECT id FROM memories WHERE id = ANY($1::uuid[])',
        [parentIds]
      );
      if (parentCheck.rowCount !== parentIds.length) {
        const found = new Set(parentCheck.rows.map((r: { id: string }) => r.id));
        const missing = parentIds.filter((id) => !found.has(id));
        throw new Error(
          `[record_decision] Invalid causalParents: ID(s) do not exist: [${missing.join(', ')}]`
        );
      }
    }

    // Insert new DECISION
    const insertSql = `
      INSERT INTO memories (
        type, content, embedding, confidence_class, confidence_score,
        status, task_id, semantic_hash, hit_count, last_seen_at, causal_parents
      ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, 1, CURRENT_TIMESTAMP, $8)
      RETURNING *;
    `;
    const insertRes = await client.query(insertSql, [
      'DECISION',
      content,
      formattedEmbedding,
      confidenceClass,
      confidenceScore,
      taskId,
      semanticHash,
      causalParents,
    ]);
    const newDecision = insertRes.rows[0];

    // Atomically mark old memory as SUPERSEDED
    let supersededMemory = null;
    if (supersedesMemoryId) {
      const updateSql = `
        UPDATE memories
        SET status = 'SUPERSEDED',
            superseded_by = $2
        WHERE id = $1
        RETURNING *;
      `;
      const updateRes = await client.query(updateSql, [
        supersedesMemoryId,
        newDecision.id,
      ]);
      supersededMemory = updateRes.rows[0];
    }

    await client.query('COMMIT');

    return {
      decision: {
        ...newDecision,
        confidence_score: Number(newDecision.confidence_score),
      },
      supersededMemory: supersededMemory
        ? {
            ...supersededMemory,
            confidence_score: Number(supersededMemory.confidence_score),
          }
        : null,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function handleRecordFailure(args: {
  taskId: string;
  content: string;
  confidenceClass?: ConfidenceClass;
  causalParents?: string[];
}) {
  if (!args.taskId) {
    throw new Error('[record_failure] Missing required parameter "taskId"');
  }
  if (!args.content) {
    throw new Error('[record_failure] Missing required parameter "content"');
  }

  const res = await MemoryService.createMemory({
    type: 'FAILURE',
    task_id: args.taskId,
    content: args.content,
    confidence_class: args.confidenceClass ?? 'OBSERVED',
    causal_parents: args.causalParents ?? [],
  });

  return res.memory;
}

export async function handleUpdateTask(args: {
  taskId: string;
  status: TaskStatus;
  isReopen?: boolean;
}) {
  const { taskId, status, isReopen = false } = args;

  if (!taskId) {
    throw new Error('[update_task] Missing required parameter "taskId"');
  }
  if (!status) {
    throw new Error('[update_task] Missing required parameter "status"');
  }

  // 1. Explicitly reject PENDING_REVIEW as target status
  if ((status as string) === 'PENDING_REVIEW') {
    throw new Error(
      `[update_task] Cannot set task status directly to "PENDING_REVIEW". Use suggestTask to create a task suggestion.`
    );
  }

  // 2. Fetch current task state
  const current = await TaskService.getTaskById(taskId);
  if (!current) {
    throw new Error(`[update_task] Task with ID "${taskId}" not found`);
  }

  // 3. Explicitly reject updating a task currently in PENDING_REVIEW
  if (current.status === 'PENDING_REVIEW') {
    throw new Error(
      `[update_task] Task "${taskId}" is currently in "PENDING_REVIEW". It cannot be modified via update_task; it must be approved via approveSuggestion or rejected via rejectSuggestion.`
    );
  }

  // 4. Delegate to state machine logic
  if (isReopen) {
    return await TaskService.reopenTask(taskId);
  }
  return await TaskService.updateTaskStatus(taskId, status);
}

export async function handleCreateHandoff(args: {
  taskId: string;
  completedItems: string[];
  remainingItems: string[];
  currentIssue?: string | null;
  nextAction: string;
}) {
  if (!args.taskId) {
    throw new Error('[create_handoff] Missing required parameter "taskId"');
  }
  if (!args.completedItems || !Array.isArray(args.completedItems)) {
    throw new Error('[create_handoff] Missing required parameter "completedItems" (array)');
  }
  if (!args.remainingItems || !Array.isArray(args.remainingItems)) {
    throw new Error('[create_handoff] Missing required parameter "remainingItems" (array)');
  }
  if (!args.nextAction) {
    throw new Error('[create_handoff] Missing required parameter "nextAction"');
  }

  const result = await HandoffService.createHandoff(args.taskId, {
    completedItems: args.completedItems,
    remainingItems: args.remainingItems,
    currentIssue: args.currentIssue,
    nextAction: args.nextAction,
  });

  return result.handoffMemory;
}

export async function dispatchToolCall(name: string, args: Record<string, any>) {
  switch (name) {
    case 'get_project_state':
      return await handleGetProjectState(args as any);
    case 'get_current_task':
      return await handleGetCurrentTask(args as any);
    case 'search_memory':
      return await handleSearchMemory(args as any);
    case 'get_relevant_context':
      return await handleGetRelevantContext(args as any);
    case 'record_decision':
      return await handleRecordDecision(args as any);
    case 'record_failure':
      return await handleRecordFailure(args as any);
    case 'update_task':
      return await handleUpdateTask(args as any);
    case 'create_handoff':
      return await handleCreateHandoff(args as any);
    default:
      throw new Error(`Unknown tool: "${name}"`);
  }
}
