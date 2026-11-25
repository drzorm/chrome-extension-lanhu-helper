(function(globalScope) {
  'use strict';

  // Panel-only identity and edits. Original ids remain exclusively for DDS DOM lookup.
  const createTreeState = () => ({
    designKey: null,
    tree: [],
    nodes: new Map(),
    parents: new Map(),
    byId: new Map(),
    descriptions: new Map(),
    deleted: new Set(),
    collapsed: new Set(),
    selectedKey: '',
    scrollTop: 0,

    replace(tree, designKey) {
      if (this.designKey !== designKey) {
        this.descriptions.clear();
        this.deleted.clear();
        this.collapsed.clear();
        this.selectedKey = '';
        this.scrollTop = 0;
      }
      this.designKey = designKey;
      this.tree = tree;
      this.reindex();
      return this.tree;
    },

    reindex() {
      this.nodes.clear();
      this.parents.clear();
      this.byId.clear();
      const visit = (nodes, parentKey = '') => {
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          if (this.deleted.has(nodes[index].treeKey)) nodes.splice(index, 1);
        }
        for (const node of nodes) {
          const key = node.treeKey;
          this.nodes.set(key, node);
          this.parents.set(key, parentKey);
          if (node.id) {
            if (!this.byId.has(node.id)) this.byId.set(node.id, []);
            this.byId.get(node.id).push(key);
          }
          if (this.descriptions.has(key)) node.description = this.descriptions.get(key);
          visit(node.children || [], key);
        }
      };
      visit(this.tree);
      if (!this.nodes.has(this.selectedKey)) this.selectedKey = '';
    },

    describe(key, description) {
      const node = this.nodes.get(key);
      if (!node) return false;
      this.descriptions.set(key, description);
      node.description = description;
      return true;
    },

    remove(key) {
      if (!this.nodes.has(key)) return false;
      this.deleted.add(key);
      this.reindex();
      return true;
    },

    path(key) {
      const path = [];
      while (this.nodes.has(key)) {
        path.unshift(key);
        key = this.parents.get(key);
      }
      return path;
    }
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = { createTreeState };
  globalScope.lanhuTreeState = { createTreeState };
})(typeof globalThis !== 'undefined' ? globalThis : this);
