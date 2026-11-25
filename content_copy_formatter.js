(function(globalScope) {
  'use strict';

  const should_skip_copy_key = (key, options) => key === 'treeKey' || key === 'className' || key === 'prompt'
    || (!options.includeNodeIds && (key === 'id' || key === 'layerId'));
  const is_dynamic_value_placeholder = (value) => (
    typeof value === 'string' && /^this\.item(?:\.|\[)/.test(value.trim())
  );

  const image_download_prompt = 'Download all remote images (including backgrounds) into the project and use local paths, not remote URLs.';

  const is_remote_image_url = (value) => (
    typeof value === 'string' && /^(?:https?:)?\/\//i.test(value.trim())
  );
  const has_remote_images = (node) => {
    if (!node || typeof node !== 'object') return false;

    if (node.type === 'image' && (is_remote_image_url(node.src) || is_remote_image_url(node.value))) {
      return true;
    }

    const has_remote_background = ['background', 'backgroundImage', 'background-image'].some((key) => (
      typeof node.style?.[key] === 'string'
      && /url\(\s*['"]?(?:https?:)?\/\//i.test(node.style[key])
    ));
    return has_remote_background || (Array.isArray(node.children) && node.children.some(has_remote_images));
  };

  const stringifyNodeForCopy = (node, options = {}) => JSON.stringify({
    ...node,
    _meta: has_remote_images(node)
      ? { ...node?._meta, instructions: image_download_prompt }
      : node?._meta
  }, (key, value) => {
    if (should_skip_copy_key(key, options)) {
      return undefined;
    }

    if (key === 'value') {
      if (typeof value !== 'string') {
        return value;
      }

      if (!value || is_dynamic_value_placeholder(value)) {
        return undefined;
      }

      return value;
    }

    if (key === 'children') {
      return value?.length ? value : undefined;
    }

    if (key === 'description') {
      return value ? value : undefined;
    }

    return value;
  });

  const content_copy_formatter = {
    stringifyNodeForCopy
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = content_copy_formatter;
  }

  globalScope.lanhuContentCopyFormatter = content_copy_formatter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
