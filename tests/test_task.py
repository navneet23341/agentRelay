from src.task import (
    create_task,
    get_task,
    get_phase_tasks,
    update_task_status,
    complete_task
)

task_id = create_task(
    1,
    "Implement database layer",
    "Create the SQLite connection and CRUD operations",
    priority=1
)

print("Created:", task_id)

update_task_status(task_id, "IN_PROGRESS")

print("Started:", get_task(task_id))

complete_task(task_id)

print("Completed:", get_task(task_id))

print("All tasks:", get_phase_tasks(1))