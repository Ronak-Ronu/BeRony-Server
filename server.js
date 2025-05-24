const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const http = require('http');
const Redis = require('ioredis');
const socketIo = require('socket.io');
const postRoutes = require('./routes/postRoutes');
const draftRoutes = require('./routes/draftRoutes');
const Post = require('./models/Posts');
const helmet = require('helmet');
const askronyai = require('./routes/askronyai');
const meetingRoutes = require('./routes/meetingRoutes');
const multer = require('multer');
const Bull = require('bull');
const cloudinary = require('./cloudinaryconfig')

require('dotenv').config();

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    // allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));



app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(helmet());

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self';");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined
};


const redisSubscriber = new Redis(redisConfig);
const redisPublisher = new Redis(redisConfig);

redisSubscriber.on('error', (err) => console.error('Redis Subscriber Error:', err));
redisPublisher.on('error', (err) => console.error('Redis Publisher Error:', err));

const channel = 'textChannel';
redisSubscriber.subscribe(channel);

redisSubscriber.on('message', (channel, message) => {
  // console.log('Redis message received:', message);
  const { postId, text } = JSON.parse(message);
  io.to(postId).emit('textChange', text);
});

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

const ChatRoomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  creatorId: { type: String, required: true },
  creatorUsername: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const ChatMessageSchema = new mongoose.Schema({
  roomId: { type: String, required: true },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  message: { type: String },
  mediaUrl: { type: String },
  mediaType: { type: String, enum: ['image', 'video', 'gif'] },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const ChatRoom = mongoose.model('ChatRoom', ChatRoomSchema);
const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);

// Multer setup for chat media
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const fileTypes = /jpeg|jpg|png|gif|mp4/;
    const extname = fileTypes.test(file.originalname.toLowerCase().split('.').pop());
    const mimetype = fileTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Only images (jpg, jpeg, png, gif) and videos (mp4) are allowed'));
    }
  }
});

const chatCleanupQueue = new Bull('chat-cleanup-queue', {
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD
  }});

chatCleanupQueue.process(async () => {
  try {
    const rooms = await ChatMessage.distinct('roomId');
    for (const roomId of rooms) {
      const chatCount = await ChatMessage.countDocuments({ roomId });
      if (chatCount > 40) {
        const chatsToDelete = await ChatMessage.find({ roomId })
          .sort({ createdAt: 1 })
          .limit(chatCount - 30);
        const chatIds = chatsToDelete.map(chat => chat._id);
        await ChatMessage.deleteMany({ _id: { $in: chatIds } });
        console.log(`Deleted ${chatIds.length} old chats from room ${roomId}`);
      }
    }
  } catch (error) {
    console.error('Error in chat cleanup:', error);
  }
});

chatCleanupQueue.add({}, {
  repeat: { every: 60 * 1000 },
  attempts: 3
}).then(() => {
  console.log('Chat cleanup job scheduled');
});

chatCleanupQueue.on('error', (error) => {
  console.error('Chat cleanup queue error:', error);
});
chatCleanupQueue.on('failed', (job, error) => {
  console.error(`Chat cleanup job ${job.id} failed:`, error);
});

