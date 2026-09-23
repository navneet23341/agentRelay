import { TaskStatus } from '../models/types.js';

export class InvalidStateTransitionError extends Error {
  public readonly from: TaskStatus;
  public readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus, customMessage?: string) {
    const message =
      customMessage ||
      `Invalid task state transition from "${from}" to "${to}". Allowed transitions from "${from}": [${(
        VALID_TASK_TRANSITIONS[from] || []
      ).join(', ')}]`;
    super(message);
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Validated transition matrix for Task lifecycle states.
 */
export const VALID_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING_REVIEW: ['TODO', 'CANCELLED'],
  TODO: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED', 'TODO'],
  BLOCKED: ['IN_PROGRESS', 'TODO', 'CANCELLED'],
  FAILED: ['TODO'],
  COMPLETED: ['TODO'],
  CANCELLED: ['TODO'],
} as const;

/**
 * Checks whether a transition between two task states is legal.
 */
export function isValidTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  options: { isReopen?: boolean } = {}
): boolean {
  if (from === to) return true;

  // Terminal states (COMPLETED, CANCELLED, FAILED) require explicit reopen to return to TODO
  if (from === 'COMPLETED' || from === 'CANCELLED' || from === 'FAILED') {
    return to === 'TODO' && !!options.isReopen;
  }

  const allowed = VALID_TASK_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Asserts that a state transition is legal, throwing InvalidStateTransitionError if not.
 */
export function validateTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  options: { isReopen?: boolean } = {}
): void {
  if (from === to) return;

  if (from === 'COMPLETED' && to !== 'TODO') {
    throw new InvalidStateTransitionError(
      from,
      to,
      `Cannot transition task directly from "COMPLETED" to "${to}". Completed tasks must be explicitly reopened to "TODO" first.`
    );
  }

  if (from === 'CANCELLED' && to !== 'TODO') {
    throw new InvalidStateTransitionError(
      from,
      to,
      `Cannot transition task directly from "CANCELLED" to "${to}". Cancelled tasks must be explicitly reopened to "TODO" first.`
    );
  }

  if (from === 'FAILED' && to !== 'TODO') {
    throw new InvalidStateTransitionError(
      from,
      to,
      `Cannot transition task directly from "FAILED" to "${to}". Failed tasks must be explicitly reopened to "TODO" first.`
    );
  }

  if (
    (from === 'COMPLETED' || from === 'CANCELLED' || from === 'FAILED') &&
    to === 'TODO' &&
    !options.isReopen
  ) {
    throw new InvalidStateTransitionError(
      from,
      to,
      `Cannot transition task from "${from}" to "TODO" using standard status update. Call reopenTask() instead.`
    );
  }

  if (from === 'PENDING_REVIEW' && to !== 'TODO' && to !== 'CANCELLED') {
    throw new InvalidStateTransitionError(
      from,
      to,
      `Task in "PENDING_REVIEW" cannot transition to "${to}". It must be approved (to "TODO") or rejected (to "CANCELLED") by a human.`
    );
  }

  if (!isValidTaskTransition(from, to, options)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
