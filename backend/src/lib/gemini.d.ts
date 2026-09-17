/** One fetch call to Gemini's generateContent REST endpoint — no SDK dependency. */
export declare function draftChaseMessage(apiKey: string, prompt: string): Promise<string>;
export interface ChasePromptInput {
    clientVoiceNotes: string | null;
    debtorName: string;
    invoiceNumber: string;
    amountPence: number;
    currency: string;
    dueDate: string;
    daysOverdue: number;
    step: number;
    stepLabel: string;
    statutoryInterestPence: number;
    fixedCompensationPence: number;
    paymentLinkOrDetails?: string;
    clientBusinessName?: string;
}
export declare function buildChasePrompt(input: ChasePromptInput): string;
