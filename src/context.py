from src.database import get_connection


def build_context(task_id):
    connection = get_connection()
    cursor = connection.cursor()

    # Get the current task
    cursor.execute("""
        SELECT
            id,
            phase_id,
            parent_task_id,
            title,
            description,
            status,
            priority
        FROM task
        WHERE id = ?
    """, (task_id,))

    task = cursor.fetchone()

    if task is None:
        connection.close()
        return None

    # Get active memories
    cursor.execute("""
        SELECT
            id,
            type,
            content,
            evidence_type,
            confidence,
            created_at
        FROM memory
        WHERE task_id = ?
          AND status = 'ACTIVE'
        ORDER BY confidence DESC, created_at DESC
    """, (task_id,))

    memories = cursor.fetchall()

    # Get latest handoff
    cursor.execute("""
        SELECT
            id,
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

    return {
        "task": task,
        "memories": memories,
        "handoff": handoff
    }


def format_context(context):
    if context is None:
        return None

    task = context["task"]
    memories = context["memories"]
    handoff = context["handoff"]

    output = []

    output.append("# AgentRelay Context\n")

    # Task
    output.append("## Current Task")

    output.append(f"Title: {task[3]}")
    output.append(f"Description: {task[4]}")
    output.append(f"Status: {task[5]}")
    output.append(f"Priority: {task[6]}")

    # Handoff
    if handoff:
        output.append("\n## Previous Handoff")

        output.append(f"Agent: {handoff[1]}")
        output.append(f"\nSummary:\n{handoff[2]}")

        output.append(f"\nCompleted:\n{handoff[3]}")
        output.append(f"\nRemaining:\n{handoff[4]}")
        output.append(f"\nNext Action:\n{handoff[5]}")

    # Memories
    if memories:
        output.append("\n## Relevant Memories")

        for memory in memories:
            output.append(f"\n### {memory[1]}")
            output.append(f"{memory[2]}")
            output.append(f"Confidence: {memory[4]}")
            output.append(f"Evidence: {memory[3]}")

    return "\n".join(output)