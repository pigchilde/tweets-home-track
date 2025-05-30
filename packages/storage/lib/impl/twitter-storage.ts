import { createStorage, StorageEnum } from '../base/index.js';

export interface TwitterPost {
  id: string;
  author: string;
  content: string;
  timestamp: string; // 格式: 年/月/日 时:分:秒
  publishTime: string; // ISO字符串，用于排序和比较
}

export interface TwitterStorageState {
  posts: TwitterPost[];
  lastFetchTime: string;
  isFirstTime: boolean;
}

const storage = createStorage<TwitterStorageState>(
  'twitter-posts-storage-key',
  {
    posts: [],
    lastFetchTime: '',
    isFirstTime: true,
  },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

// 添加新推文
const addPosts = async (newPosts: TwitterPost[]) => {
  const currentState = await storage.get();
  const existingIds = new Set(currentState.posts.map(post => post.id));
  const uniqueNewPosts = newPosts.filter(post => !existingIds.has(post.id));

  await storage.set(state => {
    // 合并所有推文并按时间排序（最新的在前）
    const allPosts = [...uniqueNewPosts, ...state.posts]
      .sort((a, b) => new Date(b.publishTime).getTime() - new Date(a.publishTime).getTime())
      .slice(0, 20); // 只保留最新的20条

    return {
      ...state,
      posts: allPosts,
      lastFetchTime: new Date().toISOString(),
      isFirstTime: false,
    };
  });

  return uniqueNewPosts.length;
};

// 获取最新推文的时间
const getLatestTimestamp = async (): Promise<Date | null> => {
  const state = await storage.get();
  if (state.posts.length === 0) return null;
  return new Date(state.posts[0].publishTime);
};

// 重置为首次状态
const reset = async () => {
  await storage.set({
    posts: [],
    lastFetchTime: '',
    isFirstTime: true,
  });
};

// 导出对象 (Move this to the end of the file)
export const twitterStorage = {
  ...storage,
  addPosts,
  getLatestTimestamp,
  reset,
};
