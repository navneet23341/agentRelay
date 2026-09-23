import { query } from '../config/database.js';
import {
  ITask,
  ITaskCreateInput,
  TaskListFilters,
  TaskStatus,
  SuggestTaskInput,
  ApproveSuggestionInput,
} from '../models/types.js';
import { validateTaskTransition } from './taskStateMachine.js';

export class TaskService {
  /**
   * Creates a standard TODO task.
   * Direct creation of PENDING_REVIEW is disallowed; agents must use suggestTask().
   */
  static async createTask(input: ITaskCreateInput): Promise<ITask> {
    if (input.status === 'PENDING_REVIEW') {
      throw new Error(
        'Cannot create a PENDING_REVIEW task via createTask(). Use suggestTask() instead.'
      );
    }

    const initialStatus: TaskStatus = input.status || 'TODO';

    const res = await query(
      `INSERT INTO tasks (project_id, phase_id, title, description, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.project_id,
        input.phase_id ?? null,
        input.title,
        input.description ?? null,
        initialStatus,
      ]
    );

    return res.rows[0];
  }

  /**
   * Retrieves a task by primary key UUID.
   */
  static async getTaskById(id: string): Promise<ITask | null> {
    const res = await query('SELECT * FROM tasks WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  /**
   * Lists tasks with flexible filtering.
   */
  static async listTasks(filters: TaskListFilters = {}): Promise<ITask[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    let sql = 'SELECT * FROM tasks';

    if (filters.projectId) {
      conditions.push(`project_id = $${paramIndex++}`);
      values.push(filters.projectId);
    }

    if (filters.phaseId) {
      conditions.push(`phase_id = $${paramIndex++}`);
      values.push(filters.phaseId);
    }

    if (filters.status) {
      if (Array.isArray(filters.status)) {
        conditions.push(`status = ANY($${paramIndex++})`);
        values.push(filters.status);
      } else {
        conditions.push(`status = $${paramIndex++}`);
        values.push(filters.status);
      }
    }

    if (filters.reopened_from) {
      if (Array.isArray(filters.reopened_from)) {
        conditions.push(`reopened_from = ANY($${paramIndex++})`);
        values.push(filters.reopened_from);
      } else {
        conditions.push(`reopened_from = $${paramIndex++}`);
        values.push(filters.reopened_from);
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ' ORDER BY created_at ASC';

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
   * Validated state transition function.
   * Throws InvalidStateTransitionError if transition is illegal.
   */
  static async updateTaskStatus(id: string, nextStatus: TaskStatus): Promise<ITask> {
    const current = await this.getTaskById(id);
    if (!current) {
      throw new Error(`Task with ID "${id}" not found`);
    }

    // Validate state machine rule
    validateTaskTransition(current.status, nextStatus, { isReopen: false });

    let completedAtClause = '';
    if (nextStatus === 'COMPLETED' && current.status !== 'COMPLETED') {
      completedAtClause = ', completed_at = CURRENT_TIMESTAMP';
    } else if (current.status === 'COMPLETED' && nextStatus !== 'COMPLETED') {
      completedAtClause = ', completed_at = NULL';
    }

    const res = await query(
      `UPDATE tasks
       SET status = $2,
           updated_at = CURRENT_TIMESTAMP
           ${completedAtClause}
       WHERE id = $1
       RETURNING *`,
      [id, nextStatus]
    );

    return res.rows[0];
  }

  /**
   * Explicit reopening of completed, cancelled, or failed tasks.
   * Transitions COMPLETED, CANCELLED, or FAILED -> TODO and clears completed_at.
   */
  static async reopenTask(id: string): Promise<ITask> {
    const current = await this.getTaskById(id);
    if (!current) {
      throw new Error(`Task with ID "${id}" not found`);
    }

    validateTaskTransition(current.status, 'TODO', { isReopen: true });

    const res = await query(
      `UPDATE tasks
       SET status = 'TODO',
           reopened_from = $2,
           completed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, current.status]
    );

    return res.rows[0];
  }

  // --------------------------------------------------------------------------
  // TASK_SUGGESTION Flow (Human-in-the-loop Approval Gate)
  // --------------------------------------------------------------------------

  /**
   * Agent creates a task suggestion.
   * Sets status strictly to PENDING_REVIEW.
   */
  static async suggestTask(input: SuggestTaskInput): Promise<ITask> {
    const fullDescription = input.reasoning
      ? `${input.description ?? ''}\n\n[Suggestion Reasoning]: ${input.reasoning}`.trim()
      : input.description ?? null;

    const res = await query(
      `INSERT INTO tasks (project_id, phase_id, title, description, status)
       VALUES ($1, $2, $3, $4, 'PENDING_REVIEW')
       RETURNING *`,
      [input.project_id, input.phase_id ?? null, input.title, fullDescription]
    );

    return res.rows[0];
  }

  /**
   * Human approval gate: Promotes a PENDING_REVIEW suggestion to an actionable TODO task.
   * Allows human reviewer to provide overrides for title, description, or phase.
   */
  static async approveSuggestion(
    taskId: string,
    overrides?: ApproveSuggestionInput
  ): Promise<ITask> {
    const current = await this.getTaskById(taskId);
    if (!current) {
      throw new Error(`Task with ID "${taskId}" not found`);
    }

    if (current.status !== 'PENDING_REVIEW') {
      throw new Error(
        `Cannot approve task with status "${current.status}". Only tasks in "PENDING_REVIEW" can be approved.`
      );
    }

    const title = overrides?.title ?? current.title;
    const description = overrides?.description ?? current.description;
    const phaseId = overrides?.phase_id ?? current.phase_id;

    const res = await query(
      `UPDATE tasks
       SET status = 'TODO',
           title = $2,
           description = $3,
           phase_id = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [taskId, title, description, phaseId]
    );

    return res.rows[0];
  }

  /**
   * Human rejection gate: Discards a PENDING_REVIEW suggestion, marking it CANCELLED.
   */
  static async rejectSuggestion(taskId: string, reason?: string): Promise<ITask> {
    const current = await this.getTaskById(taskId);
    if (!current) {
      throw new Error(`Task with ID "${taskId}" not found`);
    }

    if (current.status !== 'PENDING_REVIEW') {
      throw new Error(
        `Cannot reject task with status "${current.status}". Only tasks in "PENDING_REVIEW" can be rejected.`
      );
    }

    const rejectionNote = reason ? `\n\n[Rejection Reason]: ${reason}` : '';
    const updatedDescription = `${current.description ?? ''}${rejectionNote}`.trim();

    const res = await query(
      `UPDATE tasks
       SET status = 'CANCELLED',
           description = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [taskId, updatedDescription]
    );

    return res.rows[0];
  }
}
