const express = require('express');
const router = express.Router();
const Draft = require('../models/Drafts');

// Create a draft
router.post('/drafts', async (req, res) => {
  const newDraft = new Draft(req.body);
  await newDraft.save();
  res.json(newDraft);
});

// Get all drafts
router.get('/drafts', async (req, res) => {
  const drafts = await Draft.find();
  res.json(drafts);
});

// Delete a draft by id
router.delete('/drafts/:id', async (req, res) => {
  await Draft.findByIdAndDelete(req.params.id);
  res.json({ message: 'Draft deleted' });
});

module.exports = router;
