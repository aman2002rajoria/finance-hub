// Server-safe: no React imports, so app/layout.tsx (a server component) can use it.
/** Inline script for <head>: sets data-theme before React hydrates (no flash). */
// `?theme=light|dark|system` in the URL also sets the choice (handy for links and screenshots).
export const THEME_BOOT_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get("theme");if(q==="light"||q==="dark"||q==="system")localStorage.setItem("fh-theme",q);var c=localStorage.getItem("fh-theme")||"system";var d=c==="dark"||(c==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light");}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;
