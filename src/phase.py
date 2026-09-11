from src.database import get_connection


def create_phase(project_id, name, description, order_index, status="TODO"):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT INTO phase (
            project_id,
            name,
            description,
            order_index,
            status,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    """, (
        project_id,
        name,
        description,
        order_index,
        status
    ))

    connection.commit()

    phase_id = cursor.lastrowid

    connection.close()

    return phase_id


def get_phase(phase_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            project_id,
            name,
            description,
            order_index,
            status,
            created_at,
            updated_at
        FROM phase
        WHERE id = ?
    """, (phase_id,))

    phase = cursor.fetchone()

    connection.close()

    return phase


def get_project_phases(project_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            project_id,
            name,
            description,
            order_index,
            status,
            created_at,
            updated_at
        FROM phase
        WHERE project_id = ?
        ORDER BY order_index
    """, (project_id,))

    phases = cursor.fetchall()

    connection.close()

    return phases