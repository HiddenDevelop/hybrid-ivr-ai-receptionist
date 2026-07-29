// ALL caller-facing copy lives here, and all of it is Spanish — greetings,
// re-prompts, confirmations, fallbacks, escalation, SMS. No English
// fallback exists anywhere in the call (CLAUDE.md "Language requirement").
// Adding a prompt in English here is a bug, not a stub.
//
// Fixed prompts (PROMPTS) are pre-synthesized and cached at startup by
// tts/cache.js. The few dynamic sentences (slot offers, confirmations —
// they contain dates) are built by the template functions below and
// synthesized live, once per call at most; espeak-ng reads the digits in
// Spanish, and times are spelled out in words to keep pronunciation clean.

// Speech-controlled main menu is currently DISABLED (the menu is DTMF-only;
// data-collection answers are still spoken). To re-enable, set
// MENU_SPEECH_ENABLED=true in .env and restart — the greeting copy below
// and the session routing both key off this one flag.
const MENU_SPEECH_ENABLED = process.env.MENU_SPEECH_ENABLED === 'true';

// Field read-back confirmation style. Default is voice-only ("diga sí o
// no"); set FIELD_CONFIRM_DTMF=true in .env to go back to announcing the
// 1/2 key options. Keys 1 and 2 keep working in BOTH modes (session.onDtmf
// doesn't key off this) — the flag only changes what the caller is told.
// Like every fixed prompt this is cached at startup: restart after changing.
const FIELD_CONFIRM_DTMF = process.env.FIELD_CONFIRM_DTMF === 'true';

