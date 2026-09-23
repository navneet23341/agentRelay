import { query, getClient } from '../config/database.js';
import {
  IMemory,
  IMemoryCreateInput,
  MemoryListFilters,
  MemorySearchFilters,
  MemorySearchResult,
  BackfillEmbeddingsResult,
  MemoryStatus,
  CreateMemoryResult,
  SupersedeMemoryResult,
  CONFIDENCE_CLASS_SCORES,
  CausalLineageOptions,
  IMemoryWithDepth,
} from '../models/types.js';
import { computeSemanticHash } from './semanticHash.js';
import { EmbeddingService } from './embeddingService.js';

export class MemoryService {
  /**
   * Creates a memory with semantic hashing and atomic deduplication.
   * If a matching ACTIVE memory with the same semantic_hash exists in the same task,
   * increments hit_count and updates last_seen_at instead of creating a new row.
   * Validates that all causal_parents IDs exist before insertion.
   * Derives confidence_score from confidence_class if not explicitly provided.
   * Generates embedding via EmbeddingService (OpenAI text-embedding-3-small) if not provided.
   */
  static async createMemory(input: IMemoryCreateInput): Promise<CreateMemoryResult> {
    // Validate causal_parents exist
    if (input.causal_parents && input.causal_parents.length > 0) {
      const parentIds = [...new Set(input.causal_parents)];
      const checkRes = await query(
        'SELECT id FROM memories WHERE id = ANY($1::uuid[])',
        [parentIds]
      );
      if (checkRes.rowCount !== parentIds.length) {
        const foundSet = new Set(checkRes.rows.map((r: { id: string }) => r.id));
        const missing = parentIds.filter((id) => !foundSet.has(id));
        throw new Error(
          `Invalid causal_parents: Memory ID(s) do not exist: [${missing.join(', ')}]`
        );
      }
    }

    const confidenceScore =
      input.confidence_score !== undefined && input.confidence_score !== null
        ? input.confidence_score
        : CONFIDENCE_CLASS_SCORES[input.confidence_class] ?? 1.0;

    const semanticHash = input.semantic_hash || computeSemanticHash(input.content, input.type);

    let embeddingVector = input.embedding ?? null;
    if (embeddingVector === null) {
      embeddingVector = await EmbeddingService.generateEmbedding(input.content);
    }

    const formattedEmbedding = Array.isArray(embeddingVector)
      ? `[${embeddingVector.join(',')}]`
      : embeddingVector ?? null;

    // If tied to a task, use single atomic INSERT ... ON CONFLICT DO UPDATE
    if (input.task_id) {
      const res = await query(
        `INSERT INTO memories (
          type,
          content,
          embedding,
          confidence_class,
          confidence_score,
          status,
          invalidated_at,
          invalidated_by,
          superseded_by,
          task_id,
          semantic_hash,
          hit_count,
          last_seen_at,
          causal_parents
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (task_id, semantic_hash) WHERE status = 'ACTIVE'
        DO UPDATE SET
          hit_count = memories.hit_count + 1,
          last_seen_at = CURRENT_TIMESTAMP
        RETURNING *, (xmax = 0) AS is_inserted`,
        [
          input.type,
          input.content,
          formattedEmbedding,
          input.confidence_class,
          confidenceScore,
          input.status ?? 'ACTIVE',
          input.invalidated_at ?? null,
          input.invalidated_by ?? null,
          input.superseded_by ?? null,
          input.task_id,
          semanticHash,
          input.hit_count ?? 1,
          input.last_seen_at ?? new Date(),
          input.causal_parents ?? [],
        ]
      );

      const row = res.rows[0];
      const isInserted = row.is_inserted;
      delete row.is_inserted;

      return {
        memory: {
          ...row,
          confidence_score: Number(row.confidence_score),
        },
        isDuplicate: !isInserted,
      };
    }

    // Otherwise insert without conflict target
    const insertRes = await query(
      `INSERT INTO memories (
        type,
        content,
        embedding,
        confidence_class,
        confidence_score,
        status,
        invalidated_at,
        invalidated_by,
        superseded_by,
        task_id,
        semantic_hash,
        hit_count,
        last_seen_at,
        causal_parents
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        input.type,
        input.content,
        formattedEmbedding,
        input.confidence_class,
        confidenceScore,
        input.status ?? 'ACTIVE',
        input.invalidated_at ?? null,
        input.invalidated_by ?? null,
        input.superseded_by ?? null,
        null,
        semanticHash,
        input.hit_count ?? 1,
        input.last_seen_at ?? new Date(),
        input.causal_parents ?? [],
      ]
    );

    const row = insertRes.rows[0];
    return {
      memory: {
        ...row,
        confidence_score: Number(row.confidence_score),
      },
      isDuplicate: false,
    };
  }

  /**
   * Retrieves a memory by primary key UUID.
   */
  static async getMemoryById(id: string): Promise<IMemory | null> {
    const res = await query('SELECT * FROM memories WHERE id = $1', [id]);
    if (!res.rows[0]) return null;
    return {
      ...res.rows[0],
      confidence_score: Number(res.rows[0].confidence_score),
    };
  }

  /**
   * Builds shared SQL filter conditions (phase, task, type, status) for listMemories and searchMemory.
   * Full staleness wiring: defaults to status = 'ACTIVE' unless a status filter is explicitly passed.
   */
  private static buildMemoryFilterConditions(
    filters: MemoryListFilters = {},
    startParamIndex: number = 1
  ): {
    joins: string;
    conditions: string[];
    values: unknown[];
    nextParamIndex: number;
  } {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = startParamIndex;
    let joins = '';

    if (filters.phaseId) {
      joins += ` INNER JOIN tasks t ON m.task_id = t.id `;
      conditions.push(`t.phase_id = $${paramIndex++}`);
      values.push(filters.phaseId);
    }

    if (filters.taskId) {
      conditions.push(`m.task_id = $${paramIndex++}`);
      values.push(filters.taskId);
    }

    if (filters.type) {
      if (Array.isArray(filters.type)) {
        conditions.push(`m.type = ANY($${paramIndex++})`);
        values.push(filters.type);
      } else {
        conditions.push(`m.type = $${paramIndex++}`);
        values.push(filters.type);
      }
    }

    if (filters.status !== undefined) {
      if (filters.status !== 'ALL') {
        if (Array.isArray(filters.status)) {
          conditions.push(`m.status = ANY($${paramIndex++})`);
          values.push(filters.status);
        } else {
          conditions.push(`m.status = $${paramIndex++}`);
          values.push(filters.status);
        }
      }
    } else {
      // Default to ACTIVE unless explicitly requested
      conditions.push(`m.status = 'ACTIVE'`);
    }

    return {
      joins,
      conditions,
      values,
      nextParamIndex: paramIndex,
    };
  }

  /**
   * Lists memories with flexible filtering by task, phase, type, and status.
   * Structured retrieval path: pure relational SQL without involving embeddings.
   * Full staleness wiring: defaults to status = 'ACTIVE' unless a status filter is explicitly passed.
   * Pass status: 'ALL' to retrieve memories regardless of status.
   */
  static async listMemories(filters: MemoryListFilters = {}): Promise<IMemory[]> {
    const filterClause = this.buildMemoryFilterConditions(filters, 1);
    const values = [...filterClause.values];
    let paramIndex = filterClause.nextParamIndex;

    let sql = `
      SELECT m.*
      FROM memories m
      ${filterClause.joins}
    `;

    if (filterClause.conditions.length > 0) {
      sql += ` WHERE ${filterClause.conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY m.created_at DESC`;

    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      values.push(filters.limit);
    }

    if (filters.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      values.push(filters.offset);
    }

    const res = await query(sql, values);
    return res.rows.map((row: any) => ({
      ...row,
      confidence_score: Number(row.confidence_score),
    }));
  }

  /**
   * Semantic similarity search via pgvector's cosine distance operator (<=>).
   * Layers on top of the exact same status/task/phase filters as listMemories (reusing filter logic).
   * Keeps structured and semantic retrieval cleanly separated.
   */
  static async searchMemory(
    queryTextOrEmbedding: string | number[],
    filters: MemorySearchFilters = {}
  ): Promise<MemorySearchResult[]> {
    let queryVector: number[] | null;

    if (Array.isArray(queryTextOrEmbedding)) {
      queryVector = queryTextOrEmbedding;
    } else {
      queryVector = await EmbeddingService.generateEmbedding(queryTextOrEmbedding);
      if (!queryVector) {
        // If embedding could not be generated (no API key or API down), return empty list gracefully
        return [];
      }
    }

    const formattedQueryVector = `[${queryVector.join(',')}]`;

    // $1 is the query vector parameter
    const values: unknown[] = [formattedQueryVector];
    const filterClause = this.buildMemoryFilterConditions(filters, 2);
    values.push(...filterClause.values);
    let paramIndex = filterClause.nextParamIndex;

    const allConditions = ['m.embedding IS NOT NULL', ...filterClause.conditions];

    if (filters.minSimilarity !== undefined) {
      allConditions.push(`(1 - (m.embedding <=> $1::vector)) >= $${paramIndex++}`);
      values.push(filters.minSimilarity);
    }

    let sql = `
      SELECT
        m.*,
        (1 - (m.embedding <=> $1::vector)) AS similarity_score
      FROM memories m
      ${filterClause.joins}
      WHERE ${allConditions.join(' AND ')}
      ORDER BY m.embedding <=> $1::vector ASC
    `;

    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      values.push(filters.limit);
    }

    if (filters.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      values.push(filters.offset);
    }

    const res = await query(sql, values);
    return res.rows.map((row: any) => ({
      ...row,
      confidence_score: Number(row.confidence_score),
      similarity_score: Number(row.similarity_score),
    }));
  }

  /**
   * Backfills missing embeddings for memories where embedding IS NULL and status = 'ACTIVE'.
   * Regenerates their embeddings via EmbeddingService (or an optional generator for tests) and updates them.
   */
  static async backfillMissingEmbeddings(options?: {
    limit?: number;
    generator?: (text: string) => Promise<number[] | null>;
  }): Promise<BackfillEmbeddingsResult> {
    const limitClause = options?.limit ? `LIMIT ${Number(options.limit)}` : '';
    const res = await query(
      `SELECT id, content FROM memories WHERE embedding IS NULL AND status = 'ACTIVE' ORDER BY created_at ASC ${limitClause}`
    );

    let updated = 0;
    let failed = 0;
    const generateFn = options?.generator ?? EmbeddingService.generateEmbedding;

    for (const row of res.rows) {
      const vector = await generateFn(row.content);
      if (vector && Array.isArray(vector)) {
        const formatted = `[${vector.join(',')}]`;
        await query('UPDATE memories SET embedding = $1 WHERE id = $2', [formatted, row.id]);
        updated++;
      } else {
        failed++;
      }
    }

    return {
      processed: res.rows.length,
      updated,
      failed,
    };
  }

  // Support alternate spelling alias
  static backfillMissingEmeddings = MemoryService.backfillMissingEmbeddings;

  /**
   * Updates memory status and handles invalidation metadata.
   */
  static async updateMemoryStatus(
    id: string,
    status: MemoryStatus,
    metadata?: { invalidated_by?: string }
  ): Promise<IMemory | null> {
    let sql: string;
    let params: unknown[];

    if (status === 'INVALIDATED') {
      sql = `
        UPDATE memories
        SET status = $2,
            invalidated_at = CURRENT_TIMESTAMP,
            invalidated_by = $3
        WHERE id = $1
        RETURNING *
      `;
      params = [id, status, metadata?.invalidated_by ?? null];
    } else if (status === 'ACTIVE') {
      sql = `
        UPDATE memories
        SET status = $2,
            invalidated_at = NULL,
            invalidated_by = NULL
        WHERE id = $1
        RETURNING *
      `;
      params = [id, status];
    } else {
      sql = `
        UPDATE memories
        SET status = $2
        WHERE id = $1
        RETURNING *
      `;
      params = [id, status];
    }

    const res = await query(sql, params);
    return res.rows[0] || null;
  }

  /**
   * Manual supersession: marks oldMemory.status = 'SUPERSEDED' and oldMemory.superseded_by = newMemoryId.
   * Executed atomically within a transaction.
   */
  static async supersedeMemory(
    oldMemoryId: string,
    newMemoryId: string
  ): Promise<SupersedeMemoryResult> {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Verify new memory exists
      const newRes = await client.query('SELECT * FROM memories WHERE id = $1', [newMemoryId]);
      if (newRes.rowCount === 0) {
        throw new Error(`New memory with ID "${newMemoryId}" not found`);
      }
      const newMemory = newRes.rows[0];

      // Update old memory
      const oldRes = await client.query(
        `UPDATE memories
         SET status = 'SUPERSEDED',
             superseded_by = $2
         WHERE id = $1
         RETURNING *`,
        [oldMemoryId, newMemoryId]
      );

      if (oldRes.rowCount === 0) {
        throw new Error(`Old memory with ID "${oldMemoryId}" not found`);
      }

      await client.query('COMMIT');

      return {
        oldMemory: oldRes.rows[0],
        newMemory,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Traverses the causal graph starting from memoryId using a recursive CTE.
   * Traverses up through causal_parents to retrieve the ancestor lineage.
   * Guards against cycles with `NOT (parent.id = ANY(child.path))` and caps depth at options.maxDepth.
   */
  static async getCausalLineage(
    memoryId: string,
    options: CausalLineageOptions = {}
  ): Promise<IMemoryWithDepth[]> {
    const maxDepth = options.maxDepth ?? 10;
    const depthFilter = options.includeSelf ? 'depth >= 0' : 'depth > 0';

    const sql = `
      WITH RECURSIVE causal_lineage AS (
        -- Base case: anchor on target memory at depth 0
        SELECT
          m.id,
          m.type,
          m.content,
          m.embedding,
          m.confidence_class,
          m.confidence_score,
          m.status,
          m.created_at,
          m.invalidated_at,
          m.invalidated_by,
          m.superseded_by,
          m.task_id,
          m.semantic_hash,
          m.hit_count,
          m.last_seen_at,
          m.causal_parents,
          0 AS depth,
          ARRAY[m.id] AS path
        FROM memories m
        WHERE m.id = $1

        UNION ALL

        -- Recursive step: traverse upwards to parent memories
        SELECT
          parent.id,
          parent.type,
          parent.content,
          parent.embedding,
          parent.confidence_class,
          parent.confidence_score,
          parent.status,
          parent.created_at,
          parent.invalidated_at,
          parent.invalidated_by,
          parent.superseded_by,
          parent.task_id,
          parent.semantic_hash,
          parent.hit_count,
          parent.last_seen_at,
          parent.causal_parents,
          child.depth + 1 AS depth,
          child.path || parent.id AS path
        FROM causal_lineage child
        JOIN memories parent ON parent.id = ANY(child.causal_parents)
        WHERE child.depth < $2
          AND NOT (parent.id = ANY(child.path))
      )
      SELECT * FROM (
        SELECT DISTINCT ON (id)
          id,
          type,
          content,
          embedding,
          confidence_class,
          confidence_score,
          status,
          created_at,
          invalidated_at,
          invalidated_by,
          superseded_by,
          task_id,
          semantic_hash,
          hit_count,
          last_seen_at,
          causal_parents,
          depth
        FROM causal_lineage
        WHERE ${depthFilter}
        ORDER BY id, depth ASC
      ) deduped
      ORDER BY depth ASC, created_at DESC, id ASC;
    `;

    const res = await query(sql, [memoryId, maxDepth]);
    return res.rows.map((row: any) => ({
      ...row,
      confidence_score: Number(row.confidence_score),
      depth: Number(row.depth),
    }));
  }
}
