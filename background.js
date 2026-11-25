const SCHEMA_URL_PATTERN = 'https://lanhu-dds-backend.oss-cn-beijing.aliyuncs.com/*/schema.json';
const IMAGE_URL_PATTERN = 'https://lanhuapp.com/api/project/image?*';

console.log('[蓝湖助手] Service Worker已启动');

importScripts('vector_style_helper.js', 'background_controller.js');

const relay = globalThis.lanhuBackgroundController.createSchemaRelay({
  fetchImpl: fetch,
  storage: chrome.storage.session,
  getOpenTabIds: async () => new Set((await chrome.tabs.query({})).map((tab) => tab.id)),
  sendMessage: async (tabId, payload) => {
    await chrome.tabs.sendMessage(tabId, payload);
  }
});

const getRequestType = (url) => (
  url.includes('/api/project/image?') ? 'image' : 'schema'
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    try {
      const result = await relay.handleRequestCompleted({
        ...details,
        requestType: getRequestType(details.url || '')
      });
      if (result?.status === 'ok') {
        console.log('[蓝湖助手] 已缓存并推送schema和image数据');
      }
    } catch (error) {
      console.error('[蓝湖助手] 获取蓝湖数据失败:', error);
    }
  },
  {
    urls: [SCHEMA_URL_PATTERN, IMAGE_URL_PATTERN]
  }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'GET_SCHEMA') return false;
  relay.ready.then(() => {
    sendResponse(relay.handleRuntimeMessage(message, sender));
  }).catch((error) => {
    console.error('[蓝湖助手] 读取缓存失败:', error);
    sendResponse({ status: 'error', data: null });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  relay.clearTab(tabId);
});
