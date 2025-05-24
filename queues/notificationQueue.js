const Bull = require('bull');

const notificationQueue = new Bull('notification-queue', {
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD
  }
});

notificationQueue.on('error', (error) => {
  console.error('Notification queue error:', error);
});

notificationQueue.on('failed', (job, error) => {
  console.error(`Notification job ${job.id} failed:`, error);
});

module.exports = notificationQueue;