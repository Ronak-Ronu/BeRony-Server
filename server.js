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
const multer = require('multer');
const Bull = require('bull');
const cloudinary = require('./cloudinaryconfig')
const prerender = require('prerender-node');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Enhanced error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process in production, let it continue
  if (process.env.NODE_ENV === 'development') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

prerender.set('prerenderServiceUrl', 'https://service.prerender.io/'); 
prerender.set('crawlerUserAgents', [
  'googlebot',
  'bingbot',
  'yandex',
  'baiduspider',
  'facebookexternalhit',
  'twitterbot',
  'linkedinbot',
]);

app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(helmet());
app.use(prerender.set('prerenderToken', process.env.PRERENDER_TOKEN));

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self';");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// MongoDB connection with retry logic
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    // Retry connection after 5 seconds
    setTimeout(connectDB, 5000);
  }
};

connectDB();

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true
};

const redisSubscriber = new Redis(redisConfig);
const redisPublisher = new Redis(redisConfig);

// Handle Redis connection errors gracefully
redisSubscriber.on('error', (err) => console.error('Redis Subscriber Error:', err));
redisPublisher.on('error', (err) => console.error('Redis Publisher Error:', err));

redisSubscriber.on('connect', () => console.log('Redis Subscriber connected'));
redisPublisher.on('connect', () => console.log('Redis Publisher connected'));

const channel = 'textChannel';
redisSubscriber.subscribe(channel);

redisSubscriber.on('message', (channel, message) => {
  try {
    const { postId, text } = JSON.parse(message);
    io.to(postId).emit('textChange', text);
  } catch (error) {
    console.error('Error processing Redis message:', error);
  }
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

// Chat routes remain the same...
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
      .sort({ createdAt: 1 })
      .limit(50)
      .lean(); 
    if (chats.length === 0) {
      console.log(`No messages found in MongoDB for room ${roomId}`);
    } else {
      console.log(`Found ${chats.length} messages in MongoDB for room ${roomId}`);
      await redisPublisher.del(cacheKey); 
      await redisPublisher.lpush(cacheKey, chats.map(c => JSON.stringify(c)));
      await redisPublisher.ltrim(cacheKey, 0, 49);
      await redisPublisher.expire(cacheKey, 3600); 
    }
    res.status(200).json(chats);
  } catch (error) {
    console.error(`Error fetching chat history for room ${roomId}:`, error);
    res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// Socket.io with better error handling
io.use(async (socket, next) => {
  try {
    const { userId, username, postId } = socket.handshake.auth;
    console.log('Socket.io auth:', { userId, username });
    if (!userId || !username) {
      console.error('Socket.io auth failed: Missing userId or username');
      return next(new Error('Authentication error'));
    }
    socket.userId = userId;
    socket.username = username;
    socket.postId = postId;
    if (postId && mongoose.Types.ObjectId.isValid(postId)) {
      socket.join(postId);
      console.log(`Socket joined post room: ${postId}`);
    } else if (postId) {
      console.log(`Invalid postId: ${postId}`);
      socket.emit('error', { message: 'Invalid post ID' });
    }
    next();
  } catch (error) {
    console.error('Socket middleware error:', error);
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.username, 'ID:', socket.userId);

  socket.on('joinChatRoom', (roomId) => {
    try {
      socket.join(roomId);
      console.log(`User ${socket.username} (${socket.id}) joined room: ${roomId}`);
      ChatMessage.find({ roomId })
        .sort({ createdAt: 1 })
        .limit(50)
        .lean()
        .then(messages => {
          console.log(`Sending chat history for room ${roomId}:`, messages.length, 'messages');
          socket.emit('chatHistory', messages);
        })
        .catch(err => {
          console.error('Error fetching chat history:', err);
          socket.emit('chatError', { message: 'Failed to load chat history' });
        });
    } catch (error) {
      console.error('Error in joinChatRoom:', error);
    }
  });

  socket.on('sendChatMessage', async (data) => {
    try {
      const { roomId, message, media } = data;
      console.log('Received chat message:', { roomId, message, media: !!media });
      let mediaUrl, mediaType;
      if (media) {
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
          console.error('Cloudinary upload failed:', uploadError);
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
      console.error('Error sending message:', error);
      socket.emit('chatError', { message: 'Failed to send message due to server error' });
    }
  });

  socket.on('leaveChatRoom', (roomId) => {
    socket.leave(roomId);
    console.log(`User ${socket.username} (${socket.id}) left room: ${roomId}`);
  });

  socket.on('textChange', ({ text, senderId }) => {
    try {
      const payload = { text, senderId };
      socket.to(socket.postId).emit('textChange', payload);
      redisPublisher.publish(channel, JSON.stringify({ postId: socket.postId, text }));
    } catch (error) {
      console.error('Error in textChange:', error);
    }
  });

  socket.on('startEditing', (username) => {
    try {
      console.log(`Broadcasting startEditing for user: ${username} to room: ${socket.postId}`);
      io.to(socket.postId).emit('startEditing', username);
    } catch (error) {
      console.error('Error in startEditing:', error);
    }
  });

  socket.on('canvasUpdate', (data) => {
    try {
      socket.broadcast.emit('canvasUpdate', data);
    } catch (error) {
      console.error('Error in canvasUpdate:', error);
    }
  });

  socket.on('cursorMove', ({ position }) => {
    try {
      socket.to(socket.postId).emit('cursorUpdate', {
        userId: socket.userId,
        socketId: socket.id,
        username: socket.username,
        position
      });
    } catch (error) {
      console.error('Error in cursorMove:', error);
    }
  });

  socket.on('joinPostRoom', (postId) => {
    try {
      socket.postId = postId;
      socket.join(postId);
      console.log(`User ${socket.username} (${socket.userId}) joined room: ${postId}`);
    } catch (error) {
      console.error('Error in joinPostRoom:', error);
    }
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

  socket.on('disconnect', (reason) => {
    console.log('User disconnected:', socket.username, 'ID:', socket.userId, 'Reason:', reason);
    try {
      socket.to(socket.postId).emit('cursorRemove', { socketId: socket.id });
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

app.use('/api', postRoutes);
app.use('/api', askronyai);
app.use('/api', draftRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Keep-alive function with error handling
function sendRequest() {
  axios.get(process.env.API_LIVE_URL || `http://localhost:${process.env.PORT || 3000}/health`, {
    timeout: 10000
  })
    .then(response => {
      console.log(`Keep-alive request successful with status: ${response.status}`);
    })
    .catch(error => {
      console.error('Error in keep-alive request:', error.message);
    });
}

function keepAlive() {
  if (process.env.NODE_ENV === 'production') {
    setInterval(sendRequest, 20 * 60 * 1000);
  }
}

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
  keepAlive();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('HTTP server closed');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});