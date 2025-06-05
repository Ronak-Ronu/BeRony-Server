const Bull = require('bull');
const Redis = require('ioredis');

const redisConnection = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || null,
});

const pollQueue = new Bull('poll-deletion-queue', {
  createClient: (type) => {
    switch (type) {
      case 'client':
        return redisConnection;
      case 'subscriber':
        return redisConnection.duplicate();
      default:
        return redisConnection;
    }
  },
});

module.exports = pollQueue;