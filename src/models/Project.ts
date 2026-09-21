import { query } from '../config/database.js';
import { IProject, IProjectCreateInput } from './types.js';

export class ProjectModel {
  static async create(input: IProjectCreateInput): Promise<IProject> {
    const res = await query(
      `INSERT INTO projects (name, goal, constraints, repository_ref)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.name, input.goal ?? null, input.constraints ?? null, input.repository_ref ?? null]
    );
    return res.rows[0];
  }

  static async findById(id: string): Promise<IProject | null> {
    const res = await query('SELECT * FROM projects WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  static async findAll(): Promise<IProject[]> {
    const res = await query('SELECT * FROM projects ORDER BY created_at DESC');
    return res.rows;
  }

  static async deleteById(id: string): Promise<boolean> {
    const res = await query('DELETE FROM projects WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
