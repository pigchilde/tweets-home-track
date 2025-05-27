// Tweet structure as expected by the SidePanel
interface RawTweet {
  author: string;
  displayTimestamp: string; // 'YYYY/MM/DD HH:MM:SS'
  content: string;
  rawDatetime: string;      // The ISO string like '2023-10-27T05:23:17.000Z' from <time datetime="...">
}

// Not used directly anymore as ID generation is primarily for SidePanel, 
// but keeping structure for clarity if local ID generation were needed.
// interface TweetWithId extends RawTweet {
//   id: string; 
// }

function formatDisplayTimestamp(dateTimeString: string | null): string {
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

// Utility to generate a simple hash-like ID from key elements of a tweet was removed as it's not strictly needed
// for the current deduplication strategy which happens in SidePanel or via uniqueKey in scrolling.

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
      const rawDatetime = timeElement?.getAttribute('datetime') || new Date().toISOString(); // Fallback to current ISO if missing
      const displayTimestamp = formatDisplayTimestamp(rawDatetime);

      const tweetTextElement = tweetElement.querySelector('[data-testid="tweetText"]');
      const content = tweetTextElement?.textContent?.trim() || 'N/A';

      if (content !== 'N/A' && displayTimestamp !== 'N/A' && displayTimestamp !== 'Invalid Date') {
        currentTweets.push({ author, displayTimestamp, content, rawDatetime });
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
      // Create a unique identifier for the tweet based on its precise rawDatetime and author
      const uniqueKey = `${tweet.author}-${tweet.rawDatetime}`;
      if (!collectedTweetUniqueIdentifiers.has(uniqueKey)) {
        collectedTweets.push(tweet); // Store the RawTweet object
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
        console.log('ContentScript (TwitterScraper): Scraped tweets with scrolling:', tweets.length, "tweets.", tweets);
        chrome.runtime.sendMessage({
          type: 'SCRAPE_COMPLETE_RESPONSE',
          payload: tweets, 
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
