// Top-level greeting + patient-type routing. DTMF 1-4 or a spoken answer
// (classified by the patientType extraction field).

const newPatient = require('./flows/newPatient');
const followUp = require('./flows/followUp');
const postOp = require('./flows/postOp');
const referral = require('./flows/referral');

const FLOWS = {
  new: newPatient,
  follow_up: followUp,
  post_op: postOp,
  referral,
};

const DTMF_MAP = {
  1: 'new',
  2: 'follow_up',
  3: 'post_op',
  4: 'referral',
};

module.exports = { FLOWS, DTMF_MAP };
