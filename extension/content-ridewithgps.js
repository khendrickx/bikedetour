/**
 * content-ridewithgps.js — Content Script for RideWithGPS
 * Injected into ridewithgps.com/routes/* at document_start.
 *
 * Responsibilities:
 *  1. Inject RideWithGPSAdapter.js + injected-ridewithgps.js into the page context.
 *  2. Bridge data requests from injected-ridewithgps.js → background service worker.
 *  3. Forward toggle commands from the popup → injected-ridewithgps.js.
 */

(function () {
  'use strict';

  const FROM_PAGE    = 'rw-from-page';
  const FROM_CONTENT = 'rw-from-content';

  // ── 1. Inject page-context scripts ────────────────────────────────────────
  function injectScript(path, next) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(path);
    script.addEventListener('load', () => { script.remove(); if (next) next(); });
    (document.head || document.documentElement).appendChild(script);
  }

  injectScript('adapters/RideWithGPSAdapter.js', () => injectScript('injected-ridewithgps.js'));

  // ── 2. Bridge: page → background ─────────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__rw !== FROM_PAGE) return;

    if (e.data.type === 'RW_READY') {
      chrome.storage.local.get(['overlayEnabled', 'showLimitedAccess'], ({ overlayEnabled, showLimitedAccess }) => {
        window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE',         enabled: overlayEnabled    !== false }, '*');
        window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE_LIMITED', enabled: showLimitedAccess !== false }, '*');
      });
    }

    if (e.data.type === 'RW_FETCH') {
      chrome.runtime.sendMessage(
        { type: 'FETCH_ROADWORKS', bbox: e.data.bbox },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[BikeDetour]', chrome.runtime.lastError.message);
            return;
          }
          if (response && response.success) {
            window.postMessage({
              __rw: FROM_CONTENT,
              type: 'RW_DATA',
              data: response.data,
            }, '*');
          }
        }
      );
    }
  });

  // ── 3. Bridge: popup → page ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TOGGLE') {
      window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE',         enabled: message.enabled }, '*');
    }
    if (message.type === 'TOGGLE_LIMITED') {
      window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE_LIMITED', enabled: message.enabled }, '*');
    }
  });

})();
