import { getEncoding, Tiktoken } from 'js-tiktoken';
import { query } from '../config/database.js';
import {
  IMemory,
  IMemoryWithDepth,
  MemoryType,
  TaskStatus,
  IProject,
  IPhase,
  ITask,
} from '../models/types.js';
import { ProjectModel } from '../models/Project.js';
import { TaskService } from './taskService.js';
import { PhaseService } from './phaseService.js';
import { MemoryService } from './memoryService.js';
import { HandoffService } from './handoffService.js';

export interface DecayConfig {
  lambdas: Record<MemoryType, number>;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  lambdas: {
    FAILURE: Math.LN2 / (4 * 3600), // ~4.81e-5 s^-1 (4h half-life)
    OBSERVATION: Math.LN2 / (24 * 3600), // ~8.02e-6 s^-1 (24h half-life)
    DECISION: 0,
    CHANGE: 0,
    HANDOFF: 0,
  },
};

export type DecayMemoryInput = Pick<
  IMemory,
  'type' | 'confidence_score' | 'created_at' | 'last_seen_at' | 'task_id'
> & { id?: string };

export interface DecayOptions {
  taskStatus?: TaskStatus | null;
  now?: Date;
  config?: DecayConfig;
}

/**
 * Computes decayed relevance for a memory.
 *
 * Rules:
 * 1. DECISION, CHANGE, and HANDOFF never decay (relevance = confidence_score).
 * 2. Only OBSERVATION and FAILURE decay based on e^(-lambda * elapsed_seconds).
 * 3. Memories belonging to an active task (IN_PROGRESS or BLOCKED) do NOT decay,
 *    protecting vital debugging context across multi-hour or multi-day session gaps.
 * 4. Fails loud: If memory.task_id is present, caller MUST pass taskStatus (cannot be null/undefined).
 * 5. Uses last_seen_at (falling back to created_at if null) as the decay anchor.
 */
export function computeMemoryDecay(
  memory: DecayMemoryInput & { task_id: string },
  options: { taskStatus: TaskStatus; now?: Date; config?: DecayConfig }
): number;
export function computeMemoryDecay(
  memory: DecayMemoryInput & { task_id?: null },
  options?: { taskStatus?: null; now?: Date; config?: DecayConfig }
): number;
export function computeMemoryDecay(
  memory: DecayMemoryInput,
  options?: DecayOptions
): number;
export function computeMemoryDecay(
  memory: DecayMemoryInput,
  options: DecayOptions = {}
): number {
  const { now = new Date(), taskStatus = null, config = DEFAULT_DECAY_CONFIG } = options;

  // Runtime enforcement: If memory has a task_id, taskStatus must be explicitly provided
  if (memory.task_id && !options?.taskStatus) {
    throw new Error(
      `[computeMemoryDecay] Missing required taskStatus for memory "${memory.id ?? 'unknown'}" tied to task_id "${memory.task_id}". ` +
        `Candidate memories must be joined to their actual task status to prevent accidental context erasure.`
    );
  }

  const score = Number(memory.confidence_score);

  // 1. Type gate: Only OBSERVATION and FAILURE decay.
  const lambda = config.lambdas[memory.type] ?? 0;
  if (lambda === 0) {
    return score;
  }

  // 2. Open task immunity: Never decay memories on IN_PROGRESS or BLOCKED tasks.
  if (taskStatus === 'IN_PROGRESS' || taskStatus === 'BLOCKED') {
    return score;
  }

  // 3. Anchor: Use last_seen_at if present, falling back to created_at
  const anchorDate = memory.last_seen_at ? new Date(memory.last_seen_at) : new Date(memory.created_at);
  const elapsedSeconds = Math.max(0, (now.getTime() - anchorDate.getTime()) / 1000);

  return score * Math.exp(-lambda * elapsedSeconds);
}

export interface ScoringConfig extends DecayConfig {
  maxBoostHits: number;
  hitBoostRate: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  ...DEFAULT_DECAY_CONFIG,
  maxBoostHits: 5,
  hitBoostRate: 0.1,
};

export interface ScoreOptions extends DecayOptions {
  scoringConfig?: ScoringConfig;
}

