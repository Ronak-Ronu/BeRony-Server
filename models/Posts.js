const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
  title: String,
  bodyofcontent: String,
  endnotecontent: String,
  imageUrl: String
});

const Post = mongoose.model('posts', PostSchema);
module.exports = Post;
