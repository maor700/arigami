import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { UiProvider } from './components/ui/direction.jsx';
import { startStore } from './lib/store.js';
import { installViewportTracking } from './lib/viewport.js';
import '@fontsource-variable/inter/index.css'; // Latin UI face — self-hosted
import '@fontsource-variable/rubik/index.css'; // Latin + Hebrew (variable) — self-hosted
import './index.css';

// `#/styleguide` — the living ui/ style guide (see components/StyleGuide.jsx). It
// is its own root: no host connection, no login. Switching between it and the
// app reloads, so the app's store/effects never run underneath the guide.
const STYLEGUIDE = /^#\/styleguide/.test(window.location.hash);
window.addEventListener('hashchange', () => {
  if (/^#\/styleguide/.test(window.location.hash) !== STYLEGUIDE) window.location.reload();
});

if (!STYLEGUIDE) {
  startStore();
  installViewportTracking();
}

const Root = STYLEGUIDE ? React.lazy(() => import('./components/StyleGuide.jsx')) : App;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <UiProvider>
      <React.Suspense fallback={null}>
        <Root />
      </React.Suspense>
    </UiProvider>
  </React.StrictMode>,
);
