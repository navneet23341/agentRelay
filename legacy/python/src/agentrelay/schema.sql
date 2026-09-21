PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXIST project(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    repository_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXIST task(
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'TODO',
    progress INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,

    FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,

    CHECK (status IN ('TODO', 'IN_PROGRESS','BLOCKED', 'COMPLETED', 'CANCELLED')),
    CHECK (progress >= 0 AND progress <= 100)
);

CREATE TABLE IF NOT EXIST event(
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    task_id INTEGER,
    type  TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL CURRENT_TIMESTAMP,

    FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES task(id) ON DELETE SET NULL,
    CHECK (type IN (
        'DECISION' , 'FAILURE'
    ))
);

CREATE INDEX IF NOT EXIST idx_task_project ON task(project_id);
CREATE INDEX IF NOT EXIST idx_task_status ON task(project_id,status);
CREATE INDEX IF NOT EXIST idx_event_project ON event(project_id);
CREATE INDEX IF NOT EXIST idx_event_task ON event(task_id);
CREATE INDEX IF NOT EXIST idx_event_type ON event(project_id, type);

CREATE UNIQUE INDEX IF NOT EXIST idx_one_active_task ON task(project_id) WHERE status = 'IN_PROGRESS';
