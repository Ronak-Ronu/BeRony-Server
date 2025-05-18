const express = require('express');
const router = express.Router();
const ChatRoom = require('../models/Room');

router.get('/chat/rooms', async (req, res) => {
  const cacheKey = 'chat:rooms';
  try {
    const cachedRooms = await redisPublisher.get(cacheKey);
    if (cachedRooms) {
      console.log("Fetching rooms from Redis cache...");
      return res.json(JSON.parse(cachedRooms));
    }
    const rooms = await ChatRoom.find().sort({ createdAt: -1 });
    await redisPublisher.setex(cacheKey, 3600, JSON.stringify(rooms));
    res.json(rooms);
  } catch (error) {
    console.error('Error fetching chat rooms:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});


router.post('/chat/rooms', async (req, res) => {
  const { roomId, title, creatorId, creatorUsername } = req.body;
  try {
    const existingRoom = await ChatRoom.findOne({ roomId });
    if (existingRoom) {
      return res.status(400).json({ message: 'Room ID already exists' });
    }
    const newRoom = new ChatRoom({ roomId, title, creatorId, creatorUsername });
    await newRoom.save();
    await redisPublisher.del('chat:rooms');
    io.emit("roomCreated", newRoom);
    res.status(201).json(newRoom);
  } catch (error) {
    console.error('Error creating chat room:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

router.get('/chat/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const cacheKey = `chat:${roomId}:recent`;
  try {
    const cachedChats = await redisPublisher.lrange(cacheKey, 0, -1);
    let chats = cachedChats.length > 0
      ? cachedChats.map(c => JSON.parse(c))
      : await Chat.find({ roomId }).sort({ createdAt: -1 }).limit(50);
    res.json(chats);
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

module.exports = router;