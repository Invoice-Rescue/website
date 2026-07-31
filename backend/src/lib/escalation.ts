/**
 * ponytail: day-offset cadence (7/14/21) is the placeholder from
 * docs/credit-control-system-design.md §4.2 — it's a business decision, not
 * an engineering one. Confirm the real escalation sequence before this drafts
 * messages for a paying client.
 */
const CADENCE_DAYS = [7, 14, 21];

export const STEP_LABELS = ["", "reminder", "firm follow-up", "formal notice"];

export interface ChaseHistoryRow {
  step: number;
}

/** Returns the next step number due given days overdue and chase history, or null if none is due yet / sequence exhausted. */
export function nextStepDue(daysOverdue: number, history: ChaseHistoryRow[]): number | null {
  const lastStep = history.reduce((max, h) => Math.max(max, h.step), 0);
  const nextStep = lastStep + 1;
  if (nextStep > CADENCE_DAYS.length) return null;
  return daysOverdue >= CADENCE_DAYS[nextStep - 1] ? nextStep : null;
}
