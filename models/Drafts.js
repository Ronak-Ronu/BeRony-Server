const mongoose = require('mongoose');

const DraftSchema = new mongoose.Schema({
  title: String,
  bodyofcontent: String,
  endnotecontent: String,
  imageUrl: String,
});

const Draft = mongoose.model('drafts', DraftSchema);
module.exports = Draft;
