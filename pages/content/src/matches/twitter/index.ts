import { twitterStorage, type TwitterPost } from '@extension/storage';

console.log('Twitter content script loaded');

// 等待页面加载完成
const waitForPageLoad = (): Promise<void> => {
  return new Promise(resolve => {
    if (document.readyState === 'complete') {
      resolve();
    } else {
      window.addEventListener('load', () => resolve());
    }
  });
};

// 等待元素出现
const waitForElement = (selector: string, timeout = 10000): Promise<Element | null> => {
  return new Promise(resolve => {
    const element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }

    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
};

// 格式化时间为 年/月/日 时:分:秒
const formatTimestamp = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
};

// 解析相对时间（如"2h", "5m", "1d"）为具体时间
const parseRelativeTime = (timeText: string): Date => {
  const now = new Date();
  const match = timeText.match(/(\d+)([smhd])/);

  if (!match) return now;

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case 's':
      return new Date(now.getTime() - value * 1000);
    case 'm':
      return new Date(now.getTime() - value * 60 * 1000);
    case 'h':
      return new Date(now.getTime() - value * 60 * 60 * 1000);
    case 'd':
      return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    default:
      return now;
  }
};

// 提取推文数据
const extractTweets = async (): Promise<TwitterPost[]> => {
  const tweets: TwitterPost[] = [];

  // 等待推文容器加载
  await waitForElement('[data-testid="primaryColumn"]');

  // 查找所有推文
  const tweetElements = Array.from(document.querySelectorAll('[data-testid="tweet"]'));

  for (const tweetElement of tweetElements) {
    try {
      // 检查是否是广告
      const promotedLabel = tweetElement.querySelector('[data-testid="socialContext"]');
      if (promotedLabel && promotedLabel.textContent?.includes('Promoted')) {
        continue; // 跳过广告推文
      }

      // 获取作者名称
      const authorElement = tweetElement.querySelector('[data-testid="User-Name"] span');
      const author = authorElement?.textContent || 'Unknown';

      // 获取推文内容
      const contentElement = tweetElement.querySelector('[data-testid="tweetText"]');
      const content = contentElement?.textContent || '';

      // 获取时间
      const timeElement = tweetElement.querySelector('time');
      const dateTimeAttr = timeElement?.getAttribute('datetime');
      let publishTime: Date;

      if (dateTimeAttr) {
        publishTime = new Date(dateTimeAttr);
      } else {
        // 尝试从显示的相对时间解析
        const timeText = timeElement?.textContent || '';
        publishTime = parseRelativeTime(timeText);
      }

      // 生成唯一ID（基于内容和作者的哈希）
      const id = btoa(encodeURIComponent(author + content + publishTime.getTime()))
        .replace(/[^a-zA-Z0-9]/g, '')
        .substring(0, 16);

      const tweet: TwitterPost = {
        id,
        author,
        content,
        timestamp: formatTimestamp(publishTime),
        publishTime: publishTime.toISOString(),
      };

      tweets.push(tweet);
    } catch (error) {
      console.error('Error extracting tweet:', error);
    }
  }

  return tweets;
};

// 主要的推文监控函数
const monitorTwitter = async () => {
  try {
    // 等待页面完全加载
    await waitForPageLoad();
    await new Promise(resolve => setTimeout(resolve, 3000)); // 额外等待3秒确保内容加载

    // 检查是否在正确的页面
    if (!window.location.href.includes('x.com/home')) {
      return;
    }

    console.log('开始抓取Twitter推文...');
    const newTweets = await extractTweets();

    if (newTweets.length > 0) {
      const storage = await twitterStorage.get();
      const isFirstTime = storage.isFirstTime;

      let tweetsToSave: TwitterPost[];

      if (isFirstTime) {
        // 首次抓取，保存最新的20条
        tweetsToSave = newTweets.slice(0, 20);
      } else {
        // 非首次抓取，只保存新的推文
        const latestTimestamp = await twitterStorage.getLatestTimestamp();
        if (latestTimestamp) {
          tweetsToSave = newTweets.filter(tweet => new Date(tweet.publishTime) > latestTimestamp);
        } else {
          tweetsToSave = newTweets.slice(0, 20);
        }
      }

      if (tweetsToSave.length > 0) {
        await twitterStorage.addPosts(tweetsToSave);

        // 发送消息到侧边栏
        chrome.runtime.sendMessage({
          type: 'TWEETS_UPDATED',
          count: tweetsToSave.length,
          isFirstTime,
        });

        console.log(`成功抓取 ${tweetsToSave.length} 条推文`);
      } else {
        console.log('没有发现新推文');
      }
    }
  } catch (error) {
    console.error('抓取推文时出错:', error);
  }
};

// 监听来自侧边栏的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_TWITTER_MONITORING') {
    monitorTwitter();
    sendResponse({ success: true });
  }
});

// 如果已经在Twitter首页，自动开始监控
if (window.location.href.includes('x.com/home')) {
  // 延迟启动，确保页面完全加载
  setTimeout(monitorTwitter, 5000);
}
