(function(globalScope) {
  'use strict';

  const get_closest_element_id = (node, acceptsId = () => true) => {
    let current = node || null;

    while (current) {
      if (typeof current.id === 'string' && current.id && acceptsId(current.id)) {
        return current.id;
      }

      current = current.parentElement || null;
    }

    return '';
  };

  const find_tree_item = (panel, nodeId) => {
    const items = panel?.querySelectorAll?.('.lanhu-helper-tree-item') || [];

    for (const item of items) {
      if (item?.dataset?.id === nodeId) {
        return item;
      }
    }

    return null;
  };

  const sync_tree_selection = (panel, nodePath, itemsByKey) => {
    if (!panel || !Array.isArray(nodePath) || nodePath.length === 0) {
      return false;
    }

    const findItem = (key) => itemsByKey ? itemsByKey.get(key) : find_tree_item(panel, key);
    const targetItem = findItem(nodePath[nodePath.length - 1]);
    const targetNode = targetItem?.querySelector?.(':scope > .lanhu-helper-tree-node') || null;
    if (!targetItem || !targetNode) {
      return false;
    }

    for (const selectedNode of panel.querySelectorAll('.lanhu-helper-tree-node.selected')) {
      selectedNode.classList.remove('selected');
    }

    for (const nodeId of nodePath.slice(0, -1)) {
      const item = findItem(nodeId);
      const toggle = item?.querySelector?.(':scope > .lanhu-helper-tree-node .lanhu-helper-tree-toggle') || null;
      const childList = item?.querySelector?.(':scope > ul') || null;

      if (!toggle || !childList || toggle.classList.contains('leaf')) {
        continue;
      }

      toggle.classList.add('expanded');
      toggle.classList.remove('collapsed');
      childList.style.display = '';
    }

    targetNode.classList.add('selected');
    targetNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  };

  const define_keyboard_code = (event, name, value) => {
    try {
      Object.defineProperty(event, name, {
        get() {
          return value;
        }
      });
    } catch (error) {
      // Some browsers already expose the deprecated keyCode/which values.
    }
  };

  const create_backspace_event = (doc) => {
    const EventConstructor = doc?.defaultView?.KeyboardEvent || KeyboardEvent;
    const event = new EventConstructor('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      keyCode: 8,
      which: 8,
      bubbles: true,
      cancelable: true
    });

    define_keyboard_code(event, 'keyCode', 8);
    define_keyboard_code(event, 'which', 8);

    return event;
  };

  const trigger_lanhu_delete_for_node = async (doc, nodeId, options = {}) => {
    const target = doc?.getElementById?.(nodeId);
    const Observer = doc?.defaultView?.MutationObserver;
    if (!target || !Observer || !doc.documentElement) return false;

    const root = doc.documentElement;
    const url = doc.URL;
    const timeoutMs = options.timeoutMs ?? 1500;
    const settleMs = options.settleMs ?? 120;
    return new Promise((resolve, reject) => {
      let settleTimer;
      let timeoutTimer;
      let dispatched = false;
      let finished = false;
      const finish = (result, error) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(settleTimer);
        clearTimeout(timeoutTimer);
        if (error) reject(error);
        else resolve(result);
      };
      const check = () => {
        if (!dispatched || finished) return;
        if (doc.URL !== url || doc.documentElement !== root) {
          finish(false);
          return;
        }
        if (doc.getElementById(nodeId)) {
          clearTimeout(settleTimer);
          settleTimer = undefined;
        } else if (settleTimer === undefined) {
          // A short disappearance during a rerender is not a confirmed deletion.
          settleTimer = setTimeout(() => finish(!doc.getElementById(nodeId)
            && doc.URL === url && doc.documentElement === root), settleMs);
        }
      };
      const observer = new Observer(check);
      try {
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['id'] });
        timeoutTimer = setTimeout(() => finish(false), timeoutMs);
        doc.activeElement?.blur?.();
        target.click();
        // Selection alone may rerender/remove the target; do not mistake that for deletion.
        if (!doc.getElementById(nodeId)) {
          finish(false);
          return;
        }
        doc.dispatchEvent(create_backspace_event(doc));
        dispatched = true;
        check();
      } catch (error) {
        finish(false, error);
      }
    });
  };

  const content_sync_helper = {
    get_closest_element_id,
    sync_tree_selection,
    trigger_lanhu_delete_for_node
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = content_sync_helper;
  }

  globalScope.lanhuContentSyncHelper = content_sync_helper;
})(typeof globalThis !== 'undefined' ? globalThis : this);
