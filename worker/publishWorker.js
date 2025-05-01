const Post = require('../models/Posts');
const Redis = require('ioredis');
const redisclient = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
  ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {})
});

exports.publishScheduledPost = async (postId) => {
  try {
    const post = await Post.findByIdAndUpdate(
      postId,
      { status: 'published', createdAt: new Date() },
      { new: true }
    );

    if (!post) {
      throw new Error('Post not found');
    }

    console.log(`Post ${postId} published successfully`);

    const keys = await redisclient.keys('posts:*'); 
    if (keys.length > 0) {
      await redisclient.del(keys); 
      console.log(`Invalidated cache keys: ${keys.join(', ')}`);
    }
  } catch (error) {
    console.error(`Error publishing post ${postId}:`, error);
    throw error; 
  }
};
