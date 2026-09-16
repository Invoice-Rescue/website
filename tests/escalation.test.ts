import { test, describe } from "node:test";
import assert from "node:assert";
import { nextStepDue, advanceEscalationStage, STEP_LABELS } from "../backend/src/lib/escalation";
import { InvoiceEscalationState } from "../backend/src/types/core";

describe("escalation cadence", () => {
  test("step labels match expectations", () => {
    assert.strictEqual(STEP_LABELS[1], "reminder");
    assert.strictEqual(STEP_LABELS[2], "follow-up");
    assert.strictEqual(STEP_LABELS[3], "firm notice");
    assert.strictEqual(STEP_LABELS[4], "final notice");
  });

  test("nextStepDue schedules step 1 at 1 day overdue", () => {
    assert.strictEqual(nextStepDue(0, []), null);
    assert.strictEqual(nextStepDue(1, []), 1);
  });

  test("nextStepDue schedules step 2 at 8 days overdue", () => {
    const historyStep1 = [{ step: 1 }];
    assert.strictEqual(nextStepDue(7, historyStep1), null);
    assert.strictEqual(nextStepDue(8, historyStep1), 2);
  });

  test("nextStepDue schedules step 3 at 15 days overdue", () => {
    const historyStep2 = [{ step: 1 }, { step: 2 }];
    assert.strictEqual(nextStepDue(14, historyStep2), null);
    assert.strictEqual(nextStepDue(15, historyStep2), 3);
  });

  test("nextStepDue schedules step 4 at 22 days overdue", () => {
    const historyStep3 = [{ step: 1 }, { step: 2 }, { step: 3 }];
    assert.strictEqual(nextStepDue(21, historyStep3), null);
    assert.strictEqual(nextStepDue(22, historyStep3), 4);
  });

  test("nextStepDue returns null when sequence is exhausted", () => {
    const historyStep4 = [{ step: 1 }, { step: 2 }, { step: 3 }, { step: 4 }];
    assert.strictEqual(nextStepDue(22, historyStep4), null);
  });

  test("advanceEscalationStage works for state machine", () => {
    const today = new Date("2026-09-16T00:00:00Z");
    const dueDate = new Date("2026-09-10T00:00:00Z"); // 6 days overdue
    const state: InvoiceEscalationState = { stage: "new", dueDate, lastChaseDate: null };

    // new -> stage1_gentle
    let dec = advanceEscalationStage(state, today);
    assert.strictEqual(dec.stage, "stage1_gentle");
    assert.strictEqual(dec.nextAction, "Send Stage 1 (gentle) reminder");

    // not enough days for stage 2
    state.stage = "stage1_gentle";
    state.lastChaseDate = new Date("2026-09-14T00:00:00Z"); // 2 days ago
    dec = advanceEscalationStage(state, today);
    assert.strictEqual(dec.stage, "stage1_gentle"); // unchanged
    assert.ok(dec.nextAction.startsWith("Waiting"));

    // advance to stage 2
    state.lastChaseDate = new Date("2026-09-09T00:00:00Z"); // 7 days ago
    dec = advanceEscalationStage(state, today);
    assert.strictEqual(dec.stage, "stage2_followup");

    // advance to stage 3
    state.stage = "stage2_followup";
    dec = advanceEscalationStage(state, today);
    assert.strictEqual(dec.stage, "stage3_firm");

    // advance to stage 4
    state.stage = "stage3_firm";
    dec = advanceEscalationStage(state, today);
    assert.strictEqual(dec.stage, "stage4_final");

    // wait at stage 4
    state.stage = "stage4_final";
    state.lastChaseDate = new Date("2026-09-14T00:00:00Z");
    dec = advanceEscalationStage(state, today);
    assert.strictEqual(dec.stage, "stage4_final");
    assert.ok(dec.nextAction.startsWith("Waiting"));

    // handover
    state.stage = "stage4_final";
    state.lastChaseDate = new Date("2026-09-09T00:00:00Z");
    dec = advanceEscalationStage(state, today);
    assert.strictEqual(dec.stage, "stage4_final");
    assert.ok(dec.nextAction.includes("handing back"));
  });
});
