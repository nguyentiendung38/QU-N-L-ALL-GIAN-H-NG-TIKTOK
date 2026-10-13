function injectIntoTab(tabId) {
  if (!tabId) return;
  try {
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['content.js']
      })
      .catch(() => {});
  } catch (_) {}
}

function injectExistingTabs() {
  try {
    chrome.tabs.query(
      { url: ['https://*.tiktok.com/*', 'https://*.tiktokglobalshop.com/*'] },
      (tabs) => {
        if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
        for (const tab of tabs) {
          if (tab && tab.id) {
            injectIntoTab(tab.id);
          }
        }
      }
    );
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(() => {
  injectExistingTabs();
  setTimeout(injectExistingTabs, 1500);
  setTimeout(injectExistingTabs, 4000);
});

chrome.runtime.onStartup.addListener(() => {
  injectExistingTabs();
  setTimeout(injectExistingTabs, 1500);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === 'complete' &&
    tab &&
    tab.url &&
    (tab.url.includes('.tiktok.com/') || tab.url.includes('.tiktokglobalshop.com/'))
  ) {
    injectIntoTab(tabId);
  }
});

injectExistingTabs();
setTimeout(injectExistingTabs, 1500);
