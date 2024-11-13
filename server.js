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

const app = express();
app.use(cors(
  {
    origin: "*", 
    methods: ["GET", "POST"]
  }
));

app.use(bodyParser.json());
app.use(express.json());

const server = http.createServer(app)
const io = socketIo(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
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
    io.emit("textChange", message);  
  });

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    socket.on("textChange", (text) => {
     
      redisPublisher.publish(channel, text);
    });
  

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
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
