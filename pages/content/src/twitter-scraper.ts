// Tweet structure as expected by the SidePanel (RawTweet type)
interface RawTweet {
  author: string;
  timestamp: string; // 'YYYY/MM/DD HH:MM:SS'
  content: string;
}

// For internal use in content script to add an ID for deduplication during scraping
interface TweetWithId extends RawTweet {
  id: string; 
}

function formatTimestamp(dateTimeString: string | null): string {
  if (!dateTimeString) {
    return 'N/A';
  }
  try {
    const date = new Date(dateTimeString);
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    console.error('Error formatting timestamp:', error, dateTimeString);
    return 'Invalid Date';
  }
}

// Utility to generate a simple hash-like ID from key elements of a tweet
// This is similar to the one in SidePanel.tsx but used here for local deduplication
function generateTweetIdForContentScript(tweet: RawTweet): string {
  const keyString = `${tweet.timestamp}-${tweet.author}-${tweet.content.substring(0, 50)}`;
  let hash = 0;
  for (let i = 0; i < keyString.length; i++) {
    const char = keyString.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return `cs-tweet-${Math.abs(hash).toString(16)}`;
}


function scrapeCurrentViewPortTweets(): RawTweet[] {
  const tweetElements = document.querySelectorAll('article[data-testid="tweet"]');
  const currentTweets: RawTweet[] = [];

  tweetElements.forEach(tweetElement => {
    try {
      // Ad detection: Check for "Promoted" text within the tweet article.
      // This is a common pattern but might need adjustment if Twitter changes its DOM.
      // Looking for a span that says "Promoted" or "Ad"
      const socialContextElement = tweetElement.querySelector('[data-testid="socialContext"]');
      if (socialContextElement && (socialContextElement.textContent?.includes('Promoted') || socialContextElement.textContent?.includes('Ad'))) {
        console.log('ContentScript: Filtered out a promoted tweet.');
        return; // Skip this tweet
      }
      // Another way to check for ads, sometimes they have a specific element or text.
      // This is highly dependent on Twitter's current DOM structure.
      const promotedTextElements = Array.from(tweetElement.querySelectorAll('span'));
      const isPromoted = promotedTextElements.some(span => span.textContent === 'Promoted' || span.textContent === 'Ad');
      if (isPromoted) {
          console.log('ContentScript: Filtered out a promoted tweet based on span content.');
          return; // Skip this tweet
      }


      const authorNameElement = tweetElement.querySelector('[data-testid="User-Name"]');
      const authorName = authorNameElement?.textContent?.trim() || 'N/A';

      let authorHandle = 'N/A';
      const userLinks = tweetElement.querySelectorAll('a[href^="/"]');
      userLinks.forEach(link => {
        const textContent = link.textContent;
        if (textContent && textContent.startsWith('@') && link.href.includes(textContent.substring(1))) {
            // Check if the link's href also somewhat matches the handle to be more specific
             const potentialHandleParent = link.closest('div[data-testid="User-Name"]');
             if(potentialHandleParent){ // Ensure handle is part of the user name block
                authorHandle = textContent.trim();
             }
        }
      });
      
      const author = `${authorName} (${authorHandle})`;

      const timeElement = tweetElement.querySelector('time');
      const rawTimestamp = timeElement?.getAttribute('datetime');
      const timestamp = formatTimestamp(rawTimestamp || null);

      const tweetTextElement = tweetElement.querySelector('[data-testid="tweetText"]');
      const content = tweetTextElement?.textContent?.trim() || 'N/A';

      if (content !== 'N/A' && timestamp !== 'N/A' && timestamp !== 'Invalid Date') {
        currentTweets.push({ author, timestamp, content });
      }
    } catch (error) {
      console.error('Error scraping individual tweet in current view:', error, tweetElement);
    }
  });
  return currentTweets;
}

async function scrapeTweetsWithScrolling(): Promise<RawTweet[]> {
  const collectedTweets: RawTweet[] = [];
  const collectedTweetUniqueIdentifiers = new Set<string>(); // Used to track unique tweets

  const minTweetsToCollect = 20;
  const maxScrollAttempts = 10; // Max number of times to scroll
  const scrollDelayMs = 2000; // Wait 2 seconds for content to load after scroll

  let scrollAttempts = 0;

  console.log(`ContentScript: Starting scroll and scrape. Target: ${minTweetsToCollect} tweets or ${maxScrollAttempts} scrolls.`);

  while (collectedTweets.length < minTweetsToCollect && scrollAttempts < maxScrollAttempts) {
    console.log(`ContentScript: Scroll attempt #${scrollAttempts + 1}. Collected ${collectedTweets.length} unique tweets so far.`);
    const newTweetsInView = scrapeCurrentViewPortTweets();
    let foundNewTweetsInThisScroll = false;

    newTweetsInView.forEach(tweet => {
      // Create a unique identifier for the tweet based on its content to avoid duplicates
      // Using author + timestamp + first 100 chars of content as a pseudo-key
      const uniqueKey = `${tweet.author}-${tweet.timestamp}-${tweet.content.substring(0, 100)}`;
      if (!collectedTweetUniqueIdentifiers.has(uniqueKey)) {
        collectedTweets.push(tweet);
        collectedTweetUniqueIdentifiers.add(uniqueKey);
        foundNewTweetsInThisScroll = true;
      }
    });
    
    scrollAttempts++;

    if (collectedTweets.length >= minTweetsToCollect && scrollAttempts > 0) { // Ensure at least one scroll if aiming for updates
        console.log(`ContentScript: Reached target of ${minTweetsToCollect} tweets or more. Collected ${collectedTweets.length}.`);
        break; 
    }
    
    if (!foundNewTweetsInThisScroll && scrollAttempts > 1) { // If no new tweets after a couple of scrolls, assume end of new content
        console.log("ContentScript: No new unique tweets found in this scroll, and already scrolled. Stopping.");
        break;
    }

    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(resolve => setTimeout(resolve, scrollDelayMs));
  }

  console.log(`ContentScript: Finished scraping. Collected ${collectedTweets.length} tweets after ${scrollAttempts} scrolls.`);
  return collectedTweets; // These are RawTweet objects, SidePanel will add its own IDs
}


console.log('Twitter Scraper Loaded. Ready to receive messages.');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('ContentScript (TwitterScraper): Received message:', message, 'from sender:', sender);

  if (message.type === 'EXECUTE_SCRAPE_REQUEST') {
    console.log('ContentScript (TwitterScraper): Received EXECUTE_SCRAPE_REQUEST. Starting scrape with scrolling...');
    
    scrapeTweetsWithScrolling().then(tweets => {
      if (tweets.length > 0) {
        console.log('ContentScript (TwitterScraper): Scraped tweets with scrolling:', tweets.length, "tweets");
        chrome.runtime.sendMessage({
          type: 'SCRAPE_COMPLETE_RESPONSE',
          payload: tweets, // Sending RawTweet[]
        });
      } else {
        console.log('ContentScript (TwitterScraper): No tweets found on the page after scrolling.');
        chrome.runtime.sendMessage({
          type: 'SCRAPE_COMPLETE_RESPONSE',
          payload: [], 
        });
      }
    }).catch(error => {
      console.error('ContentScript (TwitterScraper): Error during scrapeTweetsWithScrolling:', error);
      chrome.runtime.sendMessage({
        type: 'SCRAPE_ERROR_RESPONSE',
        error: error instanceof Error ? error.message : String(error),
      });
    });
    
    return true; // Indicate that sendResponse will be called asynchronously
  }
  return false; // For other message types or if not handling
});

// Commenting out the direct call, as scraping will now be triggered by a message.
// console.log('Twitter Scraper Loaded');
// setTimeout(() => {
//   const scrapedData = scrapeTweets();
//   if (scrapedData.length > 0) {
//     console.log('Scraped Tweets:', scrapedData);
//   } else {
//     console.log('No tweets found on the page or scraper needs adjustment.');
//   }
// }, 5000); // Delay to allow page content to load
