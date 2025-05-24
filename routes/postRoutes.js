const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');
const Bookmark=require('../models/Bookmark')
const Tree = require('../models/Tree')
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
      });

      await newPost.save();

      const keys = await redisclient.keys('posts:*');
      if (keys.length > 0) {
        await redisclient.del(keys);
        console.log(`Invalidated cache keys: ${keys.join(', ')}`);
      }

      console.log(newPost);

      if (!isSchedule) {
        const author = await User.findOne({ userId: req.body.userId });
        const followers = await User.find({
          userId: { $in: author.followers || [] },
        });

        for (const follower of followers) {
          await notificationQueue.add({
            userEmail: follower.userEmail,
            authorName: author.username,
            postTitle: newPost.title,
            postId: newPost._id
          }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
        }
        console.log(`Queued notifications for ${followers.length} followers for post ${newPost._id}`);

        // io.emit('newPost', {
        //   postId: newPost._id,
        //   title: newPost.title,
        //   authorName: newPost.username,
        //   authorId: newPost.userId
        // });
      }



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
  const { q: query = '', tags: tag = '', start = 0, limit = 3 } = req.query

  try {
    let posts;
    if(tag)
    {
        posts=await Post.find({tags:tag}).sort({ createdAt: -1 }).skip(parseInt(start)).limit(parseInt(limit));
    }
    else if(query) {
      const decodedQuery = decodeURIComponent(query.trim());

      const searchWords = decodedQuery.split(/\s+/);

      const searchConditions = searchWords.map(word => ({
        $or: [
          { title: { $regex: word, $options: 'i' } }, // 'i' makes it case-insensitive
          { bodyofcontent: { $regex: word, $options: 'i' } }
        ]
      }))
      posts = await Post.find({ $and: searchConditions }).sort({ createdAt: -1 });

    } else {
      posts = await Post.find().sort({ createdAt: -1 });
    }
    res.json(posts);

  } catch (error) {
    console.error('Error fetching query posts:', error);
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
router.get('/sitemap.xml',async (req,res)=>{
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
      <url>
        <loc>https://berony.web.app/blogreel</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.9</priority>
      </url>
    `;

    posts.forEach((post)=>{
      sitemap+=`
      <url>
        <loc>https://berony.web.app/blog/${post._id}</loc>
        <lastmod>${new Date(post.createdAt).toISOString()}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.9</priority>
      </url>

      `
    })
    sitemap += `</urlset>`;
    res.header("Content-Type", "application/xml");
    res.send(sitemap);
} catch (error) {
    res.status(500).json({ message: error.message });
    
  }
})

router.get("/tree", async (req, res) => {
  try {
    const trees = await Tree.find();
    res.json(trees);
  } catch (error) {
    res.status(500).json({ message: "Error fetching trees" });
  }
});

router.post("/tree", async (req, res) => {
  // console.log("Received body:", req.body); 
  const { userId, position, woodColor, leafColor } = req.body;

  try {
    const user = await User.findOne({userId})
    // console.log(user);
    if (!user) return res.status(404).json({ message: "User not found" });
    
    const existingTree = await Tree.findOne({ userId });
    if (existingTree) return res.status(400).json({ message: "User already planted a tree" });

    const newTree = new Tree({
      userId: user.userId,
      username: user.username,
      position,
      woodColor: woodColor || "#8B5A2B",
      leafColor: leafColor || "#00FF00"
    });

    await newTree.save();
    res.status(201).json(newTree);
  } catch (error) {
    res.status(500).json({ message: "Error saving tree" });
  }
});


router.delete('/tree/:id', async (req, res) => {
  try {
    const userId=req.params.id;

    const deletedTree = await Tree.findOneAndDelete({userId:userId})
    
    if (!deletedTree) {
      return res.status(404).json({ message: 'tree not found' });
    }
    res.json({ message: 'tree deleted successfully' });
  } catch (error) {
    console.error('Error deleting post:', error);
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



// this will run but required billing so i dont have money postponding to future
router.post('/generate-story', async (req, res) => {
  const { userId, prompt, description, mediaType = 'image' } = req.body;

  if (!userId || !prompt) {
    return res.status(400).json({ success: false, error: 'userId and prompt are required' });
  }

  const user = await User.findOne({ userId });
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  try {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    const client = new PredictionServiceClient({
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    });

    // Temporary file path
    const tempFilePath = `/tmp/${Date.now()}.png`;

    // Generate media (image only for now)
    if (mediaType !== 'image') {
      throw new Error('Only image generation is supported. Use mediaType="image".');
    }

    const endpoint = `projects/${process.env.GOOGLE_CLOUD_PROJECT}/locations/${process.env.GOOGLE_CLOUD_LOCATION}/publishers/google/models/imagegeneration@006`;
    const instance = {
      prompt: prompt,
    };
    const parameters = {
      sampleCount: 1,
      aspectRatio: '1:1',
      outputFormat: 'png',
    };

    const [response] = await client.predict({
      endpoint,
      instance: { structValue: { fields: { prompt: { stringValue: prompt } } } },
      parameters: {
        structValue: {
          fields: {
            sampleCount: { numberValue: 1 },
            aspectRatio: { stringValue: '1:1' },
            outputFormat: { stringValue: 'png' },
          },
        },
      },
    });

    const imageBase64 = response.predictions[0].structValue.fields.bytesBase64Encoded.stringValue;
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    await fs.writeFile(tempFilePath, imageBuffer);

    const uploadResult = await cloudinary.uploader.upload(tempFilePath, {
      resource_type: 'image',
      folder: `berony/stories`,
      public_id: `${Date.now()}`,
      context: { description: description || '' },
    });

    const story = new Story({
      userId,
      username: user.username,
      fileUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      fileType: 'image',
      description,
    });
    await story.save();

    await storyQueue.add(
      { storyId: story._id, publicId: uploadResult.public_id, resourceType: 'image' },
      { delay: 24 * 60 * 60 * 1000, attempts: 3 }
    );

    await redisclient.del(`stories:${userId}`);
    await redisclient.del(`stories:all`);

    await fs.unlink(tempFilePath);

    res.json({
      success: true,
      storyId: story._id,
      fileUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      fileType: 'image',
    });
  } catch (error) {
    console.error(`Error generating or uploading ${mediaType}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});
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
