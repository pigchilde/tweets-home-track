import '@src/SidePanel.css';
import { t } from '@extension/i18n';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn, ErrorDisplay, LoadingSpinner, ToggleButton } from '@extension/ui';
import { useEffect, useState } from 'react';

// 1. Define Tweet Data Structure
interface Tweet {
  id: string; 
  author: string;
  content: string;
  timestamp: string; // ISO format for sorting, derived from rawDatetime
  displayTimestamp: string; // 'YYYY/MM/DD HH:MM:SS'
  rawDatetime: string; // Raw datetime string from tweet <time> element
}

// Updated RawTweet structure from content script
interface RawTweet {
  author: string;
  content: string;
  displayTimestamp: string; // The 'YYYY/MM/DD HH:MM:SS' version
  rawDatetime: string;      // The ISO string like '2023-10-27T05:23:17.000Z'
}

const STORED_TWEETS_KEY = 'storedTweets';
const LAST_FETCH_TIMESTAMP_KEY = 'lastFetchTimestamp'; // Stores ISO timestamp of the newest tweet from last fetch

const SidePanel = () => {
  const { isLight } = useStorage(exampleThemeStorage);
  const [displayedTweets, setDisplayedTweets] = useState<Tweet[]>([]);
  const [notificationMessage, setNotificationMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);


  // Utility to generate a precise ID from author and rawDatetime
  const generateTweetId = (rawTweet: RawTweet): string => {
    return `${rawTweet.author}-${rawTweet.rawDatetime}`;
  };
  
  // Utility to ensure rawDatetime is a valid ISO string for sorting, or convert if necessary.
  // rawDatetime from content script should already be ISO. This function primarily validates/passes it through.
  const getSortableTimestamp = (rawDatetime: string): string => {
    try {
      // Check if it's already a valid ISO string by parsing it
      const date = new Date(rawDatetime);
      if (isNaN(date.getTime())) {
        // This case should ideally not happen if content script sends valid ISO
        console.warn("Invalid rawDatetime received, using current time as fallback:", rawDatetime);
        return new Date().toISOString();
      }
      return date.toISOString(); // Return it as is, or re-format to ensure consistency
    } catch (e) {
      console.error("Error processing rawDatetime for sorting:", rawDatetime, e);
      return new Date().toISOString(); // Fallback
    }
  };


  const loadTweetsFromStorage = async () => {
    chrome.storage.local.get([STORED_TWEETS_KEY, LAST_FETCH_TIMESTAMP_KEY], (result) => {
      if (chrome.runtime.lastError) {
        console.error("Error loading tweets from storage:", chrome.runtime.lastError);
        setErrorMessage(t('errorFailedToLoadStoredTweets'));
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
        setErrorMessage(t('errorFailedToSaveNewTweets'));
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
          author: rawTweet.author,
          content: rawTweet.content,
          displayTimestamp: rawTweet.displayTimestamp,
          rawDatetime: rawTweet.rawDatetime,
          id: generateTweetId(rawTweet), // ID based on author and rawDatetime
          timestamp: getSortableTimestamp(rawTweet.rawDatetime), // ISO string for sorting
        }));

        setDisplayedTweets(prevTweets => {
          const existingTweetIds = new Set(prevTweets.map(t => t.id));
          const trulyNewTweets = transformedNewTweets.filter(t => !existingTweetIds.has(t.id));
          
          if (trulyNewTweets.length === 0) {
            setNotificationMessage(t('notificationNoNewTweets'));
            return prevTweets; // No change if no new unique tweets
          }
          
          setNotificationMessage(t('notificationFetchedNewTweets', { count: trulyNewTweets.length }));

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
        setErrorMessage(message.error || t('errorUnknownFetching'));
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
          <h1 className="text-lg font-semibold">{t('sidePanelHeader')}</h1>
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
              {isLoading ? t('refreshButtonLoading') : t('refreshButtonIdle')}
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
          <p className="font-medium">{t('errorPrefix')}</p>
          <p className="text-xs">{errorMessage}</p>
        </div>
      )}

      <main className="flex-grow overflow-y-auto custom-scrollbar">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-full">
            <LoadingSpinner size={32} />
            <p className={cn("mt-3 text-base", isLight ? 'text-gray-600' : 'text-gray-300')}>{t('loadingTweets')}</p>
          </div>
        ) : displayedTweets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className={cn("text-base", isLight ? 'text-gray-600' : 'text-gray-400')}>
              {t('noTweetsToDisplay')}
            </p>
            <p className={cn("text-xs mt-1", isLight ? 'text-gray-500' : 'text-gray-500')}>
              {t('noTweetsHelperText')}
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
