const express = require('express');
const router = express.Router();
const Post = require('../models/Posts');
const axios = require('axios');
const { ChromaClient } = require('chromadb');
const Tokenizer = require('sentence-tokenizer');
require('dotenv').config();

const chromaClient = new ChromaClient({ path: "http://localhost:8000" });
const BERONY_POST_COLLECTION = 'BERONY_POST_V2';
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 50;
const embeddingCache = new Map();

// Middleware for query validation
const validateSearchQuery = (req, res, next) => {
  if (!req.body.query || req.body.query.trim().length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }
  next();
};

// Improved chunking with sentence preservation
function splitTextIntoSentenceChunks(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const tokenizer = new Tokenizer('temp');
  tokenizer.setEntry(text);
  const sentences = tokenizer.getSentences();
  
  
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  for (const sentence of sentences) {
    const sentenceLength = sentence.length;

    if (currentLength + sentenceLength > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));
      
      // Apply overlap by keeping last N characters
      currentChunk = currentChunk.slice(-Math.floor(overlap / (chunkSize / currentChunk.length)));
      currentLength = currentChunk.join(' ').length;
    }

    currentChunk.push(sentence);
    currentLength += sentenceLength;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }

  return chunks;
}

// Enhanced embedding generation with metadata boosting
async function generateEmbeddingText(post, contentChunk) {
  return `
    Title: ${post.title} [10x]
    Tags: ${post.tags.join(' ')} [5x]
    Content: ${contentChunk}
  `;
}

async function generateVectorEmbeddings(text) {
  const cacheKey = text.substring(0, 200);
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  try {
    const response = await axios.post(
      "https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2",
      { inputs: text },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    const embedding = response.data[0];
    embeddingCache.set(cacheKey, embedding);
    return embedding;
  } catch (error) {
    console.error("Embedding generation error:", error);
    throw new Error('Failed to generate embeddings');
  }
}

// Improved ingestion with metadata handling
async function ingestPosts() {
  try {
    const posts = await Post.find({});
    const collection = await chromaClient.getOrCreateCollection({
      name: BERONY_POST_COLLECTION,
      metadata: { "hnsw:space": "cosine" }
    });

    for (const post of posts) {
      const content = `${post.bodyofcontent}\n${post.endnotecontent || ''}`;
      const chunks = splitTextIntoSentenceChunks(content);

      for (const [index, chunk] of chunks.entries()) {
        const embeddingText = await generateEmbeddingText(post, chunk);
        const embedding = await generateVectorEmbeddings(embeddingText);
        const chunkId = `${post._id.toString()}-${index}`;

        await collection.upsert({
          ids: [chunkId],
          documents: [chunk],
          embeddings: [embedding],
          metadatas: [{
            postId: post._id.toString(),
            title: post.title,
            tags: post.tags.join(', '),
            username: post.username,
            createdAt: post.createdAt,
            scoreBoost: post.pageviews / 100 
          }]
        });
      }
      console.log(`Ingested post: ${post.title} (${chunks.length} chunks)`);
    }
    return posts.length;
  } catch (error) {
    console.error("Ingestion error:", error);
    throw error;
  }
}

async function searchPosts(query) {
  try {
    const queryEmbedding = await generateVectorEmbeddings(query);
    const collection = await chromaClient.getOrCreateCollection({
      name: BERONY_POST_COLLECTION,
      metadata: { "hnsw:space": "cosine" }
    });

    const results = await collection.query({
      nResults: 15,
      queryEmbeddings: [queryEmbedding],
      include: ['metadatas', 'documents', 'distances']
    });

    // Group chunks by post and calculate weighted scores
    const postScores = new Map();
    
    results.ids[0].forEach((id, index) => {
      const metadata = results.metadatas[0][index];
      const postId = metadata.postId;
      const baseScore = results.distances[0][index];
      const boostedScore = baseScore * (0.9 + (metadata.scoreBoost || 0));

      if (!postScores.has(postId)) {
        postScores.set(postId, {
          score: boostedScore,
          chunks: [results.documents[0][index]],
          metadata: metadata
        });
      } else {
        const existing = postScores.get(postId);
        existing.score = Math.min(existing.score, boostedScore);
        existing.chunks.push(results.documents[0][index]);
      }
    });

    // Sort and format results
    return Array.from(postScores.entries())
      .sort((a, b) => a[1].score - b[1].score)
      .slice(0, 10)
      .map(([postId, data]) => ({
        postId,
        score: data.score,
        title: data.metadata.title,
        tags: data.metadata.tags.split(', '),
        chunks: data.chunks,
        username: data.metadata.username,
        createdAt: data.metadata.createdAt
      }));
  } catch (error) {
    console.error("Search error:", error);
    throw error;
  }
}

// API Endpoints
router.post('/ingest', async (req, res) => {
  try {
    const count = await ingestPosts();
    res.json({ 
      message: `Successfully ingested ${count} posts`,
      collection: BERONY_POST_COLLECTION
    });
  } catch (error) {
    res.status(500).json({ error: 'Ingestion failed', details: error.message });
  }
});

router.post('/search', validateSearchQuery , async (req, res) => {
  try {
    const searchResults = await searchPosts(req.body.query);
    const postIds = searchResults.map(r => r.postId);
    
    // Fetch full posts from MongoDB
    const posts = await Post.find({ _id: { $in: postIds } });
    
    // Merge search scores with post data
    const enhancedResults = searchResults.map(result => {
      const post = posts.find(p => p._id.toString() === result.postId);
      return {
        ...result,
        post: {
          title: post.title,
          imageUrl: post.imageUrl,
          pageviews: post.pageviews,
          createdAt: post.createdAt,
          username: post.username,
          tags: post.tags
        },
        excerpts: result.chunks
          .slice(0, 3)
          .map(chunk => chunk.substring(0, 150) + '...')
      };
    });

    res.json({ results: enhancedResults });
  } catch (error) {
    res.status(500).json({ 
      error: 'Search failed',
      details: error.message
    });
  }
});

router.delete('/delcollection', async (req, res) => {
  try {
    await chromaClient.deleteCollection({ name: BERONY_POST_COLLECTION });
    res.json({ 
      message: 'Collection deleted',
      collection: BERONY_POST_COLLECTION
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Deletion failed',
      details: error.message
    });
  }
});


router.get('/collections', async (req, res) => {
  try {
    const collections = await chromaClient.listCollections();
    res.json({ collections });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;