/**
 * Computes hit_count multiplier boost:
 * multiplier = 1 + 0.1 * min(max(hit_count - 1, 0), max_boost_hits)
 * Caps out at +50% (1.5x) for hit_count >= 6.
 */
export function computeHitBoost(
  hitCount: number = 1,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): number {
  const effectiveHits = Math.max(0, (hitCount || 1) - 1);
  const cappedHits = Math.min(effectiveHits, config.maxBoostHits);
  return 1 + config.hitBoostRate * cappedHits;
}

/**
 * Scores a candidate memory by combining decayed relevance with hit_count boost:
 * score = decayed_relevance * (1 + 0.1 * min(hit_count - 1, 5))
 */
export function scoreMemory(
  memory: DecayMemoryInput & { hit_count?: number; task_id: string },
  options: { taskStatus: TaskStatus; now?: Date; scoringConfig?: ScoringConfig; config?: DecayConfig }
): number;
export function scoreMemory(
  memory: DecayMemoryInput & { hit_count?: number; task_id?: null },
  options?: { taskStatus?: null; now?: Date; scoringConfig?: ScoringConfig; config?: DecayConfig }
): number;
export function scoreMemory(
  memory: DecayMemoryInput & { hit_count?: number },
  options?: ScoreOptions
): number;
export function scoreMemory(
  memory: DecayMemoryInput & { hit_count?: number },
  options: ScoreOptions = {}
): number {
  const decayedRelevance = computeMemoryDecay(memory as any, options);
  const scoringConfig = options.scoringConfig ?? DEFAULT_SCORING_CONFIG;
  const boost = computeHitBoost(memory.hit_count ?? 1, scoringConfig);
  return decayedRelevance * boost;
}

export interface ScoredMemory extends IMemory {
  task_status: TaskStatus | null;
  decayed_relevance: number;
  score: number;
  causal_lineage?: IMemoryWithDepth[];
}

export interface CompilerRetrievalOptions {
  now?: Date;
  scoringConfig?: ScoringConfig;
  semanticQuery?: string;
  semanticLimit?: number;
  semanticMinSimilarity?: number;
  enrichCausalLineage?: boolean;
  maxCausalDepth?: number;
  recentChangesLimit?: number;
}

/**
 * Item 3 (Compiler Retrieval):
 * Given a taskId, retrieves candidate memories using structured filters:
 * 1. Active memories directly under the current task
 * 2. Active architectural DECISION memories across current phase (unbounded)
 * 3. Active recent CHANGE memories across current phase (capped by recentChangesLimit, default 10)
 * 4. Active FAILURE memories from open sibling tasks in current phase (IN_PROGRESS or BLOCKED)
 * 5. (Optional) Semantic similarity query merged into candidate pool
 *
 * All candidates are joined with their task status to ensure fail-loud decay evaluation,
 * scored via scoreMemory(), ranked by score DESC, and enriched with 1-hop causal parents.
 */
