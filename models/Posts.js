const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
  title: String,
  bodyofcontent: String,
  endnotecontent: String,
  imageUrl: String,
  funnycount: { type: Number, default: 0 },
  sadcount: { type: Number, default: 0 },
  loveitcount: { type: Number, default: 0 }
});

const Post = mongoose.model('posts', PostSchema);
module.exports = Post;
