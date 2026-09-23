export type MemoryType = 'DECISION' | 'FAILURE' | 'CHANGE' | 'OBSERVATION' | 'HANDOFF';

export type ConfidenceClass = 'OBSERVED' | 'INFERRED' | 'SUGGESTED';

export const CONFIDENCE_CLASS_SCORES: Record<ConfidenceClass, number> = {
  OBSERVED: 1.0,
  INFERRED: 0.7,
  SUGGESTED: 0.3,
};

export type MemoryStatus = 'ACTIVE' | 'SUPERSEDED' | 'INVALIDATED';

export type TaskStatus =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'PENDING_REVIEW';

export type PhaseStatus = 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface IProject {
  id: string;
  name: string;
  goal: string | null;
  constraints: string | null;
  repository_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface IProjectCreateInput {
  name: string;
  goal?: string | null;
  constraints?: string | null;
  repository_ref?: string | null;
}

export interface IPhase {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  order_index: number;
  status: PhaseStatus;
  created_at: Date;
  updated_at: Date;
}

export interface IPhaseCreateInput {
  project_id: string;
  name: string;
  description?: string | null;
  order_index?: number;
  status?: PhaseStatus;
}

export interface ITask {
  id: string;
  project_id: string;
  phase_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  reopened_from: TaskStatus | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ITaskCreateInput {
  project_id: string;
  phase_id?: string | null;
  title: string;
  description?: string | null;
  status?: TaskStatus;
}

export interface IMemory {
  id: string;
  type: MemoryType;
  content: string;
  embedding: number[] | string | null;
  confidence_class: ConfidenceClass;
  confidence_score: number;
  status: MemoryStatus;
  created_at: Date;
  invalidated_at: Date | null;
  invalidated_by: string | null;
  superseded_by: string | null;
  task_id: string | null;
  semantic_hash: string | null;
  hit_count: number;
  last_seen_at: Date;
  causal_parents: string[];
}

export interface IMemoryCreateInput {
  type: MemoryType;
  content: string;
  embedding?: number[] | string | null;
  confidence_class: ConfidenceClass;
  confidence_score?: number;
  status?: MemoryStatus;
  invalidated_at?: Date | null;
  invalidated_by?: string | null;
  superseded_by?: string | null;
  task_id?: string | null;
  semantic_hash?: string | null;
  hit_count?: number;
  last_seen_at?: Date;
  causal_parents?: string[];
}

export interface MemoryListFilters {
  taskId?: string;
  phaseId?: string;
  type?: MemoryType | MemoryType[];
  status?: MemoryStatus | MemoryStatus[] | 'ALL';
  limit?: number;
  offset?: number;
}

export interface CausalLineageOptions {
  maxDepth?: number;
  includeSelf?: boolean;
}

export interface IMemoryWithDepth extends IMemory {
  depth: number;
}

export interface MemorySearchResult extends IMemory {
  similarity_score: number;
}

export interface MemorySearchFilters extends MemoryListFilters {
  limit?: number;
  minSimilarity?: number;
}

export interface BackfillEmbeddingsResult {
  processed: number;
  updated: number;
  failed: number;
}

export interface CreateMemoryResult {
  memory: IMemory;
  isDuplicate: boolean;
}

export interface SupersedeMemoryResult {
  oldMemory: IMemory;
  newMemory: IMemory;
}

export interface TaskListFilters {
  projectId?: string;
  phaseId?: string;
  status?: TaskStatus | TaskStatus[];
  reopened_from?: TaskStatus | TaskStatus[];
  limit?: number;
  offset?: number;
}

export interface PhaseListFilters {
  projectId?: string;
  status?: PhaseStatus | PhaseStatus[];
}

export interface SuggestTaskInput {
  project_id: string;
  phase_id?: string | null;
  title: string;
  description?: string | null;
  reasoning?: string;
}

export interface ApproveSuggestionInput {
  title?: string;
  description?: string;
  phase_id?: string;
}

export interface HandoffData {
  completedItems: string[];
  remainingItems: string[];
  currentIssue?: string | null;
  nextAction: string;
}
