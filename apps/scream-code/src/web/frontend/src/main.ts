import { createApp } from 'vue';
import App from './App.vue';
import './styles/tokens.css';
import './styles/variables.css';
import './styles/main.css';

/* Global ripple: spawn an expanding ink circle on pointerdown for any
 * enabled button or [role="button"]. Purely additive — no component changes
 * required. Styling lives in main.css (.ripple-host / .ripple-ink). */
function installRipple() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (reduced.matches || e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      const host = target?.closest('button:not(:disabled), [role="button"]');
      if (!(host instanceof HTMLElement)) return;

      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const size = Math.max(rect.width, rect.height) * 2;

      const ink = document.createElement('span');
      ink.className = 'ripple-ink';
      ink.style.width = ink.style.height = `${size}px`;
      ink.style.left = `${e.clientX - rect.left - size / 2}px`;
      ink.style.top = `${e.clientY - rect.top - size / 2}px`;

      host.classList.add('ripple-host');
      host.append(ink);
      ink.addEventListener('animationend', () => ink.remove(), { once: true });
    },
    { passive: true },
  );
}

installRipple();
createApp(App).mount('#app');
