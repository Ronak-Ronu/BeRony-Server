const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');
const Bookmark=require('../models/Bookmark')
const multer = require('multer');
const fs=require('fs')
const Redis=require('ioredis')
const cloudinary = require('../cloudinaryconfig')
require('dotenv').config();


const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 15 * 1024 * 1024 }, // 10 MB limit
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png|svg|gif)$/)) {
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

      if (req.file) {
      const resultimageurl = await cloudinary.uploader.upload(req.file.path, {
        folder: 'BlogData',
      });
      const newresultimageurl=`https://res.cloudinary.com/beronyimages/image/upload/${resultimageurl.public_id}`

      const newPost = new Post({
        title: req.body.title,
        bodyofcontent: req.body.bodyofcontent,
        endnotecontent: req.body.endnotecontent,
        imageUrl: newresultimageurl,
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
      return res.json(JSON.parse(cachedPost));
    }

    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    // Cache the post
    await redisclient.set(cacheKey, JSON.stringify(post),'EX', 86400);
    res.json(post);
  } catch (error) {
    console.error('Error fetching post:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});


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




module.exports = router;
