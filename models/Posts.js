const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
  title: String,
  bodyofcontent: String,
  endnotecontent: String,
  imageUrl: String,
  funnycount: { type: Number, default: 0 },
  sadcount: { type: Number, default: 0 },
  loveitcount: { type: Number, default: 0 },
  userId: { type:String , require: true },
  username: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  userBio: { type: String },
  userEmotion:{type: String },
  tags: {type: [String],default:[]}
});

PostSchema.pre('save', function(next) {
  if (this.isNew && this.username) {
    this.userBio = `Hello, I'm ${this.username} :)`;
  }
  next();
});


const Post = mongoose.model('posts', PostSchema);
module.exports = Post;
