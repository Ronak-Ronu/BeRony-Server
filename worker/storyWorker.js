const Bull = require('bull');
const Story = require('../models/Story');
const cloudinary = require('../cloudinaryconfig');

const storyQueue = new Bull('story-queue', {
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD
  }
});

storyQueue.process(async (job) => {
  const { storyId, publicId, resourceType } = job.data;
  try {
    // Delete story from MongoDB
    await Story.findByIdAndDelete(storyId);

    // Delete file from Cloudinary
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    console.log(`Story ${storyId} deleted from MongoDB and Cloudinary`);
  } catch (error) {
    console.error(`Failed to delete story ${storyId}:`, error);
    throw error; // Retry the job if it fails
  }
});

console.log('Story worker started');
module.exports = storyQueue;