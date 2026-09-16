import { EscalationStage, TERMINAL_STAGES, InvoiceEscalationState, ChaseHistoryRow, EscalationDecision } from '../types/core';
export type { ChaseHistoryRow };

export const CADENCE_DAYS = [1, 8, 15, 22];

export const STEP_LABELS = [
  "",
  "reminder",
  "follow-up",
  "firm notice",
  "final notice"
];

const DAYS_OVERDUE_FOR_STAGE1 = 1;
const DAYS_SINCE_CHASE_FOR_STAGE2 = 7;
const DAYS_SINCE_CHASE_FOR_STAGE3 = 7;
const DAYS_SINCE_CHASE_FOR_STAGE4 = 7;

export function nextStepDue(daysOverdue: number, history: ChaseHistoryRow[]): number | null {
  const lastStep = history.reduce((max, h) => Math.max(max, h.step), 0);
  const nextStep = lastStep + 1;
  if (nextStep > CADENCE_DAYS.length) return null;
  return daysOverdue >= CADENCE_DAYS[nextStep - 1] ? nextStep : null;
}

export function diffDays(d1: Date, d2: Date): number {
  return Math.floor((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24));
}

export function advanceEscalationStage(state: InvoiceEscalationState, today: Date): EscalationDecision {
  let stage = state.stage || 'new';
  if (!state.dueDate) {
    return { stage, daysOverdue: null, nextAction: "No due_date on file — cannot compute overdue status" };
  }

  const daysOverdue = diffDays(today, state.dueDate);
  const daysSinceChase = state.lastChaseDate ? diffDays(today, state.lastChaseDate) : null;
  let nextAction = "No action — waiting";

  if (stage === "new") {
    if (daysOverdue >= DAYS_OVERDUE_FOR_STAGE1) {
      stage = "stage1_gentle";
      nextAction = "Send Stage 1 (gentle) reminder";
    } else {
      nextAction = "Not yet overdue — no action";
    }
  } else if (stage === "stage1_gentle") {
    if (daysSinceChase === null) {
      nextAction = "Send Stage 1 (gentle) reminder (no prior chase logged)";
    } else if (daysSinceChase >= DAYS_SINCE_CHASE_FOR_STAGE2) {
      stage = "stage2_followup";
      nextAction = "Send Stage 2 (follow-up) reminder";
    } else {
      nextAction = `Waiting — ${daysSinceChase}d since Stage 1 (need ${DAYS_SINCE_CHASE_FOR_STAGE2}+)`;
    }
  } else if (stage === "stage2_followup") {
    if (daysSinceChase === null) {
      nextAction = "Send Stage 2 (follow-up) reminder (no prior chase logged)";
    } else if (daysSinceChase >= DAYS_SINCE_CHASE_FOR_STAGE3) {
      stage = "stage3_firm";
      nextAction = "Send Stage 3 (firm) notice";
    } else {
      nextAction = `Waiting — ${daysSinceChase}d since Stage 2 (need ${DAYS_SINCE_CHASE_FOR_STAGE3}+)`;
    }
  } else if (stage === "stage3_firm") {
    if (daysSinceChase === null) {
      nextAction = "Send Stage 3 (firm) notice (no prior chase logged)";
    } else if (daysSinceChase >= DAYS_SINCE_CHASE_FOR_STAGE4) {
      stage = "stage4_final";
      nextAction = "Send Stage 4 (final) notice";
    } else {
      nextAction = `Waiting — ${daysSinceChase}d since Stage 3 (need ${DAYS_SINCE_CHASE_FOR_STAGE4}+)`;
    }
  } else if (stage === "stage4_final") {
    if (daysSinceChase === null) {
      nextAction = "Send Stage 4 (final) notice (no prior chase logged)";
    } else if (daysSinceChase >= DAYS_SINCE_CHASE_FOR_STAGE4) {
      nextAction = "No payment after final notice — consider handing back to client";
    } else {
      nextAction = `Waiting — ${daysSinceChase}d since Stage 4 (need ${DAYS_SINCE_CHASE_FOR_STAGE4}+)`;
    }
  }

  return { stage, daysOverdue, nextAction };
}
