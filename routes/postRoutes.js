const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');
const Bookmark=require('../models/Bookmark')
const User=require('../models/User')
const multer = require('multer');
const fs=require('fs')
const Redis=require('ioredis')
const cloudinary = require('../cloudinaryconfig')
const nodemailer = require('nodemailer');
require('dotenv').config();



const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 20 * 1024 * 1024 }, // 10 MB limit
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png|svg|gif|mp4|mpeg)$/)) {
      return cb(new Error('Please upload an image'));
    }
    cb(null, true);
  }
});


const redisclient = new Redis({
  host: process.env.REDIS_HOST  ,
  password: process.env.REDIS_PASSWORD ,
  port: process.env.REDIS_PORT
});

redisclient.on('connect',()=>{
  console.log("redis is connected");
})
redisclient.on('error', (err) => {
  console.error('Redis error:', err);
});


router.post('/posts', upload.single('imageUrl'), async (req, res) => {
  try {
    // const { title, bodyofcontent, endnotecontent } = req.body;

    console.log('Request Body:', req.body);
    console.log('File:', req.file);
    const filePath = req.file.path;
    console.log('File path:', filePath);
    const tagsArray = JSON.parse(req.body.tags);
    const isVideo = req.file.mimetype.startsWith('video') || req.file.originalname.endsWith('.mp4')   ;
    const folderName = isVideo ? 'BlogData' : 'VBlogData';

      if (req.file) {
      const resultimageurl = await cloudinary.uploader.upload(req.file.path, {
        folder: folderName,
        resource_type: isVideo ? 'video' : 'image',
      });
      let newresultimageurl='';
      if (isVideo) {
        // For video, you need to use Cloudinary's video URL format
         newresultimageurl = `https://res.cloudinary.com/${process.env.CLOUD_NAME}/video/upload/${resultimageurl.public_id}.mp4`;
      } else {
        // For image, use the standard image URL
        newresultimageurl = `https://res.cloudinary.com/${process.env.CLOUD_NAME}/image/upload/${resultimageurl.public_id}`;
      }

      const newPost = new Post({
        title: req.body.title,
        bodyofcontent: req.body.bodyofcontent,
        endnotecontent: req.body.endnotecontent,
        imageUrl: isVideo ? null : newresultimageurl,
        videoUrl: isVideo ? newresultimageurl : null,
        userId: req.body.userId,
        username: req.body.username,
        createdAt: new Date(),
        tags:tagsArray
      });
      
      await newPost.save();
      await redisclient.del("posts");
      await redisclient.del(`posts:0:3`); 
      await redisclient.del(`posts:3:3`); 
  

      console.log(newPost);


      fs.unlink(req.file.path, (err) => {
        if (err) {
          console.error('error in deleting :', err);
        } else {
          console.log('file deleted');
        }
      });
      console.log(newPost);

      res.json(newPost);
    } else {
      // If no file is uploaded, return an error
      return res.status(400).json({ message: 'Missing required parameter - file' });
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
        // Fetch posts from the database if not cached

        posts = await Post.find().sort({ createdAt: -1 }).skip(parseInt(start)).limit(parseInt(limit));
        // Cache the posts in Redis
        await redisclient.setex("posts", 3600, JSON.stringify(posts));      
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
    const postid=req.params.id;

    const deletedPost = await Post.findByIdAndDelete(postid);
    
    if (!deletedPost) {
      return res.status(404).json({ message: 'Post not found' });
    }
    await redisclient.del("posts"); 
    await redisclient.del(`post:${postid}`); 

    await redisclient.del(`posts:0:3`);
    await redisclient.del(`posts:3:3`);


    res.json({ message: 'Post deleted successfully' });
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
    // Find bookmarks for the user and populate the post data
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
    html: `
      <h1>Hello!</h1>
      <p>You have been added as a collaborator to the following post:</p>
      <h2>Post Title: ${postTitle} - ${authorName}</h2>
      <p>Author Mail ID: ${authorMail}</p>
      <p>${postDescription}</p>
      <p>To start contributing, click the link below to access the workspace:</p>
      <p><a href="${workspaceLink}">Go to Workspace</a></p>
      <p>Happy contributing!</p>
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


module.exports = router;
