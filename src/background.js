// Service worker. Its only job: close the tab when the user ends a session
// from the mindful-pause screen (content scripts cannot close tabs).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'calm:close-tab' && sender.tab && sender.tab.id !== undefined) {
    chrome.tabs.remove(sender.tab.id);
  }
});
