const Post = require('../models/Posts');

exports.publishScheduledPost = async (postId) => {
  try {
    const post = await Post.findByIdAndUpdate(
      postId,
      { status: 'published', createdAt: new Date() },
      { new: true }
    );

    const author = await User.findOne({ userId: post.userId });
    const followers = await User.find({
      userId: { $in: author.followers || [] },
    });
    for (const follower of followers) {
      await notificationQueue.add({
        userEmail: follower.userEmail,
        authorName: author.username,
        postTitle: post.title,
        postId: post._id
      }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
    }
    console.log(`Queued notifications for ${followers.length} followers for post ${postId}`);

    io.emit('newPost', {
      postId: post._id,
      title: post.title,
      authorName: post.username,
      authorId: post.userId
    });

    if (!post) {
      throw new Error('Post not found');
    }

    console.log(`Post ${postId} published successfully`);

  } catch (error) {
    console.error(`Error publishing post ${postId}:`, error);
    throw error; 
  }
};
