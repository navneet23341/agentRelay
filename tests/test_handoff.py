from src.handoff import create_handoff, get_latest_handoff

handoff_id = create_handoff(
    1,
    1,
    "agent-A",
    "Implemented the SQLite database layer.",
    "Project, phase, task and memory CRUD are working.",
    "CLI and context compilation are still pending.",
    "Implement the context compiler."
)

print("Created handoff:", handoff_id)
print("Latest handoff:", get_latest_handoff(1))