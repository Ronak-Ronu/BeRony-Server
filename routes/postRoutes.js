const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');
const Bookmark=require('../models/Bookmark')
const Item = require('../models/Tree')
const User=require('../models/User')
const multer = require('multer');
const fs=require('fs')
const Redis=require('ioredis')
const cloudinary = require('../cloudinaryconfig')
const nodemailer = require('nodemailer');
const postQueue = require('../queues/bullqueue');
const { publishScheduledPost } = require('../worker/publishWorker');
const Story = require('../models/Story'); 
const Bull = require('bull');
const notificationQueue = require('../queues/notificationQueue'); 
const Poll = require('../models/Poll'); 
const pollQueue = require('../queues/pollqueue'); 
const UserActivity = require('../models/UserActivitySchema');
// const { PredictionServiceClient } = require('@google-cloud/aiplatform');

require('dotenv').config();


const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png|svg|gif|mp4|mpeg)$/)) {
      return cb(new Error('Please upload an image'));
    }
    cb(null, true);
  }
});

const uploadStory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, 
  fileFilter(req, file, cb) {
    const fileTypes = /jpeg|jpg|png|mp4/;
    const extname = fileTypes.test(file.originalname.toLowerCase().split('.').pop());
    const mimetype = fileTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Only images (jpg, jpeg, png) and videos (mp4) are allowed'));
    }
  }
});


const redisclient = new Redis({
  host: process.env.REDIS_HOST  ,
  password: process.env.REDIS_PASSWORD ,
  port: process.env.REDIS_PORT,
});


redisclient.on('connect',()=>{
  console.log("redis is connected");
})
redisclient.on('error', (err) => {
  console.error('Redis error:', err);
});

const storyQueue = new Bull('story-queue', {
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD
  }
});
storyQueue.process(async (job) => {
  const { storyId, publicId, resourceType } = job.data;
  try {
    await Story.findByIdAndDelete(storyId);
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    console.log(`Story ${storyId} deleted from MongoDB and Cloudinary`);
    io.emit('storyDeleted', { storyId });
    await redisclient.del(`story:${storyId}`);
    await redisclient.del(`stories:all`);
  } catch (error) {
    console.error(`Failed to delete story ${storyId}:`, error);
    throw error;
  }
});


const schedulePostPublishing = async (postId, scheduleTime) => {
  const delay = new Date(scheduleTime) - new Date();

  if (delay <= 0) {
    await publishScheduledPost(postId);
    return;
  }

  await postQueue.add(
    { postId },
    {
      delay,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 3000,
      }
    }
  );

  console.log(`Post ${postId} scheduled using Bull in ${delay / 1000} seconds.`);
};


