import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { AxiosError } from 'axios';

const App: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<'idle' | 'generating' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');

  const checkViteReady = async () => {
    try {
      const response = await axios.get('http://localhost:5173', {
        timeout: 2000,
        validateStatus: () => true
      });
      return response.status < 500;
    } catch {
      return false;
    }
  };

// ... existing imports ...

const handleGenerate = async () => {
  setStatus('generating');
  setError('');
  
  try {
    const response = await axios.post('http://localhost:5000/generate', { prompt });
    
    // Start polling for Vite
    const startTime = Date.now();
    const MAX_WAIT = 30000; // 30 seconds max
    let viteReady = false;

    while (Date.now() - startTime < MAX_WAIT && !viteReady) {
      viteReady = await checkViteReady();
      if (viteReady) {
        setPreviewUrl('http://localhost:5173');
        setStatus('ready');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Fallback to express static server
    setPreviewUrl('http://localhost:5000/preview-fallback');
    setStatus('ready');
    
  } catch (error) {
    setStatus('error');
    
    // Type-safe error handling
    if (axios.isAxiosError(error)) {
      setError(error.response?.data?.details || 'Generation failed');
    } else if (error instanceof Error) {
      setError(error.message);
    } else {
      setError('An unknown error occurred');
    }
    
    console.error(error);
  }
};

  const handleDownload = () => {
    window.open('http://localhost:5000/download-zip', '_blank');
  };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <h1>Website Generator</h1>
      
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the website you want to generate..."
        rows={5}
        style={{ width: '100%', marginBottom: '10px' }}
      />
      
      <div style={{ marginBottom: '20px' }}>
        <button 
          onClick={handleGenerate}
          disabled={status === 'generating'}
        >
          {status === 'generating' ? 'Generating...' : 'Generate'}
        </button>
        
        <button
          onClick={handleDownload}
          style={{ marginLeft: '10px' }}
          disabled={status !== 'ready'}
        >
          Download ZIP
        </button>
      </div>

      {status === 'error' && (
        <div style={{ color: 'red', marginBottom: '20px' }}>
          Error: {error}
        </div>
      )}

      {status === 'ready' && previewUrl && (
        <>
          <h2>Preview ({previewUrl.includes('5173') ? 'Vite' : 'Fallback'})</h2>
          <iframe
            src={previewUrl}
            title="Preview"
            style={{
              width: '100%',
              height: '500px',
              border: '1px solid #ccc',
              borderRadius: '4px'
            }}
          />
        </>
      )}
    </div>
  );
};

export default App;