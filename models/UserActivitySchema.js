const mongoose = require('mongoose');

const userActivitySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  activityType: { type: String, enum: ['post', 'edit'], required: true },
  timestamp: { type: Date, required: true },
});

const UserActivity = mongoose.model('UserActivity', userActivitySchema);
module.exports = UserActivity;