export async function retrieveCandidateMemories(
  taskId: string,
  options: CompilerRetrievalOptions = {}
): Promise<ScoredMemory[]> {
  const task = await TaskService.getTaskById(taskId);
  if (!task) {
    throw new Error(`[retrieveCandidateMemories] Task with id "${taskId}" not found.`);
  }

  const {
    now = new Date(),
    scoringConfig = DEFAULT_SCORING_CONFIG,
    semanticQuery,
    semanticLimit = 10,
    semanticMinSimilarity = 0.5,
    enrichCausalLineage = true,
    maxCausalDepth = 1,
    recentChangesLimit = 10,
  } = options;

  let candidateRows: Array<IMemory & { task_status: TaskStatus | null }> = [];

  if (task.phase_id) {
    const sql = `
      WITH current_task_memories AS (
        -- 1. All active memories created directly under the target task (excluding HANDOFF)
        SELECT m.*, t.status AS task_status
        FROM memories m
        JOIN tasks t ON m.task_id = t.id
        WHERE m.status = 'ACTIVE'
          AND m.task_id = $1
          AND m.type != 'HANDOFF'
      ),
      phase_decisions AS (
        -- 2. Enduring architectural decisions made across the current phase (unbounded)
        SELECT m.*, t.status AS task_status
        FROM memories m
        JOIN tasks t ON m.task_id = t.id
        WHERE m.status = 'ACTIVE'
          AND t.phase_id = $2
          AND m.type = 'DECISION'
      ),
      recent_phase_changes AS (
        -- 3. Capped recent changes across the current phase
        SELECT m.*, t.status AS task_status
        FROM memories m
        JOIN tasks t ON m.task_id = t.id
        WHERE m.status = 'ACTIVE'
          AND t.phase_id = $2
          AND m.type = 'CHANGE'
        ORDER BY m.created_at DESC
        LIMIT $3
      ),
      sibling_task_failures AS (
        -- 4. Active blockers/failures from open sibling tasks in the current phase
        SELECT m.*, t.status AS task_status
        FROM memories m
        JOIN tasks t ON m.task_id = t.id
        WHERE m.status = 'ACTIVE'
          AND t.phase_id = $2
          AND t.id != $1
          AND t.status IN ('IN_PROGRESS', 'BLOCKED')
          AND m.type = 'FAILURE'
      ),
      combined_candidates AS (
        SELECT * FROM current_task_memories
        UNION ALL
        SELECT * FROM phase_decisions
        UNION ALL
        SELECT * FROM recent_phase_changes
        UNION ALL
        SELECT * FROM sibling_task_failures
      )
      SELECT DISTINCT ON (id) *
      FROM combined_candidates
      ORDER BY id, created_at DESC;
    `;

    const res = await query(sql, [task.id, task.phase_id, recentChangesLimit]);
    candidateRows = res.rows.map((row: any) => ({
      ...row,
      confidence_score: Number(row.confidence_score),
      hit_count: Number(row.hit_count),
    }));
  } else {
    // Unassigned phase: target task only (excluding HANDOFF)
    const sql = `
      SELECT m.*, t.status AS task_status
      FROM memories m
      JOIN tasks t ON m.task_id = t.id
      WHERE m.status = 'ACTIVE'
        AND m.task_id = $1
        AND m.type != 'HANDOFF'
      ORDER BY m.id, m.created_at DESC;
    `;

    const res = await query(sql, [task.id]);
    candidateRows = res.rows.map((row: any) => ({
      ...row,
      confidence_score: Number(row.confidence_score),
      hit_count: Number(row.hit_count),
    }));
  }

  // Handle optional semantic search candidates
  if (semanticQuery) {
    const semanticResults = await MemoryService.searchMemory(semanticQuery, {
      status: 'ACTIVE',
      phaseId: task.phase_id ?? undefined,
      limit: semanticLimit,
      minSimilarity: semanticMinSimilarity,
    });

    const existingIds = new Set(candidateRows.map((r) => r.id));
    const newSemanticItems = semanticResults.filter(
      (sr) => !existingIds.has(sr.id) && sr.type !== 'HANDOFF'
    );

    if (newSemanticItems.length > 0) {
      const taskIdsToLookup = [
        ...new Set(newSemanticItems.map((item) => item.task_id).filter((id): id is string => Boolean(id))),
      ];

      const taskStatusMap = new Map<string, TaskStatus>();
      if (taskIdsToLookup.length > 0) {
        const taskRes = await query(
          `SELECT id, status FROM tasks WHERE id = ANY($1)`,
          [taskIdsToLookup]
        );
        for (const tRow of taskRes.rows) {
          taskStatusMap.set(tRow.id, tRow.status);
        }
      }

      for (const item of newSemanticItems) {
        candidateRows.push({
          ...item,
          task_status: item.task_id ? (taskStatusMap.get(item.task_id) ?? null) : null,
          confidence_score: Number(item.confidence_score),
          hit_count: Number(item.hit_count),
        });
      }
    }
  }

  // Score each candidate
  const scoredMemories: ScoredMemory[] = candidateRows.map((mem) => {
    const decayedRelevance = computeMemoryDecay(mem, {
      taskStatus: mem.task_status,
      now,
      config: scoringConfig,
    });
    const finalScore = scoreMemory(mem, {
      taskStatus: mem.task_status,
      now,
      scoringConfig,
    });

    return {
      ...mem,
      decayed_relevance: decayedRelevance,
      score: finalScore,
    };
  });

  // Rank by score descending, breaking ties with newer created_at, then id
  scoredMemories.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const aTime = new Date(a.created_at).getTime();
    const bTime = new Date(b.created_at).getTime();
    if (bTime !== aTime) {
      return bTime - aTime;
    }
    return a.id.localeCompare(b.id);
  });

  // 1-hop causal lineage enrichment
  if (enrichCausalLineage) {
    for (const mem of scoredMemories) {
      if (mem.causal_parents && mem.causal_parents.length > 0) {
        const parents = await MemoryService.getCausalLineage(mem.id, {
          maxDepth: maxCausalDepth,
          includeSelf: false,
        });
        mem.causal_lineage = parents;
      } else {
        mem.causal_lineage = [];
      }
    }
  }

  return scoredMemories;
}

