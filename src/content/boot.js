// Isolated-world entry point. Loads content.js as an ES module so it can
// import the shared scripts that the MAIN world already received.
import(chrome.runtime.getURL('src/content/content.js'));
