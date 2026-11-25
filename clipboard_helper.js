(function(globalScope) {
  'use strict';

  const can_use_clipboard_api = (currentNavigator, currentDocument) => {
    if (!currentNavigator?.clipboard?.writeText) {
      return false;
    }

    const permissionsPolicy = currentDocument?.permissionsPolicy || currentDocument?.featurePolicy;
    if (!permissionsPolicy || typeof permissionsPolicy.allowsFeature !== 'function') {
      return true;
    }

    try {
      return permissionsPolicy.allowsFeature('clipboard-write');
    } catch (error) {
      return true;
    }
  };

  const exec_command_copy = (text, currentDocument) => new Promise((resolve, reject) => {
    if (!currentDocument?.body || typeof currentDocument.createElement !== 'function') {
      reject(new Error('当前环境不支持降级复制'));
      return;
    }

    const textarea = currentDocument.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';

    currentDocument.body.appendChild(textarea);
    textarea.select();

    const copied = typeof currentDocument.execCommand === 'function'
      ? currentDocument.execCommand('copy')
      : false;

    currentDocument.body.removeChild(textarea);

    if (!copied) {
      reject(new Error('execCommand 复制失败'));
      return;
    }

    resolve();
  });

  const copyText = async (text, options = {}) => {
    const currentNavigator = options.navigator || globalScope.navigator;
    const currentDocument = options.document || globalScope.document;

    if (can_use_clipboard_api(currentNavigator, currentDocument)) {
      try {
        await currentNavigator.clipboard.writeText(text);
        return;
      } catch (error) {
        if (!currentDocument) {
          throw error;
        }
      }
    }

    await exec_command_copy(text, currentDocument);
  };

  const clipboard_helper = {
    copyText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = clipboard_helper;
  }

  globalScope.lanhuClipboardHelper = clipboard_helper;
})(typeof globalThis !== 'undefined' ? globalThis : this);
