import 'webextension-polyfill';
import { exampleThemeStorage } from '@extension/storage';

let refreshIntervalId: NodeJS.Timeout | null = null;
let twitterTabId: number | null = null;
const REFRESH_INTERVAL_MS = 10000; // 10 seconds

exampleThemeStorage.get().then(theme => {
  console.log('Background: Initial theme:', theme);
});

console.log('Background script loaded.');

function stopPeriodicRefresh() {
  if (refreshIntervalId !== null) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
    console.log('Background: Stopped periodic refresh.');
  }
  // twitterTabId is not reset here, as it might still be valid for a manual refresh
  // It will be reset/updated on the next successful scrape initiation
}

function startPeriodicRefresh() {
  stopPeriodicRefresh(); // Clear any existing interval first

  if (twitterTabId === null) {
    console.warn('Background: Cannot start periodic refresh, twitterTabId is not set.');
    return;
  }

  console.log(`Background: Starting periodic refresh for tab ${twitterTabId} every ${REFRESH_INTERVAL_MS}ms.`);
  refreshIntervalId = setInterval(() => {
    if (twitterTabId === null) {
      console.warn('Background: Periodic refresh - twitterTabId is null. Stopping.');
      stopPeriodicRefresh();
      return;
    }
    console.log(`Background: Periodic refresh - Sending EXECUTE_SCRAPE_REQUEST to tab ${twitterTabId}`);
    chrome.tabs.sendMessage(twitterTabId, { type: 'EXECUTE_SCRAPE_REQUEST' }, response => {
      if (chrome.runtime.lastError) {
        console.error(`Background: Periodic refresh - Error sending message to tab ${twitterTabId}:`, chrome.runtime.lastError.message);
        // Check if the error is due to the tab not being available
        if (chrome.runtime.lastError.message?.includes('No tab with id') || chrome.runtime.lastError.message?.includes('cannot be found')) {
          console.log('Background: Periodic refresh - Twitter tab likely closed. Stopping refresh.');
          stopPeriodicRefresh();
          twitterTabId = null; // Invalidate the tab ID
        }
        // Optionally, notify side panel about this error if it's critical
        // chrome.runtime.sendMessage({ type: 'FETCH_TWEETS_ERROR', error: 'Periodic refresh failed: Twitter tab lost.' });
      } else if (response) {
        console.log(`Background: Periodic refresh - Received immediate response from content script on tab ${twitterTabId}:`, response);
      }
    });
  }, REFRESH_INTERVAL_MS);
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background: Received message:', message, 'from sender:', sender);

  if (message.type === 'FETCH_TWEETS_REQUEST') {
    console.log('Background: Received FETCH_TWEETS_REQUEST from side panel. Clearing existing refresh interval.');
    stopPeriodicRefresh(); // Stop any existing refresh due to manual request

    const twitterUrls = ["https://x.com/home", "https://twitter.com/home"];
    chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }, (tabs) => {
      const homeTabs = tabs.filter(tab => tab.url && (tab.url.startsWith(twitterUrls[0]) || tab.url.startsWith(twitterUrls[1])));

      const sendScrapeRequestToTabAndUpdateState = (tabId: number) => {
        console.log(`Background: Sending EXECUTE_SCRAPE_REQUEST to tabId: ${tabId}`);
        twitterTabId = tabId; // Update global twitterTabId
        chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_SCRAPE_REQUEST' }, response => {
          if (chrome.runtime.lastError) {
            console.error(`Background: Error sending EXECUTE_SCRAPE_REQUEST to tab ${tabId}:`, chrome.runtime.lastError.message);
            chrome.runtime.sendMessage({
              type: 'FETCH_TWEETS_ERROR',
              error: `Failed to send scrape request to Twitter tab: ${chrome.runtime.lastError.message}`,
            });
            twitterTabId = null; // Invalidate on error
            stopPeriodicRefresh(); // Ensure refresh stops if initial send fails
          } else if (response) {
            console.log(`Background: Received immediate response from content script on tab ${tabId}:`, response);
          }
        });
      };

      if (homeTabs.length > 0) {
        const targetTab = homeTabs[0];
        if (targetTab.id) {
          if (!targetTab.active) {
            chrome.tabs.update(targetTab.id, { active: true }, (updatedTab) => {
              if (updatedTab && updatedTab.id) {
                sendScrapeRequestToTabAndUpdateState(updatedTab.id);
              } else {
                 console.error(`Background: Failed to activate tab ${targetTab.id}`);
                 chrome.runtime.sendMessage({ type: 'FETCH_TWEETS_ERROR', error: 'Failed to activate existing Twitter tab.'});
                 stopPeriodicRefresh();
              }
            });
          } else {
            sendScrapeRequestToTabAndUpdateState(targetTab.id);
          }
        }
      } else {
        chrome.tabs.create({ url: twitterUrls[0], active: true }, (newTab) => {
          if (newTab && newTab.id) {
            sendScrapeRequestToTabAndUpdateState(newTab.id);
          } else {
            console.error('Background: Failed to create new Twitter tab.');
            chrome.runtime.sendMessage({ type: 'FETCH_TWEETS_ERROR', error: 'Failed to create new Twitter tab.'});
            stopPeriodicRefresh();
          }
        });
      }
    });
    return true;
  }
  else if (message.type === 'SCRAPE_COMPLETE_RESPONSE') {
    console.log('Background: Received SCRAPE_COMPLETE_RESPONSE. Payload size:', message.payload?.length);
    chrome.runtime.sendMessage({ type: 'TWEET_DATA_RESPONSE', payload: message.payload });
    
    // Start or ensure periodic refresh is running, only if a tab is known
    if (twitterTabId !== null) {
        // If an interval is already running for this tabId, setInterval won't create a new one unless previous was cleared.
        // The current logic in startPeriodicRefresh already handles clearing.
        startPeriodicRefresh(); 
    } else {
        console.warn("Background: SCRAPE_COMPLETE_RESPONSE received, but no twitterTabId. Periodic refresh not started/restarted.");
    }
  } 
  else if (message.type === 'SCRAPE_ERROR_RESPONSE') {
    console.error('Background: Received SCRAPE_ERROR_RESPONSE:', message.error);
    chrome.runtime.sendMessage({ type: 'FETCH_TWEETS_ERROR', error: message.error });
    console.log('Background: Stopping periodic refresh due to SCRAPE_ERROR_RESPONSE.');
    stopPeriodicRefresh();
    // twitterTabId = null; // Consider if scrape errors should always invalidate the tab ID
  }
  return false; 
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    console.error("Background: Clicked action on a tab without an ID:", tab);
    return;
  }

  // Optional: Check if you want to restrict side panel opening to specific URLs
  // if (tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
  //   // Open the side panel on the current tab
  // }

  console.log(`Background: Action clicked on tab ${tab.id}. Opening side panel.`);
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.error(`Background: Error opening side panel for tab ${tab.id}:`, error);
  }
});

console.log("Background: Event listeners set up, including chrome.action.onClicked. Edit 'chrome-extension/src/background/index.ts' and save to reload.");
