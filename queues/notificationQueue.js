require('dotenv').config();
const Bull = require('bull');
const { sendEmailNotification } = require('../worker/notificationWorker');

const notificationQueue = new Bull('notification-queue', {
  redis: {
    host: process.env.REDIS_HOST || 'redis-14053.c1.ap-southeast-1-1.ec2.redns.redis-cloud.com',
    port: process.env.REDIS_PORT || 14053,
    password: process.env.REDIS_PASSWORD, 
    maxRetriesPerRequest: null, 
    enableReadyCheck: false, 
    ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {})
  }
});

notificationQueue.process(async (job) => {
    const { followerId, authorName, postTitle, postId }= job.data;
    await sendEmailNotification(followerId, authorName, postTitle, postId);
})

notificationQueue.on('error', (error) => {
  console.error('Notification queue error:', error);
});

notificationQueue.on('failed', (job, error) => {
  console.error(`Notification job ${job.id} failed:`, error);
});

process.on('SIGTERM', async () => {
  await notificationQueue.close();
  console.log('Notification queue closed');
});

module.exports = notificationQueue;