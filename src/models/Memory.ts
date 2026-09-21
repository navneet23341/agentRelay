import { query } from '../config/database.js';
import { IMemory, IMemoryCreateInput } from './types.js';

export class MemoryModel {
  static async create(input: IMemoryCreateInput): Promise<IMemory> {
    const formattedEmbedding = Array.isArray(input.embedding)
      ? `[${input.embedding.join(',')}]`
      : input.embedding ?? null;

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
        input.task_id ?? null,
        input.semantic_hash ?? null,
        input.hit_count ?? 1,
        input.last_seen_at ?? new Date(),
        input.causal_parents ?? [],
      ]
    );
    return res.rows[0];
  }

  static async findById(id: string): Promise<IMemory | null> {
    const res = await query('SELECT * FROM memories WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  static async findByTaskId(taskId: string): Promise<IMemory[]> {
    const res = await query(
      'SELECT * FROM memories WHERE task_id = $1 ORDER BY created_at ASC',
      [taskId]
    );
    return res.rows;
  }

  static async deleteById(id: string): Promise<boolean> {
    const res = await query('DELETE FROM memories WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
