from src.database import get_connection


def create_handoff(
    project_id,
    task_id,
    agent_id,
    summary,
    completed,
    remaining,
    next_action
):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT INTO handoff (
            project_id,
            task_id,
            agent_id,
            summary,
            completed,
            remaining,
            next_action,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    """, (
        project_id,
        task_id,
        agent_id,
        summary,
        completed,
        remaining,
        next_action
    ))

    connection.commit()

    handoff_id = cursor.lastrowid

    connection.close()

    return handoff_id

def get_latest_handoff(task_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            project_id,
            task_id,
            agent_id,
            summary,
            completed,
            remaining,
            next_action,
            created_at
        FROM handoff
        WHERE task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    """, (task_id,))

    handoff = cursor.fetchone()

    connection.close()

    return handoff