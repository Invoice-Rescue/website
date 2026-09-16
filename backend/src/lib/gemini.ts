/** One fetch call to Gemini's generateContent REST endpoint — no SDK dependency. */
export async function draftChaseMessage(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
  );
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
  }
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`Gemini did not finish cleanly: ${candidate.finishReason}`);
  }
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no draft text");
  return text.trim();
}

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
  // legacy mapping fields, assumed passed via other means or defaulted
  paymentLinkOrDetails?: string;
  clientBusinessName?: string;
}

export function buildChasePrompt(input: ChasePromptInput): string {
  const stageRules: Record<number, string> = {
    1: "Stage 1: Gentle, friendly note, assumption it slipped through. Do not mention statutory interest yet — keep it light.",
    2: "Stage 2: Following up, asking when to expect payment or if anything holds it up.",
    3: "Stage 3: Firm, past agreed terms, demand payment or firm date. State plainly that statutory interest and fixed compensation under the Late Payment of Commercial Debts (Interest) Act 1998 are now due.",
    4: "Stage 4: Final reminder, give 7-day notice before returning the matter to the client."
  };

  const amount = `${input.currency} ${(input.amountPence / 100).toFixed(2)}`;
  const interest = `${input.currency} ${(input.statutoryInterestPence / 100).toFixed(2)}`;
  const comp = `${input.currency} ${(input.fixedCompensationPence / 100).toFixed(2)}`;
  
  const paymentDetails = input.paymentLinkOrDetails || "See original invoice for payment details";
  const clientName = input.clientBusinessName || "[Client Business Name]";

  const instructions = [
    `Draft an email chasing an overdue invoice.`,
    `SENDER MODEL (LOCKED):`,
    `FROM: hello@invoicerescue.co.uk`,
    `Sign-off (every stage MUST use this exactly):`,
    `Tibor Rames`,
    `Invoice Rescue — acting on behalf of ${clientName}`,
    `hello@invoicerescue.co.uk`,
    `---`,
    `Merge fields to use (do not use brackets, use the values):`,
    `Debtor Contact: ${input.debtorName}`,
    `Client Business: ${clientName}`,
    `Invoice No: ${input.invoiceNumber}`,
    `Amount: ${amount}`,
    `Due Date: ${input.dueDate}`,
    `Days Overdue: ${input.daysOverdue}`,
    `Payment Details: ${paymentDetails}`,
    `---`,
    `Stage Instructions:`,
    stageRules[input.step] || "Unknown step",
    `---`,
    `Voice Notes:`,
    input.clientVoiceNotes ? input.clientVoiceNotes : `Professional, direct.`,
    `---`,
    `Strict rules:`,
    `- Factual only, no false legal threats.`,
    `- No invented fees.`,
    `- Stop sequence the moment payment lands.`,
    `- Output only the email body text and sign-off, no subject line, no placeholders.`
  ];

  if (input.step >= 3) {
    instructions.push(`- Mention statutory interest of ${interest} and fixed compensation of ${comp}.`);
  }

  return instructions.join("\n");
}
