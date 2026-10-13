function injectExistingTabs() {
  try {
    chrome.tabs.query(
      { url: ['https://*.tiktok.com/*', 'https://*.tiktokglobalshop.com/*'] },
      (tabs) => {
        if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
        for (const tab of tabs) {
          if (tab && tab.id) {
            chrome.scripting
              .executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
              })
              .catch(() => {});
          }
        }
      }
    );
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(injectExistingTabs);
chrome.runtime.onStartup.addListener(injectExistingTabs);
injectExistingTabs();
