require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const archiver = require('archiver');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { buildPrompt } = require('./prompt');


/*
Frontend / CURL → POST /generate
     |
     v
Gemini API --> code
     |
     v
write files (index.html, main.tsx, vite.config.js, etc)
     |
     v
npm install
     |
     v
npx vite (serve at :5173)
     

*/



const app = express();
app.use(cors());
app.use(express.json());

const GENERATED_DIR = path.join(__dirname, 'generated-site');
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;
let viteProcess = null;

const generationCache = new Map();
const RATE_LIMIT_WINDOW = 1000; 
let lastRequestTime = 0;

const fileRegex = /<file name="(.+?)">([\s\S]*?)<\/file>/g;


/*
  I am returning the promises here so that asyncily i can check whether teh port is available or not 

*/
async function generateContentWithRetry(prompt, retries = 3, delay = 2000) {
  if (!genAI) throw new Error('Gemini AI not configured');
  
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      });
      return result.response.candidates[0].content.parts[0].text;
    } catch (err) {
      if (err.status === 503 && attempt < retries - 1) {
        console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; 
        continue;
      }
      throw err;
    }
  }
}


/*
Fall back for if not getting response or like having rate limiting 
*/
function getFallbackTodoApp() {
  return `
  <file name="index.html">
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Todo App</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
      #app { border: 1px solid #ddd; padding: 20px; border-radius: 8px; }
      input, button { padding: 8px; margin-right: 10px; }
      ul { list-style: none; padding: 0; }
      li { padding: 8px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; }
      .delete-btn { color: red; cursor: pointer; }
    </style>
  </head>
  <body>
    <div id="app">
      <h1>Todo App</h1>
      <div>
        <input type="text" id="new-todo" placeholder="Add new todo">
        <button id="add-btn">Add</button>
      </div>
      <ul id="todo-list"></ul>
    </div>
    <script src="app.js"></script>
  </body>
  </html>
  </file>
  <file name="app.js">
  let todos = JSON.parse(localStorage.getItem('todos')) || [];
  
  function renderTodos() {
    const list = document.getElementById('todo-list');
    list.innerHTML = todos.map((todo, index) => \`
      <li>
        <span>\${todo}</span>
        <span class="delete-btn" data-index="\${index}">×</span>
      </li>
    \`).join('');
    
    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        todos.splice(e.target.dataset.index, 1);
        saveTodos();
        renderTodos();
      });
    });
  }
  
  function saveTodos() {
    localStorage.setItem('todos', JSON.stringify(todos));
  }
  
  document.getElementById('add-btn').addEventListener('click', () => {
    const input = document.getElementById('new-todo');
    if (input.value.trim()) {
      todos.push(input.value.trim());
      input.value = '';
      saveTodos();
      renderTodos();
    }
  });
  
  document.getElementById('new-todo').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('add-btn').click();
    }
  });
  
  renderTodos();
  </file>
  <file name="package.json">
  {
    "name": "todo-app",
    "private": true,
    "version": "1.0.0",
    "scripts": {
      "dev": "vite",
      "build": "vite build"
    },
    "dependencies": {
      "vite": "^5.0.0"
    }
  }
  </file>
  <file name="vite.config.js">
  import { defineConfig } from 'vite';
  export default defineConfig({
    server: {
      host: true,
      port: 5173
    }
  });
  </file>
  `;
}

async function parseAndWriteFiles(content) {
  let match;
  fileRegex.lastIndex = 0;
  
  while ((match = fileRegex.exec(content)) !== null) {
    const [, fileName, fileContent] = match;
    const filePath = path.join(GENERATED_DIR, fileName);
    await fs.mkdirp(path.dirname(filePath));
    await fs.writeFile(filePath, fileContent.trim());
    console.log(`Created file: ${fileName}`);
  }
}

function startViteServer() {
  if (viteProcess) {
    viteProcess.kill('SIGTERM');
  }


  /*
    Very simple fn where I am starting vite server here 
    In this code I running teh vite server in background mode on port 5173 

  */

  viteProcess = exec(
    `cd ${GENERATED_DIR} && npm install && npx vite --host 0.0.0.0 --port 5173`,
    { 
      stdio: 'inherit',
      shell: '/bin/bash',
      detached: true
    }
  );

  viteProcess.on('exit', (code) => {
    console.log(`Vite process exited with code ${code}`);
  });
}

// Rate limiting middleware
app.use((req, res, next) => {
  const now = Date.now();
  if (now - lastRequestTime < RATE_LIMIT_WINDOW) {
    return res.status(429).json({ error: "Too many requests, please wait" });
  }
  lastRequestTime = now;
  next();
});

app.post('/generate', async (req, res) => {
  const { prompt } = req.body;
  const cacheKey = JSON.stringify(prompt);
  
  try {
    // Check cache first
    if (generationCache.has(cacheKey)) {
      return res.json({ 
        success: true, 
        cached: true,
        previewUrl: 'http://localhost:5173'
      });
    }

    console.log('Processing request for:', prompt);
    
    // Generate or use fallback
    let generatedContent;
    try {
      generatedContent = await generateContentWithRetry(buildPrompt(prompt));
    } catch (err) {
      console.error('Generation failed, using fallback:', err.message);
      generatedContent = getFallbackTodoApp();
    }

    // Process files
    await fs.remove(GENERATED_DIR);
    await fs.mkdirp(GENERATED_DIR);
    await parseAndWriteFiles(generatedContent);
    

    startViteServer();
    
    
    generationCache.set(cacheKey, true);
    
    res.json({ 
      success: true,
      previewUrl: 'http://localhost:5173',
      usedFallback: generatedContent === getFallbackTodoApp()
    });
    
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ 
      error: 'Server error',
      details: err.message
    });
  }
});

app.get('/download-zip', async (req, res) => {
  try {
    const files = await fs.readdir(GENERATED_DIR);
    if (files.length === 0) throw new Error('No files to download');

    const zipPath = path.join(__dirname, 'site.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      res.download(zipPath, 'todo-app.zip', () => fs.unlinkSync(zipPath));
    });

    archive.pipe(output);
    archive.directory(GENERATED_DIR, false);
    await archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheSize: generationCache.size,
    geminiAvailable: !!genAI,
    lastRequest: new Date(lastRequestTime).toISOString()
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log(`POST /generate - Generate todo app`);
  console.log(`GET /download-zip - Download generated app`);
  console.log(`GET /health - Server health check`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  if (viteProcess) viteProcess.kill();
  process.exit(0);
});