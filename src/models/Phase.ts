import { query } from '../config/database.js';
import { IPhase, IPhaseCreateInput } from './types.js';

export class PhaseModel {
  static async create(input: IPhaseCreateInput): Promise<IPhase> {
    const res = await query(
      `INSERT INTO phases (project_id, name, description, order_index, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.project_id,
        input.name,
        input.description ?? null,
        input.order_index ?? 0,
        input.status ?? 'PLANNED',
      ]
    );
    return res.rows[0];
  }

  static async findById(id: string): Promise<IPhase | null> {
    const res = await query('SELECT * FROM phases WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  static async findByProjectId(projectId: string): Promise<IPhase[]> {
    const res = await query(
      'SELECT * FROM phases WHERE project_id = $1 ORDER BY order_index ASC, created_at ASC',
      [projectId]
    );
    return res.rows;
  }

  static async deleteById(id: string): Promise<boolean> {
    const res = await query('DELETE FROM phases WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
