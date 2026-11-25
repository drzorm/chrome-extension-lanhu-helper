(function(globalScope) {
  'use strict';

  const getBackgroundImageSrc = (value) => {
    if (typeof value !== 'string') {
      return '';
    }

    const match = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
    return match ? match[2] : '';
  };

  const createImage = (doc, src, alt) => {
    const image = doc.createElement('img');
    image.className = 'lanhu-helper-tree-label-image';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = src || '';
    image.alt = alt;
    return image;
  };

  const createBackgroundImage = (doc, src, alt) => {
    const image = createImage(doc, src, alt);
    image.style.flex = '1';
    image.style.maxWidth = '100%';
    image.style.height = '30px';
    return image;
  };

  const createTypeLabel = (doc, type) => {
    const typeLabel = doc.createElement('span');
    typeLabel.style.flexShrink = '0';
    typeLabel.textContent = type;
    return typeLabel;
  };

  const createLabel = (doc, node) => {
    const label = doc.createElement('span');
    label.className = 'lanhu-helper-tree-label';

    const background = node.style?.background || node.style?.backgroundImage || '';
    const backgroundSrc = getBackgroundImageSrc(background);
    const backgroundImageSrc = /^data:image\/svg\+xml(?:;[^,]*)?,/i.test(backgroundSrc)
      ? ''
      : backgroundSrc;
    if (backgroundImageSrc && node.type === 'block' && node.children.length > 0) {
      label.appendChild(createTypeLabel(doc, node.type));
      label.appendChild(createBackgroundImage(doc, backgroundImageSrc, node.type));
      return label;
    }

    if (backgroundImageSrc && node.children.length === 0) {
      label.appendChild(createImage(doc, backgroundImageSrc, node.type || 'background'));
      return label;
    }

    if (node.type === 'image') {
      label.appendChild(createImage(doc, node.src || '', node.type));
      return label;
    }

    label.textContent = node.type === 'text' ? String(node.text ?? '') : (node.type || 'unknown');
    return label;
  };

  const createTreeItem = (doc, node, shallow = false) => {
    const item = doc.createElement('li');
    item.className = 'lanhu-helper-tree-item';
    item.dataset.id = node.id || '';
    item.dataset.treeKey = node.treeKey || '';

    const row = doc.createElement('div');
    row.className = 'lanhu-helper-tree-node';

    const toggle = doc.createElement('span');
    toggle.className = `lanhu-helper-tree-toggle ${node.children.length ? 'expanded' : 'leaf'}`;

    const icon = doc.createElement('span');
    icon.className = `lanhu-helper-tree-icon ${node.type || 'unknown'}`;

    const label = createLabel(doc, node);

    const deleteButton = doc.createElement('span');
    deleteButton.className = 'lanhu-helper-delete';
    deleteButton.title = '删除';
    deleteButton.textContent = '🗑️';

    const remark = doc.createElement('span');
    remark.className = `lanhu-helper-remark${node.description ? ' has-description' : ''}`;
    remark.title = node.description || '备注';
    remark.textContent = '📝';

    const copy = doc.createElement('span');
    copy.className = 'lanhu-helper-copy';
    copy.title = '复制本级及下级';
    copy.textContent = '📋';

    row.appendChild(toggle);
    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(deleteButton);
    row.appendChild(remark);
    row.appendChild(copy);
    item.appendChild(row);

    if (!shallow && node.children.length > 0) {
      const childList = doc.createElement('ul');
      for (const child of node.children) {
        childList.appendChild(createTreeItem(doc, child));
      }
      item.appendChild(childList);
    }

    return item;
  };

  const createTreeRoot = (doc, nodes) => {
    const root = doc.createElement('ul');
    root.className = 'lanhu-helper-tree';

    for (const node of nodes) {
      root.appendChild(createTreeItem(doc, node));
    }

    return root;
  };

  // Reuse unchanged rows and image elements rather than rebuilding every subtree.
  const reconcileTreeRoot = (doc, root, nodes, state, previousItems = new Map()) => {
    const items = new Map();
    const replaceIfChanged = (parent, children) => {
      if (parent.children.length !== children.length
        || children.some((child, index) => parent.children[index] !== child)) {
        parent.replaceChildren(...children);
      }
    };
    const visit = (node) => {
      const item = previousItems.get(node.treeKey) || createTreeItem(doc, node, true);
      item.dataset.id = node.id || '';
      const row = item.children[0];
      const signature = JSON.stringify([node.type, node.text, node.src,
        node.style?.background, node.style?.backgroundImage, node.children.length > 0]);
      if (item.labelSignature !== undefined && item.labelSignature !== signature) {
        row.children[2].replaceWith(createLabel(doc, node));
      }
      item.labelSignature = signature;
      row.children[1].className = `lanhu-helper-tree-icon ${node.type || 'unknown'}`;
      row.classList.toggle('selected', state.selectedKey === node.treeKey);
      const collapsed = state.collapsed.has(node.treeKey);
      row.children[0].className = `lanhu-helper-tree-toggle ${node.children.length
        ? (collapsed ? 'collapsed' : 'expanded') : 'leaf'}`;
      const remark = row.children[4];
      remark.classList.toggle('has-description', Boolean(node.description?.trim()));
      remark.title = node.description || '备注';
      let childList = item.children[1];
      if (node.children.length) {
        if (!childList) {
          childList = doc.createElement('ul');
          item.appendChild(childList);
        }
        childList.style.display = collapsed ? 'none' : '';
        replaceIfChanged(childList, node.children.map(visit));
      } else {
        childList?.remove();
      }
      items.set(node.treeKey, item);
      return item;
    };
    replaceIfChanged(root, nodes.map(visit));
    return items;
  };

  const tree_renderer = {
    reconcileTreeRoot,
    createLabel,
    getBackgroundImageSrc,
    createTreeItem,
    createTreeRoot
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = tree_renderer;
  }

  globalScope.lanhuTreeRenderer = tree_renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
