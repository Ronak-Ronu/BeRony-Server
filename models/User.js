const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  userEmail: { type: String, required: true,unique: true},
  userBio: { type: String, default: '' },
  userEmotion: { type: String, default: '' }, 
  followers: { type: [String], default: [] }, 
  following: { type: [String], default: [] }, 
  createdAt: { type: Date, default: Date.now }
});

UserSchema.index({ userId: 1 });


UserSchema.pre('save', function(next) {
    if (this.isNew && this.username) {
      this.userBio = `Hello, I'm ${this.username} :)`;
    }
    next();
  });
  

const User = mongoose.model('User', UserSchema);
module.exports = User;