router.post('/posts', upload.single('imageUrl'), async (req, res) => {
  try {
    console.log('Request Body:', req.body);
    console.log('File:', req.file);
    const filePath = req.file.path;
    console.log('File path:', filePath);
    const tagsArray = JSON.parse(req.body.tags);
    const { pollId } = req.body;
    const isVideo = req.file.mimetype.startsWith('video') || req.file.originalname.endsWith('.mp4');
    const folderName = isVideo ? 'BlogData' : 'VBlogData';

    if (req.file) {
      const resultimageurl = await cloudinary.uploader.upload(req.file.path, {
        folder: folderName,
        resource_type: isVideo ? 'video' : 'image',
      });
      let newresultimageurl = '';
      if (isVideo) {
        newresultimageurl = `https://res.cloudinary.com/${process.env.CLOUD_NAME}/video/upload/${resultimageurl.public_id}.mp4`;
      } else {
        newresultimageurl = `https://res.cloudinary.com/${process.env.CLOUD_NAME}/image/upload/${resultimageurl.public_id}`;
      }

      const postScheduleTime = req.body.postScheduleTime ? new Date(req.body.postScheduleTime) : null;
      const isSchedule = postScheduleTime && postScheduleTime.getTime() > Date.now();

      const newPost = new Post({
        title: req.body.title,
        bodyofcontent: req.body.bodyofcontent,
        endnotecontent: req.body.endnotecontent,
        imageUrl: isVideo ? null : newresultimageurl,
        videoUrl: isVideo ? newresultimageurl : null,
        userId: req.body.userId,
        username: req.body.username,
        createdAt: new Date(),
        tags: tagsArray,
        postScheduleTime,
        status: isSchedule ? 'scheduled' : 'published',
        pollId: pollId || null,
      });

      await newPost.save();

      const keys = await redisclient.keys('posts:*');
      if (keys.length > 0) {
        await redisclient.del(keys);
        console.log(`Invalidated cache keys: ${keys.join(', ')}`);
      }

      console.log(newPost);

      // if (!isSchedule) {
      //   const author = await User.findOne({ userId: req.body.userId });
      //   const followers = await User.find({
      //     userId: { $in: author.followers || [] },
      //   });

      //   for (const follower of followers) {
      //     await notificationQueue.add({
      //       userEmail: follower.userEmail,
      //       authorName: author.username,
      //       postTitle: newPost.title,
      //       postId: newPost._id
      //     }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
      //   }
      //   console.log(`Queued notifications for ${followers.length} followers for post ${newPost._id}`);
      // }
      const user = await User.findOne({ userId: req.body.userId });
      if (user && Array.isArray(user.followers) && user.followers.length > 0) {
        user.followers.forEach((followerId) => {

          notificationQueue.add({
            followerId,
            authorName: user.username,
            postTitle: newPost.title,
            postId: newPost._id
          }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });

        });
      } else {
        console.log('No followers found for the user.');
      }
      console.log(`Queued notifications for ${user.followers.length} followers for post ${newPost._id}`);
      



      if (isSchedule) {
        schedulePostPublishing(newPost._id, postScheduleTime);
      }

      fs.unlink(req.file.path, (err) => {
        if (err) {
          console.error('Error in deleting:', err);
        } else {
          console.log('File deleted');
        }
      });

      res.json(newPost);
    } else {
      return res.status(400).json({ message: 'File is missing' });
    }
  } catch (error) {
    console.error('Error during post creation:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});


router.get('/posts', async (req, res) => {
  const { start=0, limit=3 } = req.query; 

  const cacheKey = `posts:${start}:${limit}`;

  try {
      let posts;
      const isExist = await redisclient.exists(cacheKey);
      if(isExist) {
        console.log("Fetching posts from Redis cache...");
        const redisdata = await redisclient.get(cacheKey);
        posts = JSON.parse(redisdata)
      } else {
        posts = await Post.find({ 
            $or: [
          { status: { $in: ['published', 'draft'] } },
          { status: { $exists: false } }
        ]
      }).sort({ createdAt: -1 }).skip(parseInt(start)).limit(parseInt(limit));
        // Cache the posts in Redis
        await redisclient.setex("posts:*", 3600, JSON.stringify(posts));
      }
    // console.log(totalPosts);
    res.json(posts);
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});
router.get('/findpost', async (req, res) => {
  const { q: query = '', tags: tag = '', start = 0, limit = 3 } = req.query;

  try {
    let posts = [];
    let users = [];

    if (tag) {
      posts = await Post.find({ tags: tag })
        .sort({ createdAt: -1 })
        .skip(parseInt(start))
        .limit(parseInt(limit));
    } else if (query) {
      const decodedQuery = decodeURIComponent(query.trim());
      const searchWords = decodedQuery.split(/\s+/);

      const searchConditions = searchWords.map((word) => ({
        $or: [
          { title: { $regex: word, $options: 'i' } }, // 'i' makes it case-insensitive
          { bodyofcontent: { $regex: word, $options: 'i' } },
          { tags: { $regex: tag, $options: 'i' } }
        ],
      }));

      posts = await Post.find({ $and: searchConditions }).sort({ createdAt: -1 });

      // Search for users
      const userSearchConditions = searchWords.map((word) => ({
        username: { $regex: word, $options: 'i' },
      }));

      users = await User.find({ $or: userSearchConditions });
    } else {
      posts = await Post.find().sort({ createdAt: -1 });
    }

    res.json({ posts, users });
  } catch (error) {
    console.error('Error fetching query posts or users:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});



router.get('/posts/:id', async (req, res) => {
  try {
    const cacheKey = `post:${req.params.id}`;
    const cachedPost = await redisclient.get(cacheKey);

    if (cachedPost) {
      console.log("Fetching post from Redis cache...");
      const post = JSON.parse(cachedPost);
      await Post.findByIdAndUpdate(req.params.id, { $inc: { pageviews: 1 } });
      post.pageviews += 1;
      await redisclient.set(cacheKey, JSON.stringify(post), 'EX', 86400);
      return res.json(JSON.parse(cachedPost));
    }

    const post = await Post.findByIdAndUpdate(
      req.params.id,
      { $inc: { pageviews: 1 } },
      { new: true }
    );

    // const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    // cache the post
    await redisclient.set(cacheKey, JSON.stringify(post),'EX', 86400);
    res.json(post);
  } catch (error) {
    console.error('Error fetching post:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});



router.get('/user/:username/posts',async (req,res)=>{
  const { username } = req.params;
  try{
    const posts = await Post.find({ username }).sort({ createdAt: -1 });

    if (!posts.length) {
      return res.status(404).json({ message: 'No posts found for this user.' });
    }
    res.json(posts);
  }
  catch(error){
    console.error('Error fetching post:', error);
    res.status(500).json({message:'Internal server error'})
  }

})

router.delete('/posts/:id', async (req, res) => {
  try {
    const postId = req.params.id;

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    let publicId = null;
    let resourceType = null;
    if (post.imageUrl) {
      const urlParts = post.imageUrl.split('/upload/');
      publicId = urlParts[1]; // VBlogData/<filename>
      resourceType = 'image';
    } else if (post.videoUrl) {
      const urlParts = post.videoUrl.split('/upload/');
      publicId = urlParts[1].replace('.mp4', ''); 
      resourceType = 'video';
    }

    if (publicId && resourceType) {
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
        console.log(`Deleted ${resourceType} from Cloudinary: ${publicId}`);
      } catch (cloudinaryError) {
        console.error(`Failed to delete ${resourceType} from Cloudinary:`, cloudinaryError);
      }
    }

    const deletedPost = await Post.findByIdAndDelete(postId);
    if (!deletedPost) {
      return res.status(404).json({ message: 'Post not found' });
    }

    await redisclient.del("posts");
    await redisclient.del(`post:${postId}`);
    await redisclient.del(`posts:0:3`);
    await redisclient.del(`posts:3:3`);

    res.json({ message: 'Post and associated media deleted successfully' });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});


router.patch('/posts/like/:id', async (req, res) => {
  const { emoji, increment } = req.body; 
    // console.log('Request body:', req.body);
  // console.log('Post ID:', req.params.id);

  try {
    const updateField = `${emoji}count`;
    
    // console.log('Updating field:', updateField);
    
    const update = { $inc: { [updateField]: increment ? 1 : -1 } };
    
    const post = await Post.findByIdAndUpdate(req.params.id, update, { new: true });
    
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    await redisclient.del("posts");
    await redisclient.del(`post:${req.params.id}`); 
    res.json(post);
  } catch (error) {
    console.error('Error updating post:', error);
    res.status(500).json({ error: 'Cannot like the post' });
  }
});

// Clear all posts cache
router.delete('/clear-posts', async (req, res) => {
  try {
    // Get all keys related to posts
    const keys = await redisclient.keys('posts:*');

    // Delete all the keys
    if (keys.length > 0) {
      await redisclient.del(keys);
      console.log(`Deleted keys: ${keys.join(', ')}`);
    }

    res.json({ message: 'All posts cache cleared successfully.' });
  } catch (error) {
    console.error('Error clearing posts cache:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});



router.post('/users/:userId/bookmarks', async (req, res) => {
  const userId = req.params.userId;
  const { postId } = req.body;
  console.log('Received request to add bookmark:', req.body);

  try {
    const existingBookmark = await Bookmark.findOne({ userId, postId });
    if (existingBookmark) {
      return res.status(400).json({ message: 'Blog is already bookmarked.' });
    }

    const newBookmark = new Bookmark({ userId, postId });
    await newBookmark.save();

    res.status(201).json({ message: 'Blog bookmarked successfully.' });
  } catch (error) {
    console.error('Error bookmarking blog:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.delete('/users/:userId/bookmarks/:postId', async (req, res) => {
  const { userId, postId } = req.params;

  try {
    // Find and delete the bookmark
    const deletedBookmark = await Bookmark.findOneAndDelete({ userId, postId });
    if (!deletedBookmark) {
      return res.status(404).json({ message: 'Bookmark not found.' });
    }

    res.json({ message: 'Bookmark removed successfully.' });
  } catch (error) {
    console.error('Error removing bookmark:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.get('/users/:userId/bookmarks', async (req, res) => {
  const { userId } = req.params;

  try {
    // finding bookmarks for the user and populate the post data
    const bookmarks = await Bookmark.find({ userId }).populate('postId');
    res.json(bookmarks.map(bookmark => bookmark.postId));
  } catch (error) {
    console.error('Error fetching bookmarked blogs:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.post('/user/register', async (req, res) => {
  const { userId, username,userEmail } = req.body;

  try {
    const existingUser = await User.findOne({ userId });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists.' });
    }
    const newUser = new User({
      userId,
      username,
      userEmail
    });
    console.log(newUser);
    
    await newUser.save();
    res.status(201).json({ message: 'User registered successfully.', user: newUser });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});


router.patch('/user/:userId/bio', async (req, res) => {
  const { userId } = req.params;
  const { userBio } = req.body;

  try {
    
    const user = await User.findOneAndUpdate({ userId: userId }, { userBio }, { new: true });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error updating user bio:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.patch('/user/:userId/email', async (req, res) => {
  const { userId } = req.params;
  const { userEmail } = req.body;

  try {
    
    const user = await User.findOneAndUpdate({ userId: userId }, { userEmail }, { new: true });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error updating user email:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});


router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    res.json({ user });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});
router.get('/users/biodata', async (req, res) => {
  try {
    const user = await User.find();
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});


router.patch('/user/:userId/emotion', async (req, res) => {
  const { userId } = req.params;
  const { userEmotion } = req.body;

  try {
    const user = await User.findOneAndUpdate({ userId: userId }, { userEmotion }, { new: true });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error updating user emotion:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.get('/search', async (req, res) => {
  const { query } = req.query;
  try {
    const users = await User.find({ username: { $regex: query, $options: 'i' } });
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: 'No user found', error });
  }
});



router.post('/:postId/add-collaborator', async (req, res) => {
  const { postId } = req.params;
  const { collaboratorId } = req.body; 
  try {
    const post = await Post.findById(postId);
    
    if (!post) return res.status(404).json({ message: 'Post not found' });
    
    if (!post.collaborators.includes(collaboratorId)) {
      post.collaborators.push(collaboratorId);
      await post.save();
      res.status(200).json({ message: 'Collaborator added successfully' });
    } else {
      res.status(400).json({ message: 'User is already a collaborator' });
    }
  } catch (error) {
    res.status(500).json({ message: '', error });
  }
});


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});
router.post('/send-collab-invite', async (req, res) => {
  const { userEmail, authorMail,authorName, postTitle, postDescription, workspaceLink } = req.body;

  const mailOptions = {
    from:process.env.EMAIL_USER,
    to: userEmail,
    subject: `You've been added as a collaborator!`,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Collaboration Invitation</title>
  <style>
    body {
      font-family: 'Arial', sans-serif;
      margin: 0;
      padding: 0;
      background-color: #f7f7f7;
      color: #333;
    }
    .container {
      max-width: 600px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
    }
    .header {
      background-color: #c6caf9;
      padding: 20px;
      text-align: center;
      color: #fff;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
    }
    .content {
      padding: 20px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 15px;
    }
    .column {
      width: 48%;
    }
    .column h3 {
      margin-bottom: 5px;
      font-size: 16px;
      color: #666;
    }
    .column p {
      margin: 0;
      font-size: 14px;
      color: #333;
    }
    .cta {
      text-align: center;
      margin: 20px 0;
    }
    .cta a {
      display: inline-block;
      padding: 12px 20px;
      font-size: 16px;
      color: #fff;
      background-color: #c6caf9;
      text-decoration: none;
      border-radius: 25px;
    }
    .cta a:hover {
      background-color: #a9add9;
    }
    .footer {
      text-align: center;
      font-size: 12px;
      color: #999;
      background-color: #f7f7f7;
      padding: 10px 20px;
    }
    .footer a {
      color: #c6caf9;
      text-decoration: none;
    }
     .info-section {
      background-color: #f2f3fc;
      padding: 15px;
      border: 1px solid #e2e5f7;
      border-radius: 8px;
      margin: 20px 0;
      text-align: center;
      font-size: 14px;
      color: #555;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Collaboration Invitation</h1>
    </div>
    <div class="content">
      <p>Hi <strong>${userEmail}</strong>,</p>
      <p>You’ve been invited by <strong>${authorName}</strong> to collaborate on an exciting new blog post!</p>

      <div class="row">
        <div class="column">
          <h3>Post Title</h3>
          <p>${postTitle}</p>
        </div>
        <div class="column">
          <h3>Author Email</h3>
          <p>${authorMail}</p>
        </div>
      </div>

          <h3>Post Description</h3>
          <p>${postDescription}</p>
      <div class="cta">
        <a href="${workspaceLink}">Join the Workspace</a>
      </div>
    </div>

    <div class="info-section">
    <p>Manually access the link: <strong>${workspaceLink}</strong></p>
  </div>
    <div class="footer">
      <p>If you did not expect this invitation, feel free to ignore it or <a href="mailto:${authorMail}">contact the author</a>.</p>
    </div>
  </div>
</body>
</html>

  `
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Invitation sent Successfully' });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ message: 'Error sending email' });
  }
});

router.post('/:currentuserid/:method/:userid', async (req, res) => {
  const { currentuserid,method, userid } = req.params;
  
  if(method==='Follow')
    {
      try {
 
        if (currentuserid === userid) {
          return res.status(400).json({ message: "You cannot follow yourself." });
        }
        const userToFollow = await User.findOne({userId: userid});
        const loggedInUser = await User.findOne({userId:currentuserid});

    
        // Check if both users exist
        if (!userToFollow || !loggedInUser) {
          return res.status(404).json({ message: "User not found." });
        }
    
        loggedInUser.following = loggedInUser.following || [];
        userToFollow.followers = userToFollow.followers || [];
    
        if (loggedInUser.following.includes(userid)) {
          return res.status(400).json({ message: "Already Following." });
        }
    
        loggedInUser.following.push(userid);
        userToFollow.followers.push(currentuserid);
    
        await loggedInUser.save();
        await userToFollow.save();
    
        res.status(200).json({ message: "Following" });
      } catch (error) {
        console.error("Error following user:", error);
        res.status(500).json({ message: error.message });
      }
    }
    if(method==='Unfollow')
    {
      try {    
    
        const userToUnFollow = await User.findOne({userId: userid});
        const loggedInUser = await User.findOne({userId:currentuserid});
    
        // Check if both users exist
        if (!userToUnFollow || !loggedInUser) {
          return res.status(404).json({ message: "User not found." });
        }
    
        loggedInUser.following = loggedInUser.following || [];
        userToUnFollow.followers = userToUnFollow.followers || [];
        
        loggedInUser.following.pull(userid);
        userToUnFollow.followers.pull(currentuserid);

      
    
        await loggedInUser.save();
        await userToUnFollow.save();
    
        res.status(200).json({ message: "Unfollowed" });


      } catch (error) {
        console.error("Error unfollowing user:", error);
        res.status(500).json({ message: error.message });
      }
    }

}
);


router.get('/sitemap.xml', async (req, res) => {
  try {
    const posts = await Post.find({});
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset
        xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
              http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
      <url>
        <loc>https://berony.web.app</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
      </url>
      <url>
        <loc>https://berony.web.app/read</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.8</priority>
      </url>
      <url>
        <loc>https://berony.web.app/whosrony</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.7</priority>
      </url>
      <url>
        <loc>https://berony.web.app/write</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.9</priority>
      </url>
    `;

    for (const post of posts) {
      const slug = post.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      sitemap += `
        <url>
          <loc>https://berony.web.app/blog/${post._id}/${slug}</loc>
          <lastmod>${new Date(post.createdAt).toISOString()}</lastmod>
          <changefreq>weekly</changefreq>
          <priority>0.9</priority>
        </url>
      `;
    }

    sitemap += `</urlset>`;
    res.header('Content-Type', 'application/xml');
    res.send(sitemap);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/items", async (req, res) => {
  try {
    const items = await Item.find();
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: "Error fetching items" });
  }
});

router.post("/items", async (req, res) => {
  const { userId, itemType, position, woodColor, leafColor, username } = req.body;
  try {
    const user = await User.findOne({ userId });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!['tree', 'flower', 'bench', 'swingSet'].includes(itemType)) {
      return res.status(400).json({ message: "Invalid item type" });
    }
    const existingItem = await Item.findOne({ userId });
    if (existingItem) {
      return res.status(400).json({ message: "User has already planted an item" });
    }
    const newItem = new Item({
      userId,
      username: user.username,
      itemType,
      position,
      woodColor: woodColor || null,
      leafColor: leafColor || null
    });
    await newItem.save();
    res.status(201).json(newItem);
  } catch (error) {
    res.status(500).json({ message: "Error saving item", error: error.message });
  }
});

router.delete('/items/:userId', async (req, res) => {
  const userId = req.params.userId;

  try {
    const deletedItem = await Item.findOneAndDelete({ userId });
    if (!deletedItem) {
      return res.status(404).json({ message: 'Item not found for this user' });
    }
    res.json({ message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting item by userId:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});




router.post('/stories', uploadStory.single('story'), async (req, res) => {
  try {
    const { userId , description} = req.body;
    if (!userId) {
      return res.status(401).json({ message: 'Login/SignUp to add stories' });
    }

    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const isVideo = req.file.mimetype.startsWith('video');
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: isVideo ? 'video' : 'image',
          folder: 'berony/stories'
        },
        (error, result) => {
          if (error) reject(error);
          resolve(result);
        }
      ).end(req.file.buffer);
    });

    const fileType = isVideo ? 'video' : 'image';

    const story = new Story({
      userId,
      username: user.username, 
      fileUrl: result.secure_url,
      publicId: result.public_id,
      fileType,
      description
    });

    await story.save();

    await storyQueue.add(
      { storyId: story._id, publicId: result.public_id, resourceType: fileType },
      { delay: 24 * 60 * 60 * 1000, attempts: 3 }
    );

    await redisclient.del(`stories:${userId}`);
    await redisclient.del(`stories:all`); // Invalidate stories cache

    res.status(201).json({ message: 'Story uploaded successfully', story });
  } catch (error) {
    console.error('Error uploading story:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});


router.get('/stories', async (req, res) => {
  try {
    const stories = await Story.find()
      .sort({ createdAt: -1 });

    res.json(stories);
  } catch (error) {
    console.error('Error fetching stories:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.get('/stories/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `story:${id}`;
  try {
    const cachedStory = await redisclient.get(cacheKey);
    if (cachedStory) {
      console.log(`Returning story ${id} from Redis cache`);
      const story = JSON.parse(cachedStory);
      await Story.findByIdAndUpdate(id, { $inc: { views: 1 } }, { new: true });
      story.views += 1;
      await redisclient.setex(cacheKey, 3600, JSON.stringify(story));
      return res.status(200).json(story);
    }

    const story = await Story.findByIdAndUpdate(id, { $inc: { views: 1 } }, { new: true }).lean();
    if (!story) {
      console.log(`Story ${id} not found`);
      return res.status(404).json({ message: 'Story not found' });
    }
    await redisclient.setex(cacheKey, 3600, JSON.stringify(story));
    console.log(`Returning story ${id} from MongoDB`);
    res.status(200).json(story);
  } catch (error) {
    console.error(`Error fetching story ${id}:`, error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

router.get('/users/:userId/suggestions', async (req, res) => {
  const { userId } = req.params;

  try {
    const currentUser = await User.findOne({ userId });
    if (!currentUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const visited = new Set();
    const queue = [userId];
    const suggestions = new Map();
    visited.add(userId);

    let level = 0;
    while (queue.length > 0 && level < 2) {
      const levelSize = queue.length;
      for (let i = 0; i < levelSize; i++) {
        const currentUserId = queue.shift();
        const user = await User.findOne({ userId: currentUserId }).select('following');
        if (!user || !user.following) continue;

        for (const followeeId of user.following) {
          if (!visited.has(followeeId)) {
            visited.add(followeeId);
            queue.push(followeeId);

            if (level === 1 && followeeId !== userId && !currentUser.following.includes(followeeId)) {
              suggestions.set(followeeId, (suggestions.get(followeeId) || 0) + 1);
            }
          }
        }
      }
      level++;
    }

    let result = [];

    if (suggestions.size > 0) {
      const suggestionList = Array.from(suggestions.entries())
        .map(([userId, score]) => ({ userId, score }))
        .sort((a, b) => b.score - a.score); 

      const suggestionUsers = await User.find({ userId: { $in: suggestionList.map(s => s.userId) } })
        .select('userId username userBio userEmail');

      result = suggestionUsers.map(user => ({
        userId: user.userId,
        username: user.username,
        userBio: user.userBio,
        userEmail: user.userEmail,
        score: suggestionList.find(s => s.userId === user.userId).score,
      }));
    } else {
      // Fallback to find the most popular users (based on number of followers)
      const popularUsers = await User.aggregate([
        {
          $project: {
            userId: 1,
            username: 1,
            userBio: 1,
            userEmail: 1,
            followerCount: { $size: { $ifNull: ['$followers', []] } }, 
          },
        },
        { $sort: { followerCount: -1 } }, 
        { $limit: 15 }, 
      ]);

      if (popularUsers.length === 0) {
        return res.json([]); 
      }

      result = popularUsers.map(user => ({
        userId: user.userId,
        username: user.username,
        userBio: user.userBio,
        userEmail: user.userEmail,
        score: 0,
        followerCount: user.followerCount,
      }));
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching user suggestions:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});


router.post('/create-poll', async (req, res) => {
  const { question, options } = req.body;

  if (!question || !options || options.length < 2) {
    return res.status(400).json({ success: false, error: 'Question and at least two options are required.' });
  }

  try {
    const poll = await Poll.create({ question, options, votes: Array(options.length).fill(0) });

    await pollQueue.add(
      { pollId: poll._id }, 
      { delay: 24 * 60 * 60 * 1000 } 
    );

    res.json({ success: true, poll });
  } catch (error) {
    console.error('Error creating poll:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});


router.post('/vote', async (req, res) => {
  const { pollId, optionIndex, userId } = req.body;

  if (!pollId || optionIndex === undefined || !userId) {
    return res.status(400).json({ success: false, error: 'pollId, optionIndex, and userId are required.' });
  }

  try {
    const poll = await Poll.findById(pollId);
    if (!poll || optionIndex < 0 || optionIndex >= poll.options.length) {
      return res.status(400).json({ success: false, error: 'Invalid poll or option.' });
    }

    if (poll.voters.includes(userId)) {
      return res.status(403).json({ success: false, error: 'You have already voted on this poll.' });
    }

    poll.votes[optionIndex]++;
    poll.voters.push(userId);
    await poll.save();

    res.json({ success: true, poll });
  } catch (error) {
    console.error('Error voting on poll:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }

});

router.get('/polls', async (req, res) => {
  const { userId } = req.query;

  try {
    const polls = await Poll.find();
    const pollsWithVoteStatus = polls.map(poll => ({
      ...poll.toObject(),
      hasVoted: userId ? poll.voters.includes(userId) : false,
    }));
    res.json({ success: true, polls: pollsWithVoteStatus });
  } catch (error) {
    console.error('Error fetching polls:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

router.get('/poll/:pollId', async (req, res) => {
  const { pollId } = req.params; 
  const { userId } = req.query; 

  try {
    const poll = await Poll.findById(pollId);
    if (!poll) {
      return res.status(404).json({ success: false, error: 'Poll not found' });
    }

    const pollWithVoteStatus = {
      ...poll.toObject(),
      hasVoted: userId ? poll.voters.includes(userId) : false,
    };

    res.json({ success: true, poll: pollWithVoteStatus });
  } catch (error) {
    console.error('Error fetching poll:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

router.post('/log-activity', async (req, res) => {
  const { userId, activityType } = req.body;
  try {
    if (!userId || !activityType) {
      return res.status(400).json({ error: 'userId and activityType are required' });
    }
    const activity = new UserActivity({
      userId,
      activityType,
      timestamp: new Date(),
    });
    await activity.save();
    res.status(201).json({ message: 'Activity logged' });
  } catch (error) {
    console.error('Error logging activity:', error.message);
    res.status(500).json({ error: 'Failed to log activity', details: error.message });
  }
});

router.get('/contributions/:userId', async (req, res) => {
  const { userId } = req.params;
  console.log('Received userId:', req.params.userId);
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  try {
    const activities = await UserActivity.aggregate([
      // { $match: { userId: new mongoose.Types.ObjectId(userId), timestamp: { $gte: oneYearAgo } } },
      { $match: { userId: userId, timestamp: { $gte: oneYearAgo } } }, 
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          count: { $sum: 1 },
        },
      },
    ]);

    const contributionMap = {};
    activities.forEach(activity => {
      contributionMap[activity._id] = activity.count;
    });

    res.json(contributionMap); // e.g., { "2024-06-05": 3, "2024-06-06": 1, ... }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contributions' });
  }
});



// this will run but required billing so i dont have money postponding to future
// router.post('/generate-story', async (req, res) => {
//   const { userId, prompt, description, mediaType = 'image' } = req.body;

//   if (!userId || !prompt) {
//     return res.status(400).json({ success: false, error: 'userId and prompt are required' });
//   }

//   const user = await User.findOne({ userId });
//   if (!user) {
//     return res.status(404).json({ success: false, error: 'User not found' });
//   }

//   try {
//     cloudinary.config({
//       cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
//       api_key: process.env.CLOUDINARY_API_KEY,
//       api_secret: process.env.CLOUDINARY_API_SECRET,
//     });

//     const client = new PredictionServiceClient({
//       project: process.env.GOOGLE_CLOUD_PROJECT,
//       location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
//     });

//     // Temporary file path
//     const tempFilePath = `/tmp/${Date.now()}.png`;

//     // Generate media (image only for now)
//     if (mediaType !== 'image') {
//       throw new Error('Only image generation is supported. Use mediaType="image".');
//     }

//     const endpoint = `projects/${process.env.GOOGLE_CLOUD_PROJECT}/locations/${process.env.GOOGLE_CLOUD_LOCATION}/publishers/google/models/imagegeneration@006`;
//     const instance = {
//       prompt: prompt,
//     };
//     const parameters = {
//       sampleCount: 1,
//       aspectRatio: '1:1',
//       outputFormat: 'png',
//     };

//     const [response] = await client.predict({
//       endpoint,
//       instance: { structValue: { fields: { prompt: { stringValue: prompt } } } },
//       parameters: {
//         structValue: {
//           fields: {
//             sampleCount: { numberValue: 1 },
//             aspectRatio: { stringValue: '1:1' },
//             outputFormat: { stringValue: 'png' },
//           },
//         },
//       },
//     });

//     const imageBase64 = response.predictions[0].structValue.fields.bytesBase64Encoded.stringValue;
//     const imageBuffer = Buffer.from(imageBase64, 'base64');
//     await fs.writeFile(tempFilePath, imageBuffer);

//     const uploadResult = await cloudinary.uploader.upload(tempFilePath, {
//       resource_type: 'image',
//       folder: `berony/stories`,
//       public_id: `${Date.now()}`,
//       context: { description: description || '' },
//     });

//     const story = new Story({
//       userId,
//       username: user.username,
//       fileUrl: uploadResult.secure_url,
//       publicId: uploadResult.public_id,
//       fileType: 'image',
//       description,
//     });
//     await story.save();

//     await storyQueue.add(
//       { storyId: story._id, publicId: uploadResult.public_id, resourceType: 'image' },
//       { delay: 24 * 60 * 60 * 1000, attempts: 3 }
//     );

//     await redisclient.del(`stories:${userId}`);
//     await redisclient.del(`stories:all`);

//     await fs.unlink(tempFilePath);

//     res.json({
//       success: true,
//       storyId: story._id,
//       fileUrl: uploadResult.secure_url,
//       publicId: uploadResult.public_id,
//       fileType: 'image',
//     });
//   } catch (error) {
//     console.error(`Error generating or uploading ${mediaType}:`, error);
//     res.status(500).json({ success: false, error: error.message });
//   }
// });



// ​http://localhost:3000/api/generate-story
// {
//   "userId": "",
//   "prompt": "A vibrant city skyline at night",
//   "description": "A beautiful cityscape for a user story",
//   "mediaType": "image"
// }

const initializeScheduledPosts = async () => {
  try {
    const scheduledPosts = await Post.find({ status: 'scheduled', postScheduleTime: { $gt: new Date() } });
    scheduledPosts.forEach(post => {
      schedulePostPublishing(post._id, post.postScheduleTime);
    });
    console.log(`Re-queued ${scheduledPosts.length} scheduled posts`);
  } catch (error) {
    console.error('Error initializing scheduled posts:', error);
  }
};


initializeScheduledPosts()

module.exports = router;