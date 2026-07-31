// Top-level greeting + patient-type routing, DTMF 1-3 only (speech at the
// menu re-prompts; data-collection answers are still spoken).

const newPatient = require('./flows/newPatient');
const followUp = require('./flows/followUp');
const postOp = require('./flows/postOp');

const FLOWS = {
  new: newPatient,
  follow_up: followUp,
  post_op: postOp,
};

const DTMF_MAP = {
  1: 'new',
  2: 'follow_up',
  3: 'post_op',
};

module.exports = { FLOWS, DTMF_MAP };
