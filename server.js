const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();
const axios = require('axios');
const http = require("http");
const Redis=require('ioredis')
const socketIo = require("socket.io");
const postRoutes = require('./routes/postRoutes');
const draftRoutes = require('./routes/draftRoutes');
const Post = require('./models/Posts');
const helmet = require('helmet');

const app = express();
app.use(cors({
  origin:  process.env.BE_RONY_WEB_APP,  
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"], 
  credentials: true,

}));

app.use(bodyParser.json());
app.use(express.json());
app.use(helmet());

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self';");
  
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  
  res.setHeader('Referrer-Policy', 'no-referrer');
  
  next();
});

const server = http.createServer(app)
const io = socketIo(server, {
  cors: {
    origin: process.env.BE_RONY_WEB_APP, 
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    
  }
});

const channel = "textChannel";



// MongoDB connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.log(err));


const redisSubscriber = new Redis({
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD,
    port: process.env.REDIS_PORT
  });
  
const redisPublisher = new Redis({
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD,
    port: process.env.REDIS_PORT
  });

  redisSubscriber.subscribe(channel);

  redisSubscriber.on("message", (channel, message) => {
      const { postId, text } = JSON.parse(message);
      io.to(postId).emit("textChange", text);
  });
  

  io.use(async (socket, next) => {
    const { userId, postId,username } = socket.handshake.auth;
  
    try {
      const post = await Post.findById(postId);
      if (!post) {
        return next(new Error("Post not found"));
      }
  
      const isAuthorized = post.userId === userId || post.collaborators.includes(userId);
      if (!isAuthorized) {
        return next(new Error("Not authorized to edit this post"));
      }
        socket.userId = userId;
        socket.postId = postId;
        socket.username = username;
        console.log(socket.username);
        
      next();
    } catch (err) {
      console.log("Authorization error:", err);  
      next(new Error("Authorization error"));
    }
  });
  
io.on("connection", (socket) => {
    console.log("User connected:", socket.username, "for post:", socket.postId);
    socket.join(socket.postId); 
      
    socket.on("textChange",(text)=>{
      socket.to(socket.postId).emit("textChange", text);
    })

    socket.on("startEditing", () => {
      io.to(socket.postId).emit("startEditing", socket.username);
    });



    socket.on("saveChanges", async (text) => {
      try {
        const post = await Post.findById(socket.postId);
        if (!post) {
          return console.error("Post not found");
        }
        
        // Update the post content
        post.bodyofcontent = text;
        await post.save();  
    
        console.log("Post updated with new text:", text);
    
        // Update Redis cache with the latest post data
        const cacheKey = `post:${socket.postId}`;
        await redisPublisher.set(cacheKey, JSON.stringify(post), 'EX', 86400); // Cache expiration of 1 day
    
        // Notify all clients about the change
        socket.to(socket.postId).emit("textChange", text);
        socket.to(socket.postId).emit("users", socket.username);

    
        // Publish the updated content to Redis for subscribers
        redisPublisher.publish(channel, JSON.stringify({ postId: socket.postId, text }));
      } catch (error) {
        console.error("Error updating post:", error);
      }
    });
    
    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.userId);

    });
});
   


app.use('/api', postRoutes);
app.use('/api', draftRoutes);


function sendRequest() {
  axios.get(process.env.API_LIVE_URL)
    .then(response => {
      console.log(`Keep-alive request successful with status: ${response.status}`);
    })
    .catch(error => {
      console.error('Error in keep-alive request:', error.message);
      console.error(error.response ? error.response.data : error.message);
    });
}

function keepAlive() {
  setInterval(sendRequest, 10*60*1000);
}

const port = process.env.PORT || 3000;
// app.listen(port, () => {
//   console.log(`Server running on port ${port}`);
//   keepAlive()
// });

server.listen(port, () => {
  console.log(`ws  running on port ${port}`);
  keepAlive()
});
