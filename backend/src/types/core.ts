export type EscalationStage = 'new' | 'stage1_gentle' | 'stage2_followup' | 'stage3_firm' | 'stage4_final' | 'paid' | 'handed_back';

export const TERMINAL_STAGES = new Set<EscalationStage>(['paid', 'handed_back']);

export interface InvoiceEscalationState {
  stage: EscalationStage;
  dueDate: Date | null;
  lastChaseDate: Date | null;
}

export interface ChaseHistoryRow {
  step: number;
}

export interface EscalationDecision {
  stage: EscalationStage;
  daysOverdue: number | null;
  nextAction: string;
}
