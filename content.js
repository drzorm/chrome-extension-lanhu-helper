// content.js - 蓝湖Schema查看器内容脚本

(function() {
  'use strict';

  if (window.lanhuHelperInjected) {
    return;
  }
  window.lanhuHelperInjected = true;

  const { buildTreeData, normalizeImageData, getImageRewriteStats } = window.lanhuSchemaParser;
  const { stringifyNodeForCopy } = window.lanhuContentCopyFormatter;
  const { reconcileTreeRoot } = window.lanhuTreeRenderer;
  const { createTreeState } = window.lanhuTreeState;
  const {
    get_closest_element_id,
    sync_tree_selection,
    trigger_lanhu_delete_for_node
  } = window.lanhuContentSyncHelper;

  const IMAGE_SCALE_OPTIONS = [1, 2, 3];
  const IMAGE_FORMAT_OPTIONS = [
    { label: 'PNG', value: 'png' },
    { label: 'JPG', value: 'jpg' },
    { label: 'WebP', value: 'webp' },
    { label: 'SVG', value: 'svg' }
  ];
  const IMAGE_SCALE_STORAGE_KEY = 'lanhu-helper-image-scale';
  const IMAGE_FORMAT_STORAGE_KEY = 'lanhu-helper-image-format';
  // Source installs keep debugging controls; release builds define __LANHU_ID_DEBUG__ as false.
  const INCLUDE_NODE_IDS_STORAGE_KEY = 'lanhu-helper-include-ids';

  // Keep synchronous per-origin settings for now; denied storage must not prevent
  // panel initialization or apply a late value over a user's current choice.
  function readSetting(key) {
    try { return window.localStorage.getItem(key); }
    catch { return null; }
  }

  function writeSetting(key, value) {
    try { window.localStorage.setItem(key, value); }
    catch { /* The current setting remains usable for this document. */ }
  }

  function getStoredImageScale() {
    const scale = Number(readSetting(IMAGE_SCALE_STORAGE_KEY));
    return IMAGE_SCALE_OPTIONS.includes(scale) ? scale : 1;
  }

  function getStoredImageFormat() {
    const format = readSetting(IMAGE_FORMAT_STORAGE_KEY);
    return IMAGE_FORMAT_OPTIONS.some((option) => option.value === format) ? format : 'png';
  }

  // 图片转换倍图
  // https://lanhu-oss-proxy.lanhuapp.com/SketchPngd416e0d1ecd0c952708742656816f3cc76625415f1fd6d19b22748a8970c0d01?x-oss-process=image/resize,w_60,h_160/format,webp

  class LanhuHelper {
    constructor() {
      this.panel = null;
      this.openButton = null;
      this.schema = null;
      this.imageScale = getStoredImageScale();
      this.imageFormat = getStoredImageFormat();
      this.treeData = null;
      this.treeState = createTreeState();
      this.treeItems = new Map();
      this.treeRoot = null;
      this.designKey = '';
      this.schemaRevision = 0;
      this.isDeleting = false;
      this.includeNodeIds = (typeof __LANHU_ID_DEBUG__ === 'undefined' || __LANHU_ID_DEBUG__) && readSetting(INCLUDE_NODE_IDS_STORAGE_KEY) === 'true';
      this.isSelectingFromTree = false;
      this.descriptionPopoverAnchor = null;
      this.descriptionPopoverNode = null;
      this.init();
    }

    init() {
      this.createPanel();
      this.bindPanelEvents();
      this.bindDocumentEvents();
      this.bindMessageListener();
      this.requestLatestSchema();
    }

    bindMessageListener() {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'SCHEMA_DATA') {
          this.handleSchemaData(message.data, message.imageData, message.layerDataIndex, message.imageDataMissing, message.url);
        }
      });
    }

    requestLatestSchema() {
      const revision = this.schemaRevision;
      chrome.runtime.sendMessage({ type: 'GET_SCHEMA' }, (response) => {
        if (chrome.runtime.lastError || revision !== this.schemaRevision) {
          return;
        }

        if (response?.status === 'ok' && response.data) {
          this.handleSchemaData(response.data, response.imageData, response.layerDataIndex, response.imageDataMissing, response.url);
        }
      });
    }

    handleSchemaData(schema, imageData, layerDataIndex, imageDataMissing, url = '') {
      this.schemaRevision += 1;
      this.designKey = JSON.stringify([url, schema?.layerId || schema?.id || '']);
      this.schema = schema;
      this.imageDataMissing = imageDataMissing ?? (imageData == null);
      this.imageData = imageData != null ? normalizeImageData(imageData) : {};
      this.layerDataIndex = layerDataIndex || null;
      this.renderTree();
    }

    createPanel() {
      this.panel = document.createElement('div');
      this.panel.className = 'lanhu-helper-panel';

      const header = document.createElement('div');
      header.className = 'lanhu-helper-header';

      const title = document.createElement('span');
      title.className = 'lanhu-helper-title';
      title.textContent = '设计稿结构';
      title.title = '设计结构助手：适用于蓝湖的第三方工具，非蓝湖官方产品';

      const scaleSelect = document.createElement('select');
      scaleSelect.className = 'lanhu-helper-scale';
      scaleSelect.title = '切换图片倍率';
      scaleSelect.setAttribute('aria-label', '切换图片倍率');

      for (const scale of IMAGE_SCALE_OPTIONS) {
        const option = document.createElement('option');
        option.value = String(scale);
        option.textContent = `@${scale}x`;
        scaleSelect.appendChild(option);
      }
      scaleSelect.value = String(this.imageScale);

      const formatSelect = document.createElement('select');
      formatSelect.className = 'lanhu-helper-format';
      formatSelect.title = '切换图片格式';
      formatSelect.setAttribute('aria-label', '切换图片格式');

      for (const format of IMAGE_FORMAT_OPTIONS) {
        const option = document.createElement('option');
        option.value = format.value;
        option.textContent = format.label;
        formatSelect.appendChild(option);
      }
      formatSelect.value = this.imageFormat;

      let idButton;
      if (typeof __LANHU_ID_DEBUG__ === 'undefined' || __LANHU_ID_DEBUG__) {
        idButton = document.createElement('button');
        idButton.className = 'lanhu-helper-include-ids';
        idButton.type = 'button';
        idButton.title = '调试时使用：复制 JSON 时包含节点 id 和图层 layerId';
        idButton.setAttribute('aria-label', idButton.title);
        idButton.setAttribute('aria-pressed', String(this.includeNodeIds));

        const bugIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        bugIcon.setAttribute('viewBox', '0 0 24 24');
        bugIcon.setAttribute('width', '16');
        bugIcon.setAttribute('height', '16');
        bugIcon.setAttribute('fill', 'none');
        bugIcon.setAttribute('stroke', 'currentColor');
        bugIcon.setAttribute('stroke-width', '2');
        bugIcon.setAttribute('stroke-linecap', 'round');
        bugIcon.setAttribute('stroke-linejoin', 'round');
        bugIcon.setAttribute('aria-hidden', 'true');
        const bugPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        bugPath.setAttribute('d', 'm8 2 1.88 1.88 M14.12 3.88 16 2 M9 7.13V6a3 3 0 0 1 6 0v1.13 M12 20v-9 M18 9a4 4 0 0 0-4-2h-4a4 4 0 0 0-4 2v5a6 6 0 0 0 12 0Z M3 5l3 3 M18 8l3-3 M2 12h4 M18 12h4 M3 19l3-3 M18 16l3 3');
        bugIcon.appendChild(bugPath);
        idButton.appendChild(bugIcon);
        idButton.addEventListener('click', () => {
          this.includeNodeIds = !this.includeNodeIds;
          writeSetting(INCLUDE_NODE_IDS_STORAGE_KEY, String(this.includeNodeIds));
          idButton.setAttribute('aria-pressed', String(this.includeNodeIds));
        });
      }

      const closeButton = document.createElement('button');
      closeButton.className = 'lanhu-helper-close';
      closeButton.title = '关闭';
      closeButton.type = 'button';
      closeButton.textContent = '×';

      const content = document.createElement('div');
      content.className = 'lanhu-helper-content';

      const loading = document.createElement('div');
      loading.className = 'lanhu-helper-loading';
      loading.textContent = '等待加载schema';

      header.appendChild(title);
      header.appendChild(scaleSelect);
      header.appendChild(formatSelect);
      if (idButton) header.appendChild(idButton);
      header.appendChild(closeButton);
      content.appendChild(loading);
      this.panel.appendChild(header);
      this.panel.appendChild(content);
      document.body.appendChild(this.panel);

      this.openButton = document.createElement('button');
      this.openButton.className = 'lanhu-helper-open';
      this.openButton.title = '打开设计稿结构';
      this.openButton.type = 'button';
      this.openButton.textContent = '结构';
      this.openButton.hidden = true;
      document.body.appendChild(this.openButton);

      this.makeDraggable(header);
    }

    bindPanelEvents() {
      this.panel.addEventListener('click', (event) => {
        const closeButton = event.target.closest('.lanhu-helper-close');
        if (closeButton) {
          this.hidePanel();
          return;
        }

        const imageOptionSelect = event.target.closest('.lanhu-helper-scale, .lanhu-helper-format, .lanhu-helper-include-ids');
        if (imageOptionSelect) {
          event.stopPropagation();
          return;
        }

        const copyButton = event.target.closest('.lanhu-helper-copy');
        if (copyButton) {
          event.stopPropagation();
          const item = copyButton.closest('.lanhu-helper-tree-item');
          this.copyNodeAndChildren(item?.dataset?.treeKey || '');
          return;
        }

        const deleteButton = event.target.closest('.lanhu-helper-delete');
        if (deleteButton) {
          event.stopPropagation();
          const item = deleteButton.closest('.lanhu-helper-tree-item');
          this.triggerBackspaceForNode(item?.dataset?.treeKey || '');
          return;
        }

        const remarkButton = event.target.closest('.lanhu-helper-remark');
        if (remarkButton) {
          event.stopPropagation();
          this.openDescriptionPopover(remarkButton);
          return;
        }

        const toggle = event.target.closest('.lanhu-helper-tree-toggle');
        if (toggle && !toggle.classList.contains('leaf')) {
          event.stopPropagation();
          this.toggleTreeItem(toggle);
          return;
        }

        const treeNode = event.target.closest('.lanhu-helper-tree-node');
        if (treeNode) {
          event.stopPropagation();
          const item = treeNode.closest('.lanhu-helper-tree-item');
          this.selectTreeItem(item?.dataset?.treeKey || '', treeNode);
        }
      });

      this.openButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.showPanel();
      });

      const scaleSelect = this.panel.querySelector('.lanhu-helper-scale');
      scaleSelect.addEventListener('change', () => {
        this.imageScale = Number(scaleSelect.value) || 1;
        writeSetting(IMAGE_SCALE_STORAGE_KEY, String(this.imageScale));
        this.renderTree();
      });

      const formatSelect = this.panel.querySelector('.lanhu-helper-format');
      formatSelect.addEventListener('change', () => {
        this.imageFormat = formatSelect.value || 'png';
        writeSetting(IMAGE_FORMAT_STORAGE_KEY, this.imageFormat);
        this.renderTree();
      });

      const content = this.panel.querySelector('.lanhu-helper-content');
      content.addEventListener('scroll', () => {
        this.positionDescriptionPopover();
      });
    }

    bindDocumentEvents() {
      document.addEventListener('click', (event) => {
        const descriptionPopover = event.target.closest('.lanhu-helper-description-popover');
        if (descriptionPopover) {
          return;
        }

        this.handleDocumentClick(event);
      });

      window.addEventListener('resize', () => {
        this.positionDescriptionPopover();
      });
    }

    makeDraggable(header) {
      let isDragging = false;
      let offsetX = 0;
      let offsetY = 0;

      header.addEventListener('mousedown', (event) => {
        if (event.target.closest('.lanhu-helper-close, .lanhu-helper-scale, .lanhu-helper-format, .lanhu-helper-include-ids')) {
          return;
        }

        isDragging = true;
        offsetX = event.clientX - this.panel.offsetLeft;
        offsetY = event.clientY - this.panel.offsetTop;
      });

      document.addEventListener('mousemove', (event) => {
        if (!isDragging) {
          return;
        }

        this.panel.style.left = `${event.clientX - offsetX}px`;
        this.panel.style.top = `${event.clientY - offsetY}px`;
        this.panel.style.bottom = 'auto';
        this.positionDescriptionPopover();
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
      });
    }

    renderTree() {
      const content = this.panel.querySelector('.lanhu-helper-content');
      const sameDesign = this.treeState.designKey === this.designKey;
      if (sameDesign) this.treeState.scrollTop = content.scrollTop;
      this.closeDescriptionPopover();

      try {
        const tree = buildTreeData(this.schema, this.imageData, {
          imageScale: this.imageScale,
          imageFormat: this.imageFormat,
          layerDataIndex: this.layerDataIndex
        });
        this.treeData = this.treeState.replace(tree, this.designKey);
        if (!sameDesign || !this.treeRoot) {
          this.treeItems = new Map();
          this.treeRoot = document.createElement('ul');
          this.treeRoot.className = 'lanhu-helper-tree';
        }
        this.treeItems = reconcileTreeRoot(document, this.treeRoot, this.treeData, this.treeState, this.treeItems);
        if (this.treeData.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'lanhu-helper-empty';
          empty.textContent = '暂无结构数据';
          content.replaceChildren(empty);
        } else if (this.treeRoot.parentElement !== content) {
          content.replaceChildren(this.treeRoot);
        }
        content.scrollTop = this.treeState.scrollTop;
        this.updateImageRewriteWarning();
      } catch (error) {
        console.error('[蓝湖助手] 结构树解析/渲染失败:', error);
        this.treeData = this.treeState.replace([], this.designKey);
        this.treeItems.clear();
        this.treeRoot = null;
        const errorNode = document.createElement('div');
        errorNode.className = 'lanhu-helper-error';
        errorNode.textContent = '结构数据解析失败';
        content.replaceChildren(errorNode);
        this.updateImageRewriteWarning();
      }
    }

    updateImageRewriteWarning() {
      const { total, rewritten } = getImageRewriteStats(this.treeData, this.imageData, {
        imageScale: this.imageScale,
        imageFormat: this.imageFormat
      });
      const count = total - rewritten;
      let warning = this.panel.querySelector('.lanhu-helper-image-warning');
      if (!count || this.imageScale === 1 && this.imageFormat === 'png') {
        warning?.remove();
        return;
      }
      if (!warning) {
        warning = document.createElement('div');
        warning.className = 'lanhu-helper-image-warning';
        warning.setAttribute('role', 'status');
        this.panel.appendChild(warning);
      }
      warning.textContent = `部分图片参数未生效（${count}处）`;
      warning.title = `图片未改写引用数：${count}（共 ${total} 个远程引用）。保留原始引用，倍率/格式不保证生效；不代表加载失败或一定模糊。同一图片重复使用按引用次数统计。`;
    }

    handleDocumentClick(event) {
      if (
        this.isSelectingFromTree ||
        !this.treeData ||
        !this.panel ||
        this.panel.contains(event.target) ||
        this.openButton?.contains(event.target)
      ) {
        return;
      }

      const nodeId = get_closest_element_id(event.target, (id) => this.treeState.byId.has(id));
      if (!nodeId) {
        return;
      }

      const keys = this.treeState.byId.get(nodeId);
      if (keys?.length !== 1 || !this.getPageTarget(keys[0])) return;
      const nodePath = this.treeState.path(keys[0]);
      if (sync_tree_selection(this.panel, nodePath, this.treeItems)) {
        this.treeState.selectedKey = keys[0];
        for (const key of nodePath.slice(0, -1)) this.treeState.collapsed.delete(key);
      }
    }

    hidePanel() {
      this.closeDescriptionPopover();
      this.panel.hidden = true;
      this.openButton.hidden = false;
    }

    showPanel() {
      this.panel.hidden = false;
      this.openButton.hidden = true;
    }

    toggleTreeItem(toggle) {
      const item = toggle.closest('.lanhu-helper-tree-item');
      const childList = item?.querySelector(':scope > ul');
      if (!childList) {
        return;
      }

      const isExpanded = toggle.classList.contains('expanded');
      toggle.classList.toggle('expanded', !isExpanded);
      toggle.classList.toggle('collapsed', isExpanded);
      childList.style.display = isExpanded ? 'none' : '';
      if (isExpanded) this.treeState.collapsed.add(item.dataset.treeKey);
      else this.treeState.collapsed.delete(item.dataset.treeKey);
    }

    openDescriptionPopover(button) {
      const item = button.closest('.lanhu-helper-tree-item');
      const treeKey = item?.dataset?.treeKey || '';
      const node = this.treeState.nodes.get(treeKey);
      if (!node) {
        return;
      }

      const existingPopover = document.querySelector('.lanhu-helper-description-popover');
      if (existingPopover?.dataset.treeKey === treeKey) {
        this.descriptionPopoverNode = button.closest('.lanhu-helper-tree-node');
        this.descriptionPopoverNode?.classList.add('remark-active');
        existingPopover.querySelector('textarea')?.focus();
        return;
      }

      this.closeDescriptionPopover();
      this.descriptionPopoverNode = button.closest('.lanhu-helper-tree-node');
      this.descriptionPopoverNode?.classList.add('remark-active');

      const popover = document.createElement('div');
      popover.className = 'lanhu-helper-description-popover';
      popover.dataset.treeKey = treeKey;

      const textarea = document.createElement('textarea');
      textarea.className = 'lanhu-helper-description-textarea';
      textarea.value = node.description || '';
      textarea.placeholder = '输入备注';

      const actions = document.createElement('div');
      actions.className = 'lanhu-helper-description-actions';

      const cancel = document.createElement('button');
      cancel.className = 'lanhu-helper-description-cancel';
      cancel.type = 'button';
      cancel.textContent = '取消';

      const confirm = document.createElement('button');
      confirm.className = 'lanhu-helper-description-confirm';
      confirm.type = 'button';
      confirm.textContent = '确定';
      confirm.addEventListener('click', (event) => {
        event.stopPropagation();
        this.confirmDescription(confirm);
      });
      cancel.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeDescriptionPopover();
      });

      actions.appendChild(cancel);
      actions.appendChild(confirm);
      popover.appendChild(textarea);
      popover.appendChild(actions);

      document.body.appendChild(popover);
      this.descriptionPopoverAnchor = button;
      this.positionDescriptionPopover();
      textarea.focus();
    }

    positionDescriptionPopover() {
      const popover = document.querySelector('.lanhu-helper-description-popover');
      if (!popover || !this.descriptionPopoverAnchor?.isConnected) {
        return;
      }

      const buttonRect = this.descriptionPopoverAnchor.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const gap = 8;
      const viewportPadding = 8;
      const left = Math.min(
        Math.max(viewportPadding, buttonRect.right - popoverRect.width),
        window.innerWidth - popoverRect.width - viewportPadding
      );
      const top = Math.max(viewportPadding, buttonRect.top - popoverRect.height - gap);
      const arrowLeft = Math.min(
        Math.max(12, buttonRect.left + (buttonRect.width / 2) - left),
        popoverRect.width - 12
      );

      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
      popover.style.setProperty('--lanhu-helper-description-arrow-left', `${arrowLeft}px`);
    }

    confirmDescription(button) {
      const popover = button.closest('.lanhu-helper-description-popover');
      const treeKey = popover?.dataset?.treeKey || '';
      if (!popover || !this.treeState.nodes.has(treeKey)) {
        return;
      }

      const description = popover.querySelector('textarea')?.value || '';
      this.treeState.describe(treeKey, description);

      const item = this.treeItems.get(treeKey);
      const remarkButton = item?.querySelector(':scope > .lanhu-helper-tree-node .lanhu-helper-remark');
      remarkButton?.classList.toggle('has-description', description.trim().length > 0);
      if (remarkButton) {
        remarkButton.title = description || '备注';
      }

      this.closeDescriptionPopover();
    }

    closeDescriptionPopover() {
      document.querySelector('.lanhu-helper-description-popover')?.remove();
      this.descriptionPopoverNode?.classList.remove('remark-active');
      this.descriptionPopoverAnchor = null;
      this.descriptionPopoverNode = null;
    }

    getPageTarget(treeKey) {
      const node = this.treeState.nodes.get(treeKey);
      // Repeated template ids do not identify a unique official DOM instance.
      if (!node?.id || this.treeState.byId.get(node.id)?.length !== 1) return null;
      const matches = document.querySelectorAll(`[id="${CSS.escape(node.id)}"]`);
      return matches.length === 1 ? matches[0] : null;
    }

    selectTreeItem(treeKey, nodeElement) {
      if (!this.treeState.nodes.has(treeKey)) return;
      this.treeItems.get(this.treeState.selectedKey)?.children[0].classList.remove('selected');
      this.treeState.selectedKey = treeKey;
      nodeElement.classList.add('selected');

      const target = this.getPageTarget(treeKey);
      if (!target) {
        this.showToast('该节点无法唯一定位到页面，仍可复制和备注');
        return;
      }
      this.isSelectingFromTree = true;
      try {
        target.click();
      } finally {
        this.isSelectingFromTree = false;
      }
    }

    async triggerBackspaceForNode(treeKey) {
      if (this.isDeleting || !this.treeState.nodes.has(treeKey)) return;
      const node = this.treeState.nodes.get(treeKey);
      if (!this.getPageTarget(treeKey)) {
        this.showToast('无法唯一定位页面节点，未执行删除');
        return;
      }
      if (!window.confirm('确认在蓝湖页面删除该节点？此操作会向官方页面发送 Backspace，可能修改设计；本扩展不提供撤销，也不保证服务端保存成功。请先核对当前设计及节点。')) return;
      this.closeDescriptionPopover();
      const revision = this.schemaRevision;
      this.isDeleting = true;
      this.isSelectingFromTree = true;
      try {
        const removed = await trigger_lanhu_delete_for_node(document, node.id);
        if (removed && revision === this.schemaRevision) {
          this.removeTreeItem(treeKey);
          this.showToast('已确认页面节点移除');
        } else {
          this.showToast('未确认删除成功，已保留结构树节点');
        }
      } catch (error) {
        console.error('[蓝湖助手] 删除节点失败:', error);
        this.showToast('删除失败，已保留结构树节点');
      } finally {
        this.isDeleting = false;
        this.isSelectingFromTree = false;
      }
    }

    removeTreeItem(treeKey) {
      if (!this.treeState.remove(treeKey)) return;
      this.treeData = this.treeState.tree;
      this.treeItems = reconcileTreeRoot(document, this.treeRoot, this.treeData, this.treeState, this.treeItems);
      this.updateImageRewriteWarning();
      if (this.descriptionPopoverAnchor && !this.descriptionPopoverAnchor.isConnected) this.closeDescriptionPopover();
    }

    copyNodeAndChildren(treeKey) {
      const node = this.treeState.nodes.get(treeKey);
      if (!node) {
        this.showToast('未找到节点');
        return;
      }

      const jsonStr = stringifyNodeForCopy(node, { includeNodeIds: (typeof __LANHU_ID_DEBUG__ === 'undefined' || __LANHU_ID_DEBUG__) && this.includeNodeIds });
      window.lanhuClipboardHelper.copyText(jsonStr).then(() => {
        this.showToast('已复制到剪贴板');
      }).catch((error) => {
        this.showToast(`复制失败: ${error.message}`);
      });
    }

    showToast(message) {
      const toast = document.createElement('div');
      toast.className = 'lanhu-helper-toast';
      toast.textContent = message;
      document.body.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('show');
      }, 10);

      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }, 2000);
    }
  }

  new LanhuHelper();
})();
