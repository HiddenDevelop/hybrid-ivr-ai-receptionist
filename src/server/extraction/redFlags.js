// Plain-code red-flag gate. Runs on the raw Spanish transcript BEFORE any
// LLM call — a model hiccup must never be able to suppress an escalation
// (prior project: a conversational model called scheduling tools on a
// chest-pain mention). Keyword matching only, no model in the loop.
//
// Keywords are Spanish-only on purpose: this deployment's transcripts are
// Spanish (WHISPER_LANGUAGE=es), and English entries would never match —
// they'd just be noise to maintain (see CLAUDE.md "Red flag / triage gate").
//
// Matching is negation-aware: the symptom-check prompt literally asks
// "¿Tiene fiebre, sangrado...?", so healthy callers ANSWER with the trigger
// words ("no tengo fiebre ni sangrado"). A match is discarded only when a
// negator ("no", "sin", "ni", ...) appears immediately before the phrase in
// the same clause; punctuation ends a clause, so "no, estoy sangrando"
// (a "no" answering the previous question) still escalates. When in doubt
// the gate errs toward escalating — a false page to the on-call MD beats a
// scheduled bleeding patient.

// Lowercase, strip diacritics (Whisper's accenting is unreliable), keep
// punctuation as a clause-boundary marker "|", collapse whitespace.
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[,.;:!?()¿¡]+/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words that, appearing right before a phrase in the same clause, mean the
// caller is DENYING the symptom.
const NEGATORS = new Set(['no', 'sin', 'ni', 'nada', 'tampoco', 'nunca', 'jamas']);
// How many tokens back to look for a negator before giving up.
const NEGATION_WINDOW = 3;

// Trigger phrases and their common spoken variants/conjugations, including
// Puerto Rican usage ("botando sangre"). Multi-word phrases match as token
// sequences, so ordinary filler around them still hits.
const RED_FLAG_PHRASES = [
  // fever
  'fiebre',
  'calentura',
  'temperatura alta',
  // bleeding
  'sangrado',
  'sangrando',
  'botando sangre',
  'me sale sangre',
  'sale sangre',
  'mucha sangre',
  'no para de sangrar',
  'no deja de sangrar',
  'hemorragia',
  // chest pain
  'dolor de pecho',
  'dolor en el pecho',
  'me duele el pecho',
  'presion en el pecho',
  'opresion en el pecho',
  // trouble breathing
  'no puedo respirar',
  'no puede respirar',
  'dificultad para respirar',
  'me falta el aire',
  'le falta el aire',
  'falta de aire',
  'me ahogo',
  'se ahoga',
  // loss of consciousness
  'inconsciente',
  'se desmayo',
  'me desmaye',
  'perdio el conocimiento',
  'perdi el conocimiento',
  'no responde',
  // wound emergencies (post-op population)
  'se abrio la herida',
  'se me abrio la herida',
  'pus en la herida',
].map((p) => normalize(p).split(' '));

// True if tokens[i-1..] within the clause contain a negator ("no tengo
// fiebre", "sin sangrado", "ni fiebre"). A "|" clause boundary stops the
// lookback, so a standalone "no," answering something else doesn't negate.
function isNegated(tokens, phraseStart) {
  for (let back = 1; back <= NEGATION_WINDOW; back += 1) {
    const i = phraseStart - back;
    if (i < 0) break;
    if (tokens[i] === '|') break;
    if (NEGATORS.has(tokens[i])) return true;
  }
  return false;
}

// Returns the first non-negated matched phrase (as a normalized string) or
// null. Callers treat any non-null return as an immediate escalation — no
// extraction, no scheduling.
function checkRedFlags(transcript) {
  if (!transcript) return null;
  const tokens = normalize(transcript).split(' ');

  for (const phrase of RED_FLAG_PHRASES) {
    for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
      let matches = true;
      for (let j = 0; j < phrase.length; j += 1) {
        if (tokens[start + j] !== phrase[j]) { matches = false; break; }
      }
      if (!matches) continue;
      // Phrases that carry their own negation ("no puedo respirar") are
      // affirmative symptoms — never negation-filtered.
      if (phrase[0] !== 'no' && isNegated(tokens, start)) continue;
      return phrase.join(' ');
    }
  }
  return null;
}

module.exports = { checkRedFlags, normalize, RED_FLAG_PHRASES };
