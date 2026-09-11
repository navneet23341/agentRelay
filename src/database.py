import sqlite3

#creation connection
def get_connection():
    return sqlite3.connect("data/agentRelay1.db")

#to create a project
def create_project(name, description, goal, repository_path):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        INSERT INTO Project (
            name,
            description,
            goal,
            repository_path,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    """, (
        name,
        description,
        goal,
        repository_path
    ))

    connection.commit()

    project_id = cursor.lastrowid

    connection.close()

    return project_id

#to read the project
def get_project(project_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            id,
            name,
            description,
            goal,
            repository_path,
            created_at,
            updated_at
        FROM project
        WHERE id = ?
    """, (project_id,))

    project = cursor.fetchone()

    connection.close()

    return project

def update_project(project_id, name, description, goal, repository_path):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        UPDATE project
        SET
            name = ?,
            description = ?,
            goal = ?,
            repository_path = ?,
            updated_at = datetime('now')
        WHERE id = ?
    """, (
        name,
        description,
        goal,
        repository_path,
        project_id
    ))

    connection.commit()
    connection.close()


def delete_project(project_id):
    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute("""
        DELETE FROM project
        WHERE id = ?
    """, (project_id,))

    connection.commit()
    connection.close()