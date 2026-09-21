import { query, getClient } from '../config/database.js';
import {
  IMemory,
  IMemoryCreateInput,
  MemoryListFilters,
  MemoryStatus,
  CreateMemoryResult,
  SupersedeMemoryResult,
} from '../models/types.js';
import { computeSemanticHash } from './semanticHash.js';

export class MemoryService {
  /**
   * Creates a memory with semantic hashing and atomic deduplication.
   * If a matching ACTIVE memory with the same semantic_hash exists in the same task,
   * increments hit_count and updates last_seen_at instead of creating a new row.
   */
  static async createMemory(input: IMemoryCreateInput): Promise<CreateMemoryResult> {
    const semanticHash = input.semantic_hash || computeSemanticHash(input.content, input.type);

    const formattedEmbedding = Array.isArray(input.embedding)
      ? `[${input.embedding.join(',')}]`
      : input.embedding ?? null;

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
          input.confidence_score ?? 1.0,
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
        memory: row,
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
        input.confidence_score ?? 1.0,
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

    return {
      memory: insertRes.rows[0],
      isDuplicate: false,
    };
  }

  /**
   * Retrieves a memory by primary key UUID.
   */
  static async getMemoryById(id: string): Promise<IMemory | null> {
    const res = await query('SELECT * FROM memories WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  /**
   * Lists memories with flexible filtering by task, phase, type, and status.
   */
  static async listMemories(filters: MemoryListFilters = {}): Promise<IMemory[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    let sql = `
      SELECT m.*
      FROM memories m
    `;

    if (filters.phaseId) {
      sql += ` INNER JOIN tasks t ON m.task_id = t.id `;
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

    if (filters.status) {
      if (Array.isArray(filters.status)) {
        conditions.push(`m.status = ANY($${paramIndex++})`);
        values.push(filters.status);
      } else {
        conditions.push(`m.status = $${paramIndex++}`);
        values.push(filters.status);
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
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
    return res.rows;
  }

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
}
