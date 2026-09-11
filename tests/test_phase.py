from src.phase import create_phase, get_project_phases

phase_id = create_phase(
    1,
    "Foundation",
    "Build the core project and database layer",
    1
)

print("Created phase:", phase_id)

phases = get_project_phases(1)

for phase in phases:
    print(phase)