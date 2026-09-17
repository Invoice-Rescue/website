import { InvoiceEscalationState, ChaseHistoryRow, EscalationDecision } from '../types/core';
export type { ChaseHistoryRow };
export declare const CADENCE_DAYS: number[];
export declare const STEP_LABELS: string[];
export declare function nextStepDue(daysOverdue: number, history: ChaseHistoryRow[]): number | null;
export declare function diffDays(d1: Date, d2: Date): number;
export declare function advanceEscalationStage(state: InvoiceEscalationState, today: Date): EscalationDecision;
