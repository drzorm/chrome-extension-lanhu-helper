(function(globalScope) {
  'use strict';

  const findNodeById = (nodes, targetId) => {
    if (!nodes || nodes.length === 0) {
      return null;
    }

    for (const node of nodes) {
      if (node.id === targetId) {
        return node;
      }

      const found = findNodeById(node.children || [], targetId);
      if (found) {
        return found;
      }
    }

    return null;
  };

  const findNodePathById = (nodes, targetId, currentPath = []) => {
    if (!nodes || nodes.length === 0) {
      return null;
    }

    for (const node of nodes) {
      const nextPath = node.id ? currentPath.concat(node.id) : currentPath;

      if (node.id === targetId) {
        return nextPath;
      }

      const found = findNodePathById(node.children || [], targetId, nextPath);
      if (found) {
        return found;
      }
    }

    return null;
  };

  const removeNodeById = (nodes, targetId) => {
    if (!nodes || nodes.length === 0 || !targetId) {
      return false;
    }

    const index = nodes.findIndex((node) => node.id === targetId);
    if (index >= 0) {
      nodes.splice(index, 1);
      return true;
    }

    for (const node of nodes) {
      if (removeNodeById(node.children || [], targetId)) {
        return true;
      }
    }

    return false;
  };

  const tree_helper = {
    findNodeById,
    findNodePathById,
    removeNodeById
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = tree_helper;
  }

  globalScope.lanhuTreeHelper = tree_helper;
})(typeof globalThis !== 'undefined' ? globalThis : this);
