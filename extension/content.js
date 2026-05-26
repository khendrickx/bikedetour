/**
 * content.js — Content Script
 * Injected into every komoot.com page at document_start.
 *
 * Responsibilities:
 *  1. Inject injected.js into the page context so it can access window.mapboxgl.
 *  2. Bridge data requests from injected.js → background service worker.
 *  3. Forward toggle commands from the popup → injected.js.
 */

(function () {
  'use strict';

  const FROM_PAGE    = 'rw-from-page';
  const FROM_CONTENT = 'rw-from-content';

  // ── 1. Inject page-context script ────────────────────────────────────────
  // Must happen as early as possible (document_start) so the patch is in place
  // before Komoot's bundle assigns window.mapboxgl.

  function injectPageScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    // Remove the tag after execution to keep the DOM clean
    script.addEventListener('load', () => script.remove());
    // documentElement (<html>) always exists at document_start
    (document.head || document.documentElement).appendChild(script);
  }

  injectPageScript();

  // ── 2. Bridge: page → background ─────────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__rw !== FROM_PAGE) return;

    if (e.data.type === 'RW_FETCH') {
      chrome.runtime.sendMessage(
        { type: 'FETCH_ROADWORKS', bbox: e.data.bbox },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[RoadWorks Content]', chrome.runtime.lastError.message);
            return;
          }
          if (response && response.success) {
            window.postMessage({
              __rw:       FROM_CONTENT,
              type:       'RW_DATA',
              hindrances: response.data.hindrances,
              brussels:   response.data.brussels,
              ndw:        response.data.ndw,
              diversions: response.data.diversions,
            }, '*');
          }
        }
      );
    }
  });

  // ── 3. Bridge: popup → page ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TOGGLE') {
      window.postMessage({
        __rw:    FROM_CONTENT,
        type:    'RW_TOGGLE',
        enabled: message.enabled,
      }, '*');
    }
    if (message.type === 'TOGGLE_LIMITED') {
      window.postMessage({
        __rw:    FROM_CONTENT,
        type:    'RW_TOGGLE_LIMITED',
        enabled: message.enabled,
      }, '*');
    }
  });

  // Apply persisted toggle state on page load
  chrome.storage.local.get(['overlayEnabled', 'showLimitedAccess'], ({ overlayEnabled, showLimitedAccess }) => {
    window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE',         enabled: overlayEnabled    !== false }, '*');
    window.postMessage({ __rw: FROM_CONTENT, type: 'RW_TOGGLE_LIMITED', enabled: showLimitedAccess !== false }, '*');
  });
})();