// Copy is written for Puerto Rico specifically: "oprima" (not "marque"),
// "cita" (not "consulta"), "récord médico" (not "expediente"), "referido"
// (not "referencia"), "plan médico" (not "aseguranza"), "médico de turno"
// (not "de guardia"). Keep it that way in future edits.
const PROMPTS = {
  greeting_menu:
    'Gracias por llamar a la Clínica de Cirugía General. '
    + 'Favor de escuchar todas las opciones. '
    + 'Si es paciente nuevo, oprima uno. '
    + 'Para una cita de seguimiento, oprima dos. '
    + 'Si le operaron recientemente, oprima tres. '
    + 'Si llama por un referido médico, oprima cuatro. '
    + (MENU_SPEECH_ENABLED
      ? 'También puede decir: paciente nuevo, seguimiento, operación reciente, o referido. '
      : '')
    // The escape hatch, announced up front and repeated in every re-prompt:
    // most of this clinic's callers are elderly, and a caller who can't get
    // through the automated flow must never have to guess how to reach a
    // person. 0 works from ANY point in the call (see session.onDtmf).
    + 'Si prefiere hablar con una persona, oprima cero en cualquier momento. '
    + 'También puede oprimir estrella para volver a este menú. ',
    // Optional, never required: the turn detector waits 1.8s on open answers
    // by itself. This is for callers who would rather not wait.
    //+ 'Cuando termine de hablar, puede esperar un momento o oprimir el numeral.',
  menu_retry:
    'Perdón. Oprima uno para paciente nuevo, dos para seguimiento, '
    + 'tres si le operaron recientemente, o cuatro para un referido médico. '
    // The 0 escape hatch is repeated in every re-prompt (CLAUDE.md): the
    // caller who just fumbled a question is exactly the caller most likely
    // to need a person.
    + 'Si prefiere hablar con una persona, oprima cero. ',

  // shared data-collection re-prompts / bailout
  reprompt_generic:
    'Perdón, no le entendí bien. ¿Podría repetirlo, por favor? '
    + 'Si prefiere, cuando termine de hablar, oprima el numeral. '
    + 'Y si desea hablar con una persona, oprima cero. ',
  handoff_human:
    'Estoy teniendo dificultades para entenderle. '
    + 'Le voy a comunicar con nuestro equipo de citas para ayudarle. Un momento, por favor.',
  // Caller pressed 0. Deliberately warm and short — they have already
  // decided; nothing here should sound like another attempt to keep them
  // in the automated flow.
  handoff_operator:
    'Con mucho gusto. Le comunico con nuestro equipo de citas. Un momento, por favor.',

  // Field read-back (see fieldReadbackText below). The value itself is one
  // short live-synthesized sentence; this fixed question is cached.
  confirm_field: FIELD_CONFIRM_DTMF
    ? '¿Es correcto? Oprima uno si está bien, o dos si lo tengo que corregir. '
      + 'También puede decir sí o no.'
    : '¿Es correcto? Diga sí o no, por favor.',
  retry_field: 'Está bien, vamos a corregirlo.',

  // new patient
  ask_full_name: 'Para empezar, ¿me puede decir su nombre y apellido, por favor?',
  ask_dob: 'Gracias. ¿Cuál es su fecha de nacimiento?',
  ask_phone: '¿A qué número de teléfono le podemos llamar?',
  // Variant played when Twilio delivered a caller ID: the caller can accept
  // the number they're calling from with a "sí" instead of dictating ten
  // digits. The digits still get the normal read-back before being kept.
  ask_phone_caller_id:
    '¿Le podemos llamar al número desde el cual nos está llamando? '
    + 'Diga sí, o dígame el número que prefiera.',
  // Insurance is asked in two turns: coverage TYPE first (comercial vs.
  // Reforma / Plan Vital — Vital patients must be reminded to bring a
  // referido from their médico primario), then the company. If the caller
  // names the company while answering the type question, the company
  // question is skipped (flows/newPatient.js).
  ask_insurance_type:
    '¿Su plan médico es un seguro comercial, o pertenece a la Reforma o Plan Vital?',
  // Caller named a carrier that sells both (Triple-S, MCS, First Medical,
  // Menonita...) without saying which product — ask, never assume.
  clarify_insurance_type: '¿Ese plan es comercial, o pertenece a la Reforma o Plan Vital?',
  ask_insurance: '¿Con cuál compañía de plan médico cuenta?',
  ask_insurance_vital: '¿Con cuál compañía de Plan Vital cuenta?',
  // Played ONLY on the Plan Vital path, right after the company lands —
  // commercial callers must never hear it.
  vital_referral_reminder:
    'Perfecto. Le recordamos que para su cita debe traer un referido vigente de su médico primario.',
  ask_allergies: '¿Es alérgico o alérgica a algún medicamento?',
  ask_reason: '¿Cuál es el motivo de su cita?',

  // follow-up
  ask_mrn_or_phone:
    'Para buscar su récord, dígame su número de récord médico, '
    + 'o el número de teléfono que tenemos registrado.',
  record_not_found:
    'No encontré su récord con esos datos. Vamos a intentarlo una vez más.',
  ask_followup_reason: '¿Cuál es el motivo de su cita de seguimiento?',

  // post-op
  ask_surgery_date: '¿En qué fecha fue su operación?',
  ask_symptoms:
    'Dígame cómo se siente. ¿Tiene fiebre, sangrado, o algún problema con la herida o el drenaje? '
    + 'Y del cero al diez, ¿cuánto dolor tiene?',
  escalate_red_flag:
    'Por lo que me dice, es importante que hable ahora mismo con el médico de turno. '
    + 'Le voy a comunicar de inmediato. Por favor, no cuelgue.',

  // referral
  ask_authorization:
    '¿Ya tiene la autorización de su plan médico? Si tiene el número de autorización, dígamelo, por favor.',
  ask_referring_provider: '¿Cómo se llama el doctor que le refiere?',
  ask_procedure: '¿Para qué procedimiento o tipo de cita le refieren?',

  // scheduling — broad window first, then specific options
  ask_sched_window:
    '¿Para cuándo quisiera su cita? Oprima uno para hoy, dos para esta semana, '
    + 'tres para la próxima semana, o cuatro para sugerir una fecha.',
  ask_preferred_date:
    '¿Qué fecha le conviene? Puede decir, por ejemplo: el martes que viene, o el cinco de agosto.',
  slots_none_window: 'No tengo citas disponibles para esas fechas.',
  // Played when the caller runs out of scheduling rounds — empty windows or
  // offers that didn't suit them. NOT the "couldn't understand you" handoff:
  // this caller answered fine every time, and the goodbye must not sound
  // like it was their fault.
  slots_none:
    'Lo siento, no encontré una cita que le convenga. '
    + 'Le voy a comunicar con nuestro equipo de citas para ayudarle. Un momento, por favor.',
  // A suggested date that already went by — understood, just unusable.
  date_in_past: 'Esa fecha ya pasó.',
  booking_confirmed_sms:
    'Su cita quedó confirmada. Le enviaremos un mensaje de texto con los detalles. '
    + 'Gracias por llamar. Que tenga buen día.',
  goodbye: 'Gracias por llamar a la Clínica de Cirugía General. Que tenga buen día.',
};

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "2026-07-27" -> "el lunes 27 de julio" (espeak-ng reads the digits in Spanish)
function spanishDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `el ${DAY_NAMES[date.getUTCDay()]} ${d} de ${MONTH_NAMES[m - 1]}`;
}

