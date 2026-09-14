# Invoice Rescue — AI Prompt & Escalation Evaluations

This directory houses deterministic evaluation datasets and test scenarios for verifying AI-drafted chase messages, escalation cadences, and statutory interest compliance.

## Evaluation Criteria

1. **Step 1 (First Reminder)**:
   - Must be polite, warm, and professional.
   - Must reference invoice number, amount, and due date.
   - Must **not** threaten legal action or mention statutory late payment interest.
2. **Step 2 (Firm Follow-up)**:
   - Must mention statutory interest and fixed-sum compensation under the Late Payment of Commercial Debts (Interest) Act 1998.
   - Must cite the exact computed figures.
3. **Step 3 (Formal Notice)**:
   - Must state final deadline for payment.
   - Must reiterate statutory interest and compensation.
   - Must retain professional, non-harassing tone and disclaim debt collection agency powers.
4. **Tone & Brand Voice Alignment**:
   - Must incorporate client-specific voice notes when provided.
