(function(globalScope) {
  'use strict';

  const { resolveClippedCardRow, resolveSourceBackground, resolveVectorStyles, resolveMergedStyles, resolveDividerStyles, resolveImageStyles, resolvePaddedImage, resolvePageBand, resolveExportedMaskGroup, resolveSourceBox, resolveSourceRadius, resolveOmittedDividers, resolveSourceOverflowOffset, resolvePlacedImage, resolveTextEffects, resolveOutsetTextFrame, resolveFrameBorder, clampTextLineBoxes, keepFlexItemSizes } = typeof module !== 'undefined' && module.exports
    ? require('./vector_style_helper') : globalScope.lanhuVectorStyleHelper;

  const THIS_ITEM_PATTERN = /^this\.item\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/;
  const ITEM_PATTERN = /^item\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/;
  const IMAGE_SCALE_VALUES = new Set([1, 2, 3]);
  const IMAGE_FORMAT_VALUES = new Set(['png', 'jpg', 'webp', 'svg']);

  const is_plain_object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  const remove_image_process = (value) => value
    .replace(/([?&])x-oss-process=[^&]*&?/g, (_, prefix) => (prefix === '?' ? '?' : ''))
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '');

  const get_url_lookup_keys = (value) => {
    if (typeof value !== 'string' || !value) {
      return [];
    }

    const keys = new Set([value, remove_image_process(value)]);

    try {
      const parsedUrl = new URL(value);
      parsedUrl.search = '';
      parsedUrl.hash = '';
      keys.add(parsedUrl.toString());
      keys.add(parsedUrl.pathname);
      keys.add(parsedUrl.pathname.split('/').filter(Boolean).pop() || '');
    } catch (error) {
      const withoutQuery = value.split('?')[0].split('#')[0];
      keys.add(withoutQuery);
      keys.add(withoutQuery.split('/').filter(Boolean).pop() || '');
    }

    return Array.from(keys).filter(Boolean);
  };

  const normalize_image_scale = (value) => {
    const scale = Number(value);
    return IMAGE_SCALE_VALUES.has(scale) ? scale : 1;
  };

  const normalize_image_format = (value) => {
    const format = typeof value === 'string' ? value.toLowerCase() : '';
    return IMAGE_FORMAT_VALUES.has(format) ? format : 'png';
  };

  const IMAGE_INDEX = Symbol('imageIndex');
  const create_empty_image_index = () => Object.defineProperty(Object.create(null), IMAGE_INDEX, { value: new Map() });
  const same_image_info = (a, b) => a && b
    && ['image', 'svg', 'width', 'height'].every((key) => a[key] === b[key]);

  const add_image_info_to_index = (index, key, imageInfo) => {
    if (!imageInfo?.image || typeof key !== 'string') return;
    const exactKeys = new Set([key, remove_image_process(key)]);
    for (const lookupKey of get_url_lookup_keys(key)) {
      const rank = exactKeys.has(lookupKey) ? 2 : 1;
      const previousRank = index[IMAGE_INDEX].get(lookupKey) || 0;
      if (rank > previousRank) index[lookupKey] = imageInfo;
      else if (rank === previousRank && !same_image_info(index[lookupKey], imageInfo)) index[lookupKey] = null;
      index[IMAGE_INDEX].set(lookupKey, Math.max(rank, previousRank));
    }
  };

  const create_image_data_index = (imageData) => {
    if (imageData?.[IMAGE_INDEX]) return imageData;
    if (!is_plain_object(imageData)) {
      return create_empty_image_index();
    }

    return Object.entries(imageData).reduce((index, [key, imageInfo]) => {
      add_image_info_to_index(index, key, imageInfo);

      if (typeof imageInfo?.image === 'string') {
        add_image_info_to_index(index, imageInfo.image, imageInfo);
      }

      return index;
    }, create_empty_image_index());
  };

  const append_image_process = (url, imageInfo, imageScale, imageFormat) => {
    if (typeof url !== 'string' || !url) {
      return url;
    }

    const width = Number(imageInfo?.width);
    const height = Number(imageInfo?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return url;
    }

    const nextWidth = Math.round(width * imageScale);
    const nextHeight = Math.round(height * imageScale);
    const baseUrl = remove_image_process(url);
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}x-oss-process=image/resize,w_${nextWidth},h_${nextHeight}/format,${imageFormat}`;
  };

  const resolve_image_url = (value, imageData, imageScale, imageFormat) => {
    if (typeof value !== 'string' || !is_plain_object(imageData)) {
      return value;
    }

    let imageInfo = null;
    for (const key of get_url_lookup_keys(value)) {
      // A known conflict must not fall through to an even weaker filename alias.
      if (Object.hasOwn(imageData, key) && imageData[key] === null) return value;
      imageInfo = Object.hasOwn(imageData, key) ? imageData[key] : null;
      if (imageInfo) {
        break;
      }
    }

    if (!imageInfo?.image) {
      return value;
    }

    return append_image_process(imageInfo.image, imageInfo, imageScale, imageFormat);
  };

  const resolve_style_image_urls = (value, imageData, imageScale, imageFormat) => {
    if (typeof value !== 'string' || !value.includes('url(')) {
      return value;
    }

    return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (match, quote, imageUrl) => {
      const nextUrl = resolve_image_url(imageUrl, imageData, imageScale, imageFormat);
      return nextUrl === imageUrl ? match : `url(${quote}${nextUrl}${quote})`;
    });
  };

  const resolve_style_image_references = (style, imageData, imageScale, imageFormat) => {
    if (!is_plain_object(style)) {
      return style;
    }

    return Object.entries(style).reduce((result, [key, value]) => {
      result[key] = resolve_style_image_urls(value, imageData, imageScale, imageFormat);
      return result;
    }, {});
  };

  const normalizeImageData = (imageData) => {
    const info = Array.isArray(imageData?.info) ? imageData.info : [];
    const getUrl = (value) => typeof value === 'string' ? value
      : value?.imageUrl || value?.url || value?.src || value?.path || '';
    return info.reduce((index, item) => {
      const image = getUrl(item?.image);
      const ddsImage = getUrl(item?.ddsImage);
      if (!image || (!ddsImage && item.exportable !== true)) return index;
      const exportSize = item.exportable === true ? item.image?.size : null;
      const imageInfo = { image, svg: item.image?.svgUrl,
        width: item.image?.width ?? exportSize?.width ?? item.width ?? item.image_width ?? item.imageWidth,
        height: item.image?.height ?? exportSize?.height ?? item.height ?? item.image_height ?? item.imageHeight };
      if (ddsImage) add_image_info_to_index(index, ddsImage, imageInfo);
      add_image_info_to_index(index, image, imageInfo);
      return index;
    }, create_empty_image_index());
  };

  // Count rendered remote references, not all raw layers or URLs retained as metadata.
  const getImageRewriteStats = (tree, imageData, options = {}) => {
    const index = create_image_data_index(imageData);
    const scale = normalize_image_scale(options.imageScale);
    const format = normalize_image_format(options.imageFormat);
    const stats = { total: 0, rewritten: 0 };
    const count = (url) => {
      if (typeof url !== 'string' || !/^(?:https?:)?\/\//i.test(url)) return;
      stats.total += 1;
      if (url.includes('x-oss-process=image/resize,')
        && resolve_image_url(url, index, scale, format) === url
        && get_url_lookup_keys(url).some((key) => index[key]?.image
          && Number.isFinite(Number(index[key].width))
          && Number.isFinite(Number(index[key].height)))) stats.rewritten += 1;
    };
    const walk = (node) => {
      if (node.type === 'image') count(node.src);
      for (const key of ['background', 'backgroundImage']) {
        const value = node.style?.[key];
        if (typeof value === 'string') {
          for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) count(match[2]);
        }
      }
      for (const child of node.children || []) walk(child);
    };
    for (const node of Array.isArray(tree) ? tree : [tree]) if (node) walk(node);
    return stats;
  };

  // Lanhu exports PostScript-style names (`家族名-字重`), but browsers match `font-family`
  // against the font's family name only, so those names never resolve and silently fall back.
  // The weight is already carried by `fontWeight`, so renaming loses no information.
  const FONT_FAMILY_ALIASES = new Map([
    ['MicrosoftYaHei', { fontFamily: 'Microsoft YaHei' }],
    ['MicrosoftYaHei-Bold', { fontFamily: 'Microsoft YaHei' }],
    ['MicrosoftYaHeiRegular', { fontFamily: 'Microsoft YaHei' }],
    ['MicrosoftYaHeiSemibold', { fontFamily: 'Microsoft YaHei', fontWeight: 600 }],
    ['AlibabaPuHuiTi-Bold', { fontFamily: 'Alibaba PuHuiTi' }],
    ['DIN-Bold', { fontFamily: 'DIN' }],
    ['DINPro-Medium', { fontFamily: 'DINPro' }],
    ['FZFW-QingYinTiS-E--GB1-0', { fontFamily: 'FZFW Qing Yin TiS E' }],
    ['AdobeHeitiStd-Regular', { fontFamily: 'Adobe Heiti Std' }]
  ]);
  // Source files occasionally keep the design tool's placeholder instead of a real font name.
  const FONT_PLACEHOLDERS = new Set(['FontName']);

  // Reports font names the conversion leaves untouched because no platform can resolve them.
  const getFontRewriteStats = (tree) => {
    const stats = { total: 0, placeholders: {} };
    const walk = (node) => {
      const fontFamily = node.style?.fontFamily;
      if (typeof fontFamily === 'string' && fontFamily) {
        stats.total += 1;
        if (FONT_PLACEHOLDERS.has(fontFamily)) stats.placeholders[fontFamily] = (stats.placeholders[fontFamily] || 0) + 1;
      }
      for (const child of node.children || []) walk(child);
    };
    for (const node of Array.isArray(tree) ? tree : [tree]) if (node) walk(node);
    return stats;
  };

  const get_loop_arr = (node) => {
    const arr = node?.loop || node?.loopData;
    return Array.isArray(arr) ? arr : [];
  };

  const get_loop_value = (loopItem, path) => {
    let value = loopItem;
    for (const key of path.split('.')) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)
        || !is_plain_object(value) || !Object.hasOwn(value, key)) return undefined;
      value = value[key];
    }
    return value;
  };

  // Only strict comparisons against literals are understood. Never evaluate schema code.
  const loop_condition_matches = (condition, loopItem) => {
    if (typeof condition !== 'string' || !is_plain_object(loopItem)) return true;
    const match = /^((?:this\.)?item\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*(===|!==)\s*("(?:[^"\\]|\\.)*"|'[^'\\]*'|-?\d+(?:\.\d+)?|true|false|null)$/.exec(condition.trim());
    if (!match) return true;
    const binding = THIS_ITEM_PATTERN.exec(match[1]) || ITEM_PATTERN.exec(match[1]);
    const literal = match[3];
    let expected;
    try {
      expected = literal.startsWith("'") ? literal.slice(1, -1) : JSON.parse(literal);
    } catch (error) {
      return true;
    }
    const equal = get_loop_value(loopItem, binding[1]) === expected;
    return match[2] === '===' ? equal : !equal;
  };

  const resolve_loop_binding = (value, loopItem) => {
    if (typeof value !== 'string' || !is_plain_object(loopItem)) {
      return value;
    }

    const trimmed = value.trim();
    const match = THIS_ITEM_PATTERN.exec(trimmed) || ITEM_PATTERN.exec(trimmed);
    return match ? (get_loop_value(loopItem, match[1]) ?? value) : value;
  };

  const resolve_nested_bindings = (value, loopItem) => {
    if (Array.isArray(value)) {
      return value.map((entry) => resolve_nested_bindings(entry, loopItem));
    }

    if (is_plain_object(value)) {
      const nextValue = {};

      for (const [key, entry] of Object.entries(value)) {
        nextValue[key] = resolve_nested_bindings(entry, loopItem);
      }

      return nextValue;
    }

    return resolve_loop_binding(value, loopItem);
  };

  const get_type = (node) => {
    const type = typeof node.type === 'string' ? node.type.replace(/^lanhu/, '') : '';
    // DDS button/custom/missing types are layout containers, not native controls.
    // Keep their styles and ordered children; do not infer text/images from values.
    return ['page', 'block', 'text', 'image'].includes(type) ? type : 'block';
  };

  const get_class_name = (node) => node.props?.className || node.eleName || '(未命名节点)';

  // DDS can put a dash segment length (source dashPattern) in the CSS style slot.
  // Recognize only that width / positive segment / color dialect, not arbitrary tokens.
  const normalize_dash_border = (value) => {
    if (typeof value !== 'string') return value;
    const match = /^(\d+(?:\.\d+)?(?:px|em|rem|pt)|0)\s+(\d+(?:\.\d+)?)\s+(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|transparent|currentColor)$/i.exec(value.trim());
    if (!match || Number(match[2]) <= 0) return value;
    if (match[3][0] === '#' && ![4, 5, 7, 9].includes(match[3].length)) return value;
    return `${match[1]} dashed ${match[3]}`;
  };

  // An explicit width and visible border style without a color must not paint currentColor.
  // Otherwise only width plus color is normalized; colored styles and variables stay untouched.
  const normalize_border = (value) => {
    if (typeof value !== 'string') return value;
    const colorless = /^(\d+(?:\.\d+)?(?:px|em|rem|pt)|0)\s+(solid|dashed|dotted|double|groove|ridge|inset|outset)\s*$/i.exec(value);
    if (colorless) return `${colorless[1]} ${colorless[2]} transparent`;
    const match = /^(\d+(?:\.\d+)?(?:px|em|rem|pt)|0)\s+(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|transparent|currentColor)$/i.exec(value.trim());
    if (!match) return value;
    if (match[2][0] === '#' && ![4, 5, 7, 9].includes(match[2].length)) return value;
    return `${match[1]} solid ${match[2]}`;
  };

  const ALIGNMENT_COMMON_KEYWORDS = ['normal', 'stretch', 'center', 'start', 'end', 'flex-start', 'flex-end',
    'inherit', 'initial', 'unset', 'revert', 'revert-layer'];
  const ALIGNMENT_KEYWORDS = {
    justifyContent: new Set([...ALIGNMENT_COMMON_KEYWORDS, 'left', 'right', 'space-between', 'space-around', 'space-evenly']),
    alignItems: new Set([...ALIGNMENT_COMMON_KEYWORDS, 'self-start', 'self-end', 'baseline', 'anchor-center']),
    alignContent: new Set([...ALIGNMENT_COMMON_KEYWORDS, 'baseline', 'space-between', 'space-around', 'space-evenly']),
    alignSelf: new Set([...ALIGNMENT_COMMON_KEYWORDS, 'auto', 'self-start', 'self-end', 'baseline', 'anchor-center'])
  };

  const normalize_alignment = (style) => {
    for (const [key, keywords] of Object.entries(ALIGNMENT_KEYWORDS)) {
      const value = style[key];
      if (typeof value !== 'string') continue;
      const keyword = value.toLowerCase();
      // Strip flex- only when the remainder is valid for this property. Unknown dialects stay untouched.
      if (keyword.startsWith('flex-') && keywords.has(keyword.slice(5))) {
        style[key] = value.slice(5);
      }
    }
  };

  // PS/DDS can keep the graphics-editor justification enum in the CSS slot. Map only the
  // known non-CSS keywords; unknown dialects, valid keywords and non-strings stay untouched.
  const TEXT_ALIGN_ENUMS = new Map([
    ['justifyleft', 'left'], ['justifycenter', 'center'], ['justifyright', 'right'],
    ['justifyjustify', 'justify'], ['justifyfull', 'justify'], ['justifyall', 'justify']
  ]);
  const normalize_text_align = (style) => {
    const value = style.textAlign;
    if (typeof value !== 'string') return;
    const mapped = TEXT_ALIGN_ENUMS.get(value.trim().toLowerCase());
    if (mapped) style.textAlign = mapped;
  };

  const normalize_lengths = (style) => Object.fromEntries(Object.entries(style).map(([key, value]) => {
    const lengthKey = /^(?:width|height|minWidth|maxWidth|minHeight|maxHeight|left|right|top|bottom|fontSize|lineHeight|letterSpacing|textIndent|gap|rowGap|columnGap|margin(?:Top|Right|Bottom|Left)?|padding(?:Top|Right|Bottom|Left)?|border(?:Width|TopWidth|RightWidth|BottomWidth|LeftWidth|Radius|TopLeftRadius|TopRightRadius|BottomLeftRadius|BottomRightRadius))$/.test(key);
    if (!lengthKey) return [key, value];
    const number = (value) => Number(value.toFixed(6)) || 0;
    // Preserve legitimate numeric geometry precision; only clean near-zero/integer noise.
    if (typeof value === 'number' && Number.isFinite(value)) return [key,
      Math.abs(value) < 0.0000005 || Math.abs(value - Math.round(value)) < 1e-12 ? number(value) : value];
    if (typeof value !== 'string') return [key, value];
    const token = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px)?$/i;
    const parts = value.trim().split(/\s+/).map((part) => token.exec(part));
    if (!parts.length || parts.length > 4 || !parts.every((part) => part && Number.isFinite(Number(part[1])))) return [key, value];
    if (parts.length === 1 && !parts[0][2]) return [key, number(Number(parts[0][1]))];
    // Normalize only explicit pixel/number lists, never expressions, percentages or other units.
    return [key, parts.map((part) => `${number(Number(part[1])).toLocaleString('en-US', {
      useGrouping: false, maximumFractionDigits: 6
    })}${part[2] || ''}`).join(' ')];
  }));

  // Only resolve px lengths; auto, percentages and expressions need browser layout.
  const pixel_length = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(value.trim())) return null;
    return Number(value.trim().replace(/px$/, ''));
  };

  const box_lengths = (style, key) => {
    const tokens = String(style[key] ?? 0).trim().split(/\s+/).map(pixel_length);
    if (tokens.length > 4 || tokens.some((value) => value === null)) return null;
    const [top, right = top, bottom = top, left = right] = tokens;
    const keys = Object.keys(style);
    return ['Top', 'Right', 'Bottom', 'Left'].map((side, index) =>
      keys.indexOf(`${key}${side}`) > keys.indexOf(key) ? pixel_length(style[`${key}${side}`]) : [top, right, bottom, left][index]);
  };

  const normalize_border_spacing = (node, firstChildOnly = false) => {
    const style = node.style;
    const bounds = node.bounds;
    // Scope to uniform borders and forward, unwrapped flex layouts. Bounds on loop
    // copies are template coordinates, not actual positions, so cannot prove spacing.
    const border = /^(\d+(?:\.\d+)?)px\s+(?:solid|dashed|dotted|double|groove|ridge|inset|outset)\s+.+$/i.exec(style.border || '');
    if (!border || !bounds || style.boxSizing !== 'border-box' || style.display !== 'flex'
      || node.loopExpandedFrom || node.loopTemplate || style.transform
      || style.direction === 'rtl' || style.writingMode && style.writingMode !== 'horizontal-tb'
      || Object.keys(style).some((key) => /^border(?:Top|Right|Bottom|Left|Width|Style)/.test(key) && !key.endsWith('Radius'))
      || !['column', 'row', undefined].includes(style.flexDirection)
      || ![undefined, 'nowrap'].includes(style.flexWrap)
      || pixel_length(style.width) !== bounds.width || pixel_length(style.height) !== bounds.height) return;
    const width = Number(border[1]);
    if (width <= 0) return;
    const padding = box_lengths(style, 'padding');
    if (!padding || padding.some((value) => value === null)) return;
    const close = (a, b) => Math.abs(a - b) < 0.001;
    const column = style.flexDirection === 'column';
    const mainStart = column ? 0 : 3;
    const mainEnd = column ? 2 : 1;
    const crossStart = column ? 3 : 0;
    const crossEnd = column ? 1 : 2;
    const flow = node.children.filter((child) => !['absolute', 'fixed'].includes(child.style.position)
      && child.style.display !== 'none');
    const edge_matches = (child, index) => {
      const margin = child && box_lengths(child.style, 'margin');
      if (!child?.bounds || !margin || margin[index] === null) return false;
      const distance = column
        ? (index === 0 ? child.bounds.top - bounds.top : bounds.top + bounds.height - child.bounds.top - child.bounds.height)
        : (index === 3 ? child.bounds.left - bounds.left : bounds.left + bounds.width - child.bounds.left - child.bounds.width);
      return close(margin[index] + padding[index], distance);
    };
    // Center/end layouts are only provable when both outer edges exactly match:
    // otherwise changing an inner min-content size can introduce flex shrink.
    const justifyStart = ([undefined, 'normal', 'start', 'flex-start', 'space-between'].includes(style.justifyContent)
      || edge_matches(flow[0], mainStart) && edge_matches(flow[flow.length - 1], mainEnd))
      && !flow.some((child) => child.style.order || child.style.flex || child.style.flexGrow);
    for (const child of node.children) {
      if (firstChildOnly && child !== flow[0]) continue;
      const childStyle = child.style;
      const childBounds = child.bounds;
      const margin = box_lengths(childStyle, 'margin');
      if (!childBounds || !margin || margin.some((value) => value === null) || childStyle.transform
        || childStyle.display === 'none' || childStyle.direction === 'rtl'
        || childStyle.position === 'fixed' || childStyle.position === 'relative'
        || childStyle.order || childStyle.flex || childStyle.flexGrow || child.loopExpandedFrom) continue;
      const distances = [childBounds.top - bounds.top,
        bounds.left + bounds.width - childBounds.left - childBounds.width,
        bounds.top + bounds.height - childBounds.top - childBounds.height,
        childBounds.left - bounds.left];
      const sides = ['Top', 'Right', 'Bottom', 'Left'];
      if (childStyle.position === 'absolute') {
        if (!['relative', 'absolute', 'fixed', 'sticky'].includes(style.position)) continue;
        // Absolute offsets also start inside the parent's border, but not padding.
        for (const [index, key] of [[0, 'top'], [1, 'right'], [2, 'bottom'], [3, 'left']]) {
          const offset = pixel_length(childStyle[key]);
          if (offset !== null && close(offset + margin[index], distances[index])) childStyle[key] = offset - width;
        }
        continue;
      }
      const align = childStyle.alignSelf && childStyle.alignSelf !== 'auto' ? childStyle.alignSelf : style.alignItems;
      const edges = [];
      if ([undefined, 'normal', 'stretch', 'start', 'flex-start'].includes(align)) edges.push(crossStart);
      if (['end', 'flex-end'].includes(align)) edges.push(crossEnd);
      if (justifyStart && child === flow[0]) edges.push(mainStart);
      if (justifyStart && child === flow[flow.length - 1]) edges.push(mainEnd);
      for (const index of edges) {
        // A correct content-origin margin differs by border width, and stays intact.
        if (close(margin[index] + padding[index], distances[index])) {
          const key = `margin${sides[index]}`;
          delete childStyle[key]; // Emit the correction after any existing shorthand.
          childStyle[key] = margin[index] - width;
        }
      }
    }
  };

  const normalize_loop_gutter = (node, children, style) => {
    const template = node.children?.[0];
    // DDS sometimes omits nthConfig on a single-row loop. Infer only the final
    // gutter when the exact fixed-width equation proves it is the overflow.
    const paintOnly = (raw) => [raw?.styleObj, raw?.props?.styleObj].every(overrides =>
      Object.keys(overrides || {}).every(key => ['background', 'backgroundImage', 'backgroundColor', 'color'].includes(key)));
    if (node.children?.length !== 1 || template?.condition || template?.loopType
      || !paintOnly(node) || !paintOnly(template)
      || children.length < 2 || style.display !== 'flex' || style.flexDirection !== 'row'
      || style.justifyContent !== 'space-between' || ![undefined, 'nowrap'].includes(style.flexWrap)
      || style.direction !== undefined && style.direction !== 'ltr' || style.writingMode || style.transform
      || style.minWidth !== undefined || style.maxWidth !== undefined
      || Object.keys(style).some((key) => /^(?:padding|border|gap|rowGap|columnGap)/.test(key)
        && ![0, '0', '0px', 'none', undefined].includes(style[key]))) return;
    const width = pixel_length(style.width);
    const itemWidth = pixel_length(children[0].style.width);
    const gutter = box_lengths(children[0].style, 'margin')?.[1];
    if (!(width > 0) || !(itemWidth > 0) || !(gutter > 0)
      || Math.abs(children.length * itemWidth + (children.length - 1) * gutter - width) > 1e-6
      || children.some((child) => {
        const s = child.style;
        const margin = box_lengths(s, 'margin');
        return pixel_length(s.width) !== itemWidth || !margin || margin[1] !== gutter || margin[3] !== 0
          || s.boxSizing !== 'border-box' || s.display === 'none'
          || ![undefined, 'static', 'relative'].includes(s.position) || s.transform
          || ['left', 'right', 'top', 'bottom', 'inset', 'translate', 'rotate', 'scale'].some(key => s[key] !== undefined)
          || s.direction !== undefined && s.direction !== 'ltr'
          || ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'minWidth', 'maxWidth', 'order'].some((key) => s[key] !== undefined);
      })) return;
    const last = children[children.length - 1].style;
    delete last.marginRight;
    last.marginRight = 0;
  };

  const resolve_inline_row_widths = (node, index) => {
    const styleOf = raw => raw.props?.style || raw.style || {};
    const safe = raw => raw && !raw.loopType && !raw.condition
      && !Object.keys(raw.styleObj || {}).length && !Object.keys(raw.props?.styleObj || {}).length
      && [undefined, 'static'].includes(styleOf(raw).position)
      && ['transform', 'translate', 'scale', 'rotate', 'direction', 'writingMode', 'order',
        'minWidth', 'maxWidth', 'flex', 'flexBasis', 'flexGrow', 'flexShrink'].every(key => styleOf(raw)[key] === undefined)
      && (raw.children === undefined || Array.isArray(raw.children) && raw.children.every(safe));
    const style = styleOf(node), box = node.rowDims, children = node.children;
    const close = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6;
    const emptyEdges = (s, key) => box_lengths(s, key)?.every(value => value === 0);
    if (!safe(node) || !box || !Array.isArray(children) || children.length < 4
      || style.display !== 'flex' || style.flexDirection !== 'row'
      || ![undefined, 'nowrap'].includes(style.flexWrap)
      || ![undefined, 'normal', 'start', 'flex-start'].includes(style.justifyContent)
      || ![undefined, 'normal', 'stretch', 'start', 'flex-start'].includes(style.alignItems)
      || !close(pixel_length(style.width), box.width) || !emptyEdges(style, 'padding')
      || Object.keys(style).some(key => /^(?:border(?!.*Radius$)|gap|rowGap|columnGap)/.test(key)
        && ![undefined, 0, '0', '0px', 'none'].includes(style[key]))) return null;
    const entries = children.map(raw => index?.[`inline:${raw.layerId}`]);
    if (entries.some(entry => !entry) || entries.filter(entry => entry.kind === 'text').length < 3
      || entries.filter(entry => entry.kind === 'paint').length !== 1) return null;
    const sameText = (raw, entry) => raw.type === 'lanhutext' && entry.kind === 'text'
      && (raw.data?.value ?? raw.props?.text ?? raw.value) === entry.text
      && styleOf(raw).whiteSpace === 'nowrap' && !raw.children?.length;
    const corrections = [];
    let cursor = box.left;
    for (let i = 0; i < children.length; i++) {
      const raw = children[i], entry = entries[i], s = styleOf(raw), f = entry.frame;
      const margins = box_lengths(s, 'margin');
      if (!margins || margins.some(value => value === null || value < 0)
        || ![undefined, 'border-box'].includes(s.boxSizing)
        || ![undefined, 'auto', 'normal', 'stretch', 'start', 'flex-start'].includes(s.alignSelf)
        || Object.keys(s).some(key => /^border(?!.*Radius$)/.test(key) && ![0, '0', '0px', 'none'].includes(s[key]))
        || !raw.rowDims || !['left', 'top', 'width', 'height'].every((key, j) => close(raw.rowDims[key], f[['x', 'y', 'width', 'height'][j]]))
        || !close(pixel_length(raw.style?.width), f.width)
        || s.width !== undefined && !close(pixel_length(s.width), f.width)
        || !close(f.x, cursor + margins[3]) || !close(f.y, box.top + margins[0])) return null;
      cursor += margins[3] + f.width + margins[1];
      if (entry.kind === 'text') {
        if (!sameText(raw, entry) || !emptyEdges(s, 'padding')) return null;
      } else {
        // A real paint span anchors the row. Preserve its original URL and layout;
        // all inner slots must belong to that same source group and stay inside it.
        const url = /^url\(\s*(['"]?)(.*?)\1\s*\)\s+100%\s+no-repeat$/.exec(s.background || '');
        const padding = box_lengths(s, 'padding');
        if (raw.type !== 'lanhublock' || !url || url[2] !== entry.image || s.backgroundSize !== '100% 100%'
          || s.display !== 'flex' || s.flexDirection !== 'column' || !padding || padding.some(value => value === null || value < 0)
          || !close(f.height, box.height) || !Array.isArray(raw.children) || !raw.children.length) return null;
        const nested = raw.children.map(child => index?.[`inline:${child.layerId}`]);
        if (nested.some((proof, j) => {
          const child = raw.children[j], b = child.rowDims;
          return !proof || !entry.parentId || proof.parentId !== entry.parentId || !b || child.children?.length
            || !close(b.left, proof.frame.x) || !close(b.top, proof.frame.y) || !close(b.width, proof.frame.width)
            || proof.frame.x < f.x || proof.frame.x + proof.frame.width > f.x + f.width
            || proof.frame.y < f.y || proof.frame.y + proof.frame.height > f.y + f.height
            || proof.kind === 'text' && !sameText(child, proof);
        }) || !nested.some(proof => proof.kind === 'text' && close(proof.frame.x, f.x + padding[3])
          && close(proof.frame.width + padding[3] + padding[1], f.width))) return null;
      }
      if (s.width === undefined) corrections.push([raw, { width: f.width }]);
    }
    return close(cursor, box.left + box.width) ? corrections : null;
  };

  // A DDS rich-text wrapper represents one painted source text layer, unlike
  // an ordinary layout group. Keep its runs in that layer's source paint order.
  const is_source_split_text = (node, style, options) => {
    const entry = options.layerDataIndex?.[`inline:${node.layerId}`];
    const children = node.children, box = node.rowDims;
    const plain = value => typeof value === 'string' && !/[<>]|&(?!nbsp;)/i.test(value)
      && !THIS_ITEM_PATTERN.test(value) ? value.replace(/&nbsp;|\u00a0/gi, ' ') : null;
    if (node.type !== 'lanhublock' || entry?.kind !== 'text' || !options.sourceSchema
      || !['flex', 'inline-flex'].includes(options.parentStyle?.display)
      || ![undefined, 'static'].includes(style.position)
      || ![undefined, 'block', 'inline', 'inline-block'].includes(style.display)
      || node.loopType || node.condition || Object.keys(node.styleObj || {}).length
      || Object.keys(node.props?.styleObj || {}).length || !box
      || !['left', 'top', 'width', 'height'].every((key, i) => box[key] === entry.frame[['x', 'y', 'width', 'height'][i]])
      || !['width', 'height'].every(key => pixel_length(style[key]) === box[key])
      || !Array.isArray(children) || children.length < 2
      || plain(node.data?.value) === null || plain(node.data.value) !== plain(entry.text)) return false;
    let occurrences = 0;
    const count = current => {
      if (current.layerId === node.layerId) occurrences++;
      if (Array.isArray(current.children)) current.children.forEach(count);
    };
    count(options.sourceSchema);
    if (occurrences !== 1) return false;
    // DDS may omit whitespace-only runs. Compare visible content without
    // changing the emitted text; the wrapper must still match the full source.
    return children.every(child => {
      const s = child?.props?.style || child?.style || {};
      return child?.type === 'lanhutext' && !child.children?.length && !child.loopType && !child.condition
        && !Object.keys(child.styleObj || {}).length && !Object.keys(child.props?.styleObj || {}).length
        && plain(child.data?.value) !== null
        && ['left', 'top', 'width', 'height'].every(key => child.rowDims?.[key] === box[key])
        && [undefined, 'static'].includes(s.position)
        && [undefined, 'auto'].includes(s.zIndex) && [undefined, 'auto'].includes(child.style?.zIndex)
        && !Object.keys(s).some(key => /^(?:transform|translate|rotate|scale|opacity|filter|backdropFilter|isolation|mixBlendMode|mask|clip|contain|willChange|background|border|outline|boxShadow)/.test(key));
    }) && children.map(child => plain(child.data.value)).join('').replace(/\s+/g, '')
      === plain(entry.text).replace(/\s+/g, '');
  };

  const normalize_text_run_font = (node, style) => {
    const size = pixel_length(node.style?.fontSize);
    const line = pixel_length(style.lineHeight);
    const children = node.children;
    const keys = ['left', 'top', 'width', 'height'];
    // DDS code generation zeros the wrapper font, but keeps a positive line-height.
    // Its strut then enlarges multiline line boxes. Use the original source font only
    // for a complete, same-size split of that frame in one family (weights may differ).
    if (node.type !== 'lanhublock' || pixel_length(style.fontSize) !== 0 || !(size > 0) || !(line > 0)
      || node.loopType || node.condition || Object.keys(node.styleObj || {}).length
      || Object.keys(node.props?.styleObj || {}).length
      || !keys.every((key) => Number.isFinite(node.rowDims?.[key]))
      || node.style.fontFamily !== style.fontFamily || pixel_length(node.style.lineHeight) !== line
      || !Array.isArray(children) || children.length < 2 || typeof node.data?.value !== 'string'
      || children.map((child) => child?.data?.value).join('') !== node.data.value) return;
    const family = (value) => typeof value === 'string'
      ? value.replace(/-(?:Regular|Medium|SemiBold|DemiBold|Bold|Light|Thin|Heavy|Black)$/i, '').toLowerCase() : null;
    const matches = children.every((child) => {
      const childStyle = child?.props?.style || child?.style;
      return child?.type === 'lanhutext' && !child.condition && !child.loopType
        && typeof child.data?.value === 'string' && !THIS_ITEM_PATTERN.test(child.data.value)
        && !Object.keys(child.styleObj || {}).length && !Object.keys(child.props?.styleObj || {}).length
        && keys.every((key) => child.rowDims?.[key] === node.rowDims[key])
        && pixel_length(childStyle?.fontSize) === size && pixel_length(childStyle?.lineHeight) === line
        && family(childStyle?.fontFamily) !== null && family(childStyle.fontFamily) === family(style.fontFamily);
    });
    if (matches) style.fontSize = size;
  };

  // An empty export is not a painted group. Only undo our source-order fallback:
  // explicit generated/source-only z values and independent paint/isolation stay intact.
  const remove_empty_paint_order = (source, node) => {
    const style = node.style;
    if (!is_plain_object(source.props?.style) || !Number.isInteger(source.style?.zIndex)
      || source.style.zIndex <= 0 || style.zIndex !== source.style.zIndex
      || [source.props.style, source.styleObj, source.props.styleObj].some((entry) => entry?.zIndex !== undefined)
      || ['fixed', 'sticky'].includes(style.position)) return;
    const independentPaint = Object.entries(style).some(([key, value]) => {
      if (value === undefined || value === null || value === '') return false;
      if (['background', 'backgroundColor', 'backgroundImage'].includes(key)) {
        return !['none', 'transparent'].includes(value);
      }
      return /^(?:border(?!.*Radius$)|outline|boxShadow|textShadow|opacity|transform|translate|rotate|scale|perspective|filter|backdropFilter|isolation|mixBlendMode|mask|clipPath|contain|containerType|contentVisibility|willChange)/.test(key);
    });
    if (!independentPaint) delete style.zIndex;
  };

  // DDS can use a source bitmap leaf as a layout parent for unrelated higher
  // layers. Its fallback index orders only that bitmap, not the synthetic group.
  const separate_reparented_bitmap_paint = (node, style, options) => {
    const source = options.layerDataIndex?.[`bitmapLeaf:${node.layerId}`];
    const raw = node.props?.style;
    const box = node.rowDims;
    if (!source || !options.sourceSchema || node.type !== 'lanhublock' || !node.children?.length
      || !raw || raw.zIndex !== undefined || !Number.isInteger(node.style?.zIndex) || node.style.zIndex <= 0
      || style.zIndex !== node.style.zIndex || style.position !== 'absolute' || !box
      || !['left', 'top', 'width', 'height'].every((key, i) => box[key] === source.frame[['x', 'y', 'width', 'height'][i]])
      || !['width', 'height'].every((key) => pixel_length(style[key]) === box[key])
      || style.backgroundSize !== '100% 100%'
      || Object.keys(style).some((key) => !['background', 'backgroundSize'].includes(key)
        && /^(?:background|border|outline|boxShadow|textShadow|opacity|transform|translate|rotate|scale|perspective|filter|backdropFilter|isolation|mixBlendMode|mask|clip|contain|containerType|contentVisibility|willChange|overflow)/.test(key))) return null;
    const match = /^url\(\s*(['"]?)(.*?)\1\s*\)\s+100%\s+no-repeat$/.exec(raw.background || '');
    if (!match || match[2] !== source.image) return null;
    let occurrences = 0;
    const count = (current) => {
      if (current.layerId === node.layerId) occurrences++;
      if (Array.isArray(current.children)) current.children.forEach(count);
    };
    count(options.sourceSchema);
    if (occurrences !== 1) return null;
    const independent = (current) => {
      if (!current || current.loopType || current.condition
        || current.children !== undefined && !Array.isArray(current.children)
        || Object.keys(current.styleObj || {}).length || Object.keys(current.props?.styleObj || {}).length
        || [current.data?.value, current.props?.src, current.props?.text, current.value]
          .some((value) => typeof value === 'string' && /^\s*(?:this\.)?item(?:\.|\[)/.test(value))) return false;
      if (current !== node) {
        const generated = current.props?.style || current.style || {};
        const z = current.style?.zIndex;
        const draws = ['lanhutext', 'lanhuimage'].includes(current.type)
          || Object.keys(generated).some((key) => /^(?:background|border(?!.*Radius$)|outline|boxShadow|textShadow)/.test(key));
        if (['fixed', 'sticky'].includes(generated.position) || current.props?.style?.zIndex !== undefined
          || draws && (!Number.isInteger(z) || z <= node.style.zIndex)
          || z !== undefined && z !== 'auto' && (!Number.isInteger(z) || z <= node.style.zIndex)) return false;
        if (Object.keys(generated).some((key) => /^(?:opacity|transform|translate|rotate|scale|perspective|filter|backdropFilter|isolation|mixBlendMode|mask|clip|contain|containerType|contentVisibility|willChange)/.test(key))) return false;
      }
      return (current.children || []).every(independent);
    };
    if (!independent(node)) return null;
    const layoutStyle = { ...style };
    for (const key of ['zIndex', 'background', 'backgroundSize']) delete layoutStyle[key];
    return { style: layoutStyle, decorations: [{ position: 'absolute', left: 0, top: 0,
      width: box.width, height: box.height, background: style.background,
      backgroundSize: style.backgroundSize, zIndex: style.zIndex, pointerEvents: 'none' }],
      convertedFrom: { sourceImage: source.image, sourceStyle: { ...style } } };
  };

  const get_style = (node, loopContext, options) => {
    const baseStyle = is_plain_object(node.props?.style)
      ? node.props.style
      : (is_plain_object(node.style) ? node.style : {});

    const styleObj = is_plain_object(node.styleObj) ? node.styleObj : {};
    const propStyleObj = is_plain_object(node.props?.styleObj) ? node.props.styleObj : {};

    const style = {
      ...baseStyle,
      ...resolve_nested_bindings(styleObj, loopContext?.item),
      ...resolve_nested_bindings(propStyleObj, loopContext?.item),
      ...(!loopContext && options.sourceLayoutStyles?.get(node))
    };

    // Generated props can omit the source paint order. Restore only painted nodes
    // where CSS z-index is effective; synthetic, unpainted layout wrappers must not
    // create stacking contexts that trap a header below a later sidebar wrapper.
    const hasPaint = ['lanhutext', 'lanhuimage'].includes(node.type)
      || !loopContext && is_source_split_text(node, style, options)
      || ['background', 'backgroundColor', 'backgroundImage'].some((key) => typeof style[key] === 'string'
        && style[key].trim() && !/^(?:none|transparent)$/i.test(style[key].trim())
        && !/^rgba\([^()]*,\s*0(?:\.0+)?\s*\)$/i.test(style[key].trim()));
    if (style.zIndex === undefined && Number.isInteger(node.style?.zIndex) && node.style.zIndex > 0
      && hasPaint && (['relative', 'absolute', 'fixed', 'sticky'].includes(style.position)
        || ['flex', 'inline-flex'].includes(options.parentStyle?.display))) style.zIndex = node.style.zIndex;

    // DDS grid templates encode trailing gutter resets as nthConfig, not styleObj.
    // Only a single unconditional template has a provable emitted sibling position.
    if (options.loopPosition && Array.isArray(node.nthConfig)) {
      const { index, count } = options.loopPosition;
      for (const rule of node.nthConfig) {
        if (typeof rule !== 'string') continue;
        const nth = /^nth-child\(([1-9]\d*)n\)$/.exec(rule);
        const last = /^nth-last-child\(-n\+([1-9]\d*)\)$/.exec(rule);
        if (nth && (index + 1) % Number(nth[1]) === 0) {
          delete style.marginRight;
          style.marginRight = 0;
        }
        if (last && count - index <= Number(last[1])) {
          delete style.marginBottom;
          style.marginBottom = 0;
        }
      }
    }
    normalize_alignment(style);
    normalize_text_align(style);
    if (!loopContext) normalize_text_run_font(node, style);
    const singleLine = !loopContext && options.layerDataIndex?.[`inline:${node.layerId}`];
    if (singleLine?.fixedLine && node.type === 'lanhutext' && node.props?.lines === 1
      && !node.loopType && !node.condition && !node.children?.length
      && !Object.keys(node.styleObj || {}).length && !Object.keys(node.props?.styleObj || {}).length
      && node.style?.whiteSpace === undefined && style.whiteSpace === undefined && style.overflowWrap === 'break-word'
      && options.parentStyle?.display === 'flex' && options.parentStyle.flexDirection === 'row'
      && (node.data?.value ?? node.props?.text ?? node.value) === singleLine.text
      && !/[<>]|^\s*(?:this\.)?item(?:\.|\[)/.test(singleLine.text)
      && ['left', 'top', 'width', 'height'].every((key, i) => node.rowDims?.[key] === singleLine.frame[['x', 'y', 'width', 'height'][i]])
      && ['width', 'height'].every((key) => pixel_length(style[key]) === singleLine.frame[key])
      && pixel_length(style.lineHeight) === singleLine.fixedLine.height
      && pixel_length(style.fontSize) === singleLine.fixedLine.fontSize) style.whiteSpace = 'nowrap';
    const pointText = !loopContext && options.layerDataIndex?.[`pointText:${node.layerId}`];
    const hardBreakText = node.data?.value ?? node.props?.text ?? node.value;
    if (pointText && options.sourceSchema && node.type === 'lanhutext'
      && !node.loopType && !node.condition && !node.children?.length
      && !Object.keys(node.styleObj || {}).length && !Object.keys(node.props?.styleObj || {}).length
      && node.style?.whiteSpace === undefined && style.whiteSpace === undefined
      && style.overflowWrap === 'break-word' && typeof hardBreakText === 'string'
      && /<br\s*\/?\s*>/i.test(hardBreakText)
      && !/[<>&\r\n]/.test(hardBreakText.replace(/<br\s*\/?\s*>/gi, ''))
      && hardBreakText.replace(/<br\s*\/?\s*>/gi, '\n') === pointText.text
      && ['left', 'top', 'width', 'height'].every((key, i) => node.rowDims?.[key] === pointText.frame[['x', 'y', 'width', 'height'][i]])
      && ['width', 'height'].every(key => pixel_length(style[key]) === pointText.frame[key])
      && pixel_length(style.fontSize) === pointText.fontSize && style.fontFamily === pointText.fontFamily) {
      let occurrences = 0;
      const count = current => {
        if (current.layerId === node.layerId) occurrences++;
        if (Array.isArray(current.children)) current.children.forEach(count);
      };
      count(options.sourceSchema);
      if (occurrences === 1) style.whiteSpace = 'nowrap';
    }
    for (const key of ['border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'outline']) {
      if (Object.hasOwn(style, key)) style[key] = normalize_dash_border(style[key]);
    }
    if (Object.hasOwn(style, 'border')) style.border = normalize_border(style.border);
    const resolved = resolve_style_image_references(style, options.imageData, options.imageScale, options.imageFormat);
    const background = !loopContext && options.sourceSchema
      && resolveSourceBackground(node, options.layerDataIndex, options.sourceSchema);
    if (background) {
      const paint = background.style || { background: `url("${append_image_process(background.image,
        background.frame, options.imageScale, options.imageFormat)}") 100% no-repeat` };
      return { style: { ...resolved, ...paint }, convertedFrom: { sourceImage: background.sourceImage,
        sourceStyle: { ...style }, ...(background.exportLayerId ? { exportLayerId: background.exportLayerId } : {}) } };
    }
    const exported = !loopContext && node.type !== 'lanhuimage' && (options.completeExports?.get(node)
      || resolveExportedMaskGroup(node, options.layerDataIndex, null));
    if (exported) {
      const image = append_image_process(exported.image, exported.paintFrame || exported.frame, options.imageScale, options.imageFormat);
      const convertedFrom = { sourceImage: exported.sourceImage, sourceBackgroundSize: style.backgroundSize,
        sourceStyle: { ...style }, exportLayerId: exported.exportLayerId,
        ...(exported.rasterizedText?.length ? { rasterizedText: exported.rasterizedText } : {}) };
      if (exported.paintFrame) {
        const nextStyle = { ...resolved };
        for (const key of ['background', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'border']) delete nextStyle[key];
        if (![ 'relative', 'absolute', 'fixed', 'sticky' ].includes(nextStyle.position)) nextStyle.position = 'relative';
        return { style: nextStyle, flattened: true, convertedFrom, decorations: [{ position: 'absolute',
          left: exported.paintFrame.x - exported.frame.x, top: exported.paintFrame.y - exported.frame.y,
          width: exported.paintFrame.width, height: exported.paintFrame.height, pointerEvents: 'none',
          background: `url("${image}") 100% no-repeat`, backgroundSize: '100% 100%' }] };
      }
      const nextStyle = { ...resolved };
      delete nextStyle.backgroundImage;
      return { style: { ...nextStyle, background: `url("${image}") 100% no-repeat` }, flattened: true, convertedFrom };
    }
    const reparented = !loopContext && separate_reparented_bitmap_paint(node, resolved, options);
    if (reparented) return reparented;
    // Do not flatten multiple independent background declarations or layers.
    const keys = ['background', 'backgroundImage'].filter((key) => typeof style[key] === 'string' && style[key].includes('url('));
    // DDS flattens a gradient stroke into a solid border. Restore the proven paint only for
    // the matching stroke-only rectangle; the border declaration stays so spacing rules still see it.
    const restore_gradient_stroke = (node, style) => {
      const stroke = node.type === 'lanhublock' && options.layerDataIndex?.[`gradientStroke:${node.layerId}`];
      if (!stroke) return null;
      const border = /^(\d+(?:\.\d+)?)px\s+solid\s+(?:#[\da-f]{3,8}|rgba?\([^()]*\)|transparent|currentColor)$/i
        .exec(String(style.border ?? '').trim());
      if (!border || Math.abs(Number(border[1]) - stroke.width) > 0.001) return null;
      if (Object.keys(style).some((key) => /^border(?:Image|TopWidth|RightWidth|BottomWidth|LeftWidth|TopStyle|RightStyle|BottomStyle|LeftStyle|Radius|TopLeftRadius|TopRightRadius|BottomLeftRadius|BottomRightRadius|Top|Right|Bottom|Left)$/.test(key))) return null;
      const close = (value, expected) => pixel_length(value) !== null
        && Math.abs(pixel_length(value) - expected) < 0.001;
      if (!close(style.width, stroke.frame.width) || !close(style.height, stroke.frame.height)) return null;
      return { ...style, borderImage: `${stroke.paint} 1` };
    };
    // A map info card is exported as one bitmap that covers the silhouette and the pointer
    // below its bottom edge, so a fixed-size slice stretches the pointer with the content.
    // The card keeps its own translucent fill and paints the proven shape instead: the ring
    // as three inset shadows plus a gapped bottom edge, and the pointer arms as the borders
    // of one absolute decoration. No layout value changes.
    const restore_notch_card = (node, style, resolvedStyle, options) => {
      const card = node.type === 'lanhublock' && options.layerDataIndex?.[`notch:${node.layerId}`];
      if (!card) return null;
      const source = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(String(style.background ?? style.backgroundImage ?? ''));
      if (!source || source[2] !== card.image) return null;
      const conflicts = ['backgroundImage', 'backgroundColor', 'border', 'borderImage', 'borderRadius',
        'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
        'outline', 'outlineOffset', 'boxShadow', 'clipPath', 'mask', 'maskImage', 'overflow',
        'opacity', 'transform', 'filter', 'backdropFilter'];
      if (Object.keys(style).some((key) => conflicts.includes(key) && style[key] !== undefined
        && !['none', 'transparent', '', 'visible'].includes(String(style[key]).trim()))) return null;
      const close = (value, expected) => pixel_length(value) !== null
        && Math.abs(pixel_length(value) - expected) <= 0.5;
      if (!close(style.width, card.box.width) || !close(style.height, card.box.height)) return null;
      // The pointer band is whatever the box has below the source body, so the drawn edge
      // lands on the declared box instead of the rounded export extent.
      const depth = Number((pixel_length(style.height) - card.body).toFixed(6));
      if (!(depth > 1) || depth > card.body / 2) return null;
      const spread = `${depth}px`;
      const silhouette = 'polygon(0 0, 100% 0, '
        + `100% calc(100% - ${spread}), calc(50% + ${spread}) calc(100% - ${spread}), 50% 100%, `
        + `calc(50% - ${spread}) calc(100% - ${spread}), 0 calc(100% - ${spread}))`;
      const border = `${card.border}px`;
      const nextStyle = { ...resolvedStyle };
      for (const key of ['background', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat']) delete nextStyle[key];
      if (!['relative', 'absolute', 'fixed', 'sticky'].includes(nextStyle.position)) nextStyle.position = 'relative';
      // The card paints its own translucent fill inside the silhouette; the ring is three
      // inset shadows (no bottom line) plus a bottom edge whose middle is open for the
      // pointer, and the pointer arms are borders of a rotated square.
      Object.assign(nextStyle, {
        backgroundColor: card.fill,
        clipPath: silhouette,
        boxShadow: [`inset 0 ${border} 0 0 ${card.stroke}`, `inset ${border} 0 0 0 ${card.stroke}`,
          `inset -${border} 0 0 0 ${card.stroke}`].join(', '),
        backgroundImage: `linear-gradient(to right, ${card.stroke} 0 calc(50% - ${spread}), `
          + `transparent calc(50% - ${spread}) calc(50% + ${spread}), ${card.stroke} calc(50% + ${spread}) 100%)`,
        backgroundSize: '100% 1px',
        backgroundPosition: `left calc(100% - ${spread})`,
        backgroundRepeat: 'no-repeat'
      });
      const side = Number((depth * Math.SQRT2).toFixed(6));
      return { style: nextStyle,
        convertedFrom: { sourceImage: card.image, sourceBackgroundSize: style.backgroundSize,
          sourceStyle: { ...style } },
        decorations: [{ position: 'absolute', left: '50%', bottom: depth,
          width: side, height: side, pointerEvents: 'none',
          transform: 'translate(-50%, 50%) rotate(45deg)',
          clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
          borderRight: `${border} solid ${card.stroke}`,
          borderBottom: `${border} solid ${card.stroke}` }] };
    };

    if (keys.length !== 1) {
      return { style: restore_gradient_stroke(node, resolved) || resolved };
    }
    const notchCard = restore_notch_card(node, style, resolved, options);
    if (notchCard) return notchCard;
    const key = keys[0];
    // Conversion may replace a shorthand and reset its color. Keep independent background
    // paint untouched until the converter can preserve its compositing with translucent images.
    const independentPaint = [style.backgroundColor,
      key === 'backgroundImage' ? style.background : style.backgroundImage];
    if (independentPaint.some((value) => value !== undefined && value !== null && value !== ''
      && value !== 'none' && value !== 'transparent')) return { style: resolved };
    const vectorStyles = resolveVectorStyles(style[key], options.layerDataIndex, style)
      || resolveVectorStyles(resolved[key], options.layerDataIndex, style)
      || resolveMergedStyles(style[key], options.layerDataIndex, node.layerId,
        { width: node.style?.width, height: node.style?.height, ...style }, node.children);
    if (!vectorStyles) return { style: resolved };
    delete resolved.background;
    delete resolved.backgroundImage;
    delete resolved.backgroundSize;
    delete resolved.backgroundRepeat;
    const { decorationNodes, ...paintStyles } = vectorStyles;
    return { style: { ...resolved, ...paintStyles,
      ...(style.boxSizing !== undefined ? { boxSizing: style.boxSizing } : {}) },
      emptyPaint: Object.keys(vectorStyles).length === 0,
      convertedFrom: { sourceImage: /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(style[key])?.[2],
        sourceBackgroundSize: style.backgroundSize, sourceStyle: { ...style } },
      decorations: Array.isArray(decorationNodes) ? decorationNodes.map((decoration) =>
        resolve_style_image_references(decoration, options.imageData, options.imageScale, options.imageFormat)) : [] };
  };

  const get_scoped_loop_context = (node, loopContext) => {
    if (!loopContext) {
      return null;
    }

    const scopedLoop = Array.isArray(node?.loop) ? node.loop : [];
    const scopedItem = scopedLoop[loopContext.index];

    if (is_plain_object(scopedItem)) {
      return {
        index: loopContext.index,
        item: scopedItem
      };
    }

    return loopContext;
  };

  const build_children = (node, loopContext, parseNode, options) => {
    const rawChildren = Array.isArray(node.children) ? node.children : [];
    const loopArr = node.loopType === true ? get_loop_arr(node) : [];

    if (loopArr.length > 0) {
      const children = [];

      for (let index = 0; index < loopArr.length; index += 1) {
        const nextLoopContext = {
          index,
          item: loopArr[index]
        };

        for (const [childIndex, child] of rawChildren.entries()) {
          const parsedChild = parseNode(child, nextLoopContext, {
            ...options, treePath: `${options.treePath}/l${index}/c${childIndex}`,
            loopPosition: rawChildren.length === 1 && !child?.condition
              ? { index, count: loopArr.length } : null
          });
          if (parsedChild) {
            children.push(parsedChild);
          }
        }
      }

      normalize_loop_gutter(node, children, options.parentStyle);
      return children;
    }

    return rawChildren.map((child, index) => parseNode(child, loopContext, {
      ...options, treePath: `${options.treePath}/c${index}`
    })).filter(Boolean);
  };

  const parseNode = (node, loopContext = null, options = {}) => {
    if (!node || typeof node !== 'object' || options.omittedArtworkNodes?.has(node)) {
      return null;
    }

    const parseOptions = {
      imageData: options.imageDataIndexed
        ? options.imageData
        : create_image_data_index(options.imageData),
      imageDataIndexed: true,
      imageScale: normalize_image_scale(options.imageScale),
      imageFormat: normalize_image_format(options.imageFormat),
      layerDataIndex: options.layerDataIndex,
      sourceSchema: options.sourceSchema,
      sourceLayoutStyles: options.sourceLayoutStyles,
      completeExports: options.completeExports,
      omittedArtworkNodes: options.omittedArtworkNodes,
      treePath: `${options.treePath || '0'}:${encodeURIComponent(node.id || node.layerId || '')}`
    };
    const type = get_type(node);
    const scopedLoopContext = get_scoped_loop_context(node, loopContext);
    if (!loop_condition_matches(node.condition, scopedLoopContext?.item)) return null;
    const resolvedStyle = get_style(node, scopedLoopContext,
      { ...parseOptions, loopPosition: options.loopPosition, parentStyle: options.parentStyle });
    const nextNode = {
      treeKey: parseOptions.treePath,
      id: typeof node.id === 'string' ? node.id : '',
      type,
      className: get_class_name(node),
      style: resolvedStyle.style,
      children: []
    };

    const boundsKeys = ['left', 'top', 'width', 'height'];
    if (boundsKeys.every((key) => typeof node.rowDims?.[key] === 'number' && Number.isFinite(node.rowDims[key]))) {
      nextNode.bounds = Object.fromEntries(boundsKeys.map((key) => [key, node.rowDims[key]]));
    }
    if (typeof node.layerId === 'string' && node.layerId) nextNode.layerId = node.layerId;
    if (resolvedStyle.convertedFrom) nextNode.convertedFrom = resolvedStyle.convertedFrom;

    if (node.loopType === true) {
      const count = get_loop_arr(node).length;
      if (count > 0) {
        nextNode.loopExpandedFrom = node.layerId || node.id || '(anonymous)';
        nextNode.loopItemCount = count;
      } else {
        nextNode.loopTemplate = true;
      }
    }

    if (type === 'text') {
      const text = node.data?.value ?? node.props?.text ?? node.value ?? '';
      nextNode.text = resolve_loop_binding(text, scopedLoopContext?.item);
      nextNode.textFormat = 'html';
      nextNode.style.display = 'inline';
      const textEffects = resolveTextEffects(node, nextNode, parseOptions.layerDataIndex);
      if (textEffects) {
        for (const key of textEffects.drop) delete nextNode.style[key];
        Object.assign(nextNode.style, textEffects.style);
      }
      const frameStroke = resolveOutsetTextFrame(node, nextNode, parseOptions.layerDataIndex);
      if (frameStroke) Object.assign(nextNode.style, frameStroke);
    }

    let imageDecorations = [];
    let emptyPaint = resolvedStyle.emptyPaint === true;
    if (type === 'image') {
      const src = node.data?.value || node.props?.src || node.value || '';
      const exportedImage = !scopedLoopContext && parseOptions.completeExports?.get(node);
      const placedImage = !scopedLoopContext && !exportedImage
        ? resolvePlacedImage(node, parseOptions.layerDataIndex) : null;
      const resolvedSrc = exportedImage
        ? append_image_process(exportedImage.image, exportedImage.frame, parseOptions.imageScale, parseOptions.imageFormat)
        : resolve_image_url(
        resolve_loop_binding(src, scopedLoopContext?.item),
        parseOptions.imageData,
        parseOptions.imageScale,
        parseOptions.imageFormat
      );
      const sourceStyle = { ...nextNode.style };
      const parentStyle = options.parentStyle;
      const main = parentStyle?.flexDirection?.startsWith('column') ? 'Height' : 'Width';
      // A replaced image has an intrinsic automatic flex minimum; a background div
      // does not. Retain the image when a fixed main-size flex parent can shrink it.
      const keepFlexImage = ['flex', 'inline-flex'].includes(parentStyle?.display)
        && pixel_length(parentStyle[main.toLowerCase()]) > 0
        && !['absolute', 'fixed'].includes(sourceStyle.position)
        && ![0, '0'].includes(sourceStyle.flexShrink) && sourceStyle.flex !== 'none'
        && [undefined, 'auto'].includes(sourceStyle[`min${main}`])
        && [undefined, 'visible', 'clip'].includes(sourceStyle.overflow)
        && [undefined, 'visible', 'clip'].includes(sourceStyle[main === 'Height' ? 'overflowY' : 'overflowX']);
      const imageIndex = keepFlexImage || exportedImage ? null : parseOptions.layerDataIndex;
      const imageStyles = resolveVectorStyles(`url("${resolve_loop_binding(src, scopedLoopContext?.item)}")`,
        imageIndex, nextNode.style)
        || resolveVectorStyles(`url("${resolvedSrc}")`, imageIndex, nextNode.style);
      const dividerStyles = !nextNode.style.background && !nextNode.style.backgroundImage
        && (resolveDividerStyles(`url("${resolve_loop_binding(src, scopedLoopContext?.item)}")`, imageIndex, nextNode.style)
          || resolveDividerStyles(`url("${resolvedSrc}")`, imageIndex, nextNode.style));
      if (imageStyles?.decorationNodes && !nextNode.style.background && !nextNode.style.backgroundImage) {
        const { decorationNodes, ...paintStyles } = imageStyles;
        nextNode.type = 'block';
        nextNode.style = { ...nextNode.style, ...paintStyles };
        imageDecorations = decorationNodes.map((decoration) => resolve_style_image_references(
          decoration, parseOptions.imageData, parseOptions.imageScale, parseOptions.imageFormat));
      } else if (imageStyles && Object.keys(imageStyles).length === 0) {
        nextNode.type = 'block';
        emptyPaint = true;
      } else if (imageStyles?.backgroundImage && !nextNode.style.background && !nextNode.style.backgroundImage) {
        // Exported icon-only groups may arrive as image nodes, not container backgrounds.
        nextNode.type = 'block';
        nextNode.style = { ...nextNode.style, ...imageStyles };
      } else {
        const paintStyles = resolveImageStyles(`url("${resolve_loop_binding(src, scopedLoopContext?.item)}")`,
          imageIndex, nextNode.style)
          || resolveImageStyles(`url("${resolvedSrc}")`, imageIndex, nextNode.style);
        if (paintStyles || dividerStyles) {
          nextNode.type = 'block';
          nextNode.style = { ...nextNode.style, ...(paintStyles || dividerStyles) };
        } else {
          const paddedImage = !scopedLoopContext && !exportedImage
            && resolvePaddedImage(node, parseOptions.layerDataIndex, nextNode.style, resolvedSrc, parentStyle);
          if (paddedImage) {
            nextNode.type = 'block';
            nextNode.style = { ...nextNode.style, ...paddedImage.style };
            imageDecorations = paddedImage.decorationNodes;
          } else if (placedImage) {
            // The source asset is a whole canvas; only the placed rectangle is visible.
            nextNode.type = 'block';
            nextNode.style.background = `url("${append_image_process(placedImage.image, placedImage.frame,
              parseOptions.imageScale, parseOptions.imageFormat)}") ${-placedImage.offset.x}px ${-placedImage.offset.y}px no-repeat`;
            nextNode.style.backgroundSize = `${placedImage.frame.width}px ${placedImage.frame.height}px`;
            nextNode.convertedFrom = { sourceImage: src, sourceStyle };
          } else {
            nextNode.src = resolvedSrc;
          }
        }
      }
      if (exportedImage) {
        nextNode.convertedFrom = { sourceImage: src, sourceStyle, exportLayerId: exportedImage.exportLayerId };
      } else if (nextNode.type === 'block') {
        nextNode.convertedFrom = { sourceImage: resolve_loop_binding(src, scopedLoopContext?.item),
          sourceBackgroundSize: sourceStyle.backgroundSize, sourceStyle };
      }
    }

    const decorations = [...(resolvedStyle.decorations || []), ...imageDecorations].map((style, index) => ({
      treeKey: `${parseOptions.treePath}/d${index}`,
      id: '', type: 'block', className: `background-decoration_${index + 1}`,
      style: normalize_lengths({ boxSizing: 'border-box', ...style }), children: []
    }));
    nextNode.style = normalize_lengths(nextNode.style);
    if (!scopedLoopContext && !resolvedStyle.convertedFrom) {
      const radius = resolveSourceRadius(node, nextNode, parseOptions.layerDataIndex);
      if (radius) nextNode.style.borderRadius = radius;
    }
    // Normalize only the final paint: dropping a source border before conversion
    // would bypass conservative effect checks or discard a converted CSS radius.
    const hasImageBackground = ['background', 'backgroundImage'].some((key) =>
      typeof nextNode.style[key] === 'string' && /url\(/i.test(nextNode.style[key]));
    const hasRadius = ['borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
      'borderBottomLeftRadius', 'borderBottomRightRadius'].some((key) => nextNode.style[key] !== undefined);
    if (hasImageBackground && !hasRadius) delete nextNode.style.border;
    nextNode.style.boxSizing = resolvedStyle.style.boxSizing ?? nextNode.style.boxSizing ?? 'border-box';
    nextNode.children = [...decorations, ...(resolvedStyle.flattened ? [] : build_children(node, scopedLoopContext, parseNode,
      { ...parseOptions, parentStyle: nextNode.style }))];
    // Restore a source child that overflows before its flex container: the generated
    // margin would otherwise start at the container edge and shift the whole subtree.
    if (!scopedLoopContext && !resolvedStyle.flattened) {
      const overflow = resolveSourceOverflowOffset(node);
      if (overflow) {
        for (const [raw, style] of overflow) {
          const index = (node.children || []).indexOf(raw);
          const child = index >= 0 ? nextNode.children[decorations.length + index] : null;
          if (child) {
            for (const [key, value] of Object.entries(style)) {
              if (child.style[key] === undefined) child.style[key] = value;
            }
          }
        }
      }
    }
    if (!nextNode.convertedFrom && !Object.keys(node.styleObj || {}).length
      && !Object.keys(node.props?.styleObj || {}).length) {
      const frameBorder = resolveFrameBorder(node, nextNode, parseOptions.layerDataIndex);
      if (frameBorder) Object.assign(nextNode.style, frameBorder);
      const sourceBox = resolveSourceBox(nextNode, parseOptions.layerDataIndex);
      if (sourceBox?.outline) {
        delete nextNode.style.border;
        nextNode.style.outline = sourceBox.outline;
        if (sourceBox.expandedBorder) {
          const width = sourceBox.expandedBorder;
          const margin = box_lengths(nextNode.style, 'margin');
          for (const [i, side] of ['Top', 'Right', 'Bottom', 'Left'].entries()) {
            if (margin && Math.abs(margin[i] + width) < 1e-6) {
              delete nextNode.style[`margin${side}`];
              nextNode.style[`margin${side}`] = 0;
            }
          }
          for (const key of ['width', 'height']) {
            const size = pixel_length(nextNode.style[key]);
            if (size !== null && Math.abs(size - nextNode.bounds[key]) < 1e-6) nextNode.style[key] = size - width * 2;
          }
          // An omitted auto width can still grow with fallback digit metrics.
          // Retain a source content width only when a static paint child proves
          // both its full span and origin within this verified expanded frame.
          const style = nextNode.style;
          const padding = box_lengths(style, 'padding');
          const contentWidth = nextNode.bounds.width - width * 2;
          if (!scopedLoopContext && style.width === undefined && style.display === 'flex'
            && style.flexDirection === 'column' && padding && padding[1] === 0 && padding[3] === 0
            && ['minWidth', 'maxWidth', 'flex', 'flexGrow', 'flexShrink', 'flexBasis'].every((key) => style[key] === undefined)
            && nextNode.children.some((child) => {
              const s = child.style;
              const margin = box_lengths(s, 'margin');
              const paint = child.type === 'image' && child.src || ['background', 'backgroundImage', 'backgroundColor']
                .some((key) => typeof s[key] === 'string' && s[key] && !['none', 'transparent'].includes(s[key]));
              return child.type !== 'text' && paint && child.bounds && margin && margin[1] === 0 && margin[3] === 0
                && !s.transform && [undefined, 'static'].includes(s.position) && s.display !== 'none'
                && s.boxSizing === 'border-box'
                && ['minWidth', 'maxWidth', 'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'order'].every((key) => s[key] === undefined)
                && Math.abs(pixel_length(s.width) - contentWidth) < 1e-6
                && Math.abs(child.bounds.width - contentWidth) < 1e-6
                && Math.abs(child.bounds.left - nextNode.bounds.left - width) < 1e-6;
            })) style.width = contentWidth;
        }
      }
      if (sourceBox?.clip) nextNode.style.overflow = 'hidden';
    }
    // Loop copies share template bounds, but static local border offsets are
    // translation-invariant. Never use bound/conditional geometry as proof.
    const staticLocalBox = (raw) => !raw.condition && !raw.loopType
      && [raw.styleObj, raw.props?.styleObj].every((style) => Object.keys(style || {})
        .every((key) => ['background', 'backgroundColor', 'color'].includes(key)));
    if (!scopedLoopContext) normalize_border_spacing(nextNode);
    else if (staticLocalBox(node) && node.children?.[0] && staticLocalBox(node.children[0])
      && nextNode.children[0]?.layerId === node.children[0].layerId) {
      // Conditional slots later in the template cannot establish its far edge.
      normalize_border_spacing(nextNode, true);
    }
    if (!scopedLoopContext && !resolvedStyle.flattened) {
      const dividers = resolveOmittedDividers(node, nextNode, parseOptions.layerDataIndex);
      if (dividers.length) {
        nextNode.style.position = 'relative';
        nextNode.children.push(...dividers.map((style, index) => ({
          treeKey: `${parseOptions.treePath}/divider${index}`, id: '', type: 'block',
          className: `source-divider_${index + 1}`, style, children: []
        })));
      }
    }
    if (emptyPaint && nextNode.type === 'block' && decorations.length === 0) {
      remove_empty_paint_order(node, nextNode);
    }
    return nextNode;
  };

  const buildTreeData = (schema, imageData, options = {}) => {
    const completeExports = new Map();
    const sourceLayoutStyles = new Map();
    const omittedArtworkNodes = new Set();
    const collect = (node) => {
      if (!node || node.loopType || node.condition) return;
      const corrections = resolveClippedCardRow(node, options.layerDataIndex)
        || resolve_inline_row_widths(node, options.layerDataIndex);
      if (corrections) corrections.forEach(([raw, style]) => sourceLayoutStyles.set(raw, style));
      const exported = resolveExportedMaskGroup(node, options.layerDataIndex, schema);
      if (exported?.paintFrame || exported?.direct) {
        completeExports.set(node, exported);
        (exported.consumedNodes || []).forEach((peer) => omittedArtworkNodes.add(peer));
      }
      if (Array.isArray(node.children)) node.children.forEach(collect);
    };
    if (options.layerDataIndex) collect(schema);
    const root = parseNode(schema, null, {
      ...options, sourceSchema: schema, sourceLayoutStyles, completeExports, omittedArtworkNodes,
      imageData: create_image_data_index(imageData),
      imageDataIndexed: true
    });
    if (root) {
      const band = resolvePageBand(root, options.layerDataIndex);
      if (band) root.children.unshift(band);
      const normalize_fonts = (node) => {
        const style = node.style;
        if (style && typeof style.fontFamily === 'string') {
          if (style.fontFamily === 'PingFangSC-Regular') style.fontFamily = 'PingFangSC-Medium';
          const alias = FONT_FAMILY_ALIASES.get(style.fontFamily);
          if (alias) {
            style.fontFamily = alias.fontFamily;
            // Explicit weights win; only fill a weight the source left unset or `normal`.
            if (alias.fontWeight !== undefined
              && (style.fontWeight === undefined || style.fontWeight === 'normal')) style.fontWeight = alias.fontWeight;
          }
        }
        for (const child of node.children || []) normalize_fonts(child);
      };
      normalize_fonts(root);
      clampTextLineBoxes([root]);
      keepFlexItemSizes([root]);
    }
    return root ? [root] : [];
  };

  const schema_parser = {
    buildTreeData,
    parseNode,
    normalizeBorder: normalize_border,
    normalizeImageData,
    getImageRewriteStats,
    getFontRewriteStats
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = schema_parser;
  }

  globalScope.lanhuSchemaParser = schema_parser;
})(typeof globalThis !== 'undefined' ? globalThis : this);
