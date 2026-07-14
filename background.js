'use strict';
(() => {
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') {
      chrome.storage.sync.set({ enabled: true });
    }
  });

  // Update badge on extension icon from content script messages
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'ANALYSIS_RESULT' && sender.tab?.id) {
      const tabId = sender.tab.id;
      const score = msg.score ?? 0;
      const color = score >= 80 ? '#4ade80' : score >= 60 ? '#4f8ef7' : score >= 40 ? '#fbbf24' : '#f87171';
      chrome.action.setBadgeText({ tabId, text: String(score) });
      chrome.action.setBadgeBackgroundColor({ tabId, color });
    }
  });
})();
