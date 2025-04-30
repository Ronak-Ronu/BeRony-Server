const Post = require('../models/Posts');
const Redis = require('ioredis');
const redisclient = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
  ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {})
});

exports.publishScheduledPost = async (postId) => {
  const post = await Post.findById(postId);
  if (!post || post.status === 'published') return;

  post.status = 'published';
  await post.save();

  console.log(`Post ${postId} published via Bull job!`);

  await redisclient.del("posts");
  await redisclient.del(`posts:0:3`);
  await redisclient.del(`posts:3:3`);
  await redisclient.del(`post:${postId}`);
};
