/*
 * Runs before the first paint, from <head>, so the page is never drawn in the
 * wrong theme and then repainted. It is a separate file rather than an inline
 * script because the console is served under script-src 'self'.
 *
 * The stored preference is 'light', 'dark' or 'system'. 'system' and anything
 * unreadable fall back to prefers-color-scheme. The application reads the same
 * key in src/theme/ThemeProvider.jsx; keep the two in step.
 */
(function () {
  var STORAGE_KEY = 'neronet.theme';
  var DENSITY_KEY = 'neronet.density';
  var root = document.documentElement;

  function stored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      // Private mode, or storage disabled by policy. The defaults still apply.
      return null;
    }
  }

  var preference = stored(STORAGE_KEY) || 'system';
  var resolved = preference;
  if (preference !== 'light' && preference !== 'dark') {
    resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', resolved);

  var density = stored(DENSITY_KEY);
  root.setAttribute('data-density', density === 'compact' ? 'compact' : 'comfortable');

  var lang = stored('neronet.language');
  if (lang === 'it' || lang === 'en') {
    root.setAttribute('lang', lang);
  }
})();
