import { query } from '../config/database.js';
import { ITask, ITaskCreateInput } from './types.js';

export class TaskModel {
  static async create(input: ITaskCreateInput): Promise<ITask> {
    const res = await query(
      `INSERT INTO tasks (project_id, phase_id, title, description, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.project_id,
        input.phase_id ?? null,
        input.title,
        input.description ?? null,
        input.status ?? 'TODO',
      ]
    );
    return res.rows[0];
  }

  static async findById(id: string): Promise<ITask | null> {
    const res = await query('SELECT * FROM tasks WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  static async findByProjectId(projectId: string): Promise<ITask[]> {
    const res = await query(
      'SELECT * FROM tasks WHERE project_id = $1 ORDER BY created_at ASC',
      [projectId]
    );
    return res.rows;
  }

  static async deleteById(id: string): Promise<boolean> {
    const res = await query('DELETE FROM tasks WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
