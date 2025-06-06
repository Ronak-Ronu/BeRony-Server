const mongoose = require('mongoose');

const userActivitySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  activityType: { type: String, enum: ['post', 'edit','comment','read','collab','poll','profile-update','plant','story','checkin'], required: true },
  timestamp: { type: Date, required: true },
});

const UserActivity = mongoose.model('UserActivity', userActivitySchema);
module.exports = UserActivity;