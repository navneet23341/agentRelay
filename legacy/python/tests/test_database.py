from src.database import get_connection ,create_project , get_project

connection = get_connection()
cursor = connection.cursor()

# cursor.execute("""
#     SELECT name
#     FROM sqlite_master
#     WHERE type='table';
# """)

# tables = cursor.fetchall()

# print(tables)
# connection.close()


project_id = create_project(
    "agentRelay",
    "Shared memory system for coding agents",
    "Preserve project context across coding agents",
    "/home/navneet/agentRelay"
)

print("Created:", project_id)

project = get_project(project_id)

print("Project:", project)