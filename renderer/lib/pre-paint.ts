/**
 * Pre-paint constants. Deliberately NOT a 'use client' module: app/layout.tsx is a server component,
 * and importing a value from a client module hands it a client *reference* instead of the string,
 * which made hydration wait on a lazily loaded chunk and intermittently fail with React error #418.
 */
export const THEME_KEY = 'clipfern.theme';
export const SIDEBAR_KEY = 'clipfern.sidebar';

/** Runs synchronously in <head>. Keep it tiny, dependency free and exception safe. */
export const PRE_PAINT_SCRIPT = `(function(){var d=document.documentElement;try{
var t=localStorage.getItem('${THEME_KEY}');if(t!=='light'&&t!=='dark'&&t!=='system')t='system';
var dark=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
d.dataset.theme=dark?'dark':'light';d.dataset.themePref=t;
if(localStorage.getItem('${SIDEBAR_KEY}')==='collapsed')d.dataset.sidebar='collapsed';
}catch(e){d.dataset.theme='dark';d.dataset.themePref='system'}
try{if(window.clipfern&&window.clipfern.platform)d.dataset.platform=window.clipfern.platform}catch(e){}
})();`;
