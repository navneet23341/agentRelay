from src.database import get_connection

from src.database import get_connection


def create_memory(
    project_id,
    task_id,
    memory_type,
    content,
    evidence_type,
    confidence
):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT INTO memory (
            project_id,
            task_id,
            type,
            content,
            evidence_type,
            confidence,
            status,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE',
                datetime('now'), datetime('now'))
    """, (
        project_id,
        task_id,
        memory_type,
        content,
        evidence_type,
        confidence
    ))

    connection.commit()

    memory_id = cursor.lastrowid

    connection.close()

    return memory_id

def get_memory(memory_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            project_id,
            task_id,
            type,
            content,
            evidence_type,
            confidence,
            status,
            created_at,
            updated_at,
            invalidated_at,
            invalidated_by,
            superseded_by
        FROM memory
        WHERE id = ?
    """, (memory_id,))

    memory = cursor.fetchone()

    connection.close()

    return memory

def get_task_memories(task_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            project_id,
            task_id,
            type,
            content,
            evidence_type,
            confidence,
            status,
            created_at,
            updated_at,
            invalidated_at,
            invalidated_by,
            superseded_by
        FROM memory
        WHERE task_id = ?
          AND status = 'ACTIVE'
        ORDER BY confidence DESC, created_at DESC
    """, (task_id,))

    memories = cursor.fetchall()

    connection.close()

    return memories

def invalidate_memory(memory_id, invalidated_by=None):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        UPDATE memory
        SET
            status = 'INVALIDATED',
            invalidated_at = datetime('now'),
            invalidated_by = ?,
            updated_at = datetime('now')
        WHERE id = ?
    """, (invalidated_by, memory_id))

    connection.commit()
    connection.close()

def supersede_memory(old_memory_id, new_memory_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        UPDATE memory
        SET
            status = 'SUPERSEDED',
            superseded_by = ?,
            updated_at = datetime('now')
        WHERE id = ?
    """, (new_memory_id, old_memory_id))

    connection.commit()
    connection.close()

