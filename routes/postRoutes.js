const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');
const multer = require('multer');
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png)$/)) {
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
