/* popup.js */

(function () {
  const toggle        = document.getElementById('toggleOverlay');
  const limitedToggle = document.getElementById('toggleLimited');
  const status        = document.getElementById('status');

  // ── Load persisted state ──────────────────────────────────────────────────

  chrome.storage.local.get(['overlayEnabled', 'showLimitedAccess'], ({ overlayEnabled, showLimitedAccess }) => {
    toggle.checked        = overlayEnabled    !== false; // default: enabled
    limitedToggle.checked = showLimitedAccess !== false; // default: enabled
  });

  // Show last-updated time from any cached tile
  chrome.storage.local.get(null, (items) => {
    const timestamps = Object.entries(items)
      .filter(([k]) => k.startsWith('rw_cache_'))
      .map(([, v]) => v.fetchedAt)
      .filter(Boolean);

    if (timestamps.length === 0) {
      status.textContent = 'No data loaded yet';
      return;
    }

    const latest = Math.max(...timestamps);
    const diffMin = Math.round((Date.now() - latest) / 60_000);
    status.textContent = diffMin < 1
      ? 'Updated just now'
      : `Updated ${diffMin} min ago`;
  });

  // ── Toggle handler ────────────────────────────────────────────────────────

  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    chrome.storage.local.set({ overlayEnabled: enabled });

    // Notify the active Komoot tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled });
      }
    });
  });

  limitedToggle.addEventListener('change', () => {
    const enabled = limitedToggle.checked;
    chrome.storage.local.set({ showLimitedAccess: enabled });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_LIMITED', enabled });
      }
    });
  });
})();
