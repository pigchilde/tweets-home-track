import '@src/SidePanel.css';
import { t } from '@extension/i18n';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn, ErrorDisplay, LoadingSpinner, ToggleButton } from '@extension/ui';
import { useEffect, useState } from 'react';

// 1. Define Tweet Data Structure
interface Tweet {
  id: string; // Unique ID, derived from timestamp + author + part of content
  author: string;
  content: string;
  timestamp: string; // ISO format for sorting
  displayTimestamp: string; // 'YYYY/MM/DD HH:MM:SS'
}

// Raw tweet structure from content script (assuming it provides author, content, and a parsable/sortable timestamp)
interface RawTweet {
  author: string;
  content: string;
  timestamp: string; // This is the 'YYYY/MM/DD HH:MM:SS' from content script
}

const STORED_TWEETS_KEY = 'storedTweets';
const LAST_FETCH_TIMESTAMP_KEY = 'lastFetchTimestamp'; // Stores ISO timestamp of the newest tweet from last fetch

const SidePanel = () => {
  const { isLight } = useStorage(exampleThemeStorage);
  const [displayedTweets, setDisplayedTweets] = useState<Tweet[]>([]);
  const [notificationMessage, setNotificationMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);


  // Utility to generate a simple hash-like ID
  const generateTweetId = (rawTweet: RawTweet): string => {
    // Simple ID from key elements to help with deduplication
    const keyString = `${rawTweet.timestamp}-${rawTweet.author}-${rawTweet.content.substring(0, 50)}`;
    // Basic hash function (not cryptographically secure, just for uniqueness)
    let hash = 0;
    for (let i = 0; i < keyString.length; i++) {
      const char = keyString.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return `tweet-${Math.abs(hash).toString(16)}`;
  };
  
  // Utility to convert 'YYYY/MM/DD HH:MM:SS' to ISO string
  const convertDisplayTimestampToISO = (displayTimestamp: string): string => {
    try {
      const parts = displayTimestamp.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (parts) {
        return new Date(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}`).toISOString();
      }
      // Fallback for unexpected format, or if it's already somewhat parsable
      const date = new Date(displayTimestamp.replace(/\//g, '-'));
      return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
    } catch (e) {
      console.warn("Error converting display timestamp to ISO:", displayTimestamp, e);
      return new Date().toISOString(); // Fallback
    }
  };


  const loadTweetsFromStorage = async () => {
    chrome.storage.local.get([STORED_TWEETS_KEY, LAST_FETCH_TIMESTAMP_KEY], (result) => {
      if (chrome.runtime.lastError) {
        console.error("Error loading tweets from storage:", chrome.runtime.lastError);
        setErrorMessage("Failed to load stored tweets.");
        setIsLoading(false);
        return;
      }
      const stored = result[STORED_TWEETS_KEY];
      if (stored && Array.isArray(stored)) {
        setDisplayedTweets(stored);
      }
      // lastFetchTimestamp is also loaded but primarily used during merge, not directly displayed
      setIsLoading(false);
    });
  };

  const saveTweetsToStorage = (tweets: Tweet[], newLastFetchTimestamp?: string) => {
    const dataToSave: { [key: string]: any } = { [STORED_TWEETS_KEY]: tweets };
    if (newLastFetchTimestamp) {
      dataToSave[LAST_FETCH_TIMESTAMP_KEY] = newLastFetchTimestamp;
    }
    chrome.storage.local.set(dataToSave, () => {
      if (chrome.runtime.lastError) {
        console.error("Error saving tweets to storage:", chrome.runtime.lastError);
        setErrorMessage("Failed to save new tweets.");
      } else {
        console.log("Tweets and last fetch timestamp saved to storage.");
      }
    });
  };

  const requestTweets = () => {
    console.log('SidePanel: Sending FETCH_TWEETS_REQUEST to background script');
    setIsLoading(true); // Set loading true immediately
    setNotificationMessage(''); 
    setErrorMessage(''); 
    chrome.runtime.sendMessage({ type: 'FETCH_TWEETS_REQUEST' });
  };

  useEffect(() => {
    // Initial setup for Twitter tab (copied from previous step)
    const twitterUrl = 'https://x.com/home';
    chrome.tabs.query({ url: twitterUrl }, (tabs) => {
      if (tabs.length > 0) {
        const twitterTab = tabs[0];
        if (twitterTab.id && !twitterTab.active) {
          chrome.tabs.update(twitterTab.id, { active: true });
        }
      } else {
        chrome.tabs.create({ url: twitterUrl });
      }
    });
    
    loadTweetsFromStorage();
    requestTweets(); // Fetch new tweets on load

    const messageListener = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
      console.log('SidePanel: Received message:', message, 'from', sender);
      if (message.type === 'TWEET_DATA_RESPONSE') {
        setIsLoading(false);
        const newlyFetchedRawTweets: RawTweet[] = message.payload;
        
        const transformedNewTweets: Tweet[] = newlyFetchedRawTweets.map(rawTweet => ({
          ...rawTweet,
          id: generateTweetId(rawTweet),
          timestamp: convertDisplayTimestampToISO(rawTweet.timestamp),
          displayTimestamp: rawTweet.timestamp, // Keep original for display
        }));

        setDisplayedTweets(prevTweets => {
          const existingTweetIds = new Set(prevTweets.map(t => t.id));
          const trulyNewTweets = transformedNewTweets.filter(t => !existingTweetIds.has(t.id));
          
          if (trulyNewTweets.length === 0) {
            setNotificationMessage('No new tweets found.');
            return prevTweets; // No change if no new unique tweets
          }
          
          setNotificationMessage(`Fetched ${trulyNewTweets.length} new tweet(s).`);

          const combinedTweets = [...prevTweets, ...trulyNewTweets];
          combinedTweets.sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // Newest first
          
          const updatedTweetsForDisplayAndStorage = combinedTweets.slice(0, 20);
          
          const newLastFetchTimestamp = updatedTweetsForDisplayAndStorage.length > 0 
            ? updatedTweetsForDisplayAndStorage[0].timestamp 
            : undefined;

          saveTweetsToStorage(updatedTweetsForDisplayAndStorage, newLastFetchTimestamp);
          return updatedTweetsForDisplayAndStorage;
        });

      } else if (message.type === 'FETCH_TWEETS_ERROR') {
        setIsLoading(false);
        console.error('SidePanel: Error fetching tweets:', message.error);
        setErrorMessage(message.error || "An unknown error occurred while fetching tweets.");
        setNotificationMessage('');
      }
      return false; // Indicate that the response channel will not be used
    };

    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  return (
    <div className={cn('flex flex-col h-screen p-4', isLight ? 'bg-slate-50 text-gray-900' : 'bg-gray-800 text-gray-100', 'text-sm')}>
      <header className={cn('pb-3 mb-3 border-b', isLight ? 'border-gray-300' : 'border-gray-600')}>
        <div className="flex justify-between items-center">
          <h1 className="text-lg font-semibold">Twitter Feed</h1>
          <div className="flex items-center space-x-2">
            <button 
              onClick={requestTweets} 
              disabled={isLoading}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded focus:outline-none focus:ring-2 focus:ring-offset-2",
                isLoading 
                  ? (isLight ? 'bg-gray-300 text-gray-500' : 'bg-gray-600 text-gray-400') 
                  : (isLight ? 'bg-blue-500 hover:bg-blue-600 text-white focus:ring-blue-400' : 'bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500')
              )}
            >
              {isLoading ? 'Refreshing...' : 'Refresh'}
            </button>
            <ToggleButton onClick={exampleThemeStorage.toggle} size="sm">{t('toggleTheme')}</ToggleButton>
          </div>
        </div>
      </header>

      {notificationMessage && (
        <div className={cn("p-2 my-2 text-xs rounded-md", isLight ? "bg-green-50 text-green-700 border border-green-200" : "bg-green-700 bg-opacity-30 text-green-200 border border-green-500")}>
          {notificationMessage}
        </div>
      )}
      {errorMessage && (
        <div className={cn("p-3 my-2 text-sm rounded-md border", isLight ? "bg-red-50 text-red-700 border-red-300" : "bg-red-800 bg-opacity-30 text-red-200 border-red-600")}>
          <p className="font-medium">Error:</p>
          <p className="text-xs">{errorMessage}</p>
        </div>
      )}

      <main className="flex-grow overflow-y-auto custom-scrollbar">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-full">
            <LoadingSpinner size={32} />
            <p className={cn("mt-3 text-base", isLight ? 'text-gray-600' : 'text-gray-300')}>Loading tweets...</p>
          </div>
        ) : displayedTweets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className={cn("text-base", isLight ? 'text-gray-600' : 'text-gray-400')}>
              No tweets to display.
            </p>
            <p className={cn("text-xs mt-1", isLight ? 'text-gray-500' : 'text-gray-500')}>
              Click 'Refresh' to fetch tweets or check your Twitter feed.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {displayedTweets.map(tweet => (
              <article 
                key={tweet.id} 
                className={cn(
                  'p-3 rounded-lg shadow-sm border', 
                  isLight ? 'bg-white border-gray-200 hover:shadow-md' : 'bg-gray-700 border-gray-600 hover:bg-gray-650'
                )}
              >
                <div className="flex justify-between items-start mb-1.5">
                  <span className={cn('font-semibold text-sm break-words', isLight ? 'text-blue-600' : 'text-blue-400')}>{tweet.author}</span>
                  <time dateTime={tweet.timestamp} className={cn('text-xs whitespace-nowrap ml-2', isLight ? 'text-gray-500' : 'text-gray-400')}>
                    {tweet.displayTimestamp}
                  </time>
                </div>
                <p className={cn('text-sm break-words whitespace-pre-wrap', isLight ? 'text-gray-800' : 'text-gray-200')}>
                  {tweet.content}
                </p>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
