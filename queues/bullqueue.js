const Bull = require('bull');
const { publishScheduledPost } = require('../worker/publishWorker');

const postQueue = new Bull('postQueue', {
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD,
    ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {})
  },
});

postQueue.process(async (job) => {
  const { postId } = job.data;
  await publishScheduledPost(postId);
});

postQueue.on('failed', (job, err) => {
  console.error(`Job failed for post ${job.data.postId}:`, err.message);
});

module.exports = postQueue;
