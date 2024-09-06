const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');

router.post('/posts', async (req, res) => {
  const newPost = new Post(req.body);
  await newPost.save();
  res.json(newPost);
});

router.get('/posts', async (req, res) => {
  const posts = await Post.find();
  res.json(posts);
});

router.get('/posts/:id',async(req,res)=>{
  const post = await Post.findById(req.params.id);
  res.json(post);
})


router.delete('/posts/:id', async (req, res) => {
  await Post.findByIdAndDelete(req.params.id);
  res.json({ message: 'Post deleted' });
});

module.exports = router;
