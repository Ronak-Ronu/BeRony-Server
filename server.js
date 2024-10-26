const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();
const axios = require('axios');

const postRoutes = require('./routes/postRoutes');
const draftRoutes = require('./routes/draftRoutes');

const app = express();
app.use(cors());

app.use(bodyParser.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.log(err));


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
  setInterval(sendRequest, 60 * 1000);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  keepAlive()
});