export interface PackedCandidate {
  memory: ScoredMemory;
  tokenCount: number;
  rendered: string;
}

export interface SkippedCandidate {
  memory: ScoredMemory;
  tokenCount: number;
  reason: string;
}

export interface PackingResult {
  packed: PackedCandidate[];
  skipped: SkippedCandidate[];
  tokensUsed: number;
  tokensRemaining: number;
}

/**
 * Item 4 (Candidate Renderer & Causal Parent Deduplication):
 * Renders a candidate memory into its final formatted string wrapper.
 *
 * Rules:
 * 1. Wraps candidate: "- [TYPE] (Conf: X.XX): content"
 * 2. If causal lineage is present:
 *    - The first time a parent ID is encountered (not in alreadyRenderedParentIds),
 *      renders full line: "\n  ↳ Caused by: [TYPE] (Conf: X.XX): content"
 *    - On subsequent encounters (parent ID in alreadyRenderedParentIds),
 *      renders terse reference: "\n  ↳ Caused by: [TYPE] (see above)"
 *      to avoid duplicating content and wasting tokens.
 */
export function renderCandidateMemory(
  memory: ScoredMemory,
  alreadyRenderedParentIds?: ReadonlySet<string>
): string {
  const confFormatted = Number(memory.confidence_score).toFixed(2);
  let rendered = `- [${memory.type}] (Conf: ${confFormatted}): ${memory.content}`;

  if (memory.causal_lineage && memory.causal_lineage.length > 0) {
    for (const parent of memory.causal_lineage) {
      if (alreadyRenderedParentIds && alreadyRenderedParentIds.has(parent.id)) {
        rendered += `\n  ↳ Caused by: [${parent.type}] (see above)`;
      } else {
        const parentConf = Number(parent.confidence_score).toFixed(2);
        rendered += `\n  ↳ Caused by: [${parent.type}] (Conf: ${parentConf}): ${parent.content}`;
      }
    }
  }

  return rendered;
}

/**
 * Item 4 (Greedy Token Packer):
 * Packs candidate memories into the given token budget.
 *
 * Rules:
 * 1. Input candidates must be pre-sorted by score DESC (retrieveCandidateMemories does this).
 * 2. Token-counts full rendered string using js-tiktoken cl100k_base.
 * 3. Does NOT halt on first candidate that doesn't fit; skips it and continues scanning
 *    smaller lower-ranked candidates that fit in remaining budget.
 * 4. Stops when all candidates have been scanned or remainingBudget <= 0.
 * 5. Deduplicates shared causal parents across packed candidates, updating alreadyRenderedParentIds
 *    only when a candidate is successfully packed (transactional).
 */
export function packCandidateMemories(
  candidates: ScoredMemory[],
  tokenBudget: number,
  tokenizer?: Tiktoken
): PackingResult {
  const enc = tokenizer ?? getEncoding('cl100k_base');
  const packed: PackedCandidate[] = [];
  const skipped: SkippedCandidate[] = [];
  const renderedParentIds = new Set<string>();
  let remainingBudget = tokenBudget;

  for (const candidate of candidates) {
    if (remainingBudget <= 0) {
      const rendered = renderCandidateMemory(candidate, renderedParentIds);
      skipped.push({
        memory: candidate,
        tokenCount: enc.encode(rendered).length,
        reason: 'Budget exhausted (0 tokens remaining)',
      });
      continue;
    }

    const rendered = renderCandidateMemory(candidate, renderedParentIds);
    const tokenCount = enc.encode(rendered).length;

    if (tokenCount <= remainingBudget) {
      packed.push({
        memory: candidate,
        tokenCount,
        rendered,
      });
      remainingBudget -= tokenCount;

      // Commit causal parent IDs to rendered set
      if (candidate.causal_lineage && candidate.causal_lineage.length > 0) {
        for (const parent of candidate.causal_lineage) {
          renderedParentIds.add(parent.id);
        }
      }
    } else {
      skipped.push({
        memory: candidate,
        tokenCount,
        reason: `Exceeds remaining budget (${tokenCount} tokens > ${remainingBudget} remaining)`,
      });
    }
  }

  return {
    packed,
    skipped,
    tokensUsed: tokenBudget - remainingBudget,
    tokensRemaining: remainingBudget,
  };
}

