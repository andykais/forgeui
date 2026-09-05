import type { Database } from "@db/sqlite";

/**
 * Every SQL statement the app runs lives here, one function per query. The
 * database is a derived index (§7), so nothing in here is a source of truth.
 */

export interface WorkflowUsage {
  /** When the workflow was last submitted, ms since epoch. */
  last_job_at: number | null;
  /** Most recent surviving output, for the workflow card's thumbnail. */
  last_output_id: string | null;
}

/** Usage figures for the Workflows list and the Generate workflow card. */
export function workflowUsage(db: Database): Map<string, WorkflowUsage> {
  const usage = new Map<string, WorkflowUsage>();
  const upsert = (id: string): WorkflowUsage => {
    const existing = usage.get(id);
    if (existing) return existing;
    const created = { last_job_at: null, last_output_id: null };
    usage.set(id, created);
    return created;
  };

  const jobs = db.prepare(
    `SELECT workflow_id, MAX(created_at) AS last_job_at
       FROM jobs
      WHERE workflow_id IS NOT NULL
      GROUP BY workflow_id`,
  ).values<[string, number]>();
  for (const [id, lastJobAt] of jobs) upsert(id).last_job_at = lastJobAt;

  const outputs = db.prepare(
    `SELECT workflow_id, id, MAX(created_at)
       FROM outputs
      WHERE workflow_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY workflow_id`,
  ).values<[string, string, number]>();
  for (const [id, outputId] of outputs) upsert(id).last_output_id = outputId;

  return usage;
}
