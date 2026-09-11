from src.database import get_connection

def create_task(
    phase_id,
    title,
    description,
    priority=2,
    parent_task_id=None
):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT INTO task (
            phase_id,
            parent_task_id,
            title,
            description,
            status,
            priority,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, 'TODO', ?, datetime('now'), datetime('now'))
    """, (
        phase_id,
        parent_task_id,
        title,
        description,
        priority
    ))

    connection.commit()

    task_id = cursor.lastrowid

    connection.close()

    return task_id

def get_task(task_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            phase_id,
            parent_task_id,
            title,
            description,
            status,
            priority,
            created_at,
            updated_at,
            started_at,
            completed_at
        FROM task
        WHERE id = ?
    """, (task_id,))

    task = cursor.fetchone()

    connection.close()

    return task

def get_phase_tasks(phase_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            phase_id,
            parent_task_id,
            title,
            description,
            status,
            priority,
            created_at,
            updated_at,
            started_at,
            completed_at
        FROM task
        WHERE phase_id = ?
        ORDER BY priority, id
    """, (phase_id,))

    tasks = cursor.fetchall()

    connection.close()

    return tasks

def update_task_status(task_id, status):
    connection = get_connection()
    cursor = connection.cursor()

    if status == "IN_PROGRESS":
        cursor.execute("""
            UPDATE task
            SET
                status = ?,
                started_at = COALESCE(started_at, datetime('now')),
                updated_at = datetime('now')
            WHERE id = ?
        """, (status, task_id))
    else:
        cursor.execute("""
            UPDATE task
            SET
                status = ?,
                updated_at = datetime('now')
            WHERE id = ?
        """, (status, task_id))

    connection.commit()
    connection.close()

def complete_task(task_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        UPDATE task
        SET
            status = 'COMPLETED',
            completed_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
    """, (task_id,))

    connection.commit()
    connection.close()