// "1985-03-12" -> "12 de marzo de 1985". Used for read-back of dates the
// caller GAVE us (birth date, surgery date): the weekday is noise there,
// and the year is what they need to hear to catch a mis-transcription.
function spanishDateLong(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} de ${MONTH_NAMES[m - 1]} de ${y}`;
}

// Read a number back digit by digit. espeak-ng says "5551234567" as one
// enormous Spanish numeral, which is useless for checking a phone number;
// separating the digits with spaces makes each its own token, and the
// commas add a breath between groups so an elderly caller can follow along.
function spanishDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  const groups = [];
  for (let i = 0; i < digits.length; i += 3) {
    groups.push(digits.slice(i, i + 3).split('').join(' '));
  }
  // A lone trailing digit ("...4 5 6, 7") sounds like a mistake — fold it
  // into the previous group, giving the familiar 3-3-4 phone grouping.
  if (groups.length > 1 && groups[groups.length - 1].length === 1) {
    groups[groups.length - 2] += ` ${groups.pop()}`;
  }
  return groups.join(', ');
}

// Same idea for alphanumeric codes (MRN, authorization number): spell them
// out character by character — "P000123" as a word is unintelligible.
function spanishCharacters(value) {
  return String(value ?? '').toUpperCase().replace(/\s+/g, '').split('').join(' ');
}

// Caller said they have no allergies; the extraction normalizes this to
// "ninguna" but callers phrase it several ways and the model passes some
// of them through verbatim.
const NO_ALLERGIES = /^(ningun[ao]s?|no|nada|ninguno|no tengo|sin alergias)\b/i;

// One read-back sentence per collected field, in Spanish, spoken back to
// the caller before the answer is kept (session.js "verify" state). This is
// what turns a silent mis-transcription into something the caller can catch
// — the clinic's callers are mostly elderly, and a wrong birth date or
// phone number found at the counter costs a whole visit.
const FIELD_READBACKS = {
  fullName: (v) => `Entendí que su nombre es ${v.first_name} ${v.last_name}.`,
  dob: (v) => `Entendí que nació el ${spanishDateLong(v.dob)}.`,
  phone: (v) => `Entendí que su teléfono es ${spanishDigits(v.phone)}.`,
  // When the caller named the company in the same breath ("tengo MCS
  // ClassiCare"), this read-back confirms company AND type in one turn —
  // it's the only confirmation that value gets, since the company question
  // is then skipped.
  insuranceType: (v) => (v.provider
    ? `Entendí que su plan médico es ${v.provider}, ${v.insurance_type === 'vital' ? 'del Plan Vital' : 'un plan comercial'}.`
    : `Entendí que su plan médico es ${v.insurance_type === 'vital' ? 'del Plan Vital' : 'comercial'}.`),
  insurance: (v) => `Entendí que su plan médico es ${v.provider}.`,
  allergies: (v) => (NO_ALLERGIES.test(String(v.allergies).trim())
    ? 'Entendí que no tiene alergia a ningún medicamento.'
    : `Entendí que tiene alergia a ${v.allergies}.`),
  reason: (v) => `Entendí que el motivo de su cita es ${v.reason}.`,
  mrnOrPhone: (v) => (v.mrn
    ? `Entendí que su número de récord es ${spanishCharacters(v.mrn)}.`
    : `Entendí que su teléfono es ${spanishDigits(v.phone)}.`),
  surgeryDate: (v) => `Entendí que su operación fue el ${spanishDateLong(v.date)}.`,
  // Only ever reached on the benign branch — fever/bleeding/drain trouble
  // and pain >= 8 escalate before the read-back (flows/postOp.js accept()).
  symptoms: (v) => `Entendí que ${v.fever ? 'tiene fiebre' : 'no tiene fiebre'}, `
    + `${v.bleeding ? 'tiene sangrado' : 'no tiene sangrado'}, `
    + `${v.drain_concern ? 'tiene problemas con la herida o el drenaje' : 'no tiene problemas con la herida ni el drenaje'}, `
    + `y que su dolor es de ${v.pain_level} de diez.`,
  authorization: (v) => (v.has_authorization
    ? `Entendí que sí tiene la autorización de su plan médico${v.authorization_code ? `, número ${spanishCharacters(v.authorization_code)}` : ''}.`
    : 'Entendí que todavía no tiene la autorización de su plan médico.'),
  referringProvider: (v) => `Entendí que le refiere ${v.provider_name}.`,
  procedureType: (v) => `Entendí que le refieren para ${v.procedure}.`,
};

// Returns null when a field has no read-back (or its value can't be
// formatted) — the session then keeps the answer without confirming it
// rather than dropping the caller into a broken turn.
function fieldReadbackText(field, value) {
  const build = FIELD_READBACKS[field];
  if (!build) return null;
  try {
    const text = build(value);
    if (typeof text !== 'string' || !text.trim()) return null;
    // A missing sub-field interpolates as "undefined"/"null" — saying that
    // to a caller is worse than not confirming at all.
    if (/\b(undefined|null|NaN)\b/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

// The three fixed slot times, spelled out so TTS pronunciation is unambiguous.
const TIME_WORDS = {
  '09:00': 'a las nueve de la mañana',
  '11:00': 'a las once de la mañana',
  '14:00': 'a las dos de la tarde',
};

function spanishTime(time) {
  return TIME_WORDS[time] || `a las ${time}`;
}

function spanishSlot(slot) {
  return `${spanishDate(slot.date)} ${spanishTime(slot.time)}`;
}

// Dynamic sentences (synthesized live, once per call). Every offer tells
// the caller how to DECLINE, not just how to accept — without a stated way
// out, a caller none of whose offers fit can only fumble until the strike
// counter hands them off "for not being understood".
function slotOfferText(slots) {
  if (slots.length === 1) {
    return `Tengo una cita disponible ${spanishSlot(slots[0])}. `
      + 'Si le sirve, oprima uno o diga sí. Si no le conviene, oprima dos o diga no.';
  }
  return `Tengo dos opciones: la primera, ${spanishSlot(slots[0])}. `
    + `La segunda, ${spanishSlot(slots[1])}. `
    + 'Oprima uno para la primera opción, o dos para la segunda. '
    + 'Si ninguna le conviene, oprima tres.';
}

function confirmSlotText(slot) {
  return `Muy bien. Su cita quedaría ${spanishSlot(slot)}. `
    + '¿Se la confirmo? Oprima uno para sí, o dos para no. También puede decir sí o no.';
}

// Closing when there is no number to text (blocked caller ID and no phone
// collected): promising an SMS that will never arrive would strand the
// caller without their appointment details, so this restates the slot —
// it's the caller's last chance to hear the date and time.
function bookingConfirmedNoSmsText(slot) {
  return `Su cita quedó confirmada para ${spanishSlot(slot)}. `
    + 'Gracias por llamar. Que tenga buen día.';
}

// The confirmation SMS is read on a screen, not heard, and it's the
// caller's durable reference for the visit — so it uses written forms
// (numeric time, year included) instead of the spelled-out TTS forms.
function smsWrittenSlot(slot) {
  const [y, m, d] = slot.date.split('-').map(Number);
  const weekday = DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const [hh, mm] = slot.time.split(':').map(Number);
  const h12 = ((hh + 11) % 12) + 1;
  const suffix = hh < 12 ? 'a. m.' : 'p. m.';
  return `${weekday} ${d} de ${MONTH_NAMES[m - 1]} de ${y}, ${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

// Only the confirmed slot plus static clinic info (CLINIC_NAME /
// CLINIC_ADDRESS) may appear here. Never add the caller's name, MRN,
// reason, or any other extracted field — Twilio must not see patient data.
function smsConfirmationText(slot) {
  const clinic = process.env.CLINIC_NAME || 'Clínica de Cirugía General';
  // No period added after the slot — the "a. m."/"p. m." suffix already
  // closes the sentence, and "p. m.." reads as a typo.
  const lines = [
    `${clinic}: su cita quedó confirmada para el ${smsWrittenSlot(slot)}`,
  ];
  if (process.env.CLINIC_ADDRESS) lines.push(`Dirección: ${process.env.CLINIC_ADDRESS}.`);
  lines.push('Favor de llegar 15 minutos antes, con su identificación y la tarjeta de su plan médico.');
  lines.push('Para cambiar o cancelar su cita, llame a este mismo número.');
  return lines.join('\n');
}

module.exports = {
  MENU_SPEECH_ENABLED,
  FIELD_CONFIRM_DTMF,
  PROMPTS,
  spanishDate,
  spanishDateLong,
  spanishDigits,
  spanishCharacters,
  spanishTime,
  spanishSlot,
  slotOfferText,
  confirmSlotText,
  bookingConfirmedNoSmsText,
  smsConfirmationText,
  fieldReadbackText,
};
