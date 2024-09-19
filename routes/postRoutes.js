const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');
const multer = require('multer');
const fs=require('fs')



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

require('dotenv').config();

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
  // const posts = await Post.find();
  // res.json(posts);
  try {
    const query = req.query.q || ''; 
    const regex = new RegExp(query, 'i');
    const posts = await Post.find({
      $or: [
        { title: { $regex: regex } },
        { bodyofcontent: { $regex: regex } }
      ]
    });
    res.json(posts);
  } catch (error) {
    console.error('Error fetching posts:', error);
  }

});

router.get('/posts/:id',async(req,res)=>{
  const post = await Post.findById(req.params.id);
  res.json(post);
})


router.delete('/posts/:id', async (req, res) => {
  await Post.findByIdAndDelete(req.params.id);
  res.json({ message: 'Post deleted' });
});

router.patch('/posts/like/:id', async (req, res) => {
  const { emoji, increment } = req.body; 
  
  // Log the incoming data for debugging
  console.log('Request body:', req.body);
  console.log('Post ID:', req.params.id);

  if (!emoji || increment === undefined) {
    return res.status(400).json({ error: 'Invalid request data' });
  }

  try {
    const updateField = `${emoji}count`;  // e.g., funnyCount, sadCount, etc.
    
    // Log the field being updated
    console.log('Updating field:', updateField);
    
    const update = { $inc: { [updateField]: increment ? 1 : -1 } };
    
    // Find the post by ID and update the count
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
