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
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
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
}

export function buildChasePrompt(input: ChasePromptInput): string {
  const amount = (input.amountPence / 100).toFixed(2);
  const interest = (input.statutoryInterestPence / 100).toFixed(2);
  const compensation = (input.fixedCompensationPence / 100).toFixed(2);
  return [
    `Draft a ${input.stepLabel} email chasing an overdue invoice, in the client's brand voice.`,
    input.clientVoiceNotes
      ? `Brand voice notes: ${input.clientVoiceNotes}`
      : "Brand voice: professional, direct, no threats beyond what's stated below.",
    `Debtor: ${input.debtorName}`,
    `Invoice ${input.invoiceNumber}: ${input.currency} ${amount}, due ${input.dueDate}, ${input.daysOverdue} days overdue.`,
    `This is escalation step ${input.step} (${input.stepLabel}).`,
    input.step >= 2
      ? `State plainly that statutory interest of ${input.currency} ${interest} and fixed compensation of ${input.currency} ${compensation} under the Late Payment of Commercial Debts (Interest) Act 1998 are now due, in addition to the invoice amount.`
      : "Do not mention statutory interest yet — this is a first reminder, keep it light.",
    "Output only the email body text, no subject line, no placeholders like [Your Name].",
  ].join("\n");
}
