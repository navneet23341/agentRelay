import { ProjectModel } from '../models/Project.js';
import { PhaseService } from './phaseService.js';
import { TaskService } from './taskService.js';
import { IProject, IPhase, ITask, TaskStatus } from '../models/types.js';

export interface ProjectStateResult {
  project: IProject;
  phases: IPhase[];
  tasks: ITask[];
  taskSummary: Record<TaskStatus, number>;
}

export class ProjectService {
  /**
   * Retrieves high-level state of a project including its phases, tasks, and status counts.
   */
  static async getProjectState(projectId: string): Promise<ProjectStateResult> {
    const project = await ProjectModel.findById(projectId);
    if (!project) {
      throw new Error(`Project with ID "${projectId}" not found`);
    }

    const phases = await PhaseService.listPhases(projectId);
    const tasks = await TaskService.listTasks({ projectId });

    const taskSummary: Record<TaskStatus, number> = {
      TODO: 0,
      IN_PROGRESS: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLED: 0,
      PENDING_REVIEW: 0,
    };

    for (const t of tasks) {
      if (t.status in taskSummary) {
        taskSummary[t.status]++;
      }
    }

    return {
      project,
      phases,
      tasks,
      taskSummary,
    };
  }
}
