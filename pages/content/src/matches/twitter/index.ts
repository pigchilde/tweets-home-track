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
  let tweetsSkippedAdCount = 0; // 用于调试，记录跳过的广告数量

  // 等待推文容器加载
  await waitForElement('[data-testid="primaryColumn"]');

  // 查找所有推文
  const tweetElements = Array.from(document.querySelectorAll('[data-testid="tweet"]'));
  //const tweetHTMLStrings = tweetElements.map(element => element.outerHTML).join(''); // 如果需要，可以取消注释
  // console.log(tweetHTMLStrings, 'tweetHTMLStrings');

  // 辅助函数：检查某个元素是否在主要推文内容区域内
  const isWithinTweetText = (element: Element, tweetElement: Element): boolean => {
    const tweetTextEl = tweetElement.querySelector('[data-testid="tweetText"]');
    return tweetTextEl ? tweetTextEl.contains(element) : false;
  };

  for (const tweetElement of tweetElements) {
    let isAd = false;

    // --- 广告检测逻辑开始 ---

    // 方法 1: 检查明确的 "Ad" 文本标签 (最可靠)
    // 这个 "Ad" 标签通常是一个独立的 <span>，位于推文头部，而不是在 data-testid="tweetText" 内部。
    const allSpans = tweetElement.querySelectorAll('span');
    for (const span of allSpans) {
      const spanText = span.textContent?.trim();
      if (spanText === 'Ad') {
        // 确认这个 "Ad" 标签不在主要推文内容 [data-testid="tweetText"] 或用户名 [data-testid="User-Name"] 内部
        // (以防有用户名为 "Ad" 或推文内容包含单词 "Ad")
        const userNameEl = tweetElement.querySelector('[data-testid="User-Name"]');
        if (!isWithinTweetText(span, tweetElement) && (!userNameEl || !userNameEl.contains(span))) {
          isAd = true;
          console.log(
            'Filter: Skipped - Explicit "Ad" label found.',
            tweetElement.textContent?.substring(0, 100).trim(),
          );
          break;
        }
      }
    }
    if (isAd) {
      tweetsSkippedAdCount++;
      continue;
    }

    // 方法 2: 检查推广卡片 (Promoted Card) 特征
    const cardWrapper = tweetElement.querySelector('[data-testid="card.wrapper"]');
    if (cardWrapper) {
      // 检查卡片链接是否包含 "twclid" (Twitter Click ID)
      if (cardWrapper.querySelector('a[href*="twclid="]')) {
        isAd = true;
        console.log(
          'Filter: Skipped - Card wrapper with twclid found.',
          tweetElement.textContent?.substring(0, 100).trim(),
        );
      } else {
        // 检查卡片下方是否有 "From [domain.com]" 格式的来源链接文本
        // 通常这个链接是 cardWrapper 父元素的子元素，或者是 cardWrapper 内部的一个链接
        const cardParent = cardWrapper.parentElement;
        const linksToCheck = Array.from(cardWrapper.querySelectorAll('a')); // 检查卡片内部链接
        if (cardParent) {
          linksToCheck.push(...Array.from(cardParent.querySelectorAll('a'))); // 也检查卡片同级或父级附近链接
        }

        for (const link of linksToCheck) {
          if (link.textContent?.startsWith('From ')) {
            // 确保这个链接确实指向外部域
            if (link.href && (link.href.startsWith('http:') || link.href.startsWith('https:'))) {
              // 避免误判内部链接或非域名文本
              const domainText = link.textContent.substring(5).trim(); // "From " 之后的部分
              if (domainText.includes('.')) {
                // 简单判断是否像域名
                isAd = true;
                console.log(
                  'Filter: Skipped - Card with "From domain.com" link found.',
                  tweetElement.textContent?.substring(0, 100).trim(),
                );
                break;
              }
            }
          }
        }
      }
    }
    if (isAd) {
      tweetsSkippedAdCount++;
      continue;
    }

    // 方法 3: 检查 data-testid="placementTracking" (常见于视频广告)
    if (tweetElement.querySelector('[data-testid="placementTracking"]')) {
      isAd = true;
      console.log('Filter: Skipped - placementTracking found.', tweetElement.textContent?.substring(0, 100).trim());
    }
    if (isAd) {
      tweetsSkippedAdCount++;
      continue;
    }

    // 方法 4: 检查 socialContext 中是否包含 "Promoted" (你原来的逻辑，作为补充)
    const socialContextPromoted = tweetElement.querySelector('[data-testid="socialContext"]');
    if (socialContextPromoted && socialContextPromoted.textContent?.toLowerCase().includes('promoted')) {
      isAd = true;
      console.log(
        'Filter: Skipped - socialContext "Promoted" found.',
        tweetElement.textContent?.substring(0, 100).trim(),
      );
    }
    if (isAd) {
      tweetsSkippedAdCount++;
      continue;
    }

    // 方法 5: 检查 aria-label 是否表明是广告 (更通用的检查)
    const ariaLabelAdElements = tweetElement.querySelectorAll('[aria-label]');
    for (const el of ariaLabelAdElements) {
      const labelText = el.getAttribute('aria-label')?.toLowerCase() || '';
      const adTerms = ['ad', 'advertisement', 'promoted', 'sponsored'];
      // 精确匹配或包含特定广告词汇，同时避免误判 (如 "add", "load")
      if (adTerms.some(term => labelText === term || labelText.includes(term + ' '))) {
        if (!isWithinTweetText(el, tweetElement)) {
          // 确保不是推文内容的一部分
          isAd = true;
          console.log(
            `Filter: Skipped - Aria-label "${labelText}" indicating ad found.`,
            tweetElement.textContent?.substring(0, 100).trim(),
          );
          break;
        }
      }
    }
    if (isAd) {
      tweetsSkippedAdCount++;
      continue;
    }

    // --- 广告检测逻辑结束 ---

    try {
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
        const timeText = timeElement?.textContent || '';
        // 你需要确保 parseRelativeTime 函数能够正确处理各种相对时间格式
        // 如果广告没有时间戳，这里可能会出错或返回无效日期，需要额外处理
        try {
          publishTime = parseRelativeTime(timeText); // 确保这个函数存在且健壮
          if (isNaN(publishTime.getTime())) {
            // parseRelativeTime 可能返回 Invalid Date
            console.warn(
              'Could not parse time, defaulting for ID generation:',
              timeText,
              tweetElement.outerHTML.substring(0, 200),
            );
            publishTime = new Date(0); // 或者使用其他默认值
          }
        } catch (timeParseError) {
          console.warn(
            'Error in parseRelativeTime, defaulting for ID generation:',
            timeParseError,
            tweetElement.outerHTML.substring(0, 200),
          );
          publishTime = new Date(0); // 默认时间，避免ID生成失败
        }
      }

      // 生成唯一ID
      // 注意: btoa 对非 ASCII 字符可能会出问题。
      // 如果 author 或 content 包含中文等字符，直接 btoa(encodeURIComponent(...)) 可能不是最佳选择。
      // encodeURIComponent 会产生 %XX 格式，btoa 再次编码它们。
      // 一个更安全的方式是先将字符串转为 UTF-8 字节流，再进行 Base64 编码，或者使用成熟的哈希库。
      // 但为保持与你原代码一致，暂时保留，但请注意潜在问题。
      let idSource = author + content + publishTime.getTime();
      let id = '';
      try {
        // 尝试将字符串转换为UTF-8字节，然后进行Base64编码
        const utf8Encoder = new TextEncoder();
        const utf8Bytes = utf8Encoder.encode(idSource);
        id = btoa(String.fromCharCode(...Array.from(utf8Bytes))) // 将字节转为Latin1字符给btoa
          .replace(/[^a-zA-Z0-9]/g, '')
          .substring(0, 16);
      } catch (e) {
        console.warn('Error generating ID with TextEncoder/btoa, falling back to simpler method:', e);
        // 降级方案（可能在某些包含特殊字符的author/content上仍有问题）
        id = btoa(unescape(encodeURIComponent(idSource))) // 尝试兼容更多字符
          .replace(/[^a-zA-Z0-9]/g, '')
          .substring(0, 16);
      }
      if (!id) {
        // 如果ID仍然为空（不太可能，但作为防护）
        id = `fallback_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      }

      const tweet: TwitterPost = {
        id,
        author,
        content,
        timestamp: formatTimestamp(publishTime), // 确保 formatTimestamp 健壮
        publishTime: publishTime.toISOString(),
      };

      tweets.push(tweet);
    } catch (error) {
      console.error('Error extracting tweet details:', error, tweetElement.outerHTML);
    }
  }
  if (tweetsSkippedAdCount > 0) {
    console.log(`Total ads skipped: ${tweetsSkippedAdCount}`);
  }
  return tweets;
};

// --- 你可能需要实现的辅助函数 (如果尚未定义) ---
// declare function waitForElement(selector: string): Promise<void>;
// declare function parseRelativeTime(timeText: string): Date; // 这个函数对正确性至关重要
// declare function formatTimestamp(date: Date): string;
// interface TwitterPost {
//   id: string;
//   author: string;
//   content: string;
//   timestamp: string;
//   publishTime: string;
// }

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
