// Per-deployment intake toggles (.env): some clinics don't want the
// allergies or visit-reason questions in the automated call. Both default
// to asking; only the literal string "false" turns one off, so a typo fails
// safe (asks an extra question rather than silently dropping one).
//
// Read at call time — each skip() evaluation — not at module load: flows
// are singletons required through menu.js, and a load-time constant would
// force the require-cache gymnastics prompts.test.js needs. These strings
// aren't cached TTS audio, so no prompt re-synthesis is involved either way;
// a skipped question simply leaves its cached prompt unplayed.

const askAllergies = () => process.env.ASK_ALLERGIES !== 'false';
const askReason = () => process.env.ASK_REASON !== 'false';

module.exports = { askAllergies, askReason };
