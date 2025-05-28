const express = require('express');
const { ExpressAdapter } = require('@bull-board/express');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const notificationQueue = require('./queues/notificationQueue');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

const app = express();

const { createBullBoard } = require('@bull-board/api');
createBullBoard({
  queues: [new BullAdapter(notificationQueue)],
  serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Bull Board is running on http://localhost:${PORT}/admin/queues`);
});