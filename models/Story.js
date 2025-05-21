const mongoose = require('mongoose');

const storySchema = new mongoose.Schema({
  userId: { type: String, ref: 'User', required: true },
  username: { type: String, required: true }, 
  fileUrl: { type: String, required: true },
  publicId: { type: String, required: true },
  fileType: { type: String, enum: ['image', 'video'], required: true },
  views: { type: Number, default: 0 },
  description: { type: String, default: '' }, 
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => Date.now() + 24 * 60 * 60 * 1000 }
});

module.exports = mongoose.model('Story', storySchema);