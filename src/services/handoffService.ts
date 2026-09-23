import { TaskService } from './taskService.js';
import { MemoryService } from './memoryService.js';
import { HandoffData, IMemory, ITask } from '../models/types.js';

export interface CreateHandoffResult {
  handoffMemory: IMemory;
  task: ITask;
}

export class HandoffService {
  /**
   * Formats structured HandoffData into standardized Markdown.
   */
  static formatHandoffContent(data: HandoffData): string {
    const completedList =
      data.completedItems.length > 0
        ? data.completedItems.map((item) => `- [x] ${item}`).join('\n')
        : '_None_';

    const remainingList =
      data.remainingItems.length > 0
        ? data.remainingItems.map((item) => `- [ ] ${item}`).join('\n')
        : '_None_';

    const currentIssue = data.currentIssue?.trim() || '_None_';
    const nextAction = data.nextAction.trim();

    return [
      '# Task Handoff',
      '',
      '## Completed Items',
      completedList,
      '',
      '## Remaining Items',
      remainingList,
      '',
      '## Current Issue',
      currentIssue,
      '',
      '## Next Action',
      nextAction,
    ].join('\n');
  }

  /**
   * Creates a HANDOFF memory record tied to the given task_id.
   */
  static async createHandoff(
    taskId: string,
    data: HandoffData
  ): Promise<CreateHandoffResult> {
    const task = await TaskService.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task with ID "${taskId}" not found`);
    }

    const content = this.formatHandoffContent(data);

    const { memory } = await MemoryService.createMemory({
      type: 'HANDOFF',
      content,
      confidence_class: 'OBSERVED',
      confidence_score: 1.0,
      task_id: taskId,
    });

    return {
      handoffMemory: memory,
      task,
    };
  }

  /**
   * Retrieves the latest active handoff memory for a given task.
   */
  static async getLatestHandoff(taskId: string): Promise<IMemory | null> {
    const memories = await MemoryService.listMemories({
      taskId,
      type: 'HANDOFF',
      status: 'ACTIVE',
      limit: 1,
    });

    return memories[0] || null;
  }
}
