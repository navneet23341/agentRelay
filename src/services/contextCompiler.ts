import { query } from '../config/database.js';
import {
  IMemory,
  IMemoryWithDepth,
  MemoryType,
  TaskStatus,
} from '../models/types.js';
import { TaskService } from './taskService.js';
import { MemoryService } from './memoryService.js';

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
        -- 1. All active memories created directly under the target task
        SELECT m.*, t.status AS task_status
        FROM memories m
        JOIN tasks t ON m.task_id = t.id
        WHERE m.status = 'ACTIVE'
          AND m.task_id = $1
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
    // Unassigned phase: target task only
    const sql = `
      SELECT m.*, t.status AS task_status
      FROM memories m
      JOIN tasks t ON m.task_id = t.id
      WHERE m.status = 'ACTIVE'
        AND m.task_id = $1
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
    const newSemanticItems = semanticResults.filter((sr) => !existingIds.has(sr.id));

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

