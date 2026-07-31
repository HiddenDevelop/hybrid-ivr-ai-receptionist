// Shared accept() for the insurance TYPE question (comercial vs. Reforma /
// Plan Vital), used by the new-patient and follow-up flows. The flows keep
// their own `after` hooks — when the Vital referido reminder plays differs
// per flow (new patient defers it when a company question is still coming).
function acceptInsuranceType(db, session, value) {
  // Carrier that sells both products, no comercial/Vital wording: ask
  // which one instead of guessing (re-asked indefinitely like any
  // re-prompt; 0 is always the way to a person). The company name is kept
  // so they don't have to repeat it after clarifying.
  if (value.insurance_type === 'unclear') {
    if (value.provider) session.providerHint = value.provider;
    return { ok: false, promptId: 'clarify_insurance_type' };
  }
  // Merge a company named on the ambiguous first pass into the resolved
  // answer — the read-back then confirms company + type together.
  // Consumed once: if the caller rejects that read-back, the hint is gone
  // and (in the new-patient flow) the company gets its own question again.
  if (!value.provider && session.providerHint) {
    value.provider = session.providerHint;
    session.providerHint = null;
  }
  return { ok: true };
}

module.exports = { acceptInsuranceType };
