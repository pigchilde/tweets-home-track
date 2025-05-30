import '@src/SidePanel.css';
//import { t } from '@extension/i18n';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage, twitterStorage, type TwitterPost } from '@extension/storage';
import { cn, ErrorDisplay, LoadingSpinner, ToggleButton } from '@extension/ui';
import { useState, useEffect, useRef } from 'react';

// 定义消息类型
interface TwitterMessage {
  type: 'TWEETS_UPDATED';
  count: number;
  isFirstTime?: boolean; // 可选属性
}

const SidePanel = () => {
  const { isLight } = useStorage(exampleThemeStorage);
  const twitterData = useStorage(twitterStorage);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [status, setStatus] = useState<string>('未开始监控');
  const [newTweetsCount, setNewTweetsCount] = useState<number>(0);

  const monitoringInterval = useRef<NodeJS.Timeout | null>(null);

  // 监听来自content script的消息
  useEffect(() => {
    const messageListener = (message: TwitterMessage) => {
      if (message.type === 'TWEETS_UPDATED') {
        setNewTweetsCount(prev => prev + message.count);
        setStatus(`成功抓取 ${message.count} 条${message.isFirstTime ? '初始' : '新'}推文`);

        // 显示通知3秒后清除
        setTimeout(() => {
          setNewTweetsCount(0);
        }, 3000);
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, []);

  // 开始监控Twitter
  const startMonitoring = async () => {
    try {
      setStatus('正在打开Twitter主页...');
      setIsMonitoring(true);

      // 打开Twitter主页
      const tab = await chrome.tabs.create({ url: 'https://x.com/home' });

      if (tab.id) {
        // 等待页面加载完成
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 发送消息给content script开始监控
        await chrome.tabs.sendMessage(tab.id, { type: 'START_TWITTER_MONITORING' });

        setStatus('正在监控Twitter推文...');

        // 设置定时器，每10秒刷新一次页面
        monitoringInterval.current = setInterval(async () => {
          if (tab.id) {
            try {
              await chrome.tabs.reload(tab.id);
              await new Promise(resolve => setTimeout(resolve, 3000));
              await chrome.tabs.sendMessage(tab.id, { type: 'START_TWITTER_MONITORING' });
            } catch (error) {
              console.error('监控过程中出错:', error);
            }
          }
        }, 10000);

        // 监听标签页关闭事件
        const tabRemovedListener = (tabId: number) => {
          if (tabId === tab.id) {
            if (monitoringInterval.current) {
              // 检查 .current 是否有值
              clearInterval(monitoringInterval.current);
              monitoringInterval.current = null; // 清除后将 .current 重置为 null
            }
            setIsMonitoring(false);
            setStatus('监控已停止');
            chrome.tabs.onRemoved.removeListener(tabRemovedListener);
          }
        };

        chrome.tabs.onRemoved.addListener(tabRemovedListener);
      }
    } catch (error) {
      console.error('启动监控失败:', error);
      setStatus('启动监控失败');
      setIsMonitoring(false);
    }
  };

  // 停止监控
  const stopMonitoring = () => {
    if (monitoringInterval.current) {
      // Check if the interval exists
      clearInterval(monitoringInterval.current);
      monitoringInterval.current = null; // Reset the ref
    }
    setIsMonitoring(false);
    setStatus('监控已停止');
  };

  // 清除所有数据
  const clearData = async () => {
    await twitterStorage.reset();
    setStatus('数据已清除');
  };

  // 格式化时间显示
  const formatTimeAgo = (timestamp: string) => {
    const now = new Date();
    const tweetTime = new Date(timestamp.replace(/\//g, '-').replace(' ', 'T'));
    const diffMs = now.getTime() - tweetTime.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    return `${diffDays}天前`;
  };

  return (
    <div className={cn('App min-h-screen', isLight ? 'bg-slate-50' : 'bg-gray-800')}>
      <header
        className={cn('border-b p-4', isLight ? 'border-gray-200 text-gray-900' : 'border-gray-700 text-gray-100')}>
        <h1 className="mb-4 text-xl font-bold">个人推文监控</h1>

        {/* 控制按钮 */}
        <div className="mb-4 flex gap-2">
          {!isMonitoring ? (
            <button
              onClick={startMonitoring}
              className="rounded bg-blue-500 px-4 py-2 text-white transition-colors hover:bg-blue-600">
              开始监控
            </button>
          ) : (
            <button
              onClick={stopMonitoring}
              className="rounded bg-red-500 px-4 py-2 text-white transition-colors hover:bg-red-600">
              停止监控
            </button>
          )}

          <button
            onClick={clearData}
            className="rounded bg-gray-500 px-4 py-2 text-white transition-colors hover:bg-gray-600">
            清除数据
          </button>

          <ToggleButton onClick={exampleThemeStorage.toggle}>{isLight ? '🌙' : '☀️'}</ToggleButton>
        </div>

        {/* 状态显示 */}
        <div className={cn('text-sm', isLight ? 'text-gray-600' : 'text-gray-400')}>状态: {status}</div>

        {/* 新推文通知 */}
        {newTweetsCount > 0 && (
          <div className="mt-2 rounded bg-green-100 p-2 text-sm text-green-800">
            🎉 新增了 {newTweetsCount} 条推文！
          </div>
        )}

        {/* 统计信息 */}
        <div className={cn('mt-4 text-sm', isLight ? 'text-gray-600' : 'text-gray-400')}>
          已保存推文: {twitterData.posts.length} 条
          {twitterData.lastFetchTime && (
            <div>最后更新: {new Date(twitterData.lastFetchTime).toLocaleString('zh-CN')}</div>
          )}
        </div>
      </header>

      {/* 推文列表 */}
      <div className="p-4">
        {twitterData.posts.length === 0 ? (
          <div className={cn('py-8 text-center', isLight ? 'text-gray-500' : 'text-gray-400')}>
            暂无推文数据，请开始监控获取推文
          </div>
        ) : (
          <div className="space-y-4">
            {twitterData.posts.map((tweet: TwitterPost) => (
              <div
                key={tweet.id}
                className={cn(
                  'rounded-lg border p-4',
                  isLight
                    ? 'border-gray-200 bg-white hover:bg-gray-50'
                    : 'border-gray-700 bg-gray-900 hover:bg-gray-800',
                )}>
                {/* 推文头部 */}
                <div className="mb-2 flex items-start justify-between">
                  <div className={cn('font-semibold', isLight ? 'text-gray-900' : 'text-gray-100')}>{tweet.author}</div>
                  <div className={cn('text-xs', isLight ? 'text-gray-500' : 'text-gray-400')}>
                    {formatTimeAgo(tweet.timestamp)}
                  </div>
                </div>

                {/* 推文内容 */}
                <div className={cn('text-sm leading-relaxed', isLight ? 'text-gray-700' : 'text-gray-300')}>
                  {tweet.content}
                </div>

                {/* 详细时间 */}
                <div className={cn('mt-2 text-xs', isLight ? 'text-gray-400' : 'text-gray-500')}>{tweet.timestamp}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
