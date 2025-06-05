const pollQueue = require('../queues/pollqueue');
const Poll = require('../models/Poll');

pollQueue.process(async (job) => {
  const { pollId } = job.data;

  try {
    const result = await Poll.findByIdAndDelete(pollId);
    if (result) {
      console.log(`Poll with ID ${pollId} deleted successfully.`);
    } else {
      console.log(`Poll with ID ${pollId} not found.`);
    }
  } catch (error) {
    console.error(`Error deleting poll with ID ${pollId}:`, error);
    throw error;
  }
});

// Handle queue errors
pollQueue.on('error', (error) => {
  console.error('Poll queue error:', error);
});