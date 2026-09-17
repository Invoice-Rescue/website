export type EscalationStage = 'new' | 'stage1_gentle' | 'stage2_followup' | 'stage3_firm' | 'stage4_final' | 'paid' | 'handed_back';
export declare const TERMINAL_STAGES: Set<EscalationStage>;
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
