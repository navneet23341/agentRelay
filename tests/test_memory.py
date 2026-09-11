from src.memory import (
    create_memory,
    get_memory,
    get_task_memories,
    supersede_memory
)

old_memory = create_memory(
    1,
    1,
    "DECISION",
    "Use SQLite for the first version of agentRelay.",
    "OBSERVED",
    0.95
)

new_memory = create_memory(
    1,
    1,
    "DECISION",
    "Use PostgreSQL when we move to production.",
    "SUGGESTED",
    0.70
)

supersede_memory(old_memory, new_memory)

print("Old:", get_memory(old_memory))
print("New:", get_memory(new_memory))
print("Active task memories:", get_task_memories(1))