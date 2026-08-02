// ALL caller-facing copy lives here, and all of it is Spanish — greetings,
// re-prompts, confirmations, fallbacks, handoffs, SMS. No English
// fallback exists anywhere in the call (CLAUDE.md "Language requirement").
// Adding a prompt in English here is a bug, not a stub.
//
// Fixed prompts (PROMPTS) are pre-synthesized and cached at startup by
// tts/cache.js. The few dynamic sentences (slot offers, confirmations —
// they contain dates) are built by the template functions below and
// synthesized live, once per call at most; espeak-ng reads the digits in
// Spanish, and times are spelled out in words to keep pronunciation clean.

// Copy is written for Puerto Rico specifically: "oprima" (not "marque"),
// "cita" (not "consulta"), "récord médico" (not "expediente"), "referido"
// (not "referencia"), "plan médico" (not "aseguranza"). Keep it that way
// in future edits.
const PROMPTS = {
  greeting_menu:
    'Gracias por llamar a la Clínica de Cirugía General. '
    + 'Favor de escuchar todas las opciones. '
    + 'Si es paciente nuevo, oprima uno. '
    + 'Para una cita de seguimiento, oprima dos. '
    + 'Si le operaron recientemente, oprima tres. '
    // The escape hatch, announced up front and repeated in every re-prompt:
    // most of this clinic's callers are elderly, and a caller who can't get
    // through the automated flow must never have to guess how to reach a
    // person. 0 works from ANY point in the call (see session.onDtmf).
    + 'Si prefiere hablar con una persona, oprima cero en cualquier momento. '
    + 'También puede oprimir estrella para volver a este menú. ',
  menu_retry:
    'Perdón. Oprima uno para paciente nuevo, dos para seguimiento, '
    + 'o tres si le operaron recientemente. '
    // The 0 escape hatch is repeated in every re-prompt (CLAUDE.md): the
    // caller who just fumbled a question is exactly the caller most likely
    // to need a person.
    + 'Si prefiere hablar con una persona, oprima cero. ',

  // shared data-collection re-prompt. There is no automatic bailout: a
  // question that keeps failing is re-asked indefinitely, and this prompt's
  // 0 reminder is the caller's stated way out.
  reprompt_generic:
    'Perdón, no le entendí bien. ¿Podría repetirlo, por favor? '
    + 'Si desea hablar con una persona, oprima cero. ',
  // Caller pressed 0. Deliberately warm and short — they have already
  // decided; nothing here should sound like another attempt to keep them
  // in the automated flow.
  handoff_operator:
    'Con mucho gusto. Le comunico con nuestro equipo de citas. Un momento, por favor.',

  // Field read-back (see fieldReadbackText below). The value itself is one
  // short live-synthesized sentence; this fixed question is cached. Keypad
  // only — confirmations are never answered by voice.
  confirm_field: '¿Es correcto? Oprima uno si está bien, o dos si lo tengo que corregir.',
  retry_field: 'Está bien, vamos a corregirlo.',

  // new patient
  ask_full_name: 'Para empezar, ¿me puede decir su nombre y apellido, por favor?',
  ask_dob: 'Gracias. ¿Cuál es su fecha de nacimiento?',
  ask_phone: '¿A qué número de teléfono le podemos llamar?',
  // Variant played when Twilio delivered a caller ID: a keypad question —
  // 1 accepts the number the caller is calling from, 2 moves on to
  // dictating one (flows/phoneSteps.js). The accepted digits still get the
  // normal read-back before being kept.
  ask_phone_caller_id:
    'Si le podemos llamar al número desde el cual nos está llamando, oprima uno. '
    + 'Si prefiere darnos otro número, oprima dos.',
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

  // post-op — administrative rebooking only: date, hospital, name, phone
  // (no symptom check on this path; see flows/postOp.js)
  ask_surgery_date: '¿En qué fecha fue su operación?',
  ask_hospital: '¿En qué hospital fue su operación?',
  ask_postop_full_name: 'Gracias. ¿Me puede decir su nombre y apellido, por favor?',

  // scheduling — broad window first, then specific options
  ask_sched_window:
    '¿Para cuándo quisiera su cita? Oprima uno para hoy, dos para esta semana, '
    + 'tres para la próxima semana, o cuatro para sugerir una fecha.',
  ask_preferred_date:
    '¿Qué fecha le conviene? Puede decir, por ejemplo: el martes que viene, o el cinco de agosto.',
  // Two grammatical variants of "nothing available": a single day (hoy, or
  // a specific date the caller suggested) vs. a multi-day window (esta
  // semana / la próxima semana). Playing the plural one for one day is the
  // kind of small wrongness this caller base notices.
  slots_none_day: 'No tengo citas disponibles para ese día.',
  slots_none_window: 'No tengo citas disponibles para esas fechas.',
  // Nothing bookable in the caller's window NOR for weeks after it — say
  // so and return to the window menu (no automatic transfer; 0 is the way
  // to a person and gets mentioned here).
  slots_none:
    'Lo siento, no encontré citas disponibles próximamente. Vamos a buscar otra fecha. '
    + 'Si prefiere hablar con una persona, oprima cero. ',
  // Played before re-asking the window question after the caller declined
  // an offer: declining can loop forever by design, so every loop reminds
  // them a person is one key away.
  sched_retry_hint:
    'Está bien, busquemos otra fecha. '
    + 'Recuerde que puede oprimir cero para hablar con una persona. ',
  // A suggested date that already went by — understood, just unusable.
  date_in_past: 'Esa fecha ya pasó.',
  booking_confirmed_sms:
    'Su cita quedó confirmada. Le enviaremos un mensaje de texto con los detalles. '
    + 'Gracias por llamar. Que tenga buen día.',
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
  surgeryDate: (v) => `Entendí que su operación fue el ${spanishDateLong(v.date)}.`,
  hospital: (v) => `Entendí que su operación fue en ${v.hospital}.`,
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
// out, a caller none of whose offers fit can only fumble at the keypad.
function slotOfferText(slots) {
  if (slots.length === 1) {
    return `Tengo una cita disponible ${spanishSlot(slots[0])}. `
      + 'Si le sirve, oprima uno. Si no le conviene, oprima dos.';
  }
  return `Tengo dos opciones: la primera, ${spanishSlot(slots[0])}. `
    + `La segunda, ${spanishSlot(slots[1])}. `
    + 'Oprima uno para la primera opción, o dos para la segunda. '
    + 'Si ninguna le conviene, oprima tres.';
}

// Played right after slots_none_day / slots_none_window when the caller's
// requested window is full: proposes the nearest slot after that window
// instead of bouncing them back to the window menu empty-handed. Same
// accept/decline keys as the one-slot offer above — the session runs this
// through the same 'offer' state.
function nearestSlotOfferText(slot) {
  return `La próxima cita disponible es ${spanishSlot(slot)}. `
    + 'Si le sirve, oprima uno. Si no le conviene, oprima dos.';
}

function confirmSlotText(slot) {
  return `Muy bien. Su cita quedaría ${spanishSlot(slot)}. `
    + '¿Se la confirmo? Oprima uno para sí, o dos para no.';
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
  PROMPTS,
  spanishDate,
  spanishTime,
  slotOfferText,
  nearestSlotOfferText,
  confirmSlotText,
  bookingConfirmedNoSmsText,
  smsConfirmationText,
  fieldReadbackText,
};
