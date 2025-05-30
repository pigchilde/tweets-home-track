import 'webextension-polyfill';
import { exampleThemeStorage } from '@extension/storage';

exampleThemeStorage.get().then(theme => {
  console.log('theme', theme);
});

// 设置点击插件图标时自动打开侧边栏
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(error => console.error('设置侧边栏行为失败:', error));

// 监听插件图标点击事件，打开侧边栏
chrome.action.onClicked.addListener(async tab => {
  try {
    // 打开侧边栏（使用当前窗口ID）
    await chrome.sidePanel.open({ windowId: tab.windowId });
    console.log('侧边栏已打开');
  } catch (error) {
    console.error('打开侧边栏失败:', error);
  }
});

// 处理来自content script和side panel的消息
chrome.runtime.onMessage.addListener((message, sender) => {
  console.log('Background received message:', message, 'from:', sender);

  if (message.type === 'TWEETS_UPDATED') {
    // 转发消息到side panel
    chrome.runtime.sendMessage(message).catch(error => {
      console.log('No side panel to receive message:', error);
    });
  }

  return false; // 同步响应
});

console.log('Background loaded');
console.log('Twitter监控背景脚本已加载');
