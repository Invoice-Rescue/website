import { test, describe } from "node:test";
import assert from "node:assert";
import { nextStepDue, STEP_LABELS } from "../backend/src/lib/escalation";

describe("escalation cadence", () => {
  test("step labels match expectations", () => {
    assert.strictEqual(STEP_LABELS[1], "reminder");
    assert.strictEqual(STEP_LABELS[2], "firm follow-up");
    assert.strictEqual(STEP_LABELS[3], "formal notice");
  });

  test("nextStepDue schedules step 1 at 7 days overdue", () => {
    assert.strictEqual(nextStepDue(0, []), null);
    assert.strictEqual(nextStepDue(6, []), null);
    assert.strictEqual(nextStepDue(7, []), 1);
    assert.strictEqual(nextStepDue(13, []), 1);
  });

  test("nextStepDue schedules step 2 at 14 days overdue after step 1", () => {
    const historyStep1 = [{ step: 1 }];
    assert.strictEqual(nextStepDue(7, historyStep1), null);
    assert.strictEqual(nextStepDue(13, historyStep1), null);
    assert.strictEqual(nextStepDue(14, historyStep1), 2);
    assert.strictEqual(nextStepDue(20, historyStep1), 2);
  });

  test("nextStepDue schedules step 3 at 21 days overdue after step 2", () => {
    const historyStep2 = [{ step: 1 }, { step: 2 }];
    assert.strictEqual(nextStepDue(14, historyStep2), null);
    assert.strictEqual(nextStepDue(20, historyStep2), null);
    assert.strictEqual(nextStepDue(21, historyStep2), 3);
    assert.strictEqual(nextStepDue(30, historyStep2), 3);
  });

  test("nextStepDue returns null when sequence is exhausted", () => {
    const historyStep3 = [{ step: 1 }, { step: 2 }, { step: 3 }];
    assert.strictEqual(nextStepDue(21, historyStep3), null);
    assert.strictEqual(nextStepDue(60, historyStep3), null);
  });
});
