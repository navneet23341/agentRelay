-- Up Migration
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS reopened_from TEXT CHECK (reopened_from IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED', 'PENDING_REVIEW'));

-- Down Migration
ALTER TABLE tasks
DROP COLUMN IF EXISTS reopened_from;