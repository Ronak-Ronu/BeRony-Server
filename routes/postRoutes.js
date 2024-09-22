const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');
const multer = require('multer');
const fs=require('fs')
const Redis=require('ioredis')
require('dotenv').config();


const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png|svg)$/)) {
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

const cloudinary = require('../cloudinaryconfig')
// const multer = require('multer');
// const { CloudinaryStorage } = require('multer-storage-cloudinary');

// const storage = new CloudinaryStorage({
//   cloudinary: cloudinary,
//   params: {
//     folder: 'BlogData', 
//     allowedFormats: ['jpg', 'png', 'jpeg'],
//   },
// });
// const upload = multer({ storage });


// router.post('/posts', async (req, res) => {
//   const {title,bodyofcontent,endnotecontent,imageUrl} = req.body;

//   const resultimageurl= await cloudinary.uploader.upload(imageUrl,
//     {
//       folder:'BlogData'
//     }
//   )
//   const newPost = new Post(
//     {
//       title,
//       bodyofcontent,
//       endnotecontent,
//       imageUrl:resultimageurl.secure_url
//     }
//   );
//   await newPost.save();
//   res.json(newPost);
// });

router.post('/posts', upload.single('imageUrl'), async (req, res) => {
  try {
    // const { title, bodyofcontent, endnotecontent } = req.body;

    console.log('Request Body:', req.body);
    console.log('File:', req.file);
    const filePath = req.file.path;
    console.log('File path:', filePath);

      if (req.file) {
      // Process the file (upload to Cloudinary or local storage)
      const resultimageurl = await cloudinary.uploader.upload(req.file.path, {
        folder: 'BlogData',
      });

      // Save post with the uploaded image URL
      const newPost = new Post({
        title: req.body.title,
        bodyofcontent: req.body.bodyofcontent,
        endnotecontent: req.body.endnotecontent,
        imageUrl: resultimageurl.secure_url,
      });

      await newPost.save();
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

// router.post('/uploadimage', upload.single('image'), async (req, res) => {
//     blogPost.imageUrl = req.file.path;
//     await blogPost.save();
//     res.status(200).json({ message: 'Image uploaded and linked successfully', blogPost });

// })


router.get('/posts', async (req, res) => {
  const query = req.query.q || ''; 
  const regex = new RegExp(query, 'i');

  try {
    let posts;

    // Check if a search query is provided
    if (query) {
      // Perform search without using cache since the query is dynamic
      posts = await Post.find({
        $or: [
          { title: { $regex: regex } },
          { bodyofcontent: { $regex: regex } }
        ]
      });
    } else {
      // If no search query, check if posts are cached in Redis
      const isExist = await redisclient.exists("posts");

      if (isExist) {
        console.log("Fetching posts from Redis cache...");
        const redisdata = await redisclient.get("posts");
        posts = JSON.parse(redisdata);
      } else {
        // Fetch posts from the database if not cached
        posts = await Post.find();
        // Cache the posts in Redis
        await redisclient.set("posts", JSON.stringify(posts));
      }
    }

    res.json(posts);

  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.get('/posts/:id',async(req,res)=>{
  const post = await Post.findById(req.params.id);
  res.json(post);
})


router.delete('/posts/:id', async (req, res) => {
  try {
    const deletedPost = await Post.findByIdAndDelete(req.params.id);
    
    if (!deletedPost) {
      return res.status(404).json({ message: 'Post not found' });
    }

    await redisclient.del("posts");

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
    
    res.json(post);
  } catch (error) {
    console.error('Error updating post:', error);
    res.status(500).json({ error: 'Cannot like the post' });
  }
});



module.exports = router;