export interface RenderContextInput {
  project: IProject;
  phase: IPhase | null;
  task: ITask;
  packedMemories: PackedCandidate[];
  latestHandoff: IMemory | null;
}

/**
 * Item 5 (Block Formatter):
 * Renders the compiled context into the standard HANDOFF-style block format:
 * PROJECT / CURRENT PHASE / CURRENT TASK / RELEVANT DECISIONS / RELEVANT FAILURES / RECENT CHANGES / (RELEVANT OBSERVATIONS) / HANDOFF
 */
export function renderCompiledContext(input: RenderContextInput): string {
  const { project, phase, task, packedMemories, latestHandoff } = input;

  const sections: string[] = [];

  // 1. PROJECT
  const projectLines = [
    `# PROJECT: ${project.name}`,
    project.goal ? `Goal: ${project.goal}` : null,
    project.constraints ? `Constraints: ${project.constraints}` : null,
    project.repository_ref ? `Repository: ${project.repository_ref}` : null,
  ].filter(Boolean);
  sections.push(projectLines.join('\n'));

  // 2. CURRENT PHASE
  if (phase) {
    const phaseLines = [
      `## CURRENT PHASE: ${phase.name} [${phase.status}]`,
      phase.description ? `Description: ${phase.description}` : null,
    ].filter(Boolean);
    sections.push(phaseLines.join('\n'));
  } else {
    sections.push(`## CURRENT PHASE: None (Unassigned)`);
  }

  // 3. CURRENT TASK
  const taskLines = [
    `## CURRENT TASK: ${task.title} [${task.status}]`,
    task.description ? `Description: ${task.description}` : null,
  ].filter(Boolean);
  sections.push(taskLines.join('\n'));

  // Group packed memories by type
  const decisions = packedMemories.filter((p) => p.memory.type === 'DECISION');
  const failures = packedMemories.filter((p) => p.memory.type === 'FAILURE');
  const changes = packedMemories.filter((p) => p.memory.type === 'CHANGE');
  const observations = packedMemories.filter((p) => p.memory.type === 'OBSERVATION');

  // 4. RELEVANT DECISIONS
  sections.push(
    `## RELEVANT DECISIONS\n` +
      (decisions.length > 0 ? decisions.map((d) => d.rendered).join('\n') : '_None_')
  );

  // 5. RELEVANT FAILURES
  sections.push(
    `## RELEVANT FAILURES\n` +
      (failures.length > 0 ? failures.map((f) => f.rendered).join('\n') : '_None_')
  );

  // 6. RECENT CHANGES
  sections.push(
    `## RECENT CHANGES\n` +
      (changes.length > 0 ? changes.map((c) => c.rendered).join('\n') : '_None_')
  );

  // RELEVANT OBSERVATIONS (if any)
  if (observations.length > 0) {
    sections.push(
      `## RELEVANT OBSERVATIONS\n` +
        observations.map((o) => o.rendered).join('\n')
    );
  }

  // 7. HANDOFF (scoped strictly to current task)
  sections.push(
    `## HANDOFF\n` +
      (latestHandoff ? latestHandoff.content : '_None (Initial task run)_')
  );

  return sections.join('\n\n');
}

export interface CompiledContextBudget {
  totalBudget: number;
  scaffoldingTokens: number;
  scratchpadReserveTokens: number;
  memoryBudget: number;
  memoryTokensUsed: number;
  memoryTokensRemaining: number;
  totalOutputTokens: number;
}

