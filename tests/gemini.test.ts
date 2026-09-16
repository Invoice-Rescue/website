import { test, describe } from "node:test";
import assert from "node:assert";
import { buildChasePrompt, type ChasePromptInput } from "../backend/src/lib/gemini";

describe("gemini prompt construction", () => {
  const baseInput: ChasePromptInput = {
    clientVoiceNotes: null,
    debtorName: "Acme Industries",
    invoiceNumber: "INV-9999",
    amountPence: 250_000, // £2,500.00
    currency: "GBP",
    dueDate: "2026-08-01",
    daysOverdue: 14,
    step: 1,
    stepLabel: "reminder",
    statutoryInterestPence: 1127,
    fixedCompensationPence: 7000,
    clientBusinessName: "TechCorp",
    paymentLinkOrDetails: "https://pay.example.com",
  };

  test("builds step 1 prompt without statutory interest mention", () => {
    const prompt = buildChasePrompt(baseInput);
    assert.ok(prompt.includes("Gentle, friendly note"));
    assert.ok(prompt.includes("Acme Industries"));
    assert.ok(prompt.includes("INV-9999"));
    assert.ok(prompt.includes("GBP 2500.00"));
    assert.ok(prompt.includes("Do not mention statutory interest yet"));
    assert.ok(prompt.includes("Tibor Rames\nInvoice Rescue — acting on behalf of TechCorp\nhello@invoicerescue.co.uk"));
  });

  test("builds step 3 prompt with statutory interest and compensation calculations", () => {
    const step3Input: ChasePromptInput = {
      ...baseInput,
      step: 3,
      stepLabel: "firm notice",
      clientVoiceNotes: "Warm but uncompromising tone, sign off as Accounts Team",
    };

    const prompt = buildChasePrompt(step3Input);
    assert.ok(prompt.includes("Firm, past agreed terms"));
    assert.ok(prompt.includes("Warm but uncompromising tone"));
    assert.ok(prompt.includes("statutory interest of GBP 11.27"));
    assert.ok(prompt.includes("fixed compensation of GBP 70.00"));
    assert.ok(prompt.includes("Late Payment of Commercial Debts (Interest) Act 1998"));
  });

  test("builds step 4 prompt with final notice", () => {
    const step4Input: ChasePromptInput = {
      ...baseInput,
      step: 4
    };

    const prompt = buildChasePrompt(step4Input);
    assert.ok(prompt.includes("Final reminder"));
  });
});
