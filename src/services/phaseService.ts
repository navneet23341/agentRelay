import { query } from '../config/database.js';
import { IPhase, IPhaseCreateInput, PhaseListFilters, PhaseStatus } from '../models/types.js';

export class PhaseService {
  static async createPhase(input: IPhaseCreateInput): Promise<IPhase> {
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

  static async getPhaseById(id: string): Promise<IPhase | null> {
    const res = await query('SELECT * FROM phases WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  static async listPhases(filter: string | PhaseListFilters): Promise<IPhase[]> {
    const projectId = typeof filter === 'string' ? filter : filter.projectId;
    const status = typeof filter === 'object' ? filter.status : undefined;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    let sql = 'SELECT * FROM phases';

    if (projectId) {
      conditions.push(`project_id = $${paramIndex++}`);
      values.push(projectId);
    }

    if (status) {
      if (Array.isArray(status)) {
        conditions.push(`status = ANY($${paramIndex++})`);
        values.push(status);
      } else {
        conditions.push(`status = $${paramIndex++}`);
        values.push(status);
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ' ORDER BY order_index ASC, created_at ASC';

    const res = await query(sql, values);
    return res.rows;
  }

  static async updatePhaseStatus(id: string, nextStatus: PhaseStatus): Promise<IPhase> {
    const current = await this.getPhaseById(id);
    if (!current) {
      throw new Error(`Phase with ID "${id}" not found`);
    }

    // State validation for phases
    const validPhaseTransitions: Record<PhaseStatus, PhaseStatus[]> = {
      PLANNED: ['ACTIVE', 'CANCELLED'],
      ACTIVE: ['COMPLETED', 'CANCELLED', 'PLANNED'],
      COMPLETED: ['ACTIVE'], // reopen
      CANCELLED: ['PLANNED', 'ACTIVE'],
    };

    if (current.status !== nextStatus) {
      const allowed = validPhaseTransitions[current.status] || [];
      if (!allowed.includes(nextStatus)) {
        throw new Error(
          `Invalid phase transition from "${current.status}" to "${nextStatus}". Allowed: [${allowed.join(', ')}]`
        );
      }
    }

    const res = await query(
      `UPDATE phases
       SET status = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, nextStatus]
    );

    return res.rows[0];
  }

  static async deletePhase(id: string): Promise<boolean> {
    const res = await query('DELETE FROM phases WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
