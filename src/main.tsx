import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { theme } from './theme/muiTheme';
import App from './App';
import './index.css';
import './theme/pdart-tokens.css';        // P-DART CSS vars + base reset (skill: pdart-theme)
import './theme/pdart-components.css';     // .pdart-* component classes

// There is NO backend: install the in-browser data layer (src/mock) BEFORE the first render so every /api call the
// pages make is answered locally from the dummy dataset.
import('./mock/install').then((m) => m.installMock()).then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
));
