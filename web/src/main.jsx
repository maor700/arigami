import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { startStore } from './lib/store.js';
import './index.css';

startStore();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