app.get('/api/chat/rooms', async (req, res) => {
  const cacheKey = 'chat:rooms';
  console.log('GET /api/chat/rooms received');
  try {
    const cachedRooms = await redisPublisher.get(cacheKey);
    if (cachedRooms) {
      console.log('Returning rooms from Redis cache');
      return res.status(200).json(JSON.parse(cachedRooms));
    }
    const rooms = await ChatRoom.find().sort({ createdAt: -1 });
    await redisPublisher.setex(cacheKey, 3600, JSON.stringify(rooms));
    console.log('Returning rooms from MongoDB:', rooms);
    res.status(200).json(rooms);
  } catch (error) {
    console.error('Error fetching chat rooms:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

app.post('/api/chat/rooms', async (req, res) => {
  console.log('POST /api/chat/rooms received:', req.body);
  const { roomId, title, creatorId, creatorUsername } = req.body;
  try {
    if (!roomId || !title || !creatorId || !creatorUsername) {
      console.log('Missing required fields');
      return res.status(400).json({ message: 'All fields are required' });
    }
    const existingRoom = await ChatRoom.findOne({ roomId });
    if (existingRoom) {
      console.log('Room ID already exists:', roomId);
      return res.status(400).json({ message: 'Room ID already exists' });
    }
    const newRoom = new ChatRoom({ roomId, title, creatorId, creatorUsername });
    await newRoom.save();
    await redisPublisher.del('chat:rooms');
    console.log('Room created:', newRoom);
    io.emit('roomCreated', newRoom);
    res.status(201).json(newRoom);
  } catch (error) {
    console.error('Error creating chat room:', error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

app.get('/api/chat/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const cacheKey = `chat:${roomId}:recent`;
  console.log(`GET /api/chat/${roomId} received`);
  try {
    const cachedChats = await redisPublisher.lrange(cacheKey, 0, -1);
    if (cachedChats.length > 0) {
      console.log(`Returning ${cachedChats.length} messages from Redis cache for room ${roomId}`);
      return res.status(200).json(cachedChats.map(c => JSON.parse(c)));
    }
    
    console.log(`No cached messages found in Redis for room ${roomId}, fetching from MongoDB`);
    const chats = await ChatMessage.find({ roomId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(); 
    if (chats.length === 0) {
      console.log(`No messages found in MongoDB for room ${roomId}`);
    } else {
      console.log(`Found ${chats.length} messages in MongoDB for room ${roomId}`);
      await redisPublisher.del(cacheKey); 
      await redisPublisher.lpush(cacheKey, chats.map(c => JSON.stringify(c)));
      await redisPublisher.expire(cacheKey, 3600); 
    }
    res.status(200).json(chats);
  } catch (error) {
    console.error(`Error fetching chat history for room ${roomId}:`, error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});
io.use(async (socket, next) => {
  const { userId, username } = socket.handshake.auth;
  console.log('Socket.io auth:', { userId, username });
  if (!userId || !username) {
    console.error('Socket.io auth failed: Missing userId or username');
    return next(new Error('Authentication error'));
  }
  socket.userId = userId;
  socket.username = username;
  next();
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.username, 'ID:', socket.userId);

  socket.on('joinChatRoom', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.username} (${socket.id}) joined room: ${roomId}`);
    ChatMessage.find({ roomId })
      .sort({ createdAt: 1 })
      .then(messages => {
        console.log(`Sending chat history for room ${roomId}:`, messages.length, 'messages');
        socket.emit('chatHistory', messages);
      })
      .catch(err => {
        console.error('Error fetching chat history:', err);
        socket.emit('chatError', { message: 'Failed to load chat history' });
      });
  });

  socket.on('sendChatMessage', async (data) => {
    try {
      const { roomId, message, media } = data;
      console.log('Received chat message:', { roomId, message, media: !!media });
      let mediaUrl, mediaType;
      if (media) {
        // Validate media
        if (!media.buffer || !media.mimetype) {
          throw new Error('Invalid media data');
        }
        try {
          const uploadResult = await cloudinary.uploader.upload(media.buffer, {
            resource_type: media.mimetype.startsWith('video') ? 'video' : 'image',
            folder: 'chat_room_media'
          });
          mediaUrl = uploadResult.secure_url;
          mediaType = media.mimetype.startsWith('video') ? 'video' : media.mimetype.includes('gif') ? 'gif' : 'image';
          console.log('Cloudinary upload successful:', { mediaUrl, mediaType });
        } catch (uploadError) {
          console.error('Cloudinary upload failed:', {
            message: uploadError.message,
            name: uploadError.name,
            http_code: uploadError.http_code
          });
          throw new Error('Failed to upload media to Cloudinary');
        }
      }
      const chatMessage = new ChatMessage({
        roomId,
        userId: socket.userId,
        username: socket.username,
        message,
        mediaUrl,
        mediaType
      });
      await chatMessage.save();
      console.log('Chat message saved:', chatMessage);
      io.to(roomId).emit('chatMessage', chatMessage);
    } catch (error) {
      console.error('Error sending message:', {
        message: error.message,
        name: error.name,
        http_code: error.http_code
      });
      socket.emit('chatError', { message: 'Failed to send message due to server error' });
    }
  });



  socket.on('leaveChatRoom', (roomId) => {
    socket.leave(roomId);
    console.log(`User ${socket.username} (${socket.id}) left room: ${roomId}`);
  });

  socket.on('textChange', (text) => {
    console.log(`Text change received for post ${socket.postId}:`, text); 
    socket.to(socket.postId).emit('textChange', text); 
    redisPublisher.publish(channel, JSON.stringify({ postId: socket.postId, text }));
  });

  socket.on('startEditing', () => {
    io.to(socket.postId).emit('startEditing', socket.username);
  });

  socket.on('canvasUpdate', (data) => {
    socket.broadcast.emit('canvasUpdate', data);
  });

  socket.on('cursorMove', ({ position }) => {
    console.log(`Received cursorMove from user ${socket.username} at position ${position}`);
    socket.to(socket.postId).emit('cursorUpdate', {
      userId: socket.userId,
      username: socket.username,
      position
    });
  });

  socket.on('joinPostRoom', (postId) => {
    socket.postId = postId; // Set postId on the socket
    socket.join(postId);
    console.log(`User ${socket.username} (${socket.userId}) joined room: ${postId}`);
  });


  socket.on('saveChanges', async (text) => {
    try {
      const post = await Post.findById(socket.postId);
      if (!post) {
        console.error('Post not found');
        return;
      }
      post.bodyofcontent = text;
      await post.save();
      console.log('Post updated with new text:', text);
      const cacheKey = `post:${socket.postId}`;
      await redisPublisher.set(cacheKey, JSON.stringify(post), 'EX', 86400);
      socket.to(socket.postId).emit('textChange', text);
      socket.to(socket.postId).emit('users', socket.username);
      redisPublisher.publish(channel, JSON.stringify({ postId: socket.postId, text }));
    } catch (error) {
      console.error('Error updating post:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.username, 'ID:', socket.userId);
    socket.to(socket.postId).emit('cursorRemove', { userId: socket.userId });
  });
});

// io.on('newPost', async (data) => {
//   const { postId, title, authorName, authorId } = data;
//   const author = await User.findOne({ userId: authorId });
//   const followers = author.followers || [];
//   followers.forEach(followerId => {
//     io.to(`user:${followerId}`).emit('newPostNotification', {
//       postId,
//       title,
//       authorName,
//       message: `${authorName} published a new post: ${title}`
//     });
//   });
// });

app.use('/api', postRoutes);
app.use('/api', askronyai);
app.use('/api', draftRoutes);
// app.use('/api', meetingRoutes);

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
  setInterval(sendRequest, 20 * 60 * 1000);
}

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  keepAlive();
});