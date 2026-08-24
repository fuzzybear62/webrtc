import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // VideoRTC extends HTMLElement, so the class declaration needs an HTMLElement
    // global at import time. jsdom provides it. We never construct the element —
    // the tests call VideoRTC.prototype.play via .call() with a fake `this`.
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
  },
});