export interface CompiledContextResult {
  compiledText: string;
  task: ITask;
  phase: IPhase | null;
  project: IProject;
  latestHandoff: IMemory | null;
  budget: CompiledContextBudget;
  packedMemories: PackedCandidate[];
  skippedMemories: SkippedCandidate[];
}

export interface CompiledContextOptions extends CompilerRetrievalOptions {
  totalTokenBudget?: number;
  scratchpadReserveRatio?: number;
  tokenizer?: Tiktoken;
}

/**
 * Item 5 (Context Compiler Entrypoint):
 * Given a taskId, executes the complete end-to-end context compilation pipeline:
 * 1. Lookups: Validates task, phase, project, and task-scoped latest handoff upfront
 * 2. Scaffolding: Token-counts headers, section wrappers, and latest handoff upfront
 * 3. Budget (Option a): Subtracts scaffolding from totalTokenBudget, then computes 80/20 split on available budget
 * 4. Retrieval: Queries candidate memories (current task, phase decisions, phase changes, sibling failures, optional semantic; HANDOFF excluded)
 * 5. Scoring: Scores each candidate (confidence × temporal decay × hit boost) and enriches 1-hop causal parents
 * 6. Packing: Greedily packs candidates into memory budget using cl100k_base token counting,
 *    skipping candidates that do not fit while continuing scan, and deduplicating shared causal parents
 * 7. Rendering: Formats into the standardized multi-section context block and reports true total token count
 */
export async function getCompiledContext(
  taskId: string,
  options: CompiledContextOptions = {}
): Promise<CompiledContextResult> {
  const {
    totalTokenBudget = 4000,
    scratchpadReserveRatio = 0.20,
    tokenizer = getEncoding('cl100k_base'),
  } = options;

  // 1. Fetch Task, Phase, Project, and Task-scoped Latest Handoff upfront before candidate retrieval
  const task = await TaskService.getTaskById(taskId);
  if (!task) {
    throw new Error(`[getCompiledContext] Task with id "${taskId}" not found.`);
  }

  const project = await ProjectModel.findById(task.project_id);
  if (!project) {
    throw new Error(
      `[getCompiledContext] Project with id "${task.project_id}" for task "${taskId}" not found.`
    );
  }

  const phase = task.phase_id ? await PhaseService.getPhaseById(task.phase_id) : null;
  const latestHandoff = await HandoffService.getLatestHandoff(taskId);

  // 2. Measure baseline scaffolding tokens (Project/Phase/Task headers, section wrappers, and latest handoff)
  const baselineScaffoldingText = renderCompiledContext({
    project,
    phase,
    task,
    packedMemories: [],
    latestHandoff,
  });
  const scaffoldingTokens = tokenizer.encode(baselineScaffoldingText).length;

  // 3. Option (a) Budget Calculation: Subtract scaffolding from totalTokenBudget before computing 80/20 split
  const availableBudget = Math.max(0, totalTokenBudget - scaffoldingTokens);
  const scratchpadReserveTokens = Math.floor(availableBudget * scratchpadReserveRatio);
  const memoryTokenBudget = availableBudget - scratchpadReserveTokens;

  // 4. Retrieve scored and ranked candidate memories (Item 3, HANDOFF excluded)
  const candidates = await retrieveCandidateMemories(taskId, options);

  // 5. Greedy token packing within memoryTokenBudget (Item 4)
  const packingResult = packCandidateMemories(candidates, memoryTokenBudget, tokenizer);

  // 6. Render final compiled context block
  const compiledText = renderCompiledContext({
    project,
    phase,
    task,
    packedMemories: packingResult.packed,
    latestHandoff,
  });

  const totalOutputTokens = tokenizer.encode(compiledText).length;

  return {
    compiledText,
    task,
    phase,
    project,
    latestHandoff,
    budget: {
      totalBudget: totalTokenBudget,
      scaffoldingTokens,
      scratchpadReserveTokens,
      memoryBudget: memoryTokenBudget,
      memoryTokensUsed: packingResult.tokensUsed,
      memoryTokensRemaining: packingResult.tokensRemaining,
      totalOutputTokens,
    },
    packedMemories: packingResult.packed,
    skippedMemories: packingResult.skipped,
  };
}



