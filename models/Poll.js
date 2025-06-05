const mongoose = require('mongoose');

const pollSchema = new mongoose.Schema({
  question: { type: String, required: true },
  options: { type: [String], required: true },
  votes: { type: [Number], default: [] },
  voters: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
});

const Poll = mongoose.model('Poll', pollSchema);
module.exports = Poll;