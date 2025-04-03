const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = 3001;

app.use(express.json());

app.get('/fetch-berony-posts', async (req, res) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const response = await page.goto('https://berony-server.onrender.com/api/posts', { waitUntil: 'networkidle' });
    const rawText = await response.text(); // Get raw response text

    console.log('Raw response:', rawText.substring(0, 200)); // Log first 200 chars for debugging

    let jsonData;
    try {
      jsonData = JSON.parse(rawText); // Attempt to parse as JSON
    } catch (parseError) {
      await browser.close();
      return res.status(500).json({ success: false, error: 'Response is not JSON: ' + rawText.substring(0, 100) });
    }

    const formattedPosts = jsonData.map(post => ({
      title: post.title || 'Untitled',
      body: post.bodyofcontent || post.content || '',
      tags: post.tags || [],
      username: post.username || 'Unknown',
      createdAt: post.createdAt || ''
    }));

    await browser.close();
    res.json({ success: true, content: formattedPosts });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`MCP Server running on http://localhost:${PORT}`);
});