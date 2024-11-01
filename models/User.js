const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  userBio: { type: String, default: '' }, // User bio
  userEmotion: { type: String, default: '' }, // User emotion
  createdAt: { type: Date, default: Date.now }
});

UserSchema.pre('save', function(next) {
    if (this.isNew && this.username) {
      this.userBio = `Hello, I'm ${this.username} :)`;
    }
    next();
  });
  

const User = mongoose.model('User', UserSchema);
module.exports = User;
