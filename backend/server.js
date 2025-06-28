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


require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const archiver = require('archiver');
const genAI = require('@google/generative-ai');
const { buildPrompt } = require('./prompt');
const net = require('net');

const app = express();
app.use(cors());
app.use(express.json());

const GENERATED_DIR = path.join(__dirname, 'generated-site');
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const ai = GEMINI_KEY ? new genAI.GoogleGenerativeAI(GEMINI_KEY) : null;
let viteProcess = null;

const fileRegex = /<file name="(.+?)">([\s\S]*?)<\/file>/g;

/*
  I am returning the promises here so that asyncily i can check whether teh port is available or not 

*/
async function isPortTaken(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => {
        tester.once('close', () => resolve(false)).close();
      })
      .listen(port);
  });
}

//This is the fn which parses and generates Files in generated-site dir which is mention abvoe 

async function parseAndWriteFiles(content) {
  console.log('Parsing generated content...');
  let fileCount = 0;
  fileRegex.lastIndex = 0;
  let match;

  //matches files and generates them
  while ((match = fileRegex.exec(content)) !== null) {
    const [, fileName, fileContent] = match;
    const filePath = path.join(GENERATED_DIR, fileName);
    
    try {
      await fs.mkdirp(path.dirname(filePath));
      await fs.writeFile(filePath, fileContent.trim());
      console.log(`✓ Created ${fileName}`);
      fileCount++;
    } catch (err) {
      console.error(`✗ Failed to create ${fileName}:`, err.message);
    }
  }

  if (fileCount === 0) {
    console.warn('No files found in response. Creating default files...');
    await createFallbackFiles();
  }
}


//If not get any repsonse from gemini then show this default file 

async function createFallbackFiles() {
  const defaultFiles = {
    'vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { \n    host: true, \n    port: 5173,\n    strictPort: true\n  }\n});`,
    'package.json': JSON.stringify({
      name: "fallback-app",
      private: true,
      type: "module",
      scripts: { dev: "vite" },
      dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
      devDependencies: { 
        "@vitejs/plugin-react": "^4.2.1",
        "vite": "^5.0.0"
      }
    }, null, 2),
    'index.html': `<!DOCTYPE html>\n<html>\n<head>\n  <title>Fallback</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.tsx"></script>\n</body>\n</html>`
  };

  for (const [fileName, content] of Object.entries(defaultFiles)) {
    await fs.writeFile(path.join(GENERATED_DIR, fileName), content);
  }
}

async function installDependencies() {
  return new Promise((resolve) => {
    console.log("Installing dependencies...");
    
    //  installing production deps
    // and then then keeping timeout of 2 minutes if not done in that second tehn we will get error 
    //so this neand our dependencies could not be installed 
    const installProcess = exec(
      `cd ${GENERATED_DIR} && npm install --production && npm install vite @vitejs/plugin-react`,
      { 
        stdio: 'inherit',
        timeout: 120000 
      },
      (err) => {
        if (err) {
          console.error('Install failed');
          resolve(false);
        } else {
          console.log('Install succeeded');
          resolve(true);
        }
      }
    );
  });
}

function startViteServer() {
  if (viteProcess) {
    viteProcess.kill('SIGTERM');
  }

  /*
    Very simple fn where I am starting vite server here 
    In this code I running teh vite server in background mode on port 5173 

  */
  console.log("Starting Vite server...");
  viteProcess = exec(
    `cd ${GENERATED_DIR} && npx vite --host 0.0.0.0 --port 5173`,
    { 
      stdio: 'inherit',
      shell: '/bin/bash',
      detached: true
    }
  );

  viteProcess.stdout.on('data', (data) => {
    console.log(`Vite: ${data}`);
  });

  viteProcess.stderr.on('data', (data) => {
    console.error(`Vite error: ${data}`);
  });

  viteProcess.on('exit', (code) => {
    console.log(`Vite process exited with code ${code}`);
  });
}

app.post('/generate', async (req, res) => {
  const { prompt } = req.body;
  console.log('\n=== NEW GENERATION REQUEST ===\nPrompt:', prompt);

  try {
    // Generate content and then overengineering the prompt to get perfect result 

    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: buildPrompt(prompt) }] }] });
    const responseText = result.response.candidates[0].content.parts[0].text;

    // Process files
    await fs.remove(GENERATED_DIR);
    await fs.mkdirp(GENERATED_DIR);
    await parseAndWriteFiles(responseText);

    
    const installed = await installDependencies();
    if (!installed) throw new Error('Dependency installation failed');

    // Start Vite server
    if (!await isPortTaken(5173)) {
      startViteServer();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    res.json({ 
      success: true,
      previewUrl: 'http://localhost:5173',
      note: 'Vite server is starting... please wait 5-10 seconds'
    });
  } catch (err) {
    console.error('Generation failed:', err);
    res.status(500).json({ 
      error: 'Generation failed',
      details: err.message
    });
  }
});

app.use('/preview-fallback', express.static(GENERATED_DIR));

app.get('/download-zip', async (req, res) => {
  try {
    const files = await fs.readdir(GENERATED_DIR);
    if (files.length === 0) throw new Error('No files to download');

    const zipPath = path.join(__dirname, 'site.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => res.download(zipPath, () => fs.unlinkSync(zipPath)));
    archive.on('error', err => { throw err; });
    archive.pipe(output);
    archive.directory(GENERATED_DIR, false);
    await archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(5000, () => {
  console.log('Backend running on http://localhost:5000');
  console.log('=== REGISTERED ROUTES ===');
  console.log('POST /generate');
  console.log('GET  /download-zip');
  console.log('GET  /preview-fallback/*');
});

//Fn for handling if somehing error happens 
process.on('uncaughtException', err => console.error('❌ Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled Rejection:', err));