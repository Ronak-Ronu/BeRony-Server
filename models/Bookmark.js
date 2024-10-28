const mongoose = require('mongoose');

const BookmarkSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  postId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'posts',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Bookmark = mongoose.model('Bookmark', BookmarkSchema);
module.exports = Bookmark;
