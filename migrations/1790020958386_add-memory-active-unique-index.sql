-- Up Migration
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_task_semantic_hash_active
ON memories (task_id, semantic_hash)
WHERE status = 'ACTIVE';

-- Down Migration
DROP INDEX IF EXISTS idx_memories_task_semantic_hash_active;