import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { startStore } from './lib/store.js';
import { installViewportTracking } from './lib/viewport.js';
import '@fontsource-variable/rubik/index.css'; // Latin + Hebrew (variable) — self-hosted
import './index.css';

startStore();
installViewportTracking();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
