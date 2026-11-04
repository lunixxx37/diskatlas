// Runs before the first paint: applies a stored light/dark choice so the page never
// flashes in the wrong theme, and sets <html lang> to the interface language.
// Same storage keys as src/ui/theme.ts (THEME_STORAGE_KEY) and src/ui/i18n (LANG_STORAGE_KEY);
// the language rule is the one in detectLanguage(): a stored choice, else the first
// English or German entry of the browser's languages, else English.
(function () {
  var root = document.documentElement;
  var lang = null;
  try {
    var choice = localStorage.getItem('diskatlas:theme');
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    lang = localStorage.getItem('diskatlas:lang');
  } catch (e) {
    // Storage blocked: follow the system setting and the browser's languages.
  }
  if (lang !== 'en' && lang !== 'de') {
    lang = 'en';
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (var k = 0; k < list.length; k++) {
      var primary = String(list[k]).toLowerCase().split(/[-_]/)[0];
      if (primary === 'en' || primary === 'de') {
        lang = primary;
        break;
      }
    }
  }
  root.setAttribute('lang', lang);
})();
