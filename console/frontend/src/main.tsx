import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { initI18n } from './i18n';
import { ThemeProvider } from './theme/ThemeProvider';
import { ToastProvider } from './ui/Toast';
import { TooltipProvider } from './ui/Tooltip';
import './index.css';

initI18n();

const container = document.getElementById('root');
if (!container) {
  throw new Error('The document has no #root element to mount the console into');
}
const root = ReactDOM.createRoot(container);

function mount(children: React.ReactNode) {
  root.render(
    <React.StrictMode>
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
}

/*
 * The primitive gallery is a development tool, not a page of the product. The
 * condition is statically false in a production build, so the import below is
 * removed with it and the gallery never reaches a bundle an operator loads.
 */
if (import.meta.env.DEV && window.location.pathname === '/__design') {
  const { DesignGallery } = await import('./design/DesignGallery.jsx');
  mount(<DesignGallery />);
} else {
  mount(<App />);
}
