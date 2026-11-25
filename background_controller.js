(function(globalScope) {
  'use strict';

  const { buildLayerDataIndex, verifySolidShapeGroups } = typeof module !== 'undefined' && module.exports
    ? require('./vector_style_helper') : globalScope.lanhuVectorStyleHelper;

  const createSchemaRelay = (options = {}) => {
    const dataByTab = new Map();
    const fetchImpl = options.fetchImpl || globalScope.fetch;
    const sendMessage = options.sendMessage || (() => Promise.resolve());
    const storage = options.storage;
    const storagePrefix = 'lanhu-schema:';
    const removedTabs = new Set();
    const warn = options.warn || ((error) => console.warn('[蓝湖助手] 会话缓存不可用:', error));
    let storageQueue = Promise.resolve();
    let requestSequence = 0;

    const getValidTabId = (tabId) => (Number.isInteger(tabId) && tabId >= 0 ? tabId : null);

    const createEmptyEntry = () => ({
      hasSchema: false,
      schema: null,
      schemaUrl: '',
      schemaRequestSequence: 0,
      schemaGeneration: 0,
      hasImage: false,
      image: null,
      imageUrl: '',
      imageRequestSequence: 0,
      latestImageRequestSequence: 0,
      pendingImage: null,
      layerDataIndex: null
    });

    const enqueueStorage = (operation) => {
      storageQueue = storageQueue.then(operation).catch(warn);
      return storageQueue;
    };

    const ready = storage ? (async () => {
      try {
        const saved = await storage.get(null);
        const openTabs = options.getOpenTabIds ? await options.getOpenTabIds() : null;
        for (const [key, entry] of Object.entries(saved)) {
          if (!key.startsWith(storagePrefix)) continue;
          const tabId = Number(key.slice(storagePrefix.length));
          if (getValidTabId(tabId) === null || removedTabs.has(tabId)
            || openTabs && !openTabs.has(tabId)
            || !entry?.hasSchema || !entry.schema || typeof entry.schemaUrl !== 'string') {
            await storage.remove(key);
            continue;
          }
          const restored = { ...createEmptyEntry(), ...entry };
          dataByTab.set(tabId, restored);
          requestSequence = Math.max(requestSequence, restored.schemaRequestSequence,
            restored.imageRequestSequence, restored.latestImageRequestSequence);
        }
      } catch (error) {
        warn(error);
      }
    })() : Promise.resolve();

    const persistEntry = (tabId, entry) => {
      if (!storage || !entry.hasSchema) return Promise.resolve();
      const key = `${storagePrefix}${tabId}`;
      const snapshot = structuredClone(entry);
      return enqueueStorage(async () => {
        try {
          await storage.set({ [key]: snapshot });
        } catch (error) {
          // Session storage is bounded. Preserve at least schema rather than an old design.
          warn(error);
          try {
            await storage.set({ [key]: { ...createEmptyEntry(), hasSchema: true,
              schema: snapshot.schema, schemaUrl: snapshot.schemaUrl,
              schemaGeneration: snapshot.schemaGeneration,
              schemaRequestSequence: snapshot.schemaRequestSequence } });
          } catch (fallbackError) {
            // Never recover an obsolete design when even schema-only exceeds quota.
            await storage.remove(key);
            throw fallbackError;
          }
        }
      });
    };

    const getEntryForTab = (tabId) => {
      let entry = dataByTab.get(tabId);
      if (!entry) {
        entry = createEmptyEntry();
        dataByTab.set(tabId, entry);
      }
      return entry;
    };

    const isEntryReady = (entry) => Boolean(entry?.hasSchema);

    const createPayload = (entry) => ({
      type: 'SCHEMA_DATA',
      data: entry.schema,
      url: entry.schemaUrl,
      imageData: entry.image,
      imageDataMissing: !entry.hasImage || entry.image == null,
      imageUrl: entry.imageUrl,
      layerDataIndex: entry.layerDataIndex
    });

    const getSchemaForTab = (tabId) => {
      const validTabId = getValidTabId(tabId);
      const entry = validTabId === null ? null : dataByTab.get(validTabId);
      return entry?.hasSchema ? entry.schema : null;
    };

    const getDataForTab = (tabId) => {
      const validTabId = getValidTabId(tabId);
      const entry = validTabId === null ? null : dataByTab.get(validTabId);
      return isEntryReady(entry) ? createPayload(entry) : null;
    };

    const clearTab = (tabId) => {
      const validTabId = getValidTabId(tabId);
      if (validTabId !== null) {
        removedTabs.add(validTabId);
        dataByTab.delete(validTabId);
        if (storage) return ready.then(() => enqueueStorage(() => storage.remove(`${storagePrefix}${validTabId}`)));
      }
      return Promise.resolve();
    };

    const getCredentialsMode = (url) => {
      try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname === 'lanhuapp.com' && parsedUrl.pathname.startsWith('/api/')
          ? 'include'
          : 'omit';
      } catch (error) {
        return 'omit';
      }
    };

    const fetchJson = async (url, requestType) => {
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(url, { credentials: getCredentialsMode(url), signal: controller.signal });
            if (!response || !response.ok) {
              throw new Error(`${requestType} request failed: ${response?.status || 'unknown'}`);
            }
            return response.json();
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`${requestType} request timed out`));
            }, options.fetchTimeoutMs ?? 15000);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    const pushIfReady = async (tabId, entry) => {
      if (!isEntryReady(entry)) {
        return { status: 'pending' };
      }

      await persistEntry(tabId, entry);
      if (dataByTab.get(tabId) !== entry) return { status: 'stale' };
      const payload = createPayload(entry);

      try {
        await sendMessage(tabId, payload);
      } catch (error) {
        // 内容脚本可能尚未注入，缓存必须保留，推送失败不影响后续补拉
      }

      return { status: 'ok', data: entry.schema, imageData: entry.image };
    };

    const imageRootId = (image) => typeof image?.ArtboardID === 'string' ? image.ArtboardID
      : image?.info?.find((layer) => layer.ddsType === 'artboard-group')?.id;
    const matchesSchema = (image, schema) => Boolean(image?.rootId && schema?.layerId && image.rootId === schema.layerId);
    const applyImage = (entry, image) => {
      entry.hasImage = true;
      entry.image = image.data;
      entry.layerDataIndex = image.index;
      entry.imageUrl = image.url;
      entry.imageRequestSequence = image.sequence;
      entry.pendingImage = null;
    };

    const handleRequestCompleted = async ({ tabId, url, requestType = 'schema' }) => {
      const validTabId = getValidTabId(tabId);
      if (validTabId === null) {
        return { status: 'ignored' };
      }

      if (requestType !== 'schema' && requestType !== 'image') {
        return { status: 'ignored' };
      }

      if (storage) await ready;
      if (removedTabs.has(validTabId)) return { status: 'stale' };
      const currentRequestSequence = ++requestSequence;
      const entry = getEntryForTab(validTabId);
      const schemaGenerationAtStart = entry.schemaGeneration;
      if (requestType === 'image') entry.latestImageRequestSequence = currentRequestSequence;
      const isStaleImage = () => entry.schemaGeneration > Math.max(1, schemaGenerationAtStart);
      const supersededImage = () => dataByTab.get(validTabId) !== entry || entry.latestImageRequestSequence !== currentRequestSequence;
      const data = await fetchJson(url, requestType);

      if (dataByTab.get(validTabId) !== entry) return { status: 'stale' };
      if (requestType === 'schema') {
        if (currentRequestSequence < entry.schemaRequestSequence) return { status: 'stale' };
        const changedSchema = entry.hasSchema && entry.schemaUrl !== url;
        if (!entry.hasSchema || changedSchema) entry.schemaGeneration += 1;
        entry.hasSchema = true;
        entry.schema = data;
        entry.schemaUrl = url;
        entry.schemaRequestSequence = currentRequestSequence;

        if (changedSchema) {
          entry.hasImage = false;
          entry.image = null;
          entry.imageUrl = '';
          entry.imageRequestSequence = 0;
          entry.layerDataIndex = null;
        }
        if (matchesSchema(entry.pendingImage, data)) applyImage(entry, entry.pendingImage);
      } else if (requestType === 'image') {
        if (supersededImage()) {
          return { status: 'stale' };
        }

        const jsonUrl = data?.result?.versions?.[0]?.json_url;
        const imageData = jsonUrl ? await fetchJson(jsonUrl, requestType) : data;

        const rootId = imageRootId(imageData);
        const image = { rootId, data: imageData, url, sequence: currentRequestSequence };
        if (supersededImage() || isStaleImage() && !matchesSchema(image, entry.schema)) return { status: 'stale' };

        image.index = await verifySolidShapeGroups(buildLayerDataIndex(imageData), fetchImpl);
        if (supersededImage() || isStaleImage() && !matchesSchema(image, entry.schema)) return { status: 'stale' };
        if (rootId && (!entry.hasSchema || !matchesSchema(image, entry.schema))) {
          // Keep the next design's layers separately until its matching schema arrives.
          entry.pendingImage = image;
          await persistEntry(validTabId, entry);
          return { status: 'pending' };
        }
        applyImage(entry, image);
      }

      return pushIfReady(validTabId, entry);
    };

    const handleRuntimeMessage = (message, sender) => {
      if (message?.type !== 'GET_SCHEMA') {
        return null;
      }

      const tabId = sender?.tab?.id;
      const payload = getDataForTab(tabId);

      return payload
        ? { status: 'ok', data: payload.data, url: payload.url, imageData: payload.imageData, imageDataMissing: payload.imageDataMissing, imageUrl: payload.imageUrl, layerDataIndex: payload.layerDataIndex }
        : { status: 'empty', data: null };
    };

    return {
      ready,
      clearTab,
      getDataForTab,
      getSchemaForTab,
      handleRequestCompleted,
      handleRuntimeMessage
    };
  };

  const controller = {
    createSchemaRelay
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = controller;
  }

  globalScope.lanhuBackgroundController = controller;
})(typeof globalThis !== 'undefined' ? globalThis : this);
