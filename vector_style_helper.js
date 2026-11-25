(function(globalScope) {
  'use strict';

  const url_keys = (url) => {
    if (typeof url !== 'string' || !url) return [];
    const clean = url.split(/[?#]/)[0];
    try {
      const parsed = new URL(clean);
      return [...new Set([url, clean, parsed.pathname, parsed.pathname.split('/').pop()])];
    } catch (error) {
      return [...new Set([url, clean, clean.split('/').pop()])];
    }
  };

  const same_vector = (a, b) => {
    const url = a?.ddsImage?.imageUrl;
    if (!url || url !== b?.ddsImage?.imageUrl) return false;
    const styles = [a, b].map((layer) => resolveVectorStyles(`url("${url}")`, { [url]: layer }));
    const geometry = (layer) => {
      const frame = layer.layerOriginFrame;
      const exported = layer.ddsOriginFrame;
      return [frame?.width, frame?.height, exported?.width, exported?.height,
        frame && exported ? frame.x - exported.x : null,
        frame && exported ? frame.y - exported.y : null];
    };
    // Relative paints (side bars, compiled layer decorations) do not depend on the
    // instance position, so reused exports with identical relative records agree.
    const relative = (layer) => layer.cssSideBar ? JSON.stringify(layer.cssSideBar)
      : layer.cssLayerPaint ? JSON.stringify(layer.cssLayerPaint.records.map((record) =>
        [record.box, record.paint, record.text === true, record.maskClipped === true])) : null;
    const leftRelative = relative(a);
    if (leftRelative !== null && leftRelative === relative(b)) return true;
    const left = geometry(a);
    const right = geometry(b);
    const unpainted = (layer) => layer?.type === 'shape' && !layer.blur?.isEnabled
      && (!layer.layers || Array.isArray(layer.layers) && !layer.layers.length)
      && ['fills', 'borders', 'shadow'].every((key) => layer[key] === undefined
        || Array.isArray(layer[key]) && enabled(layer[key]).length === 0);
    const samePaint = unpainted(a) && unpainted(b) ? true : a.gradientCard && b.gradientCard
      ? JSON.stringify(a.gradientCard) === JSON.stringify(b.gradientCard)
      : styles.every(Boolean) && JSON.stringify(styles[0]) === JSON.stringify(styles[1]);
    return samePaint && left.every((value, i) => value === right[i]
        || finite(value) && finite(right[i]) && Math.abs(value - right[i]) <= 1e-6);
  };

  const CONFLICTS = Symbol.for('lanhuVectorConflicts');

  // Only identical, safely convertible exports may share an alias.
  const buildLayerDataIndex = (data) => {
    const index = Object.create(null);
    const conflicts = new Map();
    const nodes = [];
    const textEffectLayers = [];
    const frameEffectLayers = [];
    const seen = new Set();
    const collect = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      nodes.push(node);
      if (Array.isArray(node.layers)) node.layers.forEach(collect);
    };
    if (Array.isArray(data?.info)) data.info.forEach(collect);
    const childrenByParent = new Map();
    const idCounts = new Map();
    for (const node of nodes) if (node.id) idCounts.set(node.id, (idCounts.get(node.id) || 0) + 1);
    for (const node of nodes) {
      if (!node.parentID) continue;
      if (!childrenByParent.has(node.parentID)) childrenByParent.set(node.parentID, []);
      childrenByParent.get(node.parentID).push(node);
    }
    const visit = (node) => {
      if (node.id && idCounts.get(node.id) === 1) {
        const crop = compile_clipped_card_row(node, nodes, childrenByParent, idCounts);
        if (crop) index[`crop:${node.id}`] = crop;
        const box = compile_source_box(node);
        if (box) index[`box:${node.id}`] = box;
        const inline = compile_inline_box(node, nodes, idCounts);
        if (inline) index[`inline:${node.id}`] = inline;
        if (node.type === 'bitmap' && Array.isArray(node.layers) && !node.layers.length
          && !childrenByParent.get(node.id)?.length && valid_page_box(node.ddsOriginFrame)
          && node.ddsImage?.imageUrl && node.ddsImage.size?.width === node.ddsOriginFrame.width
          && node.ddsImage.size?.height === node.ddsOriginFrame.height) {
          index[`bitmapLeaf:${node.id}`] = { frame: node.ddsOriginFrame, image: node.ddsImage.imageUrl };
        }
        const imageFrame = compile_padded_image(node);
        if (imageFrame) index[`image:${node.id}`] = imageFrame;
        const radius = compile_flipped_radius(node);
        if (radius) index[`radius:${node.id}`] = radius;
        const dividers = compile_omitted_dividers(node, childrenByParent, idCounts, nodes);
        if (dividers) index[`dividers:${node.id}`] = dividers;
      }
      // PS aliases repeat the same text layer with shared ids, so text effects are
      // matched by proven geometry/text instead of an id that may not be unique.
      if (['text', 'textLayer'].includes(node.type) && node._orgBounds) {
        const effects = compile_text_effects(node);
        if (effects) textEffectLayers.push({ bounds: node._orgBounds,
          text: source_text(node.textInfo?.text), ...effects });
      }
      // Layer ids repeat through PS aliases, so frame effects are matched by geometry.
      if (node._orgBounds) {
        const frame = compile_frame_effect(node);
        if (frame) frameEffectLayers.push({ bounds: node._orgBounds, ...frame });
      }
      // PS repeats the same layer through nested boards and flat aliases; only an identical
      // copy republishes the stroke proof, a conflicting one rejects it.
      const gradientStroke = compile_ps_gradient_stroke(node);
      if (gradientStroke && node.id !== undefined && node.id !== null) {
        const key = `gradientStroke:${node.id}`;
        if (!Object.hasOwn(index, key)) index[key] = gradientStroke;
        else if (index[key] && index[key].signature !== gradientStroke.signature) index[key] = null;
      }
      // PS repeats the same card through aliases; only an identical copy republishes the proof.
      const notchCard = compile_notch_card(node);
      if (notchCard && node.id !== undefined && node.id !== null) {
        const key = `notch:${node.id}`;
        if (!Object.hasOwn(index, key)) index[key] = notchCard;
        else if (index[key] && index[key].signature !== notchCard.signature) index[key] = null;
      }
      const placed = compile_placed_image(node);
      if (placed) {
        const key = `placed:${node.id}`;
        index[key] = Object.hasOwn(index, key) && JSON.stringify(index[key]) !== JSON.stringify(placed)
          ? null : placed;
      }
      const complete = compile_exported_slice(node, childrenByParent, idCounts);
      if (complete) index[`export:${node.id}`] = complete;
      const exported = compile_exported_mask_group(node, childrenByParent);
      if (exported) {
        const key = `slice:${exported.maskId}`;
        index[key] = Object.hasOwn(index, key) ? null : exported;
      }
      for (const artwork of compile_exported_artwork(node, childrenByParent, idCounts)) {
        const key = `artwork:${artwork.anchorId}`;
        index[key] = Object.hasOwn(index, key) ? null : artwork;
      }
      const merged = resolve_responsive_panel(node, childrenByParent)
        || resolve_merged_group(node, childrenByParent) || resolve_mask_siblings(node, childrenByParent)
        || resolve_transparent_menu(node, childrenByParent)
        || resolve_mask_paint(node, childrenByParent);
      if (merged) {
        const key = `merge:${merged.layerId}`;
        index[key] = Object.hasOwn(index, key) ? null : merged;
      }
      node = resolve_gradient_card_group(node, childrenByParent)
        || resolve_transparent_group(node, childrenByParent)
        || resolve_side_bar_group(node, childrenByParent)
        || resolve_painted_icon_group(node, childrenByParent)
        || resolve_icon_background_group(node, childrenByParent)
        || resolve_status_label_group(node, childrenByParent)
        || resolve_glow_capsule_group(node, childrenByParent)
        || resolve_rectangle_group(node, childrenByParent)
        || resolve_circle_group(node, childrenByParent) || resolve_simple_group(node, childrenByParent, idCounts)
        || resolve_layer_paint_group(node, childrenByParent) || node;
      const urls = node.gradientCard || node.cssSideBar || node.cssLayerPaint
        ? [node.ddsImage?.imageUrl, node.image?.imageUrl] : [node.ddsImage?.imageUrl];
      for (const key of new Set(urls.flatMap(url_keys))) {
        if (!Object.hasOwn(index, key)) index[key] = node;
        else if (index[key] !== node && !same_vector(index[key], node)) {
          const list = conflicts.get(key) || [];
          if (!list.length) list.push(index[key]);
          list.push(node);
          conflicts.set(key, list);
          index[key] = null;
        }
      }
    };
    nodes.forEach(visit);
    // PS info repeats the nested board as flat aliases. Use the canonical board
    // hierarchy for clipping order; duplicate identities inside it still reject.
    const psNodes = [];
    const psCounts = new Map();
    const collectPs = (node) => {
      if (!node || psNodes.includes(node)) return;
      psNodes.push(node);
      psCounts.set(node.id, (psCounts.get(node.id) || 0) + 1);
      if (Array.isArray(node.layers)) node.layers.forEach(collectPs);
    };
    if (data?.board?.isPage === true) collectPs(data.board);
    for (const node of psNodes) {
      if (psCounts.get(node.id) !== 1) continue;
      const pointText = compile_ps_point_text(node);
      if (pointText) index[`pointText:${node.id}`] = pointText;
    }
    for (const node of [...nodes.filter(n => n.type !== 'shapeLayer'), ...psNodes.filter(n => n.type === 'shapeLayer')]) {
      const background = compile_source_background(node, node.type === 'shapeLayer' ? psNodes : nodes,
        childrenByParent, node.type === 'shapeLayer' ? psCounts : idCounts);
      if (background) {
        const key = `background:${background.anchorId}`;
        index[key] = Object.hasOwn(index, key) ? null : background;
      }
    }
    // Keep only explicit leading artboard groups, not a second copy of the layer document.
    // A schema may omit a whole status/header band even though the source still contains it.
    for (const artboard of nodes.filter((node) => node.ddsType === 'artboard-group')) {
      const frame = { x: artboard.left, y: artboard.top, width: artboard.width, height: artboard.height };
      if (data.ArtboardID && data.ArtboardID !== artboard.id || !valid_page_box(frame)) continue;
      const candidates = (childrenByParent.get(artboard.id) || []).filter((layer) => {
        const box = layer.layerOriginFrame;
        return layer.isVisible !== false && layer.type === 'layer-group' && valid_page_box(box)
          && ['x', 'y', 'width'].every((key) => Math.abs(box[key] - frame[key]) < 1e-6)
          && box.height < frame.height;
      }).map((layer) => {
        const node = compile_page_band(layer, layer.layerOriginFrame, childrenByParent, new Set());
        const layerIds = new Set();
        const collectIds = (current) => {
          if (!current?.id || layerIds.has(current.id)) return;
          layerIds.add(current.id);
          [...(Array.isArray(current.layers) ? current.layers : []), ...(childrenByParent.get(current.id) || [])].forEach(collectIds);
        };
        collectIds(layer);
        return { node, height: layer.layerOriginFrame.height, layerIds: [...layerIds] };
      });
      if (candidates.length) index[`page:${artboard.id}`] = { frame, candidates };
    }
    if (conflicts.size) index[CONFLICTS] = conflicts;
    if (textEffectLayers.length) {
      const unique = new Map();
      for (const layer of textEffectLayers) unique.set(JSON.stringify(layer), layer);
      index.textEffects = [...unique.values()];
    }
    if (frameEffectLayers.length) {
      const unique = new Map();
      for (const layer of frameEffectLayers) unique.set(JSON.stringify(layer), layer);
      index.frameEffects = [...unique.values()];
    }
    return Object.keys(index).length ? index : null;
  };

  // DDS may reparent a decorative drawing under its transparent mask and split
  // strokes using logical (not painted) bounds. An explicit full-group export is
  // authoritative only when it covers that same mask and contains no text/UI.
  const compile_exported_mask_group = (group, childrenByParent) => {
    const frame = group.layerOriginFrame;
    const same = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) =>
      finite(a[key]) && finite(b[key]) && Math.abs(a[key] - b[key]) <= 1e-6);
    const clean = (node) => !node.rotation && !node.isFlippedHorizontal && !node.isFlippedVertical
      && !node.shouldBreakMaskChain && (node.blendMode === undefined || node.blendMode === 0)
      && (node.opacity === undefined || node.opacity === 100) && node.isVisible !== false;
    const children = (node) => [...new Set([...(node.layers || []), ...(childrenByParent.get(node.id) || [])])];
    if (!group.id || group.type !== 'layer-group' || group.exportable !== true || !clean(group)
      || (group.layers !== undefined && !Array.isArray(group.layers)) || group.hasClippingMask || !same(frame, group.ddsOriginFrame) || frame.width <= 0 || frame.height <= 0
      || !/^https:\/\//.test(group.image?.imageUrl || '')
      || group.image.size?.width !== frame.width || group.image.size?.height !== frame.height) return null;
    const entries = children(group);
    const mask = entries[0];
    if (entries.length < 2 || !mask?.id || !mask.hasClippingMask || !clean(mask)
      || mask.ddsType !== 'rectangle' || !mask.ddsImage?.imageUrl
      || !same(frame, mask.layerOriginFrame) || !same(frame, mask.ddsOriginFrame)
      || entries.slice(1).some((node) => node.hasClippingMask)) return null;
    const ids = new Set([group.id]);
    const visit = (node) => {
      if (!node?.id || ids.has(node.id) || !['shape', 'bitmap', 'layer-group'].includes(node.type)
        || node.shouldBreakMaskChain || (node.layers !== undefined && !Array.isArray(node.layers))) return false;
      ids.add(node.id);
      return children(node).every(visit);
    };
    if (!entries.every(visit)) return null;
    return { maskId: mask.id, exportLayerId: group.id, image: group.image.imageUrl,
      sourceImage: mask.ddsImage.imageUrl, frame, layerIds: [...ids] };
  };

  // A source card can extend beyond the artboard while DDS emits only its right-
  // clipped background. Keep that visible fragment, not an auto min-content box.
  const compile_clipped_card_row = (layer, nodes, childrenByParent, counts) => {
    const same = (a, b) => a && b && ['x', 'y', 'width', 'height'].every(key =>
      finite(a[key]) && finite(b[key]) && Math.abs(a[key] - b[key]) < 1e-6);
    const clean = n => n && counts.get(n.id) === 1 && !n.rotation && !n.hasClippingMask
      && !n.isFlippedHorizontal && !n.isFlippedVertical
      && (!n.shouldBreakMaskChain || n.type === 'layer-group') && n.isVisible !== false
      && [undefined, 100].includes(n.opacity) && [undefined, 0].includes(n.blendMode);
    const byId = id => counts.get(id) === 1 && nodes.find(n => n.id === id);
    const frame = layer.layerOriginFrame;
    const crop = layer.ddsOriginFrame;
    if (layer.type !== 'shape' || !is_rectangle(layer) || !clean(layer) || !frame || !crop
      || !['x', 'y', 'height'].every(key => frame[key] === crop[key]) || !(crop.width > 0) || !(crop.width < frame.width)) return null;
    const card = byId(layer.parentID);
    const strip = card && byId(card.parentID);
    let ancestor = strip;
    const ancestors = new Set();
    while (ancestor && ancestor.ddsType !== 'artboard-group') {
      if (!clean(ancestor) || ancestors.has(ancestor.id)) return null;
      ancestors.add(ancestor.id);
      ancestor = byId(ancestor.parentID);
    }
    if (!ancestor || !clean(ancestor) || !clean(card) || !same(card.layerOriginFrame, frame)
      || !same(card.ddsOriginFrame, frame) || crop.x + crop.width !== ancestor.left + ancestor.width) return null;
    const peers = (childrenByParent.get(strip.id) || []).filter(n => n.type === 'layer-group'
      && n.layerOriginFrame?.x < frame.x && n.layerOriginFrame?.y === frame.y)
      .sort((a, b) => b.layerOriginFrame.x - a.layerOriginFrame.x);
    const previous = peers[0];
    if (!clean(previous) || !same(previous.layerOriginFrame, previous.ddsOriginFrame)) return null;
    const first = (childrenByParent.get(previous.id) || []).filter(n => n.type === 'shape' && clean(n)
      && is_rectangle(n) && same(n.layerOriginFrame, previous.layerOriginFrame) && same(n.ddsOriginFrame, n.layerOriginFrame));
    if (first.length !== 1 || first[0].layerOriginFrame.width !== frame.width
      || first[0].layerOriginFrame.height !== frame.height) return null;
    const gap = frame.x - first[0].layerOriginFrame.x - frame.width;
    if (!(gap > 0)) return null;
    const titles = (childrenByParent.get(card.id) || []).filter(n => clean(n) && n.type === 'layer-group'
      && same(n.layerOriginFrame, n.ddsOriginFrame) && n.layerOriginFrame.x < ancestor.left + ancestor.width
      && n.layerOriginFrame.x + n.layerOriginFrame.width > ancestor.left + ancestor.width).map(n => {
      const children = childrenByParent.get(n.id) || [];
      const bar = children.find(c => c.type === 'shape' && is_rectangle(c) && clean(c));
      const text = children.find(c => c.type === 'text' && clean(c));
      return { frame: n.layerOriginFrame, children, bar, text };
    }).filter(t => t.children.length === 2 && t.bar && t.text);
    if (titles.length !== 1) return null;
    const title = titles[0];
    const paints = [];
    const collectPaints = n => {
      const original = n.layerOriginFrame, visible = n.ddsOriginFrame;
      if (n.id !== layer.id && n.type === 'shape' && clean(n) && is_rectangle(n) && original && visible
        && ['x', 'y', 'height'].every(key => original[key] === visible[key])
        && visible.width > 0 && original.width > visible.width && visible.x + visible.width === crop.x + crop.width) {
        paints.push({ id: n.id, frame: original, crop: visible });
      }
      (childrenByParent.get(n.id) || []).forEach(collectPaints);
    };
    collectPaints(card);
    return { firstId: first[0].id, secondId: layer.id, firstFrame: first[0].layerOriginFrame, crop, gap,
      titleFrame: title.frame, barId: title.bar.id, textId: title.text.id, paints };
  };

  const resolveClippedCardRow = (node, index) => {
    if (node.children?.length !== 2) return null;
    const [first, second] = node.children;
    const entry = index?.[`crop:${second.layerId}`];
    const style = n => n.props?.style || n.style || {};
    const pixels = v => typeof v === 'number' ? v : typeof v === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(v) ? Number(v.replace(/px$/, '')) : NaN;
    const safe = n => !n.loopType && !n.condition && !Object.keys(n.styleObj || {}).length
      && !Object.keys(n.props?.styleObj || {}).length && !style(n).transform
      && !style(n).writingMode && !style(n).direction
      && (n.children || []).every(safe);
    const matches = (box, frame) => box && ['left', 'top', 'width', 'height'].every((key, i) => box[key] === frame[['x', 'y', 'width', 'height'][i]]);
    const s = style(node);
    if (!entry || first.layerId !== entry.firstId || !safe(node) || s.display !== 'flex' || s.flexDirection !== 'row'
      || s.justifyContent !== 'space-between' || ![undefined, 'nowrap'].includes(s.flexWrap)
      || Object.keys(s).some(key => /^(?:padding|border|gap|columnGap|rowGap)/.test(key) && ![0, '0px', 'none'].includes(s[key]))
      || !matches(first.rowDims, entry.firstFrame) || !matches(second.rowDims, entry.crop)
      || pixels(s.width) !== entry.firstFrame.width + entry.gap + entry.crop.width
      || node.rowDims?.left !== entry.firstFrame.x || node.rowDims?.top !== entry.firstFrame.y
      || [first, second].some(n => {
        const c = style(n);
        return c.display !== 'flex' || c.flexDirection !== 'column'
          || ['width', 'minWidth', 'maxWidth', 'flex', 'flexBasis', 'flexGrow', 'flexShrink', 'position', 'order', 'overflow', 'overflowX', 'margin', 'marginLeft', 'marginRight'].some(key => c[key] !== undefined);
      })) return null;
    const title = second.children?.find(n => n.children?.length === 2
      && n.children[0].layerId === entry.barId && n.children[1].layerId === entry.textId);
    const t = title && style(title);
    if (!title || t.display !== 'flex' || t.flexDirection !== 'row' || t.justifyContent !== 'space-between'
      || title.rowDims?.left !== entry.titleFrame.x || title.rowDims?.top !== entry.titleFrame.y
      || title.rowDims?.height !== entry.titleFrame.height
      || pixels(t.width) !== entry.crop.x + entry.crop.width - entry.titleFrame.x
      || title.rowDims.width !== pixels(t.width)
      || ['flex', 'flexShrink', 'flexGrow', 'flexBasis', 'minWidth', 'maxWidth', 'position', 'overflow'].some(key => t[key] !== undefined)) return null;
    const paintStyles = [];
    const collectPaints = n => {
      const paint = entry.paints.find(p => p.id === n.layerId);
      if (paint) {
        const c = style(n);
        if (!matches(n.rowDims, paint.crop) || pixels(c.width) !== paint.crop.width
          || !c.backgroundColor || ['background', 'backgroundImage', 'transform', 'position', 'flex', 'flexShrink'].some(key => c[key] !== undefined)) return false;
        // Preserve the source rounded bar beyond the visible viewport. Keeping
        // its cropped width would invent a rounded end at the artboard edge.
        paintStyles.push([n, { width: paint.frame.width, flexShrink: 0 }]);
      }
      return (n.children || []).every(collectPaints);
    };
    if (!collectPaints(second)) return null;
    return [[first, { width: entry.firstFrame.width, flexShrink: 0 }],
      [second, { width: entry.crop.width, flexShrink: 0, overflow: 'hidden' }],
      [title, { width: entry.titleFrame.width, flexShrink: 0 }], [title.children[0], { flexShrink: 0 }], ...paintStyles];
  };

  // Recover only omitted background paint. Unlike complete decorative flattening,
  // these schema anchors may contain independent, reparented UI that must survive.
  const compile_source_background = (node, nodes, childrenByParent, idCounts) => {
    const same = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) =>
      finite(a[key]) && finite(b[key]) && Math.abs(a[key] - b[key]) < 1e-6);
    const neutral = (n) => !n.rotation && !n.isFlippedHorizontal && !n.isFlippedVertical
      && !n.hasClippingMask && !n.shouldBreakMaskChain && n.isVisible !== false
      && [undefined, 100].includes(n.opacity) && [undefined, 0].includes(n.blendMode)
      && ['fills', 'borders', 'shadow'].every((key) => !n[key] || Array.isArray(n[key]) && !enabled(n[key]).length)
      && !n.blur?.isEnabled;
    const children = (n) => [...new Set([...(Array.isArray(n.layers) ? n.layers : []), ...(childrenByParent.get(n.id) || [])])];
    if (node.type === 'layer-group' && node.exportable === true) {
      const frame = node.layerOriginFrame;
      if (!neutral(node) || idCounts.get(node.id) !== 1 || !same(frame, node.ddsOriginFrame)
        || !(frame.width > 0) || !(frame.height > 0) || !/^https:\/\//.test(node.image?.imageUrl || '')
        || node.image.size?.width !== frame.width || node.image.size?.height !== frame.height) return null;
      let entries = children(node);
      const ids = new Set([node.id]);
      // Require at least one proven same-frame neutral wrapper. Direct mask groups
      // keep their existing, stricter complete-slice path.
      if (entries.length !== 1) return null;
      while (entries.length === 1 && entries[0].type === 'layer-group') {
        const wrapper = entries[0];
        if (ids.has(wrapper.id) || idCounts.get(wrapper.id) !== 1 || !neutral(wrapper)
          || !same(frame, wrapper.layerOriginFrame) || !same(frame, wrapper.ddsOriginFrame)
          || wrapper.layers !== undefined && !Array.isArray(wrapper.layers)) return null;
        ids.add(wrapper.id);
        entries = children(wrapper);
      }
      const mask = entries[0];
      // Sketch can encode straight rectangle corners with coincident Bezier
      // handles (curveMode 4). Prove those edges locally, without relaxing the
      // general CSS shape converter's stricter path rules.
      const straightMask = mask?.type === 'shape' && mask.isClosed === true && mask.points?.length === 4
        && mask.points.every((v, i) => {
          const next = mask.points[(i + 1) % 4]?.point;
          return [v.point?.x, v.point?.y].every(n => n === 0 || n === 1)
            && !v.cornerRadius && ['curveFrom', 'curveTo'].every(key => !v[key]
              || v[key].x === v.point.x && v[key].y === v.point.y)
            && next && Math.abs(next.x - v.point.x) + Math.abs(next.y - v.point.y) === 1;
        }) && new Set(mask.points.map(v => `${v.point.x},${v.point.y}`)).size === 4;
      if (entries.length < 2 || !mask?.hasClippingMask || !(is_rectangle(mask) || straightMask)
        || !same(frame, mask.layerOriginFrame) || !same(frame, mask.ddsOriginFrame)
        || !neutral({ ...mask, hasClippingMask: false, fills: undefined })
        || entries.slice(1).some(n => n.hasClippingMask)) return null;
      const visit = (n) => {
        if (!n?.id || ids.has(n.id) || idCounts.get(n.id) !== 1
          || !['layer-group', 'shape', 'bitmap'].includes(n.type) || n.shouldBreakMaskChain
          || n.layers !== undefined && !Array.isArray(n.layers)) return false;
        ids.add(n.id);
        return children(n).every(visit);
      };
      if (!entries.every(visit)) return null;
      return { kind: 'export', anchorId: mask.id, exportLayerId: node.id,
        image: node.image.imageUrl, frame, layerIds: [...ids] };
    }
    // PS retains dormant stroke metadata (including positive widths) when its
    // explicit switch is false. Unknown fields/effects still need a bitmap fallback.
    const disabledStroke = node.strokeStyle?.strokeEnabled === false
      && Object.keys(node.strokeStyle).every(key => ['strokeStyleVersion', 'strokeEnabled', 'fillEnabled',
        'strokeStyleLineWidth', 'strokeStyleLineDashOffset', 'strokeStyleMiterLimit', 'strokeStyleLineCapType',
        'strokeStyleLineJoinType', 'strokeStyleLineAlignment', 'strokeStyleScaleLock', 'strokeStyleStrokeAdjust',
        'strokeStyleLineDashSet', 'strokeStyleBlendMode', 'strokeStyleOpacity', 'strokeStyleContent',
        'strokeStyleResolution'].includes(key))
      && (!node.strokeStyle.strokeStyleContent
        || Object.keys(node.strokeStyle.strokeStyleContent).every(key => key === 'color'));
    if (node.type !== 'shapeLayer' || !node.isClippingMask || node.visible !== true
      || idCounts.get(node.id) !== 1 || node.clipped || node.layerEffects || node.strokeStyle && !disabledStroke
      || node.fill?.class !== 'solidColorLayer' || node.opacity !== undefined && node.opacity !== 100) return null;
    const parent = nodes.find(n => Array.isArray(n.layers) && n.layers.includes(node));
    if (!parent || parent.visible === false || parent.layerEffects || parent.opacity !== undefined && parent.opacity !== 100
      || parent.blendOptions && !['normal', 'passThrough'].includes(parent.blendOptions.mode)) return null;
    const pos = parent.layers.indexOf(node);
    const bitmap = parent.layers[pos - 1];
    const parts = node.path?.pathComponents;
    const points = parts?.[0]?.subpathListKey?.[0];
    const frame = { x: node.left, y: node.top, width: node.width, height: node.height };
    const corners = [[frame.x, frame.y], [frame.x + frame.width, frame.y],
      [frame.x + frame.width, frame.y + frame.height], [frame.x, frame.y + frame.height]];
    if (!bitmap || bitmap.type !== 'layer' || bitmap.visible !== true || bitmap.clipped !== true
      || !bitmap.smartObject || idCounts.get(bitmap.id) !== 1 || parent.layers[pos - 2]?.clipped
      || bitmap.layerEffects || bitmap.rotation || bitmap.opacity !== undefined && bitmap.opacity !== 100
      || bitmap.blendOptions && bitmap.blendOptions.mode !== 'normal'
      || !/^https:\/\//.test(bitmap.ddsImages?.orgUrl || '') || bitmap.ddsImages.base !== 'Web @1x'
      || !same(frame, { x: bitmap.left, y: bitmap.top, width: bitmap.width, height: bitmap.height })
      || parts?.length !== 1 || parts[0].shapeOperation !== 'add' || parts[0].origin?.type !== 'rect'
      || parts[0].subpathListKey.length !== 1 || !points?.closedSubpath || points.points?.length !== 4
      || points.points.some((p, i) => p.forward || p.backward || p.anchor?.x !== corners[i][0] || p.anchor?.y !== corners[i][1])) return null;
    const paint = bitmap.realFrame;
    const before = bitmap.beforeClippedFrame;
    if (!paint || !before || ![paint.left, paint.top, paint.width, paint.height, before.left, before.top, before.right, before.bottom].every(finite)
      || paint.left !== before.left || paint.top !== before.top || paint.width !== before.right - before.left
      || paint.height !== before.bottom - before.top || !(paint.width > 0) || !(paint.height > 0)
      || paint.left > frame.x || paint.top > frame.y || paint.left + paint.width < frame.x + frame.width
      || paint.top + paint.height < frame.y + frame.height) return null;
    return { kind: 'bitmap', anchorId: node.id, bitmapId: bitmap.id, frame, paint,
      image: bitmap.ddsImages.orgUrl };
  };

  const resolveSourceBackground = (node, index, sourceSchema) => {
    const entry = index?.[`background:${node.layerId}`];
    const style = node.props?.style || node.style || {};
    const pixels = (v) => typeof v === 'number' ? v
      : typeof v === 'string' && /^[+-]?\d+(?:\.\d+)?(?:px)?$/.test(v) ? Number(v.replace(/px$/, '')) : NaN;
    const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) < 1e-6;
    if (!entry || node.type !== 'lanhublock' || node.loopType || node.condition
      || Object.keys(node.styleObj || {}).length || Object.keys(node.props?.styleObj || {}).length
      || !['left', 'top', 'width', 'height'].every((key, i) => close(node.rowDims?.[key], entry.frame[['x', 'y', 'width', 'height'][i]]))
      || ['transform', 'filter', 'backdropFilter', 'mask', 'maskImage', 'clipPath', 'mixBlendMode',
        'backgroundBlendMode', 'backgroundClip', 'backgroundOrigin'].some(key => style[key] !== undefined)) return null;
    let represented = false;
    const visit = (n) => {
      if (n !== node && (entry.kind === 'bitmap' ? n.layerId === entry.bitmapId : entry.layerIds.includes(n.layerId))) represented = true;
      (n.children || []).forEach(visit);
    };
    visit(sourceSchema);
    if (represented) return null;
    if (entry.kind === 'bitmap') {
      if (!['width', 'height'].every(key => close(pixels(style[key]), entry.frame[key]))
        || ['background', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat'].some(key => style[key] !== undefined)) return null;
      return { style: { backgroundImage: `url("${entry.image}")`, backgroundRepeat: 'no-repeat',
        backgroundSize: `${entry.paint.width}px ${entry.paint.height}px`,
        backgroundPosition: `${entry.paint.left - entry.frame.x}px ${entry.paint.top - entry.frame.y}px` }, sourceImage: entry.image };
    }
    const match = /^url\(\s*(['"]?)(.*?)\1\s*\)\s+100%\s+no-repeat$/.exec(style.background || '');
    if (!match || style.background !== node.style?.background || style.backgroundSize !== '100% 100%'
      || ['backgroundColor', 'backgroundImage', 'backgroundPosition', 'backgroundRepeat'].some(key => style[key] !== undefined)
      || !['width', 'height'].every(key => close(pixels(node.style?.[key]), entry.frame[key])
        && (style[key] === undefined || close(pixels(style[key]), entry.frame[key])))) return null;
    return { image: entry.image, frame: entry.frame, exportLayerId: entry.exportLayerId, sourceImage: match[2] };
  };

  // Explicit illustration exports may contain a wider badge/shadow while DDS keeps
  // only a front plate as the schema container. Restore paint, never its layout box.
  const compile_exported_artwork = (group, childrenByParent, idCounts) => {
    const frame = group.layerOriginFrame;
    const same = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) =>
      finite(a[key]) && finite(b[key]) && Math.abs(a[key] - b[key]) < 1e-6);
    if (group.type !== 'layer-group' || !group.id || group.exportable !== true
      || !/^https:\/\//.test(group.image?.imageUrl || '') || !same(frame, group.ddsOriginFrame)
      || frame.width <= 0 || frame.height <= 0 || group.rotation || group.hasClippingMask
      || group.isFlippedHorizontal || group.isFlippedVertical || group.shouldBreakMaskChain
      || group.isVisible === false || ![undefined, 100].includes(group.opacity)
      || ![undefined, 0].includes(group.blendMode)
      || !['influenceLeft', 'influenceTop', 'influenceWidth', 'influenceHeight'].every((key) => finite(group[key]))
      || group.influenceWidth <= 0 || group.influenceHeight <= 0) return [];
    const paintFrame = { x: Math.floor(group.influenceLeft + 1e-6), y: Math.floor(group.influenceTop + 1e-6) };
    paintFrame.width = Math.ceil(group.influenceLeft + group.influenceWidth - 1e-6) - paintFrame.x;
    paintFrame.height = Math.ceil(group.influenceTop + group.influenceHeight - 1e-6) - paintFrame.y;
    if (group.image.size?.width !== paintFrame.width || group.image.size?.height !== paintFrame.height
      || paintFrame.x > frame.x || paintFrame.y > frame.y
      || paintFrame.x + paintFrame.width < frame.x + frame.width - 1e-6
      || paintFrame.y + paintFrame.height < frame.y + frame.height - 1e-6) return [];
    const nodes = [];
    const ids = new Set();
    const visit = (current) => {
      if (!current?.id || ids.has(current.id) || idCounts.get(current.id) !== 1
        || !['layer-group', 'shape', 'bitmap', 'text'].includes(current.type)
        || current.layers !== undefined && !Array.isArray(current.layers)) return false;
      ids.add(current.id);
      nodes.push(current);
      const children = [...new Set([...(current.layers || []), ...(childrenByParent.get(current.id) || [])])];
      return children.every(visit);
    };
    if (!visit(group)) return [];
    return nodes.filter((anchor) => anchor.type === 'shape' && !anchor.hasClippingMask
      && !anchor.rotation && !anchor.isFlippedHorizontal && !anchor.isFlippedVertical
      && !anchor.shouldBreakMaskChain && anchor.isVisible !== false
      && [undefined, 100].includes(anchor.opacity) && [undefined, 0].includes(anchor.blendMode)
      && anchor.ddsType === 'rectangle' && anchor.ddsImage?.imageUrl
      && anchor.layerOriginFrame && anchor.ddsOriginFrame
      && ['x', 'y', 'width', 'height'].every((key) => finite(anchor.layerOriginFrame[key]) && finite(anchor.ddsOriginFrame[key]))
      && ['x', 'y', 'height'].every((key) => Math.abs(anchor.layerOriginFrame[key] - frame[key]) < 1e-6)
      && anchor.layerOriginFrame.width > 0 && anchor.layerOriginFrame.width < frame.width
      && anchor.ddsOriginFrame.width > 0 && anchor.ddsOriginFrame.height > 0).map((anchor) => ({
      anchorId: anchor.id, exportLayerId: group.id, image: group.image.imageUrl,
      sourceImage: anchor.ddsImage.imageUrl, frame: anchor.layerOriginFrame,
      sourceFrame: anchor.ddsOriginFrame, paintFrame, layerIds: [...ids],
      textById: Object.fromEntries(nodes.filter((n) => n.type === 'text'
        && n.font?.styles?.length && n.font.styles.every((run) => typeof run.content === 'string'))
        .map((n) => [n.id, n.font.styles.map((run) => run.content).join('')]))
    }));
  };

  const resolve_exported_artwork = (node, entry, sourceSchema) => {
    const style = node.props?.style || node.style || {};
    const pixels = (v) => typeof v === 'number' ? v
      : typeof v === 'string' && /^[+-]?\d+(?:\.\d+)?(?:px)?$/.test(v) ? Number(v.replace(/px$/, '')) : NaN;
    const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) < 1e-6;
    if (!entry || node.type !== 'lanhublock' || !node.children?.length || !node.rowDims
      || !['left', 'top', 'width', 'height'].every((key, i) => close(node.rowDims[key], entry.frame[['x', 'y', 'width', 'height'][i]]))
      || !['width', 'height'].every((key) => close(pixels(style[key]), entry.frame[key]))
      || Object.keys(style).some((key) => /^(?:padding|border|transform|filter|backdropFilter|boxShadow|backgroundColor|backgroundImage|overflow)/.test(key)
        && !(key === 'border' && /^\d+(?:\.\d+)?px\s+solid\s*$/.test(style[key]))
        && ![undefined, 0, '0', '0px', 'none', 'transparent', 'visible'].includes(style[key]))
      || ![undefined, 1, '1'].includes(style.opacity)
      || ['backgroundPosition', 'backgroundRepeat', 'backgroundClip', 'backgroundOrigin', 'backgroundBlendMode',
        'clip', 'clipPath', 'mask', 'maskImage', 'mixBlendMode'].some((key) => style[key] !== undefined)) return null;
    const match = /^url\(\s*(['"]?)(.*?)\1\s*\)\s+([+-]?\d+(?:\.\d+)?px)\s+([+-]?\d+(?:\.\d+)?px)\s+no-repeat$/.exec(style.background || '');
    const size = typeof style.backgroundSize === 'string' ? style.backgroundSize.split(/\s+/).map(pixels) : [];
    if (!match || match[2] !== entry.sourceImage || size.length !== 2
      || !close(size[0], entry.sourceFrame.width) || !close(size[1], entry.sourceFrame.height)
      || !close(pixels(match[3]), entry.sourceFrame.x - entry.frame.x)
      || !close(pixels(match[4]), entry.sourceFrame.y - entry.frame.y)) return null;
    const ids = new Set(entry.layerIds);
    const seen = new Set();
    const rasterizedText = [];
    const drawing = (current) => {
      if (!current || !ids.has(current.layerId) || seen.has(current.layerId)
        || !['lanhublock', 'lanhuimage', 'lanhutext'].includes(current.type) || current.loopType || current.condition
        || Object.keys(current.styleObj || {}).length || Object.keys(current.props?.styleObj || {}).length
        || [current.data?.value, current.props?.src, current.props?.text, current.value]
          .some((value) => typeof value === 'string' && /^\s*(?:this\.)?item(?:\.|\[)/.test(value))
        || current.children !== undefined && !Array.isArray(current.children)) return false;
      if (current.type === 'lanhutext') {
        const text = current.data?.value ?? current.props?.text;
        if (typeof text !== 'string' || !text || text !== entry.textById[current.layerId]) return false;
        rasterizedText.push(text);
      }
      seen.add(current.layerId);
      return (current.children || []).every(drawing);
    };
    if (!drawing(node)) return null;
    // Only static absolute peers may be consumed: ordinary-flow siblings must keep
    // their space, and independently edited/dynamic labels must stay as real text.
    const consumedNodes = [];
    const outside = (current) => {
      if (!current || current === node) return true;
      if (current.loopType || current.condition || Object.keys(current.styleObj || {}).length
        || Object.keys(current.props?.styleObj || {}).length) return false;
      if (ids.has(current.layerId)) {
        if ((current.props?.style || current.style)?.position !== 'absolute' || !drawing(current)) return false;
        consumedNodes.push(current);
        return true;
      }
      return !Array.isArray(current.children) || current.children.every(outside);
    };
    return outside(sourceSchema) ? { ...entry, consumedNodes, rasterizedText } : null;
  };

  // An explicit full export of the schema's own layer takes precedence over all
  // CSS reconstruction. A DDS preview URL alone does not establish completeness.
  const compile_exported_slice = (layer, childrenByParent, idCounts) => {
    const frame = layer.layerOriginFrame;
    if (layer.exportable !== true || !layer.id || !['layer-group', 'shape', 'bitmap'].includes(layer.type)
      || !/^https:\/\//.test(layer.image?.imageUrl || '') || !frame || !layer.ddsOriginFrame
      || !['x', 'y', 'width', 'height'].every((key) => finite(frame[key])
        && finite(layer.ddsOriginFrame[key]) && Math.abs(frame[key] - layer.ddsOriginFrame[key]) < 1e-6)
      || frame.width <= 0 || frame.height <= 0
      || layer.image.size?.width !== frame.width || layer.image.size?.height !== frame.height
      || layer.rotation || layer.isFlippedHorizontal || layer.isFlippedVertical || layer.hasClippingMask
      || layer.shouldBreakMaskChain || layer.isVisible === false
      || ![undefined, 100].includes(layer.opacity) || ![undefined, 0].includes(layer.blendMode)) return null;
    const ids = new Set();
    const visit = (current) => {
      if (!current?.id || ids.has(current.id) || idCounts.get(current.id) !== 1
        || !['layer-group', 'shape', 'bitmap'].includes(current.type)
        || current.layers !== undefined && !Array.isArray(current.layers)) return false;
      ids.add(current.id);
      return [...new Set([...(current.layers || []), ...(childrenByParent.get(current.id) || [])])].every(visit);
    };
    return visit(layer) ? { direct: true, exportLayerId: layer.id, image: layer.image.imageUrl,
      sourceImage: layer.ddsImage?.imageUrl || layer.image.imageUrl, frame, layerIds: [...ids] } : null;
  };

  const resolve_exported_slice = (node, entry, sourceSchema) => {
    const style = node.props?.style || node.style || {};
    const pixels = (v) => typeof v === 'number' ? v
      : typeof v === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(v) ? Number(v.replace(/px$/, '')) : NaN;
    const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) < 1e-6;
    if (!entry || !['lanhublock', 'lanhuimage'].includes(node.type) || !node.rowDims
      || !['left', 'top', 'width', 'height'].every((key, i) => close(node.rowDims[key], entry.frame[['x', 'y', 'width', 'height'][i]]))
      || !['width', 'height'].every((key) => close(pixels(style[key]), entry.frame[key]))
      || Object.keys(style).some((key) => /^(?:padding|border|transform|filter|backdropFilter|boxShadow|backgroundColor|clip|mask|mixBlendMode)/.test(key)
        && ![undefined, 0, '0', '0px', 'none', 'transparent'].includes(style[key]))
      || ![undefined, 1, '1'].includes(style.opacity)) return null;
    const sameUrl = (url) => typeof url === 'string' && [entry.sourceImage, entry.image].includes(url);
    let sourceImage;
    if (node.type === 'lanhuimage') {
      sourceImage = node.data?.value || node.props?.src || node.value;
      if (node.children?.length || !sameUrl(sourceImage)
        || ['background', 'backgroundImage'].some((key) => style[key] && style[key] !== 'none')
        || ![undefined, 'fill'].includes(style.objectFit)
        || ![undefined, '50% 50%'].includes(style.objectPosition)) return null;
    } else {
      const keys = ['background', 'backgroundImage'].filter((key) => typeof style[key] === 'string' && style[key].includes('url('));
      if (keys.length !== 1 || ['background', 'backgroundImage'].some((key) => key !== keys[0]
        && ![undefined, '', 'none', 'transparent'].includes(style[key]))) return null;
      const match = /^url\(\s*(['"]?)(.*?)\1\s*\)(?:\s+100%\s+no-repeat)?$/.exec(style[keys[0]]);
      const size = typeof style.backgroundSize === 'string' ? style.backgroundSize.split(/\s+/) : [];
      if (!match || !sameUrl(match[2]) || size.length !== 2
        || !size.every((part, i) => part === '100%' || close(pixels(part), entry.frame[i ? 'height' : 'width']))
        || ![undefined, '0 0', '0px 0px', '100% 100%'].includes(style.backgroundPosition)
        || ![undefined, 'no-repeat'].includes(style.backgroundRepeat)
        || ['backgroundClip', 'backgroundOrigin', 'backgroundBlendMode'].some((key) => style[key] !== undefined)) return null;
      sourceImage = match[2];
    }
    const ids = new Set(entry.layerIds);
    const seen = new Set();
    const drawing = (current) => {
      if (!current || !ids.has(current.layerId) || seen.has(current.layerId)
        || !['lanhublock', 'lanhuimage'].includes(current.type) || current.loopType || current.condition
        || Object.keys(current.styleObj || {}).length || Object.keys(current.props?.styleObj || {}).length
        || [current.data?.value, current.props?.src, current.props?.text, current.value]
          .some((value) => typeof value === 'string' && /^\s*(?:this\.)?item(?:\.|\[)/.test(value))
        || current.children !== undefined && !Array.isArray(current.children)) return false;
      seen.add(current.layerId);
      return (current.children || []).every(drawing);
    };
    const outside = (current) => current && current !== node && (ids.has(current.layerId)
      || Array.isArray(current.children) && current.children.some(outside));
    return drawing(node) && !outside(sourceSchema) ? { ...entry, sourceImage } : null;
  };

  const resolveExportedMaskGroup = (node, index, sourceSchema = node) => {
    const complete = sourceSchema && resolve_exported_slice(node, index?.[`export:${node.layerId}`], sourceSchema);
    if (complete) return complete;
    const artwork = sourceSchema && resolve_exported_artwork(node, index?.[`artwork:${node.layerId}`], sourceSchema);
    if (artwork) return artwork;
    const entry = index?.[`slice:${node.layerId}`];
    const style = node.props?.style || node.style || {};
    const box = node.rowDims;
    const pixels = (value) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : NaN;
    if (!entry || node.type !== 'lanhublock' || !box || !node.children?.length
      || box.left !== entry.frame.x || box.top !== entry.frame.y
      || ['width', 'height'].some((key) => box[key] !== entry.frame[key] || pixels(style[key]) !== entry.frame[key])
      || style.backgroundSize !== '100% 100%'
      || Object.keys(style).some((key) => /^(?:padding|border|transform|filter|backgroundColor|backgroundImage)/.test(key)
        && ![undefined, 0, '0', '0px', 'none', 'transparent'].includes(style[key]))) return null;
    const match = /^url\(\s*(['"]?)(.*?)\1\s*\)\s+100%\s+no-repeat$/.exec(style.background || '');
    if (!match || match[2] !== entry.sourceImage) return null;
    const ids = new Set(entry.layerIds);
    const seen = new Set();
    const staticDrawing = (current) => {
      if (!current || !ids.has(current.layerId) || seen.has(current.layerId)
        || !['lanhublock', 'lanhuimage'].includes(current.type) || current.loopType || current.condition
        || Object.keys(current.styleObj || {}).length || Object.keys(current.props?.styleObj || {}).length
        || /^(?:this\.)?item\./.test(current.data?.value || current.props?.src || '')
        || (current.children !== undefined && !Array.isArray(current.children))) return false;
      seen.add(current.layerId);
      return (current.children || []).every(staticDrawing);
    };
    return staticDrawing(node) ? entry : null;
  };

  const findLayer = (index, url) => {
    for (const key of url_keys(url)) {
      if (Object.hasOwn(index, key)) return index[key];
    }
    return null;
  };

  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const rounded_length = (value) => Number(value.toFixed(6)) || 0;
  const color_css = (color, opacity = 1) => {
    if (!color || !['r', 'g', 'b'].every((key) => finite(color[key]) && color[key] >= 0 && color[key] <= 255)
      || !finite(color.a) || color.a < 0 || color.a > 1) return null;
    return `rgba(${color.r},${color.g},${color.b},${color.a * opacity})`;
  };
  const enabled = (items) => Array.isArray(items) ? items.filter((item) => item?.isEnabled !== false) : [];
  // Layer opacity uses 0..100; individual effects use 0..1 in Lanhu JSON.
  const supported_effect = (effect) => effect && (effect.opacity === undefined
    || (finite(effect.opacity) && effect.opacity >= 0 && effect.opacity <= 1))
    && (effect.blendMode === undefined || effect.blendMode === 0);

  const fill_css = (fill, frame) => {
    if (!supported_effect(fill)) return null;
    if (fill.type === 'color' || fill.fillType === 0) return color_css(fill.color, fill.opacity);
    if (fill.type !== 'gradient' && fill.fillType !== 1) return null;
    const gradient = fill.gradient;
    if (!gradient || (gradient.type !== 'linear' && !(gradient.type === undefined && gradient.gradientType === 0))
      || (gradient.gradientType !== undefined && gradient.gradientType !== 0)
      || ![gradient.from?.x, gradient.from?.y, gradient.to?.x, gradient.to?.y].every(finite)
      || !Array.isArray(gradient.colorStops) || gradient.colorStops.length < 2) return null;
    const dx = gradient.to.x - gradient.from.x;
    const dy = gradient.to.y - gradient.from.y;
    // Full-span axis gradients do not need geometry; other gradients project stops onto the CSS line.
    const fullVertical = dx === 0 && ((gradient.from.y === 0 && gradient.to.y === 1) || (gradient.from.y === 1 && gradient.to.y === 0));
    const fullHorizontal = dy === 0 && ((gradient.from.x === 0 && gradient.to.x === 1) || (gradient.from.x === 1 && gradient.to.x === 0));
    let angle = Math.round(Math.atan2(dx, -dy) * 180 / Math.PI);
    let position = (stop) => stop.position * 100;
    if (!fullVertical && !fullHorizontal) {
      if (!finite(frame?.width) || !finite(frame?.height) || frame.width <= 0 || frame.height <= 0) return null;
      const px = dx * frame.width;
      const py = dy * frame.height;
      const distance = Math.hypot(px, py);
      if (!finite(distance) || distance === 0) return null;
      const ux = px / distance;
      const uy = py / distance;
      const length = Math.abs(frame.width * ux) + Math.abs(frame.height * uy);
      const start = (gradient.from.x - 0.5) * frame.width * ux
        + (gradient.from.y - 0.5) * frame.height * uy + length / 2;
      angle = Math.round(Math.atan2(px, -py) * 180 / Math.PI * 1e6) / 1e6;
      position = (stop) => Math.round((start + stop.position * distance) / length * 100 * 1e6) / 1e6;
    }
    const stops = gradient.colorStops.slice().sort((a, b) => a?.position - b?.position);
    if (!stops.every((stop) => finite(stop?.position) && stop.position >= 0 && stop.position <= 1 && color_css(stop.color))) return null;
    return `linear-gradient(${angle}deg, ${stops.map((stop) => `${color_css(stop.color, fill.opacity)} ${position(stop)}%`).join(', ')})`;
  };

  // Compare rendered border properties, not JSON field order or export metadata.
  const same_border = (left, right, frame) => {
    if (!supported_effect(left) || !supported_effect(right) || left.type !== right.type
      || !finite(left.thickness) || left.thickness !== right.thickness) return false;
    const position = (value) => ['inside', '内边框', '内部'].includes(value) ? 'inside'
      : ['outside', '外边框', '外部'].includes(value) ? 'outside'
        : ['center', '中心边框'].includes(value) ? 'center' : value;
    const paint = fill_css(left, frame);
    return Boolean(paint) && paint === fill_css(right, frame) && position(left.position) === position(right.position);
  };

  const is_rectangle = (layer) => {
    const declaredRectangle = ['rectangle', 'rounded-rectangle'].includes(layer.ddsType || layer.type);
    // DDS may label a slanted polygon as a rectangle. Explicit path geometry wins:
    // a rectangular CSS fill cannot reproduce its transparent outline.
    if (declaredRectangle && layer.points === undefined) return true;
    if ((!declaredRectangle && (layer.ddsType !== undefined || layer.type !== 'shape')) || layer.isClosed !== true
      || (layer.booleanOperation !== undefined && layer.booleanOperation !== -1)
      || !Array.isArray(layer.points) || layer.points.length < 4) return false;
    let points = layer.points;
    // Typed rectangles may contain redundant straight-edge vertices. Removing only
    // zero-radius, collinear points preserves the outline, not a polygon's slanted edge.
    if (declaredRectangle) {
      if (points.some((vertex) => vertex?.hasCurveFrom !== false || vertex.hasCurveTo !== false
        || (vertex.curveMode !== undefined && vertex.curveMode !== 1)
        || ![vertex.point?.x, vertex.point?.y].every(finite)
        || (vertex.cornerRadius !== undefined && (!finite(vertex.cornerRadius) || vertex.cornerRadius < 0)))) return false;
      points = points.filter((vertex, i) => {
        if (vertex.cornerRadius) return true;
        const previous = layer.points[(i + layer.points.length - 1) % layer.points.length].point;
        const next = layer.points[(i + 1) % layer.points.length].point;
        return !['x', 'y'].some((axis) => {
          const along = axis === 'x' ? 'y' : 'x';
          return Math.abs(previous[axis] - vertex.point[axis]) <= 1e-6
            && Math.abs(next[axis] - vertex.point[axis]) <= 1e-6
            && vertex.point[along] > Math.min(previous[along], next[along])
            && vertex.point[along] < Math.max(previous[along], next[along]);
        });
      });
    }
    if (points.length !== 4) return false;
    const corners = [];
    for (const vertex of points) {
      if (vertex?.hasCurveFrom !== false || vertex.hasCurveTo !== false
        || (vertex.curveMode !== undefined && vertex.curveMode !== 1)
        || (vertex.cornerRadius !== undefined && (!finite(vertex.cornerRadius) || vertex.cornerRadius < 0))) return false;
      const coordinates = [vertex.point?.x, vertex.point?.y];
      if (!coordinates.every((n) => finite(n) && Math.min(Math.abs(n), Math.abs(n - 1)) <= 1e-6)) return false;
      corners.push(coordinates.map((n) => Math.round(n)));
    }
    if (layer.radius !== undefined) {
      const declared = Array.isArray(layer.radius) ? layer.radius : [layer.radius];
      const radii = corners.map(([x, y], i) => ({ index: y === 0 ? x : 3 - x, radius: points[i].cornerRadius || 0 }))
        .sort((a, b) => a.index - b.index).map((corner) => corner.radius);
      if (!declared.length || declared.length > 4 || !declared.every((r) => finite(r) && r >= 0)) return false;
      const expanded = [declared[0], declared[1] ?? declared[0], declared[2] ?? declared[0], declared[3] ?? declared[1] ?? declared[0]];
      if (radii.some((r, i) => r !== expanded[i])) return false;
    }
    return new Set(corners.map((corner) => corner.join(','))).size === 4
      && corners.every((corner, i) => {
        const next = corners[(i + 1) % 4];
        return Math.abs(corner[0] - next[0]) + Math.abs(corner[1] - next[1]) === 1;
      });
  };

  const is_standard_ellipse = (circle) => {
    if (circle.type !== 'shape' || circle.isClosed !== true || circle.booleanOperation !== -1
      || (circle.opacity !== undefined && circle.opacity !== 100)
      || !Array.isArray(circle.points) || circle.points.length !== 4
      || enabled(circle.borders).length || enabled(circle.shadow).length
      || enabled(circle.fills).length !== 1 || enabled(circle.fills)[0]?.type !== 'color') return false;
    const near = (a, b) => finite(a) && Math.abs(a - b) < 1e-6;
    const cardinal = [[1, 0.5], [0.5, 1], [0, 0.5], [0.5, 0]];
    const ids = circle.points.map((v) => cardinal.findIndex(([x, y]) => near(v?.point?.x, x) && near(v?.point?.y, y)));
    if (new Set(ids).size !== 4 || ids.includes(-1)) return false;
    const k = 0.2761423749153967;
    for (let i = 0; i < 4; i++) {
      const v = circle.points[i];
      const next = cardinal[ids[(i + 1) % 4]];
      const previous = cardinal[ids[(i + 3) % 4]];
      const [x, y] = cardinal[ids[i]];
      if (Math.abs(ids[i] - ids[(i + 1) % 4]) % 2 !== 1 || v.hasCurveFrom !== true || v.hasCurveTo !== true
        || (v.cornerRadius !== undefined && v.cornerRadius !== 0)) return false;
      const control = (neighbor) => x === 0.5
        ? { x: x + Math.sign(neighbor[0] - x) * k, y }
        : { x, y: y + Math.sign(neighbor[1] - y) * k };
      const from = control(next);
      const to = control(previous);
      if (!near(v.curveFrom?.x, from.x) || !near(v.curveFrom?.y, from.y)
        || !near(v.curveTo?.x, to.x) || !near(v.curveTo?.y, to.y)) return false;
    }
    return true;
  };

  // Normalize only transforms that cannot change a uniform, symmetric rectangle.
  const normalize_symmetric_rectangle = (layer) => {
    // Sketch exports can contain numerical noise instead of an exact zero angle.
    // Normalize only verified rectangles, without mutating the captured layer data.
    if (layer && finite(layer.rotation) && layer.rotation !== 0
      && Math.abs(layer.rotation) <= 0.00001 && is_rectangle(layer)
      && !layer.hasClippingMask && !layer.blur?.isEnabled) {
      layer = { ...layer, rotation: 0 };
    }
    if (!layer || (!layer.rotation && !layer.isFlippedHorizontal && !layer.isFlippedVertical)
      || !is_rectangle(layer) || ![undefined, 0, 180, -180].includes(layer.rotation)
      || layer.hasClippingMask || layer.blur?.isEnabled || enabled(layer.shadow).length
      || layer.borderOptions?.dashPattern?.length || layer.shouldBreakMaskChain) return layer;
    const fills = enabled(layer.fills);
    const borders = enabled(layer.borders);
    const radii = layer.radius === undefined ? [0] : Array.isArray(layer.radius) ? layer.radius : [layer.radius];
    const frame = layer.layerOriginFrame;
    const exported = layer.ddsOriginFrame;
    const verticalGradient = fills.length === 1 && fills[0]?.type === 'gradient'
      && !layer.rotation && layer.isFlippedHorizontal && !layer.isFlippedVertical
      && fills[0].gradient?.from?.x === fills[0].gradient?.to?.x
      && Boolean(fill_css(fills[0], frame));
    if (fills.length !== 1 || (fills[0]?.type !== 'color' && !verticalGradient) || borders.length > 1
      || borders.some((border) => border?.type !== 'color' || !['inside', '内边框', '内部'].includes(border.position))
      || !radii.length || radii.length > 4 || !radii.every((r) => finite(r) && r >= 0 && r === radii[0])
      || layer.points?.some((point) => (point.cornerRadius ?? 0) !== radii[0])
      || !frame || !exported || !['x', 'y', 'width', 'height'].every((key) =>
        finite(frame[key]) && finite(exported[key]) && Math.abs(frame[key] - exported[key]) <= 1e-6)) return layer;
    return { ...layer, rotation: 0, isFlippedHorizontal: false, isFlippedVertical: false };
  };

  // An opaque fill and an identical inside stroke form one paint before layer opacity.
  // Collapsing them avoids double alpha at the edge and leaves child content opaque.
  const normalize_uniform_border = (layer, style) => {
    if (!layer || !is_rectangle(layer) || layer.hasClippingMask || layer.shouldBreakMaskChain
      || layer.blur?.isEnabled || enabled(layer.shadow).length || layer.borderOptions?.dashPattern?.length
      || ['fills', 'borders', 'shadow'].some((key) => layer[key] !== undefined && !Array.isArray(layer[key]))
      || enabled(layer.fills).length !== 1 || enabled(layer.borders).length !== 1
      || (style.border && style.border !== 'none') || (style.boxShadow && style.boxShadow !== 'none')) return layer;
    const frame = layer.layerOriginFrame;
    const exported = layer.ddsOriginFrame;
    if (!frame || !exported || frame.width <= 0 || frame.height <= 0
      || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key])
        || Math.abs(frame[key] - exported[key]) > 1e-6)) return layer;
    const border = enabled(layer.borders)[0];
    if (!['inside', '内边框', '内部'].includes(border.position) || !finite(border.thickness)
      || border.thickness <= 0 || border.thickness * 2 >= Math.min(frame.width, frame.height)) return layer;
    const solid = (paint) => {
      if (!supported_effect(paint) || (paint.opacity ?? 1) !== 1 || !fill_css(paint, frame)) return null;
      const colors = paint.type === 'color' || paint.fillType === 0 ? [paint.color]
        : paint.gradient?.colorStops?.map((stop) => stop.color);
      return colors?.length && colors.every((color) => color?.a === 1
        && color_css(color) === color_css(colors[0])) ? colors[0] : null;
    };
    const color = solid(enabled(layer.fills)[0]);
    const stroke = solid(border);
    if (!color || !stroke || color_css(color) !== color_css(stroke)) return layer;
    return { ...layer, fills: [{ type: 'color', color }], borders: [] };
  };

  // Reproject cropped unrounded gradients, or keep inset strokes only when the
  // crop is perpendicular to their offset and cannot introduce a new painted edge.
  const normalize_cropped_axis_paint = (layer) => {
    const frame = layer?.layerOriginFrame;
    const exported = layer?.ddsOriginFrame;
    if (!layer || !frame || !exported || !is_rectangle(layer) || layer.hasClippingMask
      || layer.rotation || layer.isFlippedHorizontal || layer.isFlippedVertical || layer.blur?.isEnabled
      || layer.shouldBreakMaskChain || enabled(layer.borders).length
      || layer.points?.some((point) => point.cornerRadius)
      || (layer.radius !== undefined && (Array.isArray(layer.radius) ? layer.radius : [layer.radius]).some((r) => r !== 0))
      || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key]))
      || frame.width <= 0 || frame.height <= 0 || exported.width <= 0 || exported.height <= 0
      || Math.abs(frame.x - exported.x) > 1e-6 || Math.abs(frame.y - exported.y) > 1e-6
      || exported.width > frame.width || exported.height > frame.height
      || exported.width === frame.width && exported.height === frame.height) return layer;
    const fills = enabled(layer.fills);
    if (fills.length !== 1 || !fill_css(fills[0], frame)) return layer;
    const shadows = enabled(layer.shadow);
    if (fills[0].type === 'color' && shadows.length
      && (layer.opacity === undefined || layer.opacity === 100)
      && shadows.every((shadow) => supported_effect(shadow) && shadow.type === '内阴影'
        && color_css(shadow.color, shadow.opacity) && shadow.blurRadius === 0 && shadow.spread === 0
        && finite(shadow.offsetX) && finite(shadow.offsetY)
        && (exported.width === frame.width || shadow.offsetX === 0)
        && (exported.height === frame.height || shadow.offsetY === 0))) {
      return { ...layer, ddsType: 'rectangle', points: undefined, layerOriginFrame: { ...exported } };
    }
    if (fills[0].type !== 'gradient' || shadows.length) return layer;
    const gradient = fills[0].gradient;
    const project = (point) => ({ x: point.x * frame.width / exported.width,
      y: point.y * frame.height / exported.height });
    return { ...layer, ddsType: 'rectangle', points: undefined, layerOriginFrame: { ...exported },
      fills: [{ ...fills[0], gradient: { ...gradient, from: project(gradient.from), to: project(gradient.to) } }] };
  };

  const resolveVectorStyles = (value, index, originalStyle = {}) => {
    if (typeof value !== 'string' || !index) return null;
    const urls = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)];
    if (urls.length !== 1) return null;
    // Only understood positioning/sizing tokens may surround the image. Colors and functions
    // in a background shorthand must not disappear when its image is converted to CSS paint.
    const remainder = value.replace(urls[0][0], '').replace(/\//g, ' / ').trim();
    if (remainder && !remainder.split(/\s+/).every((token) =>
      /^(?:[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:px|%)?|\/|auto|cover|contain|left|right|top|bottom|center|repeat|repeat-x|repeat-y|no-repeat|space|round|scroll|fixed|local|border-box|padding-box|content-box)$/.test(token))) return null;
    let layer = normalize_uniform_border(normalize_cropped_axis_paint(
      normalize_symmetric_rectangle(findLayer(index, urls[0][2]))), originalStyle);
    if (layer?.verifiedTransparentBitmap) return {};
    // Some DDS records echo the same alpha in both color and fill.opacity, while
    // the exported bitmap applies it once. Equality alone cannot prove that two
    // factors are independent: keep the authoritative image for this ambiguity.
    const sourceFills = enabled(layer?.fills);
    const solid = sourceFills.length === 1 ? sourceFills[0] : null;
    if ((solid?.type === 'color' || solid?.fillType === 0) && typeof solid.color?.value === 'string'
      && finite(solid.color.a) && solid.color.a > 0 && solid.color.a < 1
      && finite(solid.opacity) && Math.abs(solid.opacity - solid.color.a) < 1e-6) return null;
    // Opaque solid fill/stroke are disjoint paints before the layer alpha is applied.
    // Clip the CSS fill to the padding box to avoid applying alpha twice at the border.
    if (layer && finite(layer.opacity) && layer.opacity >= 0 && layer.opacity < 100
      && is_rectangle(layer) && !layer.hasClippingMask && !layer.shouldBreakMaskChain && !layer.blur?.isEnabled
      && !enabled(layer.shadow).length && enabled(layer.fills).length === 1 && enabled(layer.borders).length === 1
      && !layer.borderOptions?.dashPattern?.length && layer.layerOriginFrame && layer.ddsOriginFrame
      && ['x', 'y', 'width', 'height'].every((key) => finite(layer.layerOriginFrame[key])
        && finite(layer.ddsOriginFrame[key]) && Math.abs(layer.layerOriginFrame[key] - layer.ddsOriginFrame[key]) <= 1e-6)) {
      const fill = enabled(layer.fills)[0];
      const border = enabled(layer.borders)[0];
      if (fill.type === 'color' && border.type === 'color' && fill.color?.a === 1 && border.color?.a === 1
        && supported_effect(fill) && supported_effect(border) && (fill.opacity ?? 1) === 1 && (border.opacity ?? 1) === 1
        && ['inside', '内边框', '内部'].includes(border.position)) {
        const candidate = { ...layer, opacity: 100, fills: [{ ...fill, opacity: layer.opacity / 100 }],
          borders: [{ ...border, opacity: layer.opacity / 100 }] };
        const paint = resolveVectorStyles(value, { ...index,
          ...Object.fromEntries(url_keys(urls[0][2]).map((key) => [key, candidate])) }, originalStyle);
        return paint ? { ...paint, backgroundClip: 'padding-box' } : null;
      }
    }
    if (layer?.cssLayerPaint) return render_layer_paint(layer.cssLayerPaint, originalStyle, [], remainder);
    if (layer?.cssSideBar) {
      const pixels = (value) => typeof value === 'number' ? value
        : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : NaN;
      if ((originalStyle.transform && originalStyle.transform !== 'none')
        || (originalStyle.filter && originalStyle.filter !== 'none')
        || (originalStyle.opacity !== undefined && Number(originalStyle.opacity) !== 1)
        || (originalStyle.border && originalStyle.border !== 'none')
        || (originalStyle.boxShadow && originalStyle.boxShadow !== 'none')
        || originalStyle.objectFit && originalStyle.objectFit !== 'fill'
        || originalStyle.objectPosition && originalStyle.objectPosition !== '50% 50%'
        || originalStyle.backgroundSize !== undefined && originalStyle.backgroundSize !== '100% 100%'
        || originalStyle.backgroundPosition && !['0 0', '100% 100%'].includes(originalStyle.backgroundPosition)
        || remainder && !['100% no-repeat', '0 0 no-repeat'].includes(remainder)
        || originalStyle.width !== undefined && Math.abs(pixels(originalStyle.width) - layer.layerOriginFrame.width) > 1e-6
        || originalStyle.width !== undefined && !finite(pixels(originalStyle.width))
        || originalStyle.height !== undefined && originalStyle.height !== 'auto'
          && (!finite(pixels(originalStyle.height)) || pixels(originalStyle.height) < layer.cssSideBar.width)
        || Object.keys(originalStyle).some((key) => /^(?:padding|border(?:Top|Right|Bottom|Left|Width))/.test(key)
          && ![undefined, 0, '0', '0px', 'none'].includes(originalStyle[key]))) return null;
      return { position: ['relative', 'absolute', 'fixed', 'sticky'].includes(originalStyle.position)
        ? originalStyle.position : 'relative', decorationNodes: [{ ...layer.cssSideBar }] };
    }
    if (layer?.cssShadowGroup && ['width', 'height'].some((key) => {
      const value = originalStyle[key];
      return value !== undefined && (typeof value !== 'number' && !/^\d+(?:\.\d+)?(?:px)?$/.test(value)
        || Math.abs(Number(String(value).replace(/px$/, '')) - layer.layerOriginFrame[key]) > 1e-6);
    })) return null;
    // Independent ellipse exports reuse the verified four-segment path check.
    if (layer && is_standard_ellipse(layer) && !layer.hasClippingMask && !layer.shouldBreakMaskChain
      && !layer.blur?.isEnabled && !layer.rotation && !layer.isFlippedHorizontal && !layer.isFlippedVertical) {
      const frame = layer.layerOriginFrame;
      const exported = layer.ddsOriginFrame;
      if (frame && exported && ['x', 'y', 'width', 'height'].every((key) =>
        finite(frame[key]) && finite(exported[key]) && Math.abs(frame[key] - exported[key]) <= 1e-6)
        && frame.width > 0 && frame.height > 0) {
        const candidate = { ...layer, ddsType: 'rectangle', radius: undefined, points: undefined };
        // The rectangle path still validates opacity, effects and child layers.
        const styles = resolveVectorStyles(value, { ...index,
          ...Object.fromEntries(url_keys(urls[0][2]).map((key) => [key, candidate])) }, originalStyle);
        return styles ? { ...styles, borderRadius: '50%' } : null;
      }
    }
    if (layer?.iconBackground || layer?.transparentGroup || layer?.gradientCardStyles) {
      if ((originalStyle.transform && originalStyle.transform !== 'none')
        || (originalStyle.filter && originalStyle.filter !== 'none')
        || (originalStyle.opacity !== undefined && Number(originalStyle.opacity) !== 1)) return null;
      if (layer.iconBackground) {
        if (layer.paintedIcon && (originalStyle.border && originalStyle.border !== 'none'
          || originalStyle.boxShadow && originalStyle.boxShadow !== 'none')) return null;
        const frame = layer.layerOriginFrame;
        const pixels = (value) => typeof value === 'number' ? value
          : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value.trim()) ? Number(value.trim().replace(/px$/, '')) : NaN;
        if (['width', 'height'].some((key) => originalStyle[key] !== undefined
          && (!finite(pixels(originalStyle[key])) || Math.abs(pixels(originalStyle[key]) - frame[key]) > 1e-6))) return null;
        const neutralPosition = (position) => position === undefined || position === ''
          || typeof position === 'string' && position.trim().split(/\s+/).every((token) =>
          /^(?:0(?:px)?|[-+]?\d+(?:\.\d+)?%|left|right|top|bottom|center)$/.test(token));
        const shorthand = remainder.replace(/\b(?:no-repeat|repeat-x|repeat-y|repeat|scroll|fixed|local|border-box|padding-box|content-box)\b/g, '').trim().split('/');
        if (!neutralPosition(shorthand[0]) || !neutralPosition(originalStyle.backgroundPosition)) return null;
        const size = originalStyle.backgroundSize ?? shorthand[1]?.trim();
        if (size !== undefined && size !== '') {
          const parts = typeof size === 'string' ? size.trim().split(/\s+/) : [];
          if (!(parts.length === 1 && parts[0] === 'auto')
            && !(parts.length === 2 && parts.every((part, i) => part === 'auto' || part === '100%'
              || Math.abs(pixels(part) - frame[i === 0 ? 'width' : 'height']) <= 1e-6))) return null;
        }
      }
      if (layer.gradientCardStyles) {
        const { width, height } = layer.layerOriginFrame;
        const pixels = (value) => typeof value === 'number' ? value
          : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : NaN;
        if (['width', 'height'].some((key) => originalStyle[key] !== undefined
          && Math.abs(pixels(originalStyle[key]) - ({ width, height })[key]) > 1e-6)
          || ['width', 'height'].some((key) => originalStyle[key] !== undefined && !finite(pixels(originalStyle[key])))
          || originalStyle.border && originalStyle.border !== 'none'
          || originalStyle.boxShadow && originalStyle.boxShadow !== 'none') return null;
      }
      return layer.gradientCardStyles || layer.iconBackground || {};
    }
    if (layer?.statusLabel) {
      if ((originalStyle.transform && originalStyle.transform !== 'none')
        || (originalStyle.filter && originalStyle.filter !== 'none')
        || (originalStyle.opacity !== undefined && Number(originalStyle.opacity) !== 1)) return null;
      return { position: ['relative', 'absolute', 'fixed', 'sticky'].includes(originalStyle.position)
        ? originalStyle.position : 'relative', isolation: 'isolate', decorationNodes: layer.statusLabel };
    }
    if (layer?.capsuleDecoration) {
      const { capsuleDecoration, ...paintLayer } = layer;
      const capsuleValueUrl = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value)?.[2];
      const paintIndex = { ...index, ...Object.fromEntries([...new Set([...url_keys(layer.ddsImage.imageUrl),
        ...url_keys(capsuleValueUrl)])].map((key) => [key, paintLayer])) };
      const styles = resolveVectorStyles(value, paintIndex, originalStyle);
      return styles ? { ...styles,
        background: `${capsuleDecoration} 0 0 / 100% 100% no-repeat border-box border-box, ${styles.background}` } : null;
    }
    if (layer?.rectangleLayers) return resolve_rectangle_svg(layer.rectangleLayers, layer.ddsOriginFrame, originalStyle);
    // Solid capsules do not need raster padding or subpixel export offsets.
    // Bake opacity into the paint, never into the container and its children.
    if (layer && finite(layer.opacity) && layer.opacity >= 0 && layer.opacity < 100
      && !layer.hasClippingMask && enabled(layer.fills).length === 1
      && enabled(layer.fills)[0]?.type === 'color' && !enabled(layer.borders).length) {
      const frame = layer.layerOriginFrame;
      const exported = layer.ddsOriginFrame;
      const fill = enabled(layer.fills)[0];
      const position = value.replace(urls[0][0], '').trim();
      const size = originalStyle.backgroundSize;
      if (frame && exported && ['x', 'y', 'width', 'height'].every((key) => finite(frame[key]) && finite(exported[key]))
        && frame.width > 0 && frame.height > 0
        && ['x', 'y'].every((key) => exported[key] === Math.floor(frame[key]))
        && exported.width === Math.ceil(frame.x + frame.width) - exported.x
        && exported.height === Math.ceil(frame.y + frame.height) - exported.y
        && /^-?\d+(?:\.\d+)?px\s+-?\d+(?:\.\d+)?px\s+no-repeat$/.test(position)
        && size === `${exported.width}px ${exported.height}px` && supported_effect(fill)) {
        const radius = Array.isArray(layer.radius) ? layer.radius : [layer.radius];
        const background = color_css(fill.color, (fill.opacity ?? 1) * layer.opacity / 100);
        if (is_rectangle(layer) && !layer.rotation && !layer.isFlippedHorizontal && !layer.isFlippedVertical
          && (layer.blendMode === undefined || layer.blendMode === 0) && !layer.blur?.isEnabled
          && !enabled(layer.shadow).length && !layer.borderOptions?.dashPattern?.length
          && (layer.layers === undefined || Array.isArray(layer.layers) && !layer.layers.length)
          && ['fills', 'borders', 'shadow'].every((key) => layer[key] === undefined || Array.isArray(layer[key]))
          && radius.length >= 1 && radius.length <= 4
          && radius.every((r) => finite(r) && r === radius[0] && r >= frame.height / 2)
          && (!originalStyle.transform || originalStyle.transform === 'none')
          && (!originalStyle.filter || originalStyle.filter === 'none')
          && (originalStyle.opacity === undefined || Number(originalStyle.opacity) === 1)
          && (!originalStyle.border || originalStyle.border === 'none')
          && (!originalStyle.boxShadow || originalStyle.boxShadow === 'none') && background) {
          return { background, borderRadius: '999px' };
        }
      }
    }
    if (layer && enabled(layer.borders).length === 1 && !layer.hasClippingMask
      && layer.layerOriginFrame && layer.ddsOriginFrame) {
      const frame = layer.layerOriginFrame;
      const exported = layer.ddsOriginFrame;
      const roundedExport = ['x', 'y'].every((key) => exported[key] === Math.floor(frame[key]))
        && exported.width === Math.ceil(frame.x + frame.width) - exported.x
        && exported.height === Math.ceil(frame.y + frame.height) - exported.y
        && ['x', 'y', 'width', 'height'].some((key) => Math.abs(frame[key] - exported[key]) > 1e-6);
      const fill = enabled(layer.fills)[0];
      const matchingExport = ['x', 'y', 'width', 'height'].every((key) =>
        finite(frame[key]) && finite(exported[key]) && Math.abs(frame[key] - exported[key]) <= 1e-6);
      const translucentGradient = (matchingExport || roundedExport) && enabled(layer.fills).length === 1
        && fill?.type === 'gradient'
        && ((fill.opacity ?? 1) !== 1 || fill.gradient?.colorStops?.some((stop) => stop.color?.a !== 1));
      if ((roundedExport && fill?.type === 'color') || translucentGradient) {
        const svg = resolve_rectangle_svg([layer], exported, originalStyle);
        if (svg) return svg;
      }
    }
    if (layer && enabled(layer.borders).length === 1 && enabled(layer.borders)[0]?.type === 'gradient'
      && layer.layerOriginFrame && layer.ddsOriginFrame
      && ['x', 'y', 'width', 'height'].some((key) =>
        Math.abs(layer.layerOriginFrame[key] - layer.ddsOriginFrame[key]) > 1e-6)) {
      const frame = layer.layerOriginFrame;
      const exported = layer.ddsOriginFrame;
      // Preserve real fractional coverage, not just a larger geometry tolerance.
      const rounded = ['width', 'height'].some((key) => Math.abs(frame[key] - exported[key]) > 1e-6)
        && ['x', 'y'].every((key) => Math.abs(exported[key] - Math.floor(frame[key] + 1e-6)) <= 1e-6)
        && ['width', 'height'].every((key) => Math.abs(exported[key] - Math.ceil(frame[key] - 1e-6)) <= 1e-6);
      if (rounded) return resolve_rectangle_svg([layer], exported, originalStyle);
    }
    if (layer?.type === 'shape' && layer.isClosed === false) {
      let line = layer;
      const frame = layer.layerOriginFrame;
      const exported = layer.ddsOriginFrame;
      const points = layer.points;
      if (frame && exported && [frame.x, frame.y, frame.width, frame.height,
        exported.x, exported.y, exported.width, exported.height].every(finite)
        && Array.isArray(points) && points.length === 2) {
        const constantAlong = (axis) => {
          const along = axis === 'x' ? 'y' : 'x';
          const values = points.map((p) => p.point?.[along]);
          return values.every((v) => v === values[0] && [0, 0.5, 1].includes(v))
            && points.map((p) => p.point?.[axis]).slice().sort((a, b) => a - b).join(',') === '0,1';
        };
        const horizontal = constantAlong('x');
        const vertical = constantAlong('y');
        const axis = horizontal ? 'x' : 'y';
        const length = horizontal ? 'width' : 'height';
        if ((horizontal || vertical) && frame[length] > exported[length] && exported[length] > 0
          && Math.abs(frame[axis] - exported[axis]) <= 1e-6) {
          line = { ...layer, points: points.map((p) => ({ ...p, point: { ...p.point,
            [axis]: Math.min(p.point[axis] * frame[length], exported[length]) / frame[length] } })) };
        }
      }
      return resolve_line(line, originalStyle);
    }
    if (layer?.type === 'shape' && layer.isClosed === true
      && (layer.points?.length > 4 || layer.points?.length >= 3 && !is_rectangle(layer))) {
      const svg = resolve_polygon_svg(layer, originalStyle);
      if (svg) return svg;
    }
    // Keep a cropped inside stroke on the original rectangle in a clipped SVG viewport.
    // Drawing a border around the shorter export would invent bottom corners and an edge.
    if (layer && is_rectangle(layer) && enabled(layer.borders).length === 1
      && ['inside', '内边框', '内部'].includes(enabled(layer.borders)[0].position)
      && enabled(layer.borders)[0].type === 'color' && enabled(layer.borders)[0].color?.a === 1
      && (enabled(layer.borders)[0].opacity ?? 1) === 1
      && !layer.hasClippingMask && !layer.shouldBreakMaskChain) {
      const frame = layer.layerOriginFrame;
      const exported = layer.ddsOriginFrame;
      if (frame && exported && ['x', 'y', 'width'].every((key) => finite(frame[key])
        && finite(exported[key]) && Math.abs(frame[key] - exported[key]) <= 1e-6)
        && finite(frame.height) && finite(exported.height) && exported.height > 0 && exported.height < frame.height) {
        const cropped = resolve_rectangle_svg([layer], exported, originalStyle);
        if (cropped) return cropped;
      }
    }
    if (layer && enabled(layer.fills).length > 1) return resolve_multifill_rectangle(layer, value, originalStyle);
    if (layer && enabled(layer.borders).length === 1 && enabled(layer.borders)[0]?.type === 'gradient') {
      return resolve_gradient_border(layer, value, index, originalStyle);
    }
    // A single gradient without overlapping effects can bake layer opacity into its stops.
    // Never put opacity on the container: its independent text must stay opaque.
    const translucentGradient = layer && finite(layer.opacity) && layer.opacity >= 0 && layer.opacity < 100
      && !layer.hasClippingMask && !layer.blur?.isEnabled && !layer.circleBackground
      && enabled(layer.fills).length === 1 && enabled(layer.fills)[0]?.type === 'gradient'
      && enabled(layer.borders).length === 0 && enabled(layer.shadow).length === 0;
    // A single solid paint can bake opacity too, provided no crop or raster padding changes its box.
    const raster_rounded_bounds = (frame, exported) => frame && exported
      && ['x', 'y'].every((key) => finite(frame[key]) && finite(exported[key])
        && Math.abs(exported[key] - Math.floor(frame[key] + 1e-6)) <= 1e-6)
      && ['width', 'height'].every((key) => {
        if (!finite(frame[key]) || !finite(exported[key]) || exported[key] <= 0) return false;
        const expected = key === 'width'
          ? Math.ceil(frame.x + frame.width - 1e-6) - exported.x
          : Math.ceil(frame.y + frame.height - 1e-6) - exported.y;
        return Math.abs(exported[key] - expected) <= 1e-6;
      });
    const translucentSolid = layer && finite(layer.opacity) && layer.opacity >= 0 && layer.opacity < 100
      && !layer.hasClippingMask && !layer.blur?.isEnabled && !layer.circleBackground
      && enabled(layer.fills).length === 1
      && (enabled(layer.fills)[0]?.type === 'color' || enabled(layer.fills)[0]?.fillType === 0)
      && enabled(layer.borders).length === 0 && enabled(layer.shadow).length === 0
      && ((!layer.layerOriginFrame && !layer.ddsOriginFrame)
        || ['x', 'y', 'width', 'height'].every((key) => finite(layer.layerOriginFrame?.[key])
          && finite(layer.ddsOriginFrame?.[key])
          && Math.abs(layer.layerOriginFrame[key] - layer.ddsOriginFrame[key]) <= 1e-6));
    // Layer alpha applies once to both paints; an inside stroke cannot add a cropped edge.
    const translucentBordered = layer && finite(layer.opacity) && layer.opacity > 0 && layer.opacity < 100
      && !layer.hasClippingMask && !layer.blur?.isEnabled && !layer.circleBackground
      && enabled(layer.fills).length === 1 && enabled(layer.fills)[0]?.type === 'color'
      && enabled(layer.fills)[0].color?.a === 1 && (enabled(layer.fills)[0].opacity ?? 1) === 1
      && enabled(layer.borders).length === 1 && enabled(layer.borders)[0]?.type === 'color'
      && ['inside', '内边框', '内部'].includes(enabled(layer.borders)[0].position)
      && enabled(layer.shadow).length === 0 && raster_rounded_bounds(layer.layerOriginFrame, layer.ddsOriginFrame);
    if (translucentBordered) {
      const k = layer.opacity / 100;
      layer = { ...layer, opacity: 100,
        fills: [{ ...enabled(layer.fills)[0], opacity: k }],
        borders: [{ ...enabled(layer.borders)[0], opacity: (enabled(layer.borders)[0].opacity ?? 1) * k }] };
    }
    // Only proven simple rectangles are safe. Effects baked into other bitmaps must not be applied twice.
    if (!layer || !is_rectangle(layer)
      || (layer.layers !== undefined && (!Array.isArray(layer.layers) || layer.layers.length))
      || (layer.rotation !== undefined && layer.rotation !== 0)
      || layer.isFlippedHorizontal || layer.isFlippedVertical
      || (layer.opacity !== undefined && layer.opacity !== 100 && !translucentGradient && !translucentSolid)
      || (layer.blendMode !== undefined && layer.blendMode !== 0)
      || ['fills', 'borders', 'shadow'].some((key) => layer[key] !== undefined && !Array.isArray(layer[key]))
      || (originalStyle.transform && originalStyle.transform !== 'none')
      || (originalStyle.filter && originalStyle.filter !== 'none')
      || (originalStyle.opacity !== undefined && Number(originalStyle.opacity) !== 1)) return null;

    // An unpainted rectangular mask exports only a transparent placeholder.
    if (layer.hasClippingMask && (layer.clippingMaskMode === undefined || layer.clippingMaskMode === 0)
      && ['fills', 'borders', 'shadow'].every((key) => enabled(layer[key]).length === 0)) return {};
    if (layer.hasClippingMask) return null;

    let fills = enabled(layer.fills);
    // Border-only rectangles have transparent interiors. Inside strokes need matching
    // export bounds; centered strokes use the expanded bounds/offset proof below and
    // the existing pair of non-layout outer/inset shadows (half the source thickness).
    if (fills.length === 0) {
      const borders = enabled(layer.borders);
      const frame = layer.layerOriginFrame;
      const exported = layer.ddsOriginFrame;
      const centered = ['center', '中心边框'].includes(borders[0]?.position);
      if (borders.length !== 1 || borders[0]?.type !== 'color'
        || (!centered && !['inside', '内边框', '内部'].includes(borders[0].position))
        || layer.blur?.isEnabled || enabled(layer.shadow).length || layer.circleBackground
        || !frame || !exported || frame.width <= 0 || frame.height <= 0
        || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key])
          || (!centered && Math.abs(frame[key] - exported[key]) > 1e-6))) return null;
      if (centered && (originalStyle.boxSizing && originalStyle.boxSizing !== 'border-box'
        || Object.keys(originalStyle).some((key) => /^border(?:$|Top|Right|Bottom|Left|Width|Style)/.test(key)
          && !key.endsWith('Radius') && originalStyle[key] !== 'none'))) return null;
      fills = [{ type: 'color', color: { r: 0, g: 0, b: 0, a: 0 } }];
    }
    if (fills.length !== 1) return null;
    if (!supported_effect(fills[0])) return null;
    const fill = translucentGradient || translucentSolid
      ? { ...fills[0], opacity: (fills[0].opacity ?? 1) * layer.opacity / 100 } : fills[0];
    let background = fill_css(fill, layer.gradientPaintFrame || layer.layerOriginFrame);
    if (!background) return null;
    if (layer.circleBackground) {
      const { x, y, rx, ry } = layer.circleBackground;
      if (![x, y, rx, ry].every(finite) || rx <= 0 || ry <= 0 || !background.startsWith('rgba(')) return null;
      background = `radial-gradient(ellipse ${rx}px ${ry}px at ${x}px ${y}px, ${background} 100%, transparent 100%)`;
    }
    const borders = enabled(layer.borders);
    let radius = layer.radius;
    if (radius === undefined && layer.ddsType === undefined && layer.type === 'shape') {
      const corners = layer.points.map((vertex) => ({
        index: Math.round(vertex.point.y) === 0 ? Math.round(vertex.point.x) : 3 - Math.round(vertex.point.x),
        radius: vertex.cornerRadius || 0
      })).sort((a, b) => a.index - b.index).map((corner) => corner.radius);
      if (corners.some((r) => r > 0)) radius = corners;
    }
    const flatColor = background.startsWith('rgba(') && borders.length === 0
      && enabled(layer.shadow).length === 0 && (radius === undefined
        || (Array.isArray(radius) ? radius : [radius]).every((r) => r === 0));
    const outside = borders.length === 1 && ['outside', '外边框', '外部'].includes(borders[0]?.position);
    const centered = borders.length === 1 && ['center', '中心边框'].includes(borders[0]?.position);
    const expansion = outside ? borders[0].thickness : centered ? borders[0].thickness / 2 : 0;
    if (!finite(expansion) || expansion < 0) return null;
    const frame = layer.layerOriginFrame;
    const exportFrame = layer.ddsOriginFrame;
    // An outside border is drawn inside the expanded export box; layout stays unchanged.
    if ((outside || centered) && (!frame || !exportFrame || enabled(layer.shadow).length)) return null;
    const sharpShadows = enabled(layer.shadow);
    const shadow = sharpShadows.length === 1 ? sharpShadows[0] : null;
    const sharpShadow = !borders.length && shadow?.type === '外阴影' && shadow.blurRadius === 0 && shadow.spread === 0
      && finite(shadow.offsetX) && finite(shadow.offsetY) && frame && exportFrame;
    const rasterBounds = (dx, dy, spread) => {
      const x = Math.floor(Math.min(frame.x, frame.x + dx - spread));
      const y = Math.floor(Math.min(frame.y, frame.y + dy - spread));
      return { x, y, width: Math.ceil(Math.max(frame.x + frame.width, frame.x + frame.width + dx + spread)) - x,
        height: Math.ceil(Math.max(frame.y + frame.height, frame.y + frame.height + dy + spread)) - y };
    };
    const roundedBounds = centered ? rasterBounds(0, 0, expansion) : sharpShadow ? rasterBounds(shadow.offsetX, shadow.offsetY, 0) : null;
    const offsets = { x: -expansion, y: -expansion, width: expansion * 2, height: expansion * 2 };
    // Artboard exports may cut off the bottom while the source rectangle stays full-height.
    const croppedBottom = outside && finite(frame.height) && finite(exportFrame.height)
      && exportFrame.height > expansion && exportFrame.height < frame.height + expansion * 2 - 0.01;
    const pixels = (value) => typeof value === 'number' ? value
      : (typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:px)?$/.test(value.trim()) ? Number(value.replace(/px$/, '')) : NaN);
    const cornerRadii = radius === undefined ? [0, 0, 0, 0] : Array.isArray(radius) ? radius : [radius];
    const expandedRadii = [cornerRadii[0], cornerRadii[1] ?? cornerRadii[0],
      cornerRadii[2] ?? cornerRadii[0], cornerRadii[3] ?? cornerRadii[1] ?? cornerRadii[0]];
    // A solid rectangle clipped above its bottom corners needs only its original top corners.
    // Do not resize the layout or introduce new rounded corners at the crop edge.
    // A bottom crop cannot create or remove a horizontal inset stroke, and the fill
    // alpha is already baked into the background color, so both survive the crop.
    const insetSideShadows = sharpShadows.length <= 1 && sharpShadows.every((shadow) => shadow.type === '内阴影'
      && shadow.blurRadius === 0 && shadow.spread === 0 && shadow.offsetY === 0 && finite(shadow.offsetX));
    const solidCroppedBottom = background.startsWith('rgba(')
      && !layer.blur?.isEnabled && !borders.length && insetSideShadows
      && frame && exportFrame && cornerRadii.length >= 1 && cornerRadii.length <= 4
      && expandedRadii.every((r) => finite(r) && r >= 0)
      && Math.abs(exportFrame.x - frame.x) <= 1e-6 && Math.abs(exportFrame.y - frame.y) <= 1e-6
      && Math.abs(exportFrame.width - frame.width) <= 1e-6
      && exportFrame.y + exportFrame.height <= frame.y + frame.height + 1e-6
      && exportFrame.height > 0 && exportFrame.height < frame.height - 0.01
      && exportFrame.height >= Math.max(expandedRadii[0], expandedRadii[1])
      && exportFrame.height <= frame.height - Math.max(expandedRadii[2], expandedRadii[3])
      && expandedRadii[0] + expandedRadii[1] <= frame.width
      && expandedRadii[2] + expandedRadii[3] <= frame.width
      && expandedRadii[0] + expandedRadii[3] <= frame.height
      && expandedRadii[1] + expandedRadii[2] <= frame.height
      && ['width', 'height'].every((key) => originalStyle[key] === undefined
        || Math.abs(pixels(originalStyle[key]) - exportFrame[key]) <= 1e-6)
      && (!originalStyle.boxShadow || originalStyle.boxShadow === 'none');
    // Simple paint can follow the CSS box despite integer-rounded PNG bounds.
    // Keep crops and effect-expanded exports out of this relaxation.
    const roundedPaintBounds = frame && exportFrame && !layer.blur?.isEnabled
      && !borders.length && !sharpShadows.length
      && (background.startsWith('rgba(') || background.startsWith('linear-gradient('))
      && ['width', 'height'].every((key) => finite(frame[key]) && frame[key] > 0
        && (layer[key] === undefined || finite(layer[key]) && Math.abs(layer[key] - frame[key]) <= 1e-6))
      && ['x', 'y'].every((key) => finite(frame[key]) && finite(exportFrame[key])
        && Math.abs(exportFrame[key] - Math.floor(frame[key] + 1e-6)) <= 1e-6)
      && ['width', 'height'].every((key, i) => {
        const axis = i === 0 ? 'x' : 'y';
        return finite(exportFrame[key]) && exportFrame[key] > 0
          && Math.abs(exportFrame[key] - (Math.ceil(frame[axis] + frame[key] - 1e-6)
            - exportFrame[axis])) <= 1e-6;
      });
    const clippedLeft = flatColor && frame && exportFrame && frame.x >= -1 && frame.x < 0 && exportFrame.x === 0
      && exportFrame.width === Math.floor(frame.width) && exportFrame.width === Math.ceil(frame.x + frame.width)
      && exportFrame.width > 0;
    if (frame && exportFrame && Object.keys(offsets).some((key) => {
      if (!finite(frame[key]) || !finite(exportFrame[key])) return true;
      if (roundedBounds) return exportFrame[key] !== roundedBounds[key];
      if (roundedPaintBounds) return false;
      if (clippedLeft && key === 'x') return false;
      if (solidCroppedBottom) return key !== 'height' && Math.abs(exportFrame[key] - frame[key]) > 1e-6;
      if (key === 'height' && croppedBottom) return false;
      // Uniform fills are unaffected by pixel rounding of export bounds.
      if (flatColor && ['x', 'y'].includes(key) && exportFrame[key] === Math.floor(frame[key])) return false;
      if (flatColor && ['width', 'height'].includes(key) && frame[key] > 0 && Number.isInteger(exportFrame[key])) {
        return exportFrame[key] !== Math.floor(frame[key]) || exportFrame[key] <= 0;
      }
      return Math.abs(exportFrame[key] - frame[key] - offsets[key]) > 0.01;
    })) return null;
    if (croppedBottom && ((originalStyle.width !== undefined && pixels(originalStyle.width) !== frame.width)
      || (originalStyle.height !== undefined && (!finite(pixels(originalStyle.height))
        || pixels(originalStyle.height) <= 0 || pixels(originalStyle.height) > frame.height)))) return null;
    if (sharpShadow && ['width', 'height'].some((key) => originalStyle[key] !== undefined && pixels(originalStyle[key]) !== frame[key])) return null;
    const originalBox = croppedBottom || centered || outside && ['width', 'height'].every((key) => pixels(originalStyle[key]) === frame[key]);
    if (centered && Object.keys(originalStyle).length && ['width', 'height'].some((key) => originalStyle[key] !== undefined
      && pixels(originalStyle[key]) !== frame[key])) return null;
    if (originalBox && (!croppedBottom || Object.keys(originalStyle).length)) {
      const position = value.replace(urls[0][0], '').trim().split(/\s+/);
      const size = typeof originalStyle.backgroundSize === 'string' ? originalStyle.backgroundSize.trim().split(/\s+/) : [];
      if (position.length !== 3 || pixels(position[0]) !== (centered ? exportFrame.x - frame.x : -expansion)
        || pixels(position[1]) !== (centered ? exportFrame.y - frame.y : -expansion)
        || position[2] !== 'no-repeat' || size.length !== 2
        || pixels(size[0]) !== exportFrame.width || pixels(size[1]) !== exportFrame.height
        || (originalStyle.boxShadow && originalStyle.boxShadow !== 'none')) return null;
    } else if (outside && ['width', 'height'].some((key) => originalStyle[key] !== undefined
      && pixels(originalStyle[key]) !== exportFrame[key])) return null;

    const styles = { background };
    if (translucentBordered) styles.backgroundClip = 'padding-box';
    if (layer.gradientPaintFrame) {
      const frame = layer.gradientPaintFrame;
      if ((originalStyle.height !== undefined && pixels(originalStyle.height) !== layer.ddsOriginFrame.height)
        || (originalStyle.width !== undefined && pixels(originalStyle.width) !== layer.ddsOriginFrame.width)) return null;
      styles.backgroundSize = `100% ${frame.height}px`;
      styles.backgroundPosition = '0 0';
      styles.backgroundRepeat = 'no-repeat';
    }
    if (clippedLeft) {
      // Preserve the partially covered last PNG column instead of filling it opaquely.
      const right = frame.x + frame.width;
      const full = Math.floor(right);
      const coverage = right - full;
      if (coverage > 0) {
        const fill = fills[0];
        const edge = color_css({ ...fill.color, a: Math.round(fill.color.a * (fill.opacity ?? 1) * coverage * 255) / 255 });
        const stop = full / exportFrame.width * 100;
        styles.background = `linear-gradient(90deg, ${background} ${stop}%, ${edge} ${stop}%)`;
      }
    }
    if (croppedBottom) {
      styles.width = frame.width;
      styles.height = frame.height;
    }
    if (solidCroppedBottom && radius !== undefined) radius = [expandedRadii[0], expandedRadii[1], 0, 0];
    if (radius !== undefined) {
      const radii = Array.isArray(radius) ? radius : [radius];
      if (radii.length < 1 || radii.length > 4 || !radii.every((r) => finite(r) && r >= 0)) return null;
      styles.borderRadius = radii.map((r) => `${r > 0 && !originalBox ? r + expansion : r}px`).join(' ');
    }
    if (borders.length > 1) return null;
    if (borders.length) {
      const border = borders[0];
      const color = color_css(border?.color, border?.opacity);
      if (!supported_effect(border) || border.type !== 'color' || !color
        || !finite(border.thickness) || border.thickness < 0
        || (!outside && !centered && !['inside', '内边框', '内部'].includes(border.position))
        || layer.borderOptions?.dashPattern?.length) return null;
      if (originalBox) {
        // Draw the outside stroke without shrinking the content box or shifting children.
        styles.boxShadow = centered
          ? `0 0 0 ${expansion}px ${color}, inset 0 0 0 ${expansion}px ${color}`
          : `0 0 0 ${border.thickness}px ${color}`;
      } else {
        styles.border = `${border.thickness}px solid ${color}`;
        styles.boxSizing = 'border-box';
        // Bitmap strokes do not participate in layout. On auto-sized containers a
        // newly added CSS border must replace proven padding, not enlarge the box.
        // Fixed-size spacing is handled separately by the parser's bounds checks.
        if (border.thickness > 0 && !outside && !centered && Object.keys(originalStyle).length
          && (!originalStyle.border || originalStyle.border === 'none')
          && ['width', 'height'].some((key) => originalStyle[key] === undefined || originalStyle[key] === 'auto')) {
          if (originalStyle.boxSizing && originalStyle.boxSizing !== 'border-box'
            || Object.keys(originalStyle).some((key) => /^border(?:Top|Right|Bottom|Left|Width|Style)/.test(key)
              && !key.endsWith('Radius'))) return null;
          let padding = [0, 0, 0, 0];
          const sides = ['Top', 'Right', 'Bottom', 'Left'];
          // Iterate in declaration order: a later shorthand resets prior longhands.
          for (const [key, value] of Object.entries(originalStyle)) {
            if (key === 'padding') {
              const parts = String(value).trim().split(/\s+/).map(pixels);
              if (!parts.length || parts.length > 4 || !parts.every(finite)) return null;
              const [top, right = top, bottom = top, left = right] = parts;
              padding = [top, right, bottom, left];
            } else if (sides.some((side) => key === `padding${side}`)) {
              padding[sides.findIndex((side) => key === `padding${side}`)] = pixels(value);
            }
          }
          if (padding.some((value) => !finite(value) || rounded_length(value - border.thickness) < 0)) return null;
          padding = padding.map((value) => rounded_length(value - border.thickness));
          styles.padding = padding.map((value) => `${value}px`).join(' ');
          for (const [i, side] of sides.entries()) styles[`padding${side}`] = padding[i];
        }
      }
    }
    const shadows = enabled(layer.shadow);
    const shadowValues = [];
    for (const shadow of shadows) {
      const color = color_css(shadow?.color, shadow?.opacity);
      if (!supported_effect(shadow) || !color || !['内阴影', '外阴影'].includes(shadow.type)
        || ![shadow.offsetX, shadow.offsetY, shadow.blurRadius, shadow.spread].every(finite)
        || shadow.blurRadius < 0) return null;
      shadowValues.push(`${shadow.type === '内阴影' ? 'inset ' : ''}${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blurRadius}px ${shadow.spread}px ${color}`);
    }
    if (shadowValues.length) styles.boxShadow = shadowValues.join(', ');
    return styles;
  };

  // Sketch paints enabled fills from bottom to top; CSS background layers run top to bottom.
  const resolve_multifill_rectangle = (layer, value, style) => {
    const frame = layer.layerOriginFrame;
    const exported = layer.ddsOriginFrame;
    const pixels = (value) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value.trim()) ? Number(value.trim().replace(/px$/, '')) : NaN;
    if (!is_rectangle(layer) || !frame || !exported || layer.hasClippingMask || layer.blur?.isEnabled
      || layer.gradientPaintFrame || layer.circleBackground
      || (layer.opacity !== undefined && layer.opacity !== 100)
      || enabled(layer.borders).length || enabled(layer.shadow).length
      || (style.border && style.border !== 'none') || (style.boxShadow && style.boxShadow !== 'none')
      || (style.backgroundBlendMode && style.backgroundBlendMode !== 'normal')
      || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key])
        || Math.abs(frame[key] - exported[key]) > 1e-6)
      || frame.width <= 0 || frame.height <= 0
      || ['width', 'height'].some((key) => style[key] !== undefined
        && (!finite(pixels(style[key])) || Math.abs(pixels(style[key]) - frame[key]) > 1e-6))) return null;
    const fills = enabled(layer.fills);
    const paints = fills.map((fill) => fill_css(fill, frame));
    if (paints.some((paint) => !paint)) return null;
    const candidate = { ...layer, fills: [fills[0]] };
    const match = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
    const base = match && resolveVectorStyles(value,
      Object.fromEntries(url_keys(match[2]).map((key) => [key, candidate])), style);
    if (!base || Object.keys(base).some((key) => !['background', 'borderRadius'].includes(key))) return null;
    const background = paints.reverse().map((paint) => paint.startsWith('rgba(')
      ? `linear-gradient(${paint}, ${paint})` : paint).join(', ');
    return { ...base, background };
  };

  // Keep fractional geometry and overlapping rectangle paints in an SVG background.
  // Only uniform corner radii, linear fills and inside strokes are supported.
  const resolve_rectangle_svg = (layers, exported, style = {}) => {
    const keys = ['x', 'y', 'width', 'height'];
    if (!exported || !keys.every((key) => finite(exported[key])) || exported.width <= 0 || exported.height <= 0
      || (style.transform && style.transform !== 'none') || (style.filter && style.filter !== 'none')
      || (style.opacity !== undefined && Number(style.opacity) !== 1)
      || (style.border && style.border !== 'none') || (style.boxShadow && style.boxShadow !== 'none')) return null;
    const pixels = (value) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : NaN;
    if (['width', 'height'].some((key) => style[key] !== undefined
      && (!finite(pixels(style[key])) || Math.abs(pixels(style[key]) - exported[key]) > 1e-6))) return null;
    const number = (value) => Math.round(value * 1e6) / 1e6;
    const defs = [];
    const rects = [];
    const paint = (fill, frame, id) => {
      if (!supported_effect(fill) || !fill_css(fill, frame)) return null;
      if (fill.type === 'color' || fill.fillType === 0) return color_css(fill.color, fill.opacity);
      const gradient = fill.gradient;
      const stops = gradient.colorStops.slice().sort((a, b) => a.position - b.position);
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${number(gradient.from.x * frame.width)}" y1="${number(gradient.from.y * frame.height)}" x2="${number(gradient.to.x * frame.width)}" y2="${number(gradient.to.y * frame.height)}">${stops.map((stop) => `<stop offset="${stop.position}" stop-color="${color_css(stop.color, fill.opacity)}"/>`).join('')}</linearGradient>`);
      return `url(#${id})`;
    };
    for (const [i, layer] of layers.entries()) {
      const frame = layer.layerOriginFrame;
      const fills = enabled(layer.fills);
      const borders = enabled(layer.borders);
      const radius = layer.radius === undefined ? [0] : Array.isArray(layer.radius) ? layer.radius : [layer.radius];
      if (!is_rectangle(layer) || !frame || !keys.every((key) => finite(frame[key]))
        || frame.width <= 0 || frame.height <= 0 || layer.rotation || layer.isFlippedHorizontal || layer.isFlippedVertical
        || (layer.opacity !== undefined && layer.opacity !== 100) || (layer.blendMode !== undefined && layer.blendMode !== 0)
        || layer.blur?.isEnabled || enabled(layer.shadow).length || layer.borderOptions?.dashPattern?.length
        || (layer.layers !== undefined && (!Array.isArray(layer.layers) || layer.layers.length))
        || ['fills', 'borders', 'shadow'].some((key) => layer[key] !== undefined && !Array.isArray(layer[key]))
        || (layer.hasClippingMask && layer.clippingMaskMode !== undefined && layer.clippingMaskMode !== 0)
        || fills.length !== 1 || borders.length > 1 || !radius.length || radius.length > 4
        || !radius.every((r) => finite(r) && r >= 0 && r === radius[0])
        || (layer.radius === undefined && layer.points?.some((point) => point.cornerRadius > 0))) return null;
      // SVG paints the stroke over the fill, unlike stacked CSS backgrounds.
      // Allow a translucent gradient only for a single unmasked rectangle.
      const fill = fills[0];
      const translucentGradient = layers.length === 1 && !layer.hasClippingMask && fill.type === 'gradient';
      if (!translucentGradient && ((fill.opacity ?? 1) !== 1 || ((fill.type === 'color' || fill.fillType === 0)
        ? fill.color?.a !== 1 : !fill.gradient?.colorStops?.every((stop) => stop.color?.a === 1)))) return null;
      const background = paint(fill, frame, `fill${i}`);
      if (!background) return null;
      const rounded = Math.min(radius[0], frame.width / 2, frame.height / 2);
      const geometry = `width="${number(frame.width)}" height="${number(frame.height)}" rx="${number(rounded)}"`;
      let stroke = '';
      if (borders.length) {
        const border = borders[0];
        if (!['inside', '内边框', '内部'].includes(border.position) || !finite(border.thickness)
          || border.thickness <= 0 || border.thickness * 2 >= Math.min(frame.width, frame.height)) return null;
        const color = paint(border, frame, `stroke${i}`);
        if (!color) return null;
        defs.push(`<clipPath id="clip${i}"><rect ${geometry}/></clipPath>`);
        stroke = ` stroke="${color}" stroke-width="${number(border.thickness * 2)}" clip-path="url(#clip${i})"`;
      }
      rects.push(`<g transform="translate(${number(frame.x - exported.x)} ${number(frame.y - exported.y)})"><rect ${geometry} fill="${background}"${stroke}/></g>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${exported.width}" height="${exported.height}" viewBox="0 0 ${exported.width} ${exported.height}" preserveAspectRatio="none"><defs>${defs.join('')}</defs>${rects.join('')}</svg>`;
    const encoded = encodeURIComponent(svg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return { background: `url("data:image/svg+xml,${encoded}") 0 0 / 100% 100% no-repeat` };
  };

  const resolve_rectangle_group = (group, childrenByParent) => {
    if (group.type !== 'layer-group' || !group.ddsImage?.imageUrl || group.hasClippingMask
      || group.rotation || group.isFlippedHorizontal || group.isFlippedVertical || group.blur?.isEnabled
      || (group.opacity !== undefined && group.opacity !== 100) || (group.blendMode !== undefined && group.blendMode !== 0)
      || (group.layers !== undefined && !Array.isArray(group.layers))
      || ['fills', 'borders', 'shadow'].some((key) => group[key] !== undefined
        && (!Array.isArray(group[key]) || enabled(group[key]).length))) return null;
    const children = [...new Set([...(group.layers || []), ...(childrenByParent.get(group.id) || [])])]
      .filter((child) => child.isVisible !== false);
    if (children.length < 2 || children.length > 16 || children.some((child) => child.hasClippingMask || child.shouldBreakMaskChain)) return null;
    // The export list is in paint order. Require the first child to be the opaque base;
    // decorations must not overlap, so their relative order does not matter.
    const exported = group.ddsOriginFrame;
    const bases = children.filter((child) => child.layerOriginFrame && exported
      && ['x', 'y', 'width', 'height'].every((key) => finite(child.layerOriginFrame[key])
        && Math.abs(child.layerOriginFrame[key] - exported[key]) <= 1e-6));
    if (bases.length !== 1 || children[0] !== bases[0]) return null;
    const base = bases[0];
    const decorations = children.filter((child) => child !== base);
    for (const [i, child] of decorations.entries()) {
      const frame = child.layerOriginFrame;
      if (!frame || !exported || !['x', 'y', 'width', 'height'].every((key) => finite(frame[key]))
        || frame.x < exported.x - 1e-6 || frame.y < exported.y - 1e-6
        || frame.x + frame.width > exported.x + exported.width + 1e-6
        || frame.y + frame.height > exported.y + exported.height + 1e-6
        || decorations.slice(0, i).some((other) => {
          const b = other.layerOriginFrame;
          return frame.x < b.x + b.width && b.x < frame.x + frame.width
            && frame.y < b.y + b.height && b.y < frame.y + frame.height;
        })) return null;
    }
    let paintedBase = base;
    // Lanhu sometimes reports the export height as the origin frame height, while
    // the actual opaque base and group height leave transparent space at the bottom.
    if (base.height !== undefined && Math.abs(base.height - exported.height) > 1e-6) {
      if (!finite(base.height) || !Number.isInteger(base.height) || base.height <= 0
        || base.height >= exported.height || base.height !== group.height
        || !finite(base.width) || Math.abs(base.width - exported.width) > 1e-6
        || enabled(base.fills).length !== 1 || enabled(base.fills)[0]?.type !== 'color'
        || enabled(base.borders).length || enabled(base.shadow).length
        || (base.radius !== undefined && (Array.isArray(base.radius) ? base.radius : [base.radius]).some((r) => r !== 0))
        || decorations.some((child) => child.layerOriginFrame.y + child.layerOriginFrame.height
          > exported.y + base.height + 1e-6)) return null;
      paintedBase = { ...base, layerOriginFrame: { ...base.layerOriginFrame, height: base.height } };
    }
    const ordered = [paintedBase, ...decorations];
    return resolve_rectangle_svg(ordered, group.ddsOriginFrame)
      ? { ...group, rectangleLayers: ordered } : null;
  };

  // Opaque straight-sided panels retain their outline and linear paint in a self-contained SVG.
  const resolve_polygon_svg = (layer, style) => {
    const frame = layer.layerOriginFrame;
    const exported = layer.ddsOriginFrame;
    if (!frame || !exported || layer.isClosed !== true
      || !Array.isArray(layer.points) || layer.points.length < 3 || layer.points.length > 32
      || layer.booleanOperation !== -1 || layer.hasClippingMask || layer.rotation
      || layer.isFlippedHorizontal || layer.isFlippedVertical
      || (layer.opacity !== undefined && layer.opacity !== 100)
      || (layer.blendMode !== undefined && layer.blendMode !== 0)
      || (layer.layers !== undefined && (!Array.isArray(layer.layers) || layer.layers.length))
      || ['fills', 'borders', 'shadow'].some((key) => layer[key] !== undefined && !Array.isArray(layer[key]))
      || enabled(layer.borders).length || enabled(layer.shadow).length
      || (style.transform && style.transform !== 'none') || (style.filter && style.filter !== 'none')
      || (style.opacity !== undefined && Number(style.opacity) !== 1)
      || (layer.blur?.isEnabled && (layer.blur.type !== '背景模糊' || layer.blur.blurType !== 3))
      || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key]))
      || frame.width <= 0 || frame.height <= 0 || exported.width <= 0 || exported.height <= 0
      || frame.x !== exported.x || frame.y !== exported.y || frame.width !== exported.width
      || exported.height > frame.height) return null;
    const fills = enabled(layer.fills);
    if (fills.length !== 1 || !supported_effect(fills[0]) || (fills[0].opacity ?? 1) !== 1) return null;
    const fill = fills[0];
    const colors = fill.type === 'color' ? [fill.color]
      : fill.type === 'gradient' && fill_css(fill, frame) ? fill.gradient.colorStops.map((stop) => stop.color) : [];
    const color = colors[0];
    // Opaque paint hides backdrop blur, so no blur filter is needed in the SVG.
    if (!color || !colors.every((c) => c?.a === 1 && color_css(c))) return null;
    const points = layer.points.map((vertex) => {
      if (vertex?.hasCurveFrom !== false || vertex.hasCurveTo !== false
        || ![vertex.point?.x, vertex.point?.y].every(finite)
        || vertex.point.x < -1e-6 || vertex.point.x > 1 + 1e-6
        || vertex.point.y < -1e-6 || vertex.point.y > 1 + 1e-6
        || !finite(vertex.cornerRadius ?? 0) || (vertex.cornerRadius ?? 0) < 0) return null;
      return { x: Math.max(0, Math.min(1, vertex.point.x)) * frame.width,
        y: Math.max(0, Math.min(1, vertex.point.y)) * frame.height, radius: vertex.cornerRadius ?? 0 };
    });
    if (points.some((p) => !p)) return null;
    const corners = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const previous = points[(i + points.length - 1) % points.length];
      const next = points[(i + 1) % points.length];
      const a = { x: previous.x - p.x, y: previous.y - p.y };
      const b = { x: next.x - p.x, y: next.y - p.y };
      const al = Math.hypot(a.x, a.y);
      const bl = Math.hypot(b.x, b.y);
      if (al < 1e-6 || bl < 1e-6) return null;
      const angle = Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / al / bl)));
      const tangent = Math.tan(angle / 2);
      const distance = p.radius && tangent > 1e-6 ? Math.min(p.radius / tangent, al / 2, bl / 2) : 0;
      const radius = distance * tangent;
      corners.push({ start: { x: p.x + a.x / al * distance, y: p.y + a.y / al * distance },
        end: { x: p.x + b.x / bl * distance, y: p.y + b.y / bl * distance },
        radius, sweep: a.x * b.y - a.y * b.x < 0 ? 1 : 0 });
    }
    const number = (n) => Math.round(n * 1e6) / 1e6;
    const position = (p) => `${number(p.x)} ${number(p.y)}`;
    const path = corners.map((corner, i) => `${i ? 'L' : 'M'} ${position(corner.start)} `
      + (corner.radius > 1e-6 ? `A ${number(corner.radius)} ${number(corner.radius)} 0 0 ${corner.sweep} ${position(corner.end)}`
        : `L ${position(corner.end)}`)).join(' ') + ' Z';
    let definitions = '';
    let paint = `rgb(${color.r},${color.g},${color.b})`;
    if (!colors.every((c) => color_css(c) === color_css(color))) {
      const gradient = fill.gradient;
      const stops = gradient.colorStops.slice().sort((a, b) => a.position - b.position);
      definitions = `<defs><linearGradient id="polygon-fill" gradientUnits="userSpaceOnUse" x1="${number(gradient.from.x * frame.width)}" y1="${number(gradient.from.y * frame.height)}" x2="${number(gradient.to.x * frame.width)}" y2="${number(gradient.to.y * frame.height)}">${stops.map((stop) => `<stop offset="${stop.position}" stop-color="${color_css(stop.color)}"/>`).join('')}</linearGradient></defs>`;
      paint = 'url(#polygon-fill)';
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${exported.width}" height="${exported.height}" viewBox="0 0 ${exported.width} ${exported.height}" preserveAspectRatio="none">${definitions}<path d="${path}" fill="${paint}"/></svg>`;
    const encoded = encodeURIComponent(svg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return { background: `url("data:image/svg+xml,${encoded}") 0 0 / 100% 100% no-repeat` };
  };

  // Two clipped backgrounds reproduce an inside gradient stroke without moving text.
  const resolve_gradient_border = (layer, value, index, style) => {
    const border = enabled(layer.borders)[0];
    const frame = layer.layerOriginFrame;
    const exported = layer.ddsOriginFrame;
    if (!is_rectangle(layer) || !frame || !exported
      || (layer.opacity !== undefined && layer.opacity !== 100)
      || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key])
        || Math.abs(frame[key] - exported[key]) > 1e-6)
      || frame.width <= 0 || frame.height <= 0
      || !['inside', '内边框', '内部'].includes(border.position)
      || !finite(border.thickness) || border.thickness <= 0
      || border.thickness * 2 >= Math.min(frame.width, frame.height)
      || layer.borderOptions?.dashPattern?.length || enabled(layer.shadow).length
      || (layer.hasClippingMask && layer.clippingMaskMode !== undefined && layer.clippingMaskMode !== 0)) return null;
    const fills = enabled(layer.fills);
    // The upper background must be opaque so the border cannot bleed through it.
    if (fills.length !== 1 || !supported_effect(fills[0]) || (fills[0].opacity ?? 1) !== 1
      || !((fills[0].type === 'color' || fills[0].fillType === 0)
        ? fills[0].color?.a === 1
        : fills[0].gradient?.colorStops?.every((stop) => stop.color?.a === 1))) return null;
    const stroke = fill_css(border, frame);
    if (!stroke) return null;
    const url = layer.ddsImage?.imageUrl;
    if (!url) return null;
    const candidate = { ...layer, hasClippingMask: false, borders: [] };
    // The value may reach this layer through an alias (e.g. its preview image url);
    // replace every alias or the borderless candidate is never seen and recursion loops.
    const valueUrl = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value)?.[2];
    const aliasKeys = [...new Set([...url_keys(url), ...url_keys(valueUrl)])];
    const base = resolveVectorStyles(value, { ...index,
      ...Object.fromEntries(aliasKeys.map((key) => [key, candidate])) }, style);
    if (!base) return null;
    const pixels = (v) => typeof v === 'number' ? v
      : typeof v === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(v) ? Number(v.replace(/px$/, '')) : NaN;
    if (['width', 'height'].some((key) => style[key] !== undefined
      && (!finite(pixels(style[key])) || Math.abs(pixels(style[key]) - frame[key]) > 1e-6))
      || (style.border && style.border !== 'none')) return null;
    let shorthand;
    if (style.padding !== undefined) {
      const parts = typeof style.padding === 'number' ? [style.padding]
        : typeof style.padding === 'string' ? style.padding.trim().split(/\s+/).map(pixels) : [];
      if (!parts.length || parts.length > 4 || !parts.every(finite)) return null;
      shorthand = [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]];
    }
    const padding = {};
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    for (const [i, side] of sides.entries()) {
      const key = `padding${side}`;
      if (Object.keys(style).length) {
        const amount = style[key] !== undefined ? pixels(style[key]) : shorthand?.[i];
        if (!finite(amount) || rounded_length(amount - border.thickness) < 0) return null;
        padding[key] = rounded_length(amount - border.thickness);
      }
    }
    if (shorthand) padding.padding = sides.map((side) => `${padding[`padding${side}`]}px`).join(' ');
    // A color is only legal in the last CSS background layer. Use a constant gradient above the stroke.
    const paint = base.background.startsWith('rgba(')
      ? `linear-gradient(${base.background}, ${base.background})` : base.background;
    return { ...base,
      background: `${paint} border-box padding-box, ${stroke} border-box border-box`,
      border: `${border.thickness}px solid transparent`, boxSizing: 'border-box', ...padding };
  };

  // Status labels have a flexible bottom plate and a fixed-size, mirrored corner tab.
  const resolve_status_label_group = (group, childrenByParent) => {
    const frame = group.layerOriginFrame;
    const exported = group.ddsOriginFrame;
    const clean = (layer) => layer && !layer.rotation && !layer.isFlippedVertical && !layer.hasClippingMask
      && !layer.shouldBreakMaskChain && !layer.blur?.isEnabled
      && (layer.opacity === undefined || layer.opacity === 100) && (layer.blendMode === undefined || layer.blendMode === 0)
      && ['fills', 'borders', 'shadow'].every((key) => layer[key] === undefined || Array.isArray(layer[key]))
      && !enabled(layer.shadow).length && !layer.borderOptions?.dashPattern?.length;
    const children = (node) => [...new Set([...(Array.isArray(node.layers) ? node.layers : []), ...(childrenByParent.get(node.id) || [])])]
      .filter((child) => child.isVisible !== false);
    const sameFrame = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) =>
      finite(a[key]) && finite(b[key]) && Math.abs(a[key] - b[key]) <= 1e-6);
    if (group.type !== 'layer-group' || !group.ddsImage?.imageUrl || !clean(group) || group.isFlippedHorizontal
      || (group.layers !== undefined && !Array.isArray(group.layers)) || !sameFrame(frame, exported)
      || enabled(group.fills).length || enabled(group.borders).length) return null;
    const entries = children(group);
    if (entries.length !== 3) return null;
    const [base, tab, iconGroup] = entries;
    const baseFrame = base.layerOriginFrame;
    const tabFrame = tab.layerOriginFrame;
    if (!clean(base) || base.isFlippedHorizontal || !is_rectangle(base) || children(base).length
      || !clean(tab) || tab.isFlippedHorizontal !== true || tab.isClosed !== true || tab.points?.length !== 4
      || !baseFrame || !tabFrame || frame.width <= 0 || frame.height <= 0
      || !sameFrame(baseFrame, base.ddsOriginFrame) || !sameFrame(tabFrame, tab.ddsOriginFrame)
      || baseFrame.x !== frame.x || baseFrame.width !== frame.width || baseFrame.y <= frame.y
      || baseFrame.y + baseFrame.height !== frame.y + frame.height
      || tabFrame.x !== frame.x || tabFrame.y !== frame.y || tabFrame.height !== frame.height
      || tabFrame.width <= 0 || tabFrame.width >= frame.width
      || !Array.isArray(base.radius) || base.radius.length !== 1 || !finite(base.radius[0]) || base.radius[0] < 0
      || enabled(base.fills).length !== 1 || enabled(base.fills)[0]?.type !== 'gradient'
      || enabled(tab.fills).length !== 1 || enabled(tab.fills)[0]?.type !== 'color') return null;
    const baseFill = enabled(base.fills)[0];
    const tabFill = enabled(tab.fills)[0];
    const border = enabled(base.borders)[0];
    if (enabled(base.borders).length !== 1 || enabled(tab.borders).length !== 1
      || !same_border(border, enabled(tab.borders)[0], baseFrame)
      || border.type !== 'color' || !['inside', '内边框', '内部'].includes(border.position)
      || !finite(border.thickness) || border.thickness <= 0 || border.thickness >= baseFrame.height / 2
      || !supported_effect(border) || !color_css(border.color, border.opacity)
      || (baseFill.opacity ?? 1) !== 1 || !baseFill.gradient?.colorStops?.every((stop) => stop.color?.a === 1)
      || (tabFill.opacity ?? 1) !== 1 || tabFill.color?.a !== 1) return null;
    const gradient = fill_css(baseFill, baseFrame);
    const tabPoints = tab.points.map((point) => ({ ...point, point: { x: 1 - point.point?.x, y: point.point?.y } }));
    const tabSvg = resolve_polygon_svg({ ...tab, isFlippedHorizontal: false, points: tabPoints, borders: [] }, {});
    if (!gradient || !tabSvg || !clean(iconGroup) || iconGroup.isFlippedHorizontal || iconGroup.type !== 'layer-group'
      || enabled(iconGroup.fills).length || enabled(iconGroup.borders).length) return null;
    const icons = children(iconGroup);
    if (icons.length !== 1) return null;
    const icon = icons[0];
    const iconFrame = icon.layerOriginFrame;
    if (!clean(icon) || icon.isFlippedHorizontal || enabled(icon.borders).length || children(icon).length
      || !sameFrame(iconFrame, icon.ddsOriginFrame) || !sameFrame(iconFrame, iconGroup.layerOriginFrame)
      || !sameFrame(iconFrame, iconGroup.ddsOriginFrame)
      || iconFrame.width <= 0 || iconFrame.height <= 0 || iconFrame.x < tabFrame.x || iconFrame.y < tabFrame.y
      || iconFrame.x + iconFrame.width > tabFrame.x + tabFrame.width
      || iconFrame.y + iconFrame.height > tabFrame.y + tabFrame.height) return null;
    const decode = (style) => decodeURIComponent(style.background.match(/data:image\/svg\+xml,([^"]+)/)[1]);
    const path = decode(tabSvg).match(/<path d="([^"]+)"/)[1];
    const number = (value) => Math.round(value * 1e6) / 1e6;
    const stroke = color_css(border.color, border.opacity);
    let iconMarkup = '';
    let imageStyle = {};
    if (icon.points) {
      const iconSvg = resolve_polygon_svg(icon, {});
      if (!iconSvg) return null;
      const decodedIcon = decode(iconSvg);
      // This embedding copies a standalone path, not gradient definitions.
      if (decodedIcon.includes('<defs>')) return null;
      const markup = decodedIcon.match(/<path [\s\S]*?\/>/)[0];
      iconMarkup = `<g transform="translate(${number(iconFrame.x - tabFrame.x)} ${number(iconFrame.y - tabFrame.y)})">${markup}</g>`;
    } else {
      // Merged shape groups lack paths. Keep only the independently exported small icon.
      if (icon.ddsType !== 'shape-group' || !icon.ddsImage?.imageUrl) return null;
      imageStyle = { image: icon.ddsImage.imageUrl, x: iconFrame.x - tabFrame.x, y: iconFrame.y - tabFrame.y,
        width: iconFrame.width, height: iconFrame.height };
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tabFrame.width}" height="${tabFrame.height}" viewBox="0 0 ${tabFrame.width} ${tabFrame.height}"><defs><clipPath id="tab"><path d="${path}"/></clipPath></defs><path d="${path}" fill="${color_css(tabFill.color)}" stroke="${stroke}" stroke-width="${number(border.thickness * 2)}" clip-path="url(#tab)"/>${iconMarkup}</svg>`;
    const encoded = encodeURIComponent(svg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const decoration = { position: 'absolute', left: 0, top: 0, width: tabFrame.width, height: tabFrame.height,
      zIndex: -1, pointerEvents: 'none', background: `url("data:image/svg+xml,${encoded}") 0 0 / ${tabFrame.width}px ${tabFrame.height}px no-repeat` };
    if (imageStyle.image) decoration.background = `url("${imageStyle.image}") ${imageStyle.x}px ${imageStyle.y}px / ${imageStyle.width}px ${imageStyle.height}px no-repeat, ${decoration.background}`;
    return { ...group, statusLabel: [
      { position: 'absolute', top: baseFrame.y - frame.y, bottom: 0, left: 0, right: 0, zIndex: -1,
        pointerEvents: 'none', background: gradient, borderRadius: `${base.radius[0]}px`,
        boxShadow: `inset 0 0 0 ${border.thickness}px ${stroke}` }, decoration
    ] };
  };

  // A narrowly supported mask chain: capsule stroke, gradient capsule, then two blurred highlights.
  // CSS owns the radius and 1px stroke; only decorative highlights stretch with the button.
  const resolve_glow_capsule_group = (group, childrenByParent) => {
    const frame = group.layerOriginFrame;
    const exported = group.ddsOriginFrame;
    const url = group.ddsImage?.imageUrl;
    const keys = ['x', 'y', 'width', 'height'];
    const clean = (layer) => !layer.rotation && !layer.isFlippedHorizontal && !layer.isFlippedVertical
      && (layer.blendMode === undefined || layer.blendMode === 0) && !layer.shouldBreakMaskChain
      && (layer.layers === undefined || Array.isArray(layer.layers) && !layer.layers.length)
      && ['fills', 'borders', 'shadow'].every((key) => layer[key] === undefined || Array.isArray(layer[key]))
      && !enabled(layer.shadow).length;
    if (group.type !== 'layer-group' || !url || !frame || !exported || !clean(group)
      || group.hasClippingMask || group.blur?.isEnabled || (group.opacity !== undefined && group.opacity !== 100)
      || enabled(group.fills).length || enabled(group.borders).length
      || !keys.every((key) => finite(frame[key]) && finite(exported[key]) && Math.abs(frame[key] - exported[key]) <= 1e-6)
      || frame.height <= 0 || frame.width <= frame.height) return null;
    const children = [...new Set([...(group.layers || []), ...(childrenByParent.get(group.id) || [])])]
      .filter((child) => child.isVisible !== false);
    if (children.length !== 4) return null;
    const [outline, base, ...highlights] = children;
    for (const mask of [outline, base]) {
      if (!clean(mask) || !is_rectangle(mask) || !mask.hasClippingMask || mask.blur?.isEnabled
        || (mask.opacity !== undefined && mask.opacity !== 100)
        || (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0)
        || !mask.layerOriginFrame || !keys.every((key) => finite(mask.layerOriginFrame[key])
          && Math.abs(mask.layerOriginFrame[key] - frame[key]) <= 1e-6)
        || !Array.isArray(mask.radius) || mask.radius.length !== 1 || mask.radius[0] !== frame.height / 2
        || enabled(mask.borders).length !== 1) return null;
    }
    const border = enabled(base.borders)[0];
    if (enabled(outline.fills).length || enabled(base.fills).length !== 1
      || border.type !== 'gradient' || !same_border(border, enabled(outline.borders)[0], frame)) return null;
    const number = (value) => Math.round(value * 1e6) / 1e6;
    const definitions = [];
    const ellipses = [];
    for (const [i, highlight] of highlights.entries()) {
      const bounds = highlight.layerOriginFrame;
      const fill = enabled(highlight.fills)[0];
      const blur = highlight.blur;
      const opacity = highlight.opacity ?? 100;
      if (!clean(highlight) || highlight.ddsType !== 'oval' || highlight.hasClippingMask
        || !bounds || !keys.every((key) => finite(bounds[key])) || bounds.width <= 0 || bounds.height <= 0
        || bounds.width >= frame.width || bounds.height >= frame.height / 2
        || bounds.x < frame.x || bounds.x + bounds.width > frame.x + frame.width
        || bounds.y < frame.y || bounds.y > frame.y + frame.height
        || enabled(highlight.fills).length !== 1 || fill?.type !== 'color' || !supported_effect(fill)
        || enabled(highlight.borders).length || !finite(opacity) || opacity < 0 || opacity > 100
        || !blur?.isEnabled || blur.type !== '高斯模糊' || blur.blurType !== 0
        || !finite(blur.radius) || blur.radius <= 0 || blur.radius > 2) return null;
      const color = color_css(fill.color, (fill.opacity ?? 1) * opacity / 100);
      if (!color) return null;
      // Sketch blur radius corresponds approximately to twice the Gaussian standard deviation.
      definitions.push(`<filter id="glow${i}" x="-50%" y="-200%" width="200%" height="500%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${number(blur.radius / 2)}"/></filter>`);
      ellipses.push(`<ellipse cx="${number(bounds.x - frame.x + bounds.width / 2)}" cy="${number(bounds.y - frame.y + bounds.height / 2)}" rx="${number(bounds.width / 2)}" ry="${number(bounds.height / 2)}" fill="${color}" filter="url(#glow${i})"/>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}" preserveAspectRatio="none"><defs>${definitions.join('')}</defs>${ellipses.join('')}</svg>`;
    const encoded = encodeURIComponent(svg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const candidate = { ...base, hasClippingMask: false, ddsImage: group.ddsImage, ddsOriginFrame: exported };
    if (!resolveVectorStyles(`url("${url}")`, { [url]: candidate })) return null;
    return { ...candidate, capsuleDecoration: `url("data:image/svg+xml,${encoded}")` };
  };

  // A transparent export canvas containing only a full-height narrow left strip.
  const resolve_side_bar_group = (group, childrenByParent) => {
    const clean = (node) => node && !node.rotation && !node.isFlippedHorizontal && !node.isFlippedVertical
      && !node.hasClippingMask && !node.shouldBreakMaskChain && !node.blur?.isEnabled
      && (node.opacity === undefined || node.opacity === 100)
      && (node.blendMode === undefined || node.blendMode === 0)
      && (node.layers === undefined || Array.isArray(node.layers))
      && ['fills', 'borders', 'shadow'].every((key) => node[key] === undefined || Array.isArray(node[key]))
      && !enabled(node.borders).length && !enabled(node.shadow).length;
    const children = (node) => [...new Set([...(node.layers || []), ...(childrenByParent.get(node.id) || [])])]
      .filter((child) => child.isVisible !== false);
    const keys = ['x', 'y', 'width', 'height'];
    const same = (a, b) => a && b && keys.every((key) => finite(a[key]) && finite(b[key])
      && Math.abs(a[key] - b[key]) <= 1e-6);
    const frame = group.layerOriginFrame;
    if (group.type !== 'layer-group' || !clean(group) || enabled(group.fills).length
      || !group.ddsImage?.imageUrl || !same(frame, group.ddsOriginFrame)
      || frame.width <= 0 || frame.height <= 0) return null;
    const entries = children(group);
    if (entries.length !== 1) return null;
    const bar = entries[0];
    const f = bar.layerOriginFrame;
    const fills = enabled(bar.fills);
    const radii = Array.isArray(bar.radius) ? bar.radius : [bar.radius ?? 0];
    if (!clean(bar) || !is_rectangle(bar) || children(bar).length || !same(f, bar.ddsOriginFrame)
      || !f || Math.abs(f.x - frame.x) > 1e-6 || Math.abs(f.y - frame.y) > 1e-6
      || Math.abs(f.height - frame.height) > 1e-6 || f.width <= 0 || f.width > 12
      || f.height <= f.width * 2 || frame.width <= f.width * 2
      || fills.length !== 1 || fills[0].type !== 'color' || !supported_effect(fills[0])
      || (fills[0].opacity ?? 1) !== 1 || fills[0].color?.a !== 1 || !color_css(fills[0].color)
      || !radii.length || radii.length > 4 || !radii.every((radius) => finite(radius) && radius >= 0 && radius === radii[0])) return null;
    return { ...group, cssSideBar: { position: 'absolute', left: 0, top: 0, bottom: 0,
      width: f.width, borderRadius: `${Math.min(radii[0], f.width / 2)}px`,
      background: color_css(fills[0].color), pointerEvents: 'none' } };
  };

  // A solid button plate plus a standalone icon can shed its full-size bitmap.
  // Only effect-free, single-child wrappers may be traversed; icon internals stay in the asset.
  const resolve_painted_icon_group = (group, childrenByParent) => {
    const children = (node) => [...new Set([...(Array.isArray(node.layers) ? node.layers : []),
      ...(childrenByParent.get(node.id) || [])])].filter((child) => child.isVisible !== false);
    const sameFrame = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) =>
      finite(a[key]) && finite(b[key]) && Math.abs(a[key] - b[key]) <= 1e-6);
    const clean = (node) => !node.rotation && !node.isFlippedHorizontal && !node.isFlippedVertical
      && !node.hasClippingMask && !node.shouldBreakMaskChain && !node.blur?.isEnabled
      && (node.opacity === undefined || node.opacity === 100)
      && (node.blendMode === undefined || node.blendMode === 0)
      && (node.layers === undefined || Array.isArray(node.layers))
      && ['fills', 'borders', 'shadow'].every((key) => node[key] === undefined
        || Array.isArray(node[key]) && enabled(node[key]).length === 0);
    const frame = group.layerOriginFrame;
    const url = group.ddsImage?.imageUrl;
    if (group.type !== 'layer-group' || !url || !frame || frame.width <= 0 || frame.height <= 0
      || !sameFrame(frame, group.ddsOriginFrame)) return null;
    let container = group;
    const seen = new Set();
    let entries;
    while (container.type === 'layer-group' && clean(container)
      && sameFrame(container.layerOriginFrame, frame) && sameFrame(container.ddsOriginFrame, frame)) {
      if (seen.has(container)) return null;
      seen.add(container);
      entries = children(container);
      if (entries.length !== 1) break;
      container = entries[0];
    }
    if (!entries || entries.length !== 2 || !clean(container)) return null;
    const base = entries.find((node) => node.type === 'shape' && is_rectangle(node));
    let icon = entries.find((node) => node !== base);
    if (!base || !icon || children(base).length || !sameFrame(base.layerOriginFrame, frame)
      || !sameFrame(base.ddsOriginFrame, frame) || enabled(base.fills).length !== 1
      || enabled(base.fills)[0]?.type !== 'color' || enabled(base.fills)[0].color?.a !== 1
      || (enabled(base.fills)[0].opacity ?? 1) !== 1 || enabled(base.shadow).length
      || base.blur?.isEnabled || base.shouldBreakMaskChain
      || enabled(base.borders).some((border) => !['inside', '内边框', '内部'].includes(border.position))) return null;
    const paint = resolveVectorStyles(`url("${url}")`, { [url]: { ...base, ddsImage: { imageUrl: url } } });
    if (!paint || Object.keys(paint).some((key) => !['background', 'border', 'borderRadius', 'boxSizing'].includes(key))) return null;
    const iconSeen = new Set();
    while (!icon.ddsImage?.imageUrl) {
      if (iconSeen.has(icon) || icon.type !== 'layer-group' || !clean(icon)) return null;
      iconSeen.add(icon);
      const nested = children(icon);
      if (nested.length !== 1 || !sameFrame(icon.layerOriginFrame, nested[0].layerOriginFrame)
        || !sameFrame(icon.ddsOriginFrame, nested[0].ddsOriginFrame)) return null;
      icon = nested[0];
    }
    const exported = icon.ddsOriginFrame;
    if (!clean(icon) || !sameFrame(icon.layerOriginFrame, exported)
      || exported.width <= 0 || exported.height <= 0 || exported.width >= frame.width || exported.height > frame.height
      || exported.x < frame.x || exported.y < frame.y
      || exported.x + exported.width > frame.x + frame.width
      || exported.y + exported.height > frame.y + frame.height) return null;
    const { background, ...plateStyles } = paint;
    return { ...group, paintedIcon: true, iconBackground: {
      ...plateStyles, backgroundColor: background, backgroundImage: `url("${icon.ddsImage.imageUrl}")`,
      backgroundPosition: `${exported.x - frame.x}px ${exported.y - frame.y}px`,
      backgroundSize: `${exported.width}px ${exported.height}px`, backgroundRepeat: 'no-repeat',
      backgroundOrigin: 'border-box'
    } };
  };

  // Transparent layout rectangles plus one independently exported icon need no full-size bitmap.
  const resolve_icon_background_group = (group, childrenByParent) => {
    const children = (node) => [...new Set([...(Array.isArray(node.layers) ? node.layers : []),
      ...(childrenByParent.get(node.id) || [])])].filter((child) => child.isVisible !== false);
    const clean = (node) => !node.rotation && !node.isFlippedHorizontal && !node.isFlippedVertical
      && !node.hasClippingMask && !node.shouldBreakMaskChain && !node.blur?.isEnabled
      && (node.opacity === undefined || node.opacity === 100)
      && (node.blendMode === undefined || node.blendMode === 0)
      && (node.layers === undefined || Array.isArray(node.layers))
      && ['fills', 'borders', 'shadow'].every((key) => node[key] === undefined || Array.isArray(node[key]))
      && !enabled(node.borders).length && !enabled(node.shadow).length;
    const sameFrame = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) =>
      finite(a[key]) && finite(b[key]) && Math.abs(a[key] - b[key]) <= 1e-6);
    // Rotation/flips of an unpainted layout rectangle have no visible effect.
    const blank = (node) => clean({ ...node, rotation: 0, isFlippedHorizontal: false, isFlippedVertical: false })
      && is_rectangle(node) && !enabled(node.fills).length && !children(node).length;
    const frame = group.layerOriginFrame;
    if (group.type !== 'layer-group' || !group.ddsImage?.imageUrl || !clean(group)
      || enabled(group.fills).length || !sameFrame(frame, group.ddsOriginFrame)
      || frame.width <= 0 || frame.height <= 0) return null;
    const entries = children(group);
    if (entries.length !== 2) return null;
    const base = entries.find(blank);
    const iconGroup = entries.find((node) => node.type === 'layer-group');
    if (!base || !sameFrame(base.layerOriginFrame, frame) || !iconGroup || !clean(iconGroup)
      || enabled(iconGroup.fills).length) return null;
    const icons = children(iconGroup);
    if (icons.length !== 2 || icons.filter(blank).length !== 1) return null;
    const icon = icons.find((node) => !blank(node));
    const exported = icon?.ddsOriginFrame;
    if (!icon || !clean(icon) || icon.ddsType !== 'shape-group' || !icon.ddsImage?.imageUrl
      || children(icon).length || !exported
      || !['x', 'y', 'width', 'height'].every((key) => finite(exported[key]))
      || exported.width <= 0 || exported.height <= 0
      || exported.width >= frame.width || exported.height > frame.height
      || exported.x < frame.x || exported.y < frame.y
      || exported.x + exported.width > frame.x + frame.width
      || exported.y + exported.height > frame.y + frame.height) return null;
    const fills = enabled(icon.fills);
    if (fills.length !== 1 || fills[0].type !== 'color' || !supported_effect(fills[0])
      || !color_css(fills[0].color, fills[0].opacity)) return null;
    const number = (value) => Math.round(value * 1e6) / 1e6;
    return { ...group, iconBackground: {
      backgroundColor: 'transparent',
      backgroundImage: `url("${icon.ddsImage.imageUrl}")`,
      backgroundPosition: `${number(exported.x - frame.x)}px ${number(exported.y - frame.y)}px`,
      backgroundSize: `${number(exported.width)}px ${number(exported.height)}px`,
      backgroundRepeat: 'no-repeat'
    } };
  };

  // A standard four-segment ellipse plus invisible layout rectangles can be a CSS background.
  const resolve_circle_group = (group, childrenByParent) => {
    if (group.type !== 'layer-group' || !group.ddsImage?.imageUrl || group.hasClippingMask
      || (group.layers !== undefined && !Array.isArray(group.layers))
      || ['fills', 'borders', 'shadow'].some((key) => group[key] !== undefined
        && (!Array.isArray(group[key]) || enabled(group[key]).length))) return null;
    const children = [...new Set([...(Array.isArray(group.layers) ? group.layers : []), ...(childrenByParent.get(group.id) || [])])]
      .filter((child) => child.isVisible !== false);
    if (children.some((child) => child.hasClippingMask || child.shouldBreakMaskChain)) return null;
    const painted = children.filter((child) => !(child.opacity === 0 && is_rectangle(child)));
    if (painted.length !== 1) return null;
    const circle = painted[0];
    if (!is_standard_ellipse(circle)) return null;
    const frame = group.layerOriginFrame;
    const inner = circle.layerOriginFrame;
    if (!frame || !inner || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(inner[key]))
      || inner.width <= 0 || inner.height <= 0 || inner.x < frame.x || inner.y < frame.y
      || inner.x + inner.width > frame.x + frame.width || inner.y + inner.height > frame.y + frame.height) return null;
    const url = group.ddsImage.imageUrl;
    if (!resolveVectorStyles(`url("${url}")`, { [url]: { ...circle, ddsType: 'rectangle' } })) return null;
    const candidate = { ...group, ddsType: 'rectangle', layers: [], fills: circle.fills,
      circleBackground: { x: inner.x - frame.x + inner.width / 2, y: inner.y - frame.y + inner.height / 2,
        rx: inner.width / 2, ry: inner.height / 2 } };
    return resolveVectorStyles(`url("${url}")`, { [url]: candidate }) ? candidate : null;
  };

  // Split a verified gradient plate from masked decoration; the SVG remains the source of
  // truth for decoration geometry and effects, so no shadow coordinates are guessed.
  const resolve_gradient_card_group = (group, childrenByParent) => {
    const children = (node) => [...new Set([...(Array.isArray(node.layers) ? node.layers : []),
      ...(childrenByParent.get(node.id) || [])])].filter((child) => child?.isVisible !== false);
    const clean = (node) => node && (node.layers === undefined || Array.isArray(node.layers))
      && !node.isFlippedHorizontal && !node.isFlippedVertical && !node.shouldBreakMaskChain
      && !node.blur?.isEnabled && (node.blendMode === undefined || node.blendMode === 0)
      && ['fills', 'borders', 'shadow'].every((key) => node[key] === undefined || Array.isArray(node[key]));
    const opaque = (node) => node.opacity === undefined || node.opacity === 100;
    const sameFrame = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) =>
      finite(a[key]) && finite(b[key]) && Math.abs(a[key] - b[key]) <= 1e-6);
    if (group.type !== 'layer-group' || !clean(group) || !opaque(group) || group.rotation || group.hasClippingMask
      || !sameFrame(group.layerOriginFrame, group.ddsOriginFrame)
      || typeof group.image?.svgUrl !== 'string' || !/^https:\/\//i.test(group.image.svgUrl)
      || ['fills', 'borders', 'shadow'].some((key) => enabled(group[key]).length)) return null;
    const entries = children(group);
    if (entries.length !== 2) return null;
    const [base, decoration] = entries;
    if (!base || !decoration) return null;
    const frame = group.layerOriginFrame;
    const radii = base.radius === undefined
      ? Array.isArray(base.points) ? base.points.map((point) => point?.cornerRadius ?? 0) : [0]
      : Array.isArray(base.radius) ? base.radius : [base.radius];
    if (!clean(base) || !opaque(base) || !is_rectangle(base) || base.rotation || base.hasClippingMask
      || children(base).length || !sameFrame(base.layerOriginFrame, frame) || !sameFrame(base.ddsOriginFrame, frame)
      || frame.width <= 0 || frame.height <= 0 || enabled(base.shadow).length || base.borderOptions?.dashPattern?.length
      || !radii.length || radii.length > 4 || !radii.every((r) => finite(r) && r >= 0 && r === radii[0])
      || !clean(decoration) || !opaque(decoration) || decoration.type !== 'layer-group' || decoration.rotation
      || decoration.hasClippingMask || ['fills', 'borders', 'shadow'].some((key) => enabled(decoration[key]).length)) return null;
    const fill = enabled(base.fills)[0];
    const border = enabled(base.borders)[0];
    if (enabled(base.fills).length !== 1 || fill?.type !== 'gradient' || !fill_css(fill, frame)
      || (fill.opacity ?? 1) !== 1 || !fill.gradient.colorStops.every((stop) => stop.color.a === 1)
      || enabled(base.borders).length !== 1 || border?.type !== 'color' || !supported_effect(border)
      || !['inside', '内边框', '内部'].includes(border.position) || !finite(border.thickness) || border.thickness <= 0
      || border.thickness * 2 >= Math.min(frame.width, frame.height)
      || !color_css(border.color, border.opacity) || border.color.a !== 1 || (border.opacity ?? 1) !== 1
      || (radii[0] !== 0 && radii[0] < border.thickness / 2)
      || radii[0] > Math.min(frame.width, frame.height) / 2) return null;
    const clip = decoration.layerOriginFrame;
    if (!clip || !['x', 'y', 'width', 'height'].every((key) => finite(clip[key])) || clip.width <= 0 || clip.height <= 0
      || clip.x < frame.x || clip.y < frame.y || clip.x + clip.width > frame.x + frame.width
      || clip.y + clip.height > frame.y + frame.height) return null;
    const parts = children(decoration);
    const mask = parts[0];
    if (parts.length < 2 || !mask?.hasClippingMask || !is_rectangle(mask) || !clean(mask) || !opaque(mask)
      || mask.rotation || children(mask).length || !sameFrame(mask.layerOriginFrame, clip)
      || (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0)
      || enabled(mask.borders).length || enabled(mask.shadow).length || enabled(mask.fills).length !== 1) return null;
    const maskFill = enabled(mask.fills)[0];
    if (!fill_css(maskFill, clip) || (maskFill.type === 'color'
      ? maskFill.color.a !== 0 : !maskFill.gradient?.colorStops.every((stop) => stop.color.a === 0))) return null;
    for (const part of parts.slice(1)) {
      const shadow = enabled(part.shadow)[0];
      if (!clean(part) || part.type !== 'shape' || part.hasClippingMask || children(part).length
        || enabled(part.fills).length || enabled(part.borders).length || enabled(part.shadow).length !== 1
        || shadow?.type !== '内阴影' || !supported_effect(shadow) || !color_css(shadow.color, shadow.opacity)
        || ![shadow.blurRadius, shadow.offsetX, shadow.offsetY, shadow.spread].every(finite) || shadow.blurRadius < 0
        || (part.rotation !== undefined && !finite(part.rotation))
        || (part.opacity !== undefined && (!finite(part.opacity) || part.opacity < 0 || part.opacity > 100))
        || part.isClosed !== true || !Array.isArray(part.points) || part.points.length < 3
        || part.points.some((point) => point.hasCurveTo || point.hasCurveFrom || point.cornerRadius
          || !finite(point.point?.x) || !finite(point.point?.y))) return null;
    }
    const gradient = fill.gradient;
    const stops = gradient.colorStops.slice().sort((a, b) => a.position - b.position)
      .map((stop) => ({ position: stop.position, color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a } }));
    const card = { svgUrl: group.image.svgUrl, width: frame.width, height: frame.height, radius: radii[0],
      thickness: border.thickness, borderColor: color_css(border.color), gradient: {
        from: { x: gradient.from.x, y: gradient.from.y }, to: { x: gradient.to.x, y: gradient.to.y }, colorStops: stops
      } };
    return { ...group, gradientCard: card };
  };

  // Recursively prove that an exported group paints nothing; never infer this from its name.
  const resolve_transparent_group = (group, childrenByParent) => {
    if (group.type !== 'layer-group' || !group.ddsImage?.imageUrl) return null;
    const seen = new Set();
    const empty = (node) => {
      if (seen.has(node) || (node.layers !== undefined && !Array.isArray(node.layers))) return false;
      seen.add(node);
      if (node.isVisible === false || node.opacity === 0) return true;
      if (node.opacity !== undefined && node.opacity !== 100 || node.blur?.isEnabled
        || node.blendMode !== undefined && node.blendMode !== 0
        || !['layer-group', 'shape'].includes(node.type)
        || ['fills', 'borders', 'shadow'].some((key) => node[key] !== undefined
          && (!Array.isArray(node[key]) || enabled(node[key]).length))) return false;
      const children = [...new Set([...(node.layers || []), ...(childrenByParent.get(node.id) || [])])];
      return children.every(empty);
    };
    return empty(group) ? { ...group, transparentGroup: true } : null;
  };

  // Some exports store group children in the flat info array, linked only by parentID.
  const resolve_simple_group = (group, childrenByParent, idCounts) => {
    const url = group.ddsImage?.imageUrl;
    if (!url || group.type !== 'layer-group' || group.hasClippingMask
      || (group.layers !== undefined && !Array.isArray(group.layers))
      || group.rotation || group.isFlippedHorizontal || group.isFlippedVertical
      || (group.opacity !== undefined && group.opacity !== 100)
      || (group.blendMode !== undefined && group.blendMode !== 0)
      || ['fills', 'borders', 'shadow'].some((key) => group[key] !== undefined
        && (!Array.isArray(group[key]) || enabled(group[key]).length))) return null;
    let children = [...new Set([...(group.layers || []), ...(childrenByParent.get(group.id) || [])])]
      .filter((child) => child.isVisible !== false);
    // Transparent wrappers do not change a same-frame plate's paint. Follow only
    // a bounded, unique, single-child chain; text, masks, effects and shifts reject.
    const wrappers = new Set([group.id]);
    while (children.length === 1 && children[0].type === 'layer-group') {
      const wrapper = children[0];
      const frame = group.layerOriginFrame;
      if (!wrapper.id || wrappers.has(wrapper.id) || wrappers.size >= 8 || idCounts?.get(group.id) !== 1
        || idCounts?.get(wrapper.id) !== 1
        || !frame || !wrapper.layerOriginFrame || ['x', 'y', 'width', 'height'].some((key) =>
          !finite(frame[key]) || frame[key] !== wrapper.layerOriginFrame[key])
        || wrapper.hasClippingMask || wrapper.shouldBreakMaskChain || wrapper.rotation
        || wrapper.isFlippedHorizontal || wrapper.isFlippedVertical || wrapper.blur?.isEnabled
        || wrapper.opacity !== undefined && wrapper.opacity !== 100
        || wrapper.blendMode !== undefined && wrapper.blendMode !== 0
        || ['fills', 'borders', 'shadow'].some((key) => wrapper[key] !== undefined
          && (!Array.isArray(wrapper[key]) || enabled(wrapper[key]).length))
        || wrapper.layers !== undefined && !Array.isArray(wrapper.layers)) return null;
      wrappers.add(wrapper.id);
      children = [...new Set([...(wrapper.layers || []), ...(childrenByParent.get(wrapper.id) || [])])]
        .filter((child) => child.isVisible !== false);
    }
    if (wrappers.size > 1 && (children.length !== 1 || idCounts?.get(children[0].id) !== 1)) return null;
    const masks = children.filter((child) => child.hasClippingMask);
    if (!masks.length && children.length === 1 && is_rectangle(children[0])) {
      const child = children[0];
      const frame = group.layerOriginFrame;
      if (!frame || !child.layerOriginFrame || ['x', 'y', 'width', 'height'].some((key) => frame[key] !== child.layerOriginFrame[key])) return null;
      let candidate = { ...child, ddsImage: group.ddsImage, ddsOriginFrame: group.ddsOriginFrame,
        dividerGroup: frame.width <= 2 || frame.height <= 2 };
      const exported = group.ddsOriginFrame;
      const shadows = enabled(child.shadow);
      const shadow = shadows.length === 1 ? shadows[0] : null;
      // Render simple solid shadow plates on their original CSS box, not the padded PNG box.
      if (exported && shadow?.type === '外阴影' && supported_effect(shadow)
        && [shadow.blurRadius, shadow.spread, shadow.offsetX, shadow.offsetY].every(finite)
        && shadow.blurRadius > 0 && shadow.spread <= 0
        && shadow.blurRadius + shadow.spread > 0 && !child.blur?.isEnabled
        && !enabled(child.borders).length && enabled(child.fills).length === 1
        && enabled(child.fills)[0]?.type === 'color' && enabled(child.fills)[0]?.color?.a === 1
        && ['x', 'y', 'width', 'height'].every((key) => finite(frame[key]))
        && frame.width > 0 && frame.height > 0) {
        const extent = shadow.blurRadius + shadow.spread;
        const x = Math.floor(Math.min(frame.x, frame.x + shadow.offsetX - extent));
        const y = Math.floor(Math.min(frame.y, frame.y + shadow.offsetY - extent));
        const width = Math.ceil(Math.max(frame.x + frame.width,
          frame.x + frame.width + shadow.offsetX + extent)) - x;
        const height = Math.ceil(Math.max(frame.y + frame.height,
          frame.y + frame.height + shadow.offsetY + extent)) - y;
        if (['x', 'y', 'width', 'height'].every((key) => exported[key] === ({ x, y, width, height })[key])) {
          const plate = { ...candidate, ddsOriginFrame: { ...frame }, cssShadowGroup: true };
          if (resolveVectorStyles(`url("${url}")`, { [url]: plate })) return plate;
        }
      }
      // Some tall panels export transparent space below the painted rectangle.
      const fill = enabled(child.fills);
      if (exported && frame.x === exported.x && frame.y === exported.y && frame.width === exported.width
        && exported.height === Math.ceil(frame.height) && finite(child.height) && child.height > 0
        && child.height === group.height && child.height < frame.height
        && Number.isInteger(child.height) && !child.hasClippingMask && !child.blur?.isEnabled
        && !enabled(child.borders).length && !enabled(child.shadow).length
        && fill.length === 1 && fill[0]?.type === 'gradient' && fill[0].gradient?.type === 'linear'
        && [fill[0].gradient.from?.x, fill[0].gradient.from?.y,
          fill[0].gradient.to?.x, fill[0].gradient.to?.y].every(finite)
        && Array.isArray(child.radius) && child.radius.length === 1
        && finite(child.radius[0]) && child.radius[0] >= 0 && child.height > child.radius[0] * 2) {
        const gradient = fill[0].gradient;
        const ratio = frame.height / child.height;
        candidate = { ...candidate, layerOriginFrame: { ...exported },
          radius: [child.radius[0], child.radius[0], 0, 0],
          gradientPaintFrame: { width: frame.width, height: child.height },
          fills: [{ ...fill[0], gradient: { ...gradient,
            from: { ...gradient.from, y: gradient.from.y * ratio },
            to: { ...gradient.to, y: gradient.to.y * ratio } } }] };
      }
      return resolveVectorStyles(`url("${url}")`, { [url]: candidate }) ? candidate : null;
    }
    if (!masks.length && children.length === 1 && children[0].type === 'shape' && children[0].isClosed === false) {
      const child = children[0];
      const exported = group.ddsOriginFrame;
      const frame = child.layerOriginFrame;
      const candidate = { ...child, ddsImage: group.ddsImage, ddsOriginFrame: exported };
      // Full-height vertical strokes can reuse the verified line geometry without normalization.
      if (exported?.width <= 4 && exported.height > 4 && frame && !child.shouldBreakMaskChain
        && resolveVectorStyles(`url("${url}")`, { [url]: candidate })) return candidate;
      // Treat subpixel drawing drift as a horizontal divider, not an intentional diagonal.
      if (!exported || exported.height !== 1 || !frame || exported.width < 32
        || child.shouldBreakMaskChain
        || !resolveVectorStyles(`url("${url}")`, { [url]: candidate })) return null;
      const [a, b] = child.points;
      const dx = Math.abs(a.point.x - b.point.x) * frame.width;
      const dy = Math.abs(a.point.y - b.point.y) * frame.height;
      if (dy > 0.5001 || dy / dx > 0.002 || Math.abs(dx - exported.width) > 0.5001) return null;
      const normalized = { ...candidate, rotation: 0, layerOriginFrame: { ...exported },
        points: child.points.map((point, i) => ({ ...point,
          point: { x: i === 0 ? (a.point.x < b.point.x ? 0 : 1) : (a.point.x < b.point.x ? 1 : 0), y: 0.5 } })) };
      return resolveVectorStyles(`url("${url}")`, { [url]: normalized }) ? normalized : null;
    }
    if (masks.length !== 1) return null;
    const mask = masks[0];
    if (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0) return null;
    const frame = group.layerOriginFrame;
    if (!frame || !mask.layerOriginFrame || ['x', 'y', 'width', 'height'].some((key) =>
      !finite(frame[key]) || frame[key] !== mask.layerOriginFrame[key])) return null;
    // A lone painted rectangle has nothing to clip. Preserve its paint, not the mask flag.
    if (children.length === 1 && is_rectangle(mask) && !mask.shouldBreakMaskChain
      && !mask.blur?.isEnabled && !enabled(mask.shadow).length && !enabled(mask.borders).length
      && (mask.opacity === undefined || mask.opacity === 100)
      && group.ddsOriginFrame && mask.ddsOriginFrame
      && ['x', 'y', 'width', 'height'].every((key) =>
        finite(group.ddsOriginFrame[key]) && finite(mask.ddsOriginFrame[key])
        && frame[key] === group.ddsOriginFrame[key] && frame[key] === mask.ddsOriginFrame[key])) {
      const candidate = { ...mask, hasClippingMask: false,
        ddsImage: group.ddsImage, ddsOriginFrame: group.ddsOriginFrame };
      if (resolveVectorStyles(`url("${url}")`, { [url]: candidate })) return candidate;
    }
    const fills = enabled(mask.fills);
    if (fills.length !== 1 || fills[0]?.color?.a !== 1
      || (fills[0].opacity !== undefined && fills[0].opacity !== 1)
      || !['color', undefined].includes(fills[0].type) || !color_css(fills[0].color)) return null;
    const candidate = { ...mask, hasClippingMask: false, ddsImage: group.ddsImage, ddsOriginFrame: group.ddsOriginFrame };
    const styles = resolveVectorStyles(`url("${url}")`, { [url]: candidate });
    if (!styles) return null;
    // Opaque same-color rectangles are redundant under the mask, even if clipped at its edge.
    for (const child of children.filter((child) => child !== mask)) {
      if (child.type === 'layer-group' || child.hasClippingMask) return null;
      const childStyles = resolveVectorStyles(`url("${url}")`, { [url]: child });
      if (!childStyles || childStyles.background !== styles.background
        || Object.keys(childStyles).some((key) => !['background', 'borderRadius'].includes(key))) return null;
    }
    return candidate;
  };

  // Separate fixed decorative paint from content-driven panels. Only two proven
  // structures are supported: a gradient mask plus bitmap, or a white scroll panel.
  const resolve_responsive_panel = (group, childrenByParent) => {
    const keys = ['x', 'y', 'width', 'height'];
    const clean = (node) => node && !node.rotation && !node.isFlippedHorizontal && !node.isFlippedVertical
      && !node.blur?.isEnabled && !node.shouldBreakMaskChain
      && (node.opacity === undefined || node.opacity === 100)
      && (node.blendMode === undefined || node.blendMode === 0)
      && (node.layers === undefined || Array.isArray(node.layers))
      && ['fills', 'borders', 'shadow'].every((key) => node[key] === undefined || Array.isArray(node[key]))
      && !enabled(node.borders).length && !enabled(node.shadow).length;
    const same = (a, b) => a && b && keys.every((key) => finite(a[key]) && finite(b[key])
      && Math.abs(a[key] - b[key]) <= 1e-6);
    if (group.type !== 'layer-group' || !clean(group) || group.hasClippingMask || enabled(group.fills).length) return null;
    const children = [...new Set([...(group.layers || []), ...(childrenByParent.get(group.id) || [])])]
      .filter((child) => child.isVisible !== false);
    const mask = children[0];
    const frame = group.layerOriginFrame;
    if (!mask?.hasClippingMask || !clean(mask) || !is_rectangle(mask)
      || (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0)
      || !same(frame, mask.layerOriginFrame) || !same(frame, group.ddsOriginFrame)
      || frame.width <= 0 || frame.height <= 0) return null;
    const fill = enabled(mask.fills);
    if (fill.length !== 1 || !supported_effect(fill[0]) || (fill[0].opacity ?? 1) !== 1) return null;
    const url = mask.ddsImage?.imageUrl;
    const paint = url && resolveVectorStyles(`url("${url}")`, { [url]: {
      ...mask, hasClippingMask: false, ddsOriginFrame: frame
    } });
    if (!paint || Object.keys(paint).some((key) => !['background', 'borderRadius'].includes(key))) return null;
    const number = (value) => Math.round(value * 1e6) / 1e6;
    const inside = (box, tolerance = 0) => box && keys.every((key) => finite(box[key]))
      && box.width > 0 && box.height > 0 && box.x >= frame.x - tolerance && box.y >= frame.y - tolerance
      && box.x + box.width <= frame.x + frame.width + tolerance
      && box.y + box.height <= frame.y + frame.height + tolerance;
    const gradient = fill[0].gradient;
    const bitmap = children[1];
    if (children.length === 2 && fill[0].type === 'gradient' && paint.background.startsWith('linear-gradient(')
      && gradient?.from?.x === gradient?.to?.x && gradient.from.y === 0 && gradient.to.y > 0 && gradient.to.y <= 1
      && gradient.colorStops.every((stop) => stop.color?.a === 1)
      && bitmap.type === 'bitmap' && clean({ ...bitmap, opacity: 100, rotation: 0,
        isFlippedHorizontal: false, isFlippedVertical: false }) && !bitmap.hasClippingMask
      && (bitmap.opacity === undefined || finite(bitmap.opacity) && bitmap.opacity >= 0 && bitmap.opacity <= 100)
      && !enabled(bitmap.fills).length && !bitmap.layers?.length && bitmap.ddsImage?.imageUrl
      && inside(bitmap.ddsOriginFrame, 1)) {
      const exported = bitmap.ddsOriginFrame;
      const last = gradient.colorStops.slice().sort((a, b) => a.position - b.position).at(-1);
      const right = Math.max(0, frame.x + frame.width - exported.x - exported.width);
      const top = Math.max(0, exported.y - frame.y);
      return { layerId: mask.id, frame, responsive: true, styles: {
        backgroundColor: color_css(last.color),
        backgroundImage: `url("${bitmap.ddsImage.imageUrl}"), ${paint.background}`,
        backgroundPosition: `right ${number(right)}px top ${number(top)}px, 0 0`,
        backgroundSize: `${exported.width}px ${exported.height}px, 100% ${number(frame.height)}px`,
        backgroundRepeat: 'no-repeat', ...(paint.borderRadius ? { borderRadius: paint.borderRadius } : {})
      } };
    }
    // A narrow grey rounded rectangle against the right edge represents a static
    // scrollbar thumb. Replace it only in the presence of a separate content group.
    const thumb = children[1];
    const content = children[2];
    const thumbFrame = thumb?.layerOriginFrame;
    const thumbFill = enabled(thumb?.fills);
    const thumbRadius = Array.isArray(thumb?.radius) ? thumb.radius : [thumb?.radius];
    if (children.length !== 3 || fill[0].type !== 'color' || color_css(fill[0].color) !== 'rgba(255,255,255,1)'
      || !thumb || !clean(thumb) || thumb.hasClippingMask || !is_rectangle(thumb) || thumb.layers?.length
      || !inside(thumbFrame) || thumbFrame.width > 12 || thumbFrame.height <= thumbFrame.width * 2
      || thumbFrame.height >= frame.height || frame.x + frame.width - thumbFrame.x - thumbFrame.width > 8
      || !thumbRadius.length || !thumbRadius.every((radius) => finite(radius) && radius >= thumbFrame.width / 2)
      || thumbFill.length !== 1 || thumbFill[0].type !== 'color' || !supported_effect(thumbFill[0])
      || (thumbFill[0].opacity ?? 1) !== 1 || thumbFill[0].color?.a !== 1
      || !content || content.type !== 'layer-group' || !clean(content) || content.hasClippingMask
      || enabled(content.fills).length) return null;
    const thumbColor = color_css(thumbFill[0].color);
    const channels = ['r', 'g', 'b'].map((key) => thumbFill[0].color?.[key]);
    if (!thumbColor || Math.min(...channels) < 180 || Math.max(...channels) - Math.min(...channels) > 15) return null;
    return { layerId: mask.id, frame, responsive: true, requiredLayerIds: [], excludedLayerIds: [thumb.id], styles: {
      backgroundColor: paint.background, ...(paint.borderRadius ? { borderRadius: paint.borderRadius } : {}),
      overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: `${thumbColor} transparent`
    } };
  };

  const resolve_merged_group = (group, childrenByParent) => {
    if (group.type !== 'layer-group' || group.hasClippingMask || group.rotation
      || group.isFlippedHorizontal || group.isFlippedVertical
      || (group.layers !== undefined && !Array.isArray(group.layers))
      || (group.opacity !== undefined && group.opacity !== 100)
      || (group.blendMode !== undefined && group.blendMode !== 0)
      || ['fills', 'borders', 'shadow'].some((key) => group[key] !== undefined
        && (!Array.isArray(group[key]) || enabled(group[key]).length))) return null;
    const children = [...new Set([...(group.layers || []), ...(childrenByParent.get(group.id) || [])])]
      .filter((child) => child.isVisible !== false);
    if (children.length !== 2) return null;
    const mask = children.find((child) => child.hasClippingMask);
    const bitmap = children.find((child) => child.type === 'bitmap' && !child.hasClippingMask);
    if (!mask?.id || !bitmap || (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0)
      || bitmap.rotation || bitmap.isFlippedHorizontal || bitmap.isFlippedVertical
      || (bitmap.layers !== undefined && (!Array.isArray(bitmap.layers) || bitmap.layers.length))
      || (bitmap.blendMode !== undefined && bitmap.blendMode !== 0)
      || bitmap.shouldBreakMaskChain
      || ['fills', 'borders', 'shadow'].some((key) => bitmap[key] !== undefined
        && (!Array.isArray(bitmap[key]) || enabled(bitmap[key]).length))) return null;
    const frame = group.layerOriginFrame;
    const exported = bitmap.ddsOriginFrame;
    const url = bitmap.ddsImage?.imageUrl;
    if (!frame || !exported || !url || !mask.layerOriginFrame
      || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key])
        || frame[key] !== mask.layerOriginFrame[key])
      || frame.width <= 0 || frame.height <= 0 || exported.width <= 0 || exported.height <= 0
      || exported.x < frame.x || exported.y < frame.y
      || exported.x + exported.width > frame.x + frame.width
      || exported.y + exported.height > frame.y + frame.height) return null;
    const fill = enabled(mask.fills);
    if (fill.length !== 1 || fill[0]?.color?.a !== 1
      || (fill[0].opacity !== undefined && fill[0].opacity !== 1)) return null;
    const maskStyles = resolveVectorStyles(`url("${url}")`, { [url]: { ...mask, hasClippingMask: false } });
    // A gradient stroke around the mask stays in the background shorthand; the bitmap
    // becomes the top layer so its own position and size stay exact.
    const borderedMask = Boolean(maskStyles) && !maskStyles.background?.startsWith('rgba(')
      && maskStyles.background?.includes('border-box')
      && Object.keys(maskStyles).every((key) => ['background', 'border', 'boxSizing', 'borderRadius',
        'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].includes(key));
    // A solid mask cropped by the artboard still paints one color over the crop.
    const radii = Array.isArray(mask.radius) ? mask.radius : [mask.radius ?? 0];
    const cropPaint = !maskStyles && exported.x === frame.x && exported.y === frame.y
      && exported.width <= frame.width && exported.height <= frame.height
      && radii.every((radius) => radius === 0) && !mask.blur?.isEnabled
      && !enabled(mask.borders).length && !enabled(mask.shadow).length
      && color_css(fill[0].color, fill[0].opacity);
    if (!borderedMask && !cropPaint
      && (!maskStyles || !maskStyles.background?.startsWith('rgba(')
        || Object.keys(maskStyles).some((key) => !['background', 'borderRadius'].includes(key)))) return null;
    const position = `${exported.x - frame.x}px ${exported.y - frame.y}px`;
    const size = `${exported.width}px ${exported.height}px`;
    const styles = borderedMask
      ? { ...maskStyles, background: `url("${url}") ${position} / ${size} no-repeat, ${maskStyles.background}` }
      : cropPaint
        ? { backgroundColor: cropPaint, backgroundImage: `url("${url}")`, backgroundPosition: '0px 0px',
          backgroundSize: size, backgroundRepeat: 'no-repeat' }
        : { backgroundColor: maskStyles.background, backgroundImage: `url("${url}")`,
          backgroundPosition: position, backgroundSize: size, backgroundRepeat: 'no-repeat' };
    if (!borderedMask && !cropPaint && maskStyles.borderRadius) styles.borderRadius = maskStyles.borderRadius;
    // The exported bitmap already includes layer opacity and mask clipping.
    return { layerId: mask.id, frame, styles };
  };

  // Flat Sketch mask chains can contain an exported icon followed by independent text.
  const resolve_mask_siblings = (mask, childrenByParent) => {
    if (!mask.id || !mask.parentID || !mask.hasClippingMask || !is_rectangle(mask)
      || (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0)) return null;
    const siblings = childrenByParent.get(mask.parentID) || [];
    const start = siblings.indexOf(mask);
    const chain = [];
    for (const sibling of siblings.slice(start + 1)) {
      if (sibling.hasClippingMask || sibling.shouldBreakMaskChain) break;
      if (sibling.isVisible !== false) chain.push(sibling);
    }
    if (chain.length !== 2) return null;
    const [icon, text] = chain;
    if (icon.type !== 'layer-group' || !icon.ddsImage?.imageUrl || text.type !== 'text' || !text.id
      || icon.rotation || icon.isFlippedHorizontal || icon.isFlippedVertical
      || (icon.opacity !== undefined && icon.opacity !== 100)
      || (icon.blendMode !== undefined && icon.blendMode !== 0)) return null;
    const frame = mask.layerOriginFrame;
    const exported = mask.ddsOriginFrame;
    const imageFrame = icon.ddsOriginFrame;
    const iconFrame = icon.layerOriginFrame;
    if (!frame || !exported || !imageFrame || !iconFrame
      || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key])
        || Math.abs(frame[key] - exported[key]) > 1e-6
        || !finite(imageFrame[key]) || !finite(iconFrame[key]) || Math.abs(imageFrame[key] - iconFrame[key]) > 1e-6)
      || imageFrame.width <= 0 || imageFrame.height <= 0
      || imageFrame.x < frame.x || imageFrame.y < frame.y
      || imageFrame.x + imageFrame.width > frame.x + frame.width
      || imageFrame.y + imageFrame.height > frame.y + frame.height) return null;
    const fills = enabled(mask.fills);
    if (fills.length !== 1 || (fills[0].opacity ?? 1) !== 1
      || ((fills[0].type === 'color' || fills[0].fillType === 0)
        ? fills[0].color?.a !== 1 : !fills[0].gradient?.colorStops?.every((stop) => stop.color?.a === 1))) return null;
    const url = mask.ddsImage?.imageUrl;
    if (!url) return null;
    const candidate = { ...mask, hasClippingMask: false };
    const bordered = enabled(mask.borders).length === 1 && enabled(mask.borders)[0]?.type === 'gradient';
    const base = bordered ? resolve_rectangle_svg([candidate], exported)
      : resolveVectorStyles(`url("${url}")`, { [url]: candidate });
    if (!base || !(bordered || base.background?.startsWith('linear-gradient('))
      || Object.keys(base).some((key) => !['background', 'borderRadius'].includes(key))) return null;
    return { layerId: mask.id, frame, textLayerIds: [text.id], styles: {
      backgroundImage: `url("${icon.ddsImage.imageUrl}"), ${bordered ? base.background.match(/^url\("[^"]*"\)/)[0] : base.background}`,
      backgroundPosition: `${Math.round((imageFrame.x - frame.x) * 1e6) / 1e6}px ${Math.round((imageFrame.y - frame.y) * 1e6) / 1e6}px, 0 0`,
      backgroundSize: `${imageFrame.width}px ${imageFrame.height}px, 100% 100%`,
      backgroundRepeat: 'no-repeat', ...(base.borderRadius ? { borderRadius: base.borderRadius } : {})
    } };
  };

  // Transparent menu masks may merge only the trailing arrow; the leading icon and
  // label remain schema children. Never duplicate those independent children.
  const resolve_transparent_menu = (mask, childrenByParent) => {
    const keys = ['x', 'y', 'width', 'height'];
    const clean = (node) => node && !node.rotation && !node.isFlippedHorizontal && !node.isFlippedVertical
      && !node.hasClippingMask && !node.shouldBreakMaskChain && !node.blur?.isEnabled
      && (node.opacity === undefined || node.opacity === 100)
      && (node.blendMode === undefined || node.blendMode === 0)
      && (node.layers === undefined || Array.isArray(node.layers))
      && ['fills', 'borders', 'shadow'].every((key) => node[key] === undefined
        || Array.isArray(node[key]) && enabled(node[key]).length === 0);
    if (!mask.id || !mask.parentID || !mask.hasClippingMask || !is_rectangle(mask)
      || (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0)
      || !clean({ ...mask, hasClippingMask: false })) return null;
    const children = (node) => [...new Set([...(node.layers || []), ...(childrenByParent.get(node.id) || [])])]
      .filter((child) => child.isVisible !== false);
    const siblings = childrenByParent.get(mask.parentID) || [];
    const visible = siblings.filter((node) => node.isVisible !== false);
    if (visible.length !== 3 || visible[0] !== mask) return null;
    let content = visible[1];
    const arrow = visible[2];
    const frame = mask.layerOriginFrame;
    const contained = (box) => frame && box && keys.every((key) => finite(frame[key]) && finite(box[key]))
      && box.width > 0 && box.height > 0 && box.x >= frame.x && box.y >= frame.y
      && box.x + box.width <= frame.x + frame.width + 1e-6
      && box.y + box.height <= frame.y + frame.height + 1e-6;
    const roundedExport = (node) => {
      const f = node.layerOriginFrame;
      const e = node.ddsOriginFrame;
      return f && e && keys.every((key) => finite(f[key]) && finite(e[key]))
        && ['x', 'y'].every((key) => Math.abs(e[key] - Math.floor(f[key])) <= 1e-6)
        && Math.abs(e.width - (Math.ceil(f.x + f.width) - e.x)) <= 1e-6
        && Math.abs(e.height - (Math.ceil(f.y + f.height) - e.y)) <= 1e-6;
    };
    if (!contained(frame) || !roundedExport(mask) || !clean(arrow) || arrow.type !== 'layer-group'
      || !arrow.ddsImage?.imageUrl || !contained(arrow.layerOriginFrame) || !roundedExport(arrow)
      || arrow.layerOriginFrame.width >= frame.width / 2 || arrow.layerOriginFrame.height >= frame.height) return null;
    const seen = new Set();
    let entries;
    while (content.type === 'layer-group' && clean(content) && contained(content.layerOriginFrame)) {
      if (seen.has(content)) return null;
      seen.add(content);
      entries = children(content);
      if (entries.length !== 1) break;
      content = entries[0];
    }
    if (!entries || entries.length !== 2 || !clean(content)) return null;
    const icon = entries.find((node) => node.type === 'layer-group' && node.ddsImage?.imageUrl);
    const text = entries.find((node) => node.type === 'text');
    if (!icon || !text || !clean(icon) || !contained(icon.layerOriginFrame) || !contained(text.layerOriginFrame)) return null;
    const f = arrow.layerOriginFrame;
    const number = (value) => Math.round(value * 1e6) / 1e6;
    return { layerId: mask.id, frame, requiredLayerIds: [icon.id, text.id], excludedLayerIds: [arrow.id], styles: {
      backgroundImage: `url("${arrow.ddsImage.imageUrl}")`, backgroundRepeat: 'no-repeat',
      backgroundPosition: `${number(f.x - frame.x)}px ${number(f.y - frame.y)}px`,
      backgroundSize: `${f.width}px ${f.height}px`
    } };
  };

  // Compile only effect-free rectangular paint and small independent icon assets.
  // Owner ids let the renderer omit paint already represented by schema children.
  const compile_layer_paint = (frame, nodes, childrenByParent) => {
    const keys = ['x', 'y', 'width', 'height'];
    const finiteBox = (box) => box && keys.every((key) => finite(box[key])) && box.width > 0 && box.height > 0;
    if (!finiteBox(frame)) return null;
    const clean = (node) => node && !node.isFlippedHorizontal && !node.isFlippedVertical
      && !node.blur?.isEnabled && !node.shouldBreakMaskChain
      && (node.rotation === undefined || node.rotation === 0
        || finite(node.rotation) && node.rotation % 360 === 0)
      && (node.opacity === undefined || node.opacity === 100)
      && (node.blendMode === undefined || node.blendMode === 0)
      && (node.layers === undefined || Array.isArray(node.layers))
      && ['fills', 'borders', 'shadow'].every((key) => node[key] === undefined || Array.isArray(node[key]))
      && !enabled(node.shadow).length;
    const blank = (node) => is_rectangle(node) && ['fills', 'borders', 'shadow'].every((key) => !enabled(node[key]).length);
    const children = (node) => [...new Set([...(node.layers || []), ...(childrenByParent.get(node.id) || [])])]
      .filter((child) => child.isVisible !== false);
    const contained = (box, clip) => finiteBox(box) && box.x >= clip.x - 1e-6 && box.y >= clip.y - 1e-6
      && box.x + box.width <= clip.x + clip.width + 1e-6 && box.y + box.height <= clip.y + clip.height + 1e-6;
    const records = [];
    // Records store frame-relative boxes so reused exports compare equal.
    const rel = (b) => ({ x: b.x - frame.x, y: b.y - frame.y, width: b.width, height: b.height });
    const seen = new Set();
    const sourceUrls = new Set(nodes.filter((node) => keys.every((key) => finite(node.layerOriginFrame?.[key])
      && Math.abs(node.layerOriginFrame[key] - frame[key]) <= 1e-6)).map((node) => node.ddsImage?.imageUrl).filter(Boolean));
    const visit = (node, owners, clip) => {
      if (node?.opacity === 0 && !node.hasClippingMask && !node.shouldBreakMaskChain) return true;
      const leafAsset = node?.type === 'shape' && !is_rectangle(node) && !children(node).length
        && (node.ddsImage?.imageUrl || node.image?.imageUrl);
      if (!node || seen.has(node) || !clean(leafAsset ? { ...node, rotation: 0,
        isFlippedHorizontal: false, isFlippedVertical: false } : node) || !node.id) return false;
      seen.add(node);
      owners = [...owners, node.id];
      const box = node.layerOriginFrame;
      if (node.type === 'shape' && node.isClosed === false && box
        && (box.width === 0 || box.height === 0) && [box.x, box.y, box.width, box.height].every(finite)
        && !node.hasClippingMask && !enabled(node.fills).length && enabled(node.borders).length === 1
        && node.points?.length === 2 && node.points.every((point) => point.hasCurveFrom === false && point.hasCurveTo === false
          && finite(point.point?.x) && finite(point.point?.y))) {
        const border = enabled(node.borders)[0];
        const color = color_css(border.color, border.opacity);
        if (!supported_effect(border) || border.type !== 'color' || !color || border.thickness !== 1
          || !['center', '中心边框'].includes(border.position) || node.borderOptions?.dashPattern?.length
          || node.startMarkerType || node.endMarkerType) return false;
        const line = box.width === 0 ? { ...box, x: box.x - 0.5, width: 1 }
          : { ...box, y: box.y - 0.5, height: 1 };
        if (!contained(line, clip)) return false;
        records.push({ owners, box: rel(line), paint: { background: color } }); return true;
      }
      if (!contained(box, clip)) return false;
      if (node.type === 'text') { records.push({ owners, text: true, box: rel(box) }); return true; }
      if (node.type === 'layer-group') {
        if (node.hasClippingMask || enabled(node.fills).length || enabled(node.borders).length) return false;
        const entries = children(node);
        if (!entries.length) return !node.ddsImage?.imageUrl && !node.image?.imageUrl;
        const mask = entries[0]?.hasClippingMask ? entries[0] : null;
        if (mask) {
          const radii = Array.isArray(mask.radius) ? mask.radius : [mask.radius || 0];
          if (!clean(mask) || !is_rectangle(mask)
            || (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0)
            || !keys.every((key) => finite(mask.layerOriginFrame?.[key])
              && Math.abs(mask.layerOriginFrame[key] - box[key]) <= 1e-6)) return false;
          owners = [...owners, mask.id];
          if (!blank(mask) || !radii.every((r) => r === 0)) {
            records.push({ owners, text: true }); return true;
          }
        }
        const checkpoint = records.length;
        if (entries.filter((child) => child !== mask).every((child) => visit(child, owners, box))) return true;
        records.length = checkpoint;
        const asset = node.ddsImage || node.image;
        const exported = node.ddsOriginFrame;
        const scanned = new Set();
        const hasText = (current) => {
          if (scanned.has(current)) return true;
          scanned.add(current);
          return current.type === 'text' || children(current).some(hasText);
        };
        if (!asset?.imageUrl || sourceUrls.has(asset.imageUrl) || !finiteBox(exported) || exported.width > 32 || exported.height > 32
          || !contained(exported, clip) || hasText(node)) return false;
        records.push({ owners, box: rel(exported), paint: { backgroundImage: `url("${asset.imageUrl}")`,
          backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' } }); return true;
      }
      if (node.hasClippingMask || children(node).length) return false;
      if (node.type === 'shape' && (is_rectangle(node) || is_standard_ellipse(node))) {
        if (is_rectangle(node) && blank(node)) return true;
        const url = 'https://lanhu.invalid/css-paint';
        const candidate = { ...node, ddsImage: { imageUrl: url }, ddsOriginFrame: box };
        const paint = resolveVectorStyles(`url("${url}")`, { [url]: candidate });
        if (!paint || Object.keys(paint).some((key) => !['background', 'border', 'borderRadius', 'boxSizing'].includes(key))) return false;
        records.push({ owners, box: rel(box), paint }); return true;
      }
      const asset = node.ddsImage || node.image;
      const exported = node.ddsOriginFrame;
      if (node.type === 'shape' && asset?.imageUrl && !sourceUrls.has(asset.imageUrl) && finiteBox(exported)
        && exported.width <= 32 && exported.height <= 32 && contained(exported, clip)) {
        records.push({ owners, box: rel(exported), paint: { backgroundImage: `url("${asset.imageUrl}")`,
          backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' } }); return true;
      }
      // Axis-aligned zero-width/height divider frames are handled separately below.
      return false;
    };
    if (!nodes.every((node) => visit(node, [], frame)) || !records.some((record) => record.paint)) return null;
    return { frame, records };
  };

  const resolve_layer_paint_group = (group, childrenByParent) => {
    if (group.type !== 'layer-group' || !group.ddsImage?.imageUrl) return null;
    const children = [...new Set([...(group.layers || []), ...(childrenByParent.get(group.id) || [])])]
      .filter((node) => node.isVisible !== false);
    if (children.length < 2) return null;
    const paint = compile_layer_paint(group.layerOriginFrame, [group], childrenByParent);
    if (!paint || paint.records.some((record) => record.text)) return null;
    const exported = group.ddsOriginFrame;
    const frame = group.layerOriginFrame;
    const roundedOrigin = (key) => Math.abs(exported[key] - Math.floor(frame[key] + 1e-6)) <= 1e-6
      || Math.abs(exported[key] - Math.round(frame[key])) <= 1e-6;
    if (!exported || !['x', 'y'].every(roundedOrigin)
      || Math.abs(exported.width - (Math.ceil(frame.x + frame.width) - exported.x)) > 1e-6
      || Math.abs(exported.height - (Math.ceil(frame.y + frame.height) - exported.y)) > 1e-6) return null;
    return { ...group, cssLayerPaint: paint };
  };

  const resolve_mask_paint = (mask, childrenByParent) => {
    if (!mask.id || !mask.parentID || !mask.hasClippingMask || !is_rectangle(mask)
      || mask.rotation || mask.isFlippedHorizontal || mask.isFlippedVertical || mask.blur?.isEnabled
      || (mask.opacity !== undefined && mask.opacity !== 100) || (mask.blendMode !== undefined && mask.blendMode !== 0)
      || mask.shouldBreakMaskChain || (mask.clippingMaskMode !== undefined && mask.clippingMaskMode !== 0)
      || ['fills', 'borders', 'shadow'].some((key) => mask[key] !== undefined && !Array.isArray(mask[key]))
      || enabled(mask.shadow).length) return null;
    const siblings = childrenByParent.get(mask.parentID) || [];
    const start = siblings.indexOf(mask);
    const chain = [];
    for (const sibling of siblings.slice(start + 1)) {
      if (sibling.hasClippingMask || sibling.shouldBreakMaskChain) break;
      if (sibling.isVisible !== false) chain.push(sibling);
    }
    if (!chain.length) return null;
    let paint = compile_layer_paint(mask.layerOriginFrame, chain, childrenByParent);
    if (!paint && enabled(mask.fills).length === 1 && enabled(mask.fills)[0]?.type === 'gradient'
      && chain.length > 0 && chain.length <= 4) {
      const frame = mask.layerOriginFrame;
      const records = [];
      for (const bitmap of chain) {
        const box = bitmap.ddsOriginFrame;
        if (bitmap.type !== 'bitmap' || bitmap.hasClippingMask || bitmap.shouldBreakMaskChain
          || bitmap.blur?.isEnabled || (bitmap.opacity !== undefined
            && (!finite(bitmap.opacity) || bitmap.opacity < 0 || bitmap.opacity > 100))
          || (bitmap.blendMode !== undefined && bitmap.blendMode !== 0)
          || ['fills', 'borders', 'shadow'].some((key) => bitmap[key] !== undefined
            && (!Array.isArray(bitmap[key]) || enabled(bitmap[key]).length))
          || (bitmap.layers !== undefined && (!Array.isArray(bitmap.layers) || bitmap.layers.length))
          || !bitmap.ddsImage?.imageUrl || !box || !frame
          || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(box[key]))
          || box.width <= 0 || box.height <= 0 || box.x < frame.x || box.y < frame.y
          || box.x + box.width > frame.x + frame.width || box.y + box.height > frame.y + frame.height) return null;
        records.push({ owners: [bitmap.id], maskClipped: true,
          box: { x: box.x - frame.x, y: box.y - frame.y, width: box.width, height: box.height },
          paint: { backgroundImage: `url("${bitmap.ddsImage.imageUrl}")`,
            backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' } });
      }
      paint = { frame, records };
    }
    if (!paint) return null;
    const radii = Array.isArray(mask.radius) ? mask.radius : [mask.radius || 0];
    if (!radii.length || radii.length > 4 || !radii.every((r) => finite(r) && r >= 0)) return null;
    const corner = Math.max(...radii);
    if (corner > 0 && paint.records.some((record) => {
      if (record.maskClipped) return false;
      const b = record.box;
      const size = mask.layerOriginFrame;
      // Full-bleed child paint also needs the mask's rounded clipping. Keep the
      // bitmap rather than emitting an unclipped square decoration.
      return !b || !(b.x >= corner && b.x + b.width <= size.width - corner
        || b.y >= corner && b.y + b.height <= size.height - corner);
    })) return null;
    if (enabled(mask.fills).length || enabled(mask.borders).length) {
      const url = 'https://lanhu.invalid/mask-paint';
      const base = { ...mask, hasClippingMask: false, ddsImage: { imageUrl: url }, ddsOriginFrame: mask.layerOriginFrame };
      const styles = resolveVectorStyles(`url("${url}")`, { [url]: base });
      if (!styles || Object.keys(styles).some((key) => !['background', 'border', 'borderRadius', 'boxSizing'].includes(key))) return null;
      paint.records.unshift({ owners: [mask.id], paint: styles,
        box: { x: 0, y: 0, width: mask.layerOriginFrame.width, height: mask.layerOriginFrame.height } });
    }
    return { layerId: mask.id, frame: mask.layerOriginFrame, layerPaint: paint };
  };

  const render_layer_paint = (data, style, children = [], remainder = '') => {
    const pixels = (value) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : NaN;
    if ((remainder && remainder !== '100% no-repeat') || (style.transform && style.transform !== 'none')
      || (style.filter && style.filter !== 'none') || (style.opacity !== undefined && Number(style.opacity) !== 1)
      || (style.border && style.border !== 'none') || (style.boxShadow && style.boxShadow !== 'none')
      || (style.backgroundSize !== undefined && style.backgroundSize !== '100% 100%')
      || (style.backgroundPosition !== undefined && !['0 0', '0px 0px', '0% 0%'].includes(style.backgroundPosition))
      || (style.backgroundRepeat !== undefined && style.backgroundRepeat !== 'no-repeat')
      || (style.objectFit !== undefined && style.objectFit !== 'fill')
      || (style.objectPosition !== undefined && style.objectPosition !== '50% 50%')
      || ['width', 'height'].some((key) => style[key] !== undefined
        && (!finite(pixels(style[key])) || Math.abs(pixels(style[key]) - Math.round(data.frame[key])) > 0.01))
      || Object.keys(style).some((key) => /^(?:padding|border(?:Top|Right|Bottom|Left|Width|Style))/.test(key)
        && ![undefined, 0, '0', '0px', 'none'].includes(style[key]))) return null;
    const ids = new Set();
    const visit = (node) => { if (node.layerId) ids.add(node.layerId); (node.children || []).forEach(visit); };
    children.forEach(visit);
    if (data.records.some((record) => record.text && !record.owners.some((id) => ids.has(id)))) return null;
    const number = (value) => Math.round(value * 1e6) / 1e6;
    return { position: ['relative', 'absolute', 'fixed', 'sticky'].includes(style.position) ? style.position : 'relative',
      isolation: 'isolate', decorationNodes: data.records.filter((record) => record.paint
        && !record.owners.some((id) => ids.has(id))).map(({ box, paint }) => ({ position: 'absolute',
        left: number(box.x), top: number(box.y), width: box.width, height: box.height,
        zIndex: -1, pointerEvents: 'none', ...paint })) };
  };

  const resolveMergedStyles = (value, index, layerId, originalStyle = {}, children = []) => {
    if (typeof value !== 'string' || !index || !layerId) return null;
    const urls = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)];
    if (urls.length !== 1
      || !/\/merge_image\/imgs\/[^/?#]+_mergeImage\.png(?:[?#]|$)/.test(urls[0][2])) return null;
    const merged = index[`merge:${layerId}`];
    const remainder = value.replace(urls[0][0], '').trim();
    // Loop-bound Lanhu card backgrounds use a shorthand, not a bare image URL.
    // Full-box positioning is harmless only for the responsive panel rules.
    if (remainder && (!(merged?.responsive || merged?.layerPaint) || !/^(?:100%|0(?:px)?(?:\s+0(?:px)?)?|center)\s+no-repeat$/.test(remainder))) return null;
    if (!merged || (originalStyle.transform && originalStyle.transform !== 'none')
      || (originalStyle.filter && originalStyle.filter !== 'none')
      || (originalStyle.opacity !== undefined && Number(originalStyle.opacity) !== 1)) return null;
    if (merged.layerPaint) return render_layer_paint(merged.layerPaint, originalStyle, children, remainder);
    if (merged.requiredLayerIds) {
      const ids = new Set();
      const visit = (node) => {
        if (node?.layerId) ids.add(node.layerId);
        (node?.children || []).forEach(visit);
      };
      children.forEach(visit);
      if (!merged.requiredLayerIds.every((id) => ids.has(id))
        || merged.excludedLayerIds.some((id) => ids.has(id))) return null;
    }
    if (merged.textLayerIds) {
      const textIds = new Set();
      const visit = (node) => {
        if (node?.type === 'lanhutext') textIds.add(node.layerId);
        if (Array.isArray(node?.children)) node.children.forEach(visit);
      };
      children.forEach(visit);
      if (!merged.textLayerIds.every((id) => textIds.has(id))) return null;
    }
    const pixels = (value) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : NaN;
    if (merged.responsive) {
      if (originalStyle.backgroundSize !== undefined && originalStyle.backgroundSize !== '100% 100%') return null;
      if ((originalStyle.border && originalStyle.border !== 'none')
        || (originalStyle.boxShadow && originalStyle.boxShadow !== 'none')
        || ['width', 'height'].some((key) => originalStyle[key] !== undefined
          && originalStyle[key] !== 'auto' && originalStyle[key] !== '100%'
          && (!finite(pixels(originalStyle[key])) || pixels(originalStyle[key]) <= 0))) return null;
    } else {
      // A crop whose paint starts at the box origin may size to the painted crop.
      const sizes = [merged.frame];
      if (merged.styles.backgroundPosition === '0px 0px' && typeof merged.styles.backgroundSize === 'string') {
        const [sizeWidth, sizeHeight] = merged.styles.backgroundSize.split(' ').map(pixels);
        if (finite(sizeWidth) && finite(sizeHeight)) sizes.push({ width: sizeWidth, height: sizeHeight });
      }
      if (!sizes.some((box) => ['width', 'height'].every((key) => finite(pixels(originalStyle[key]))
        && Math.abs(pixels(originalStyle[key]) - box[key]) <= 1e-6))) return null;
    }
    return { ...merged.styles };
  };

  // Parse only the static SVG subset used by exported card decorations. Keep source ranges so
  // removing the plate does not reserialize filters, paths or their floating-point coordinates.
  const parse_card_svg = (source) => {
    const allowed = new Set(['svg', 'title', 'defs', 'linearGradient', 'stop', 'path', 'rect', 'polygon',
      'filter', 'feGaussianBlur', 'feOffset', 'feComposite', 'feColorMatrix', 'feMorphology', 'g', 'mask', 'use']);
    if (source.length > 30000 || /<!|&/.test(source)) return null;
    const nodes = [];
    const stack = [];
    const ids = new Map();
    let root;
    let cursor = 0;
    for (const match of source.matchAll(/<[^>]*>|[^<]+/g)) {
      if (match.index !== cursor) return null;
      const token = match[0];
      cursor += token.length;
      if (/^<\?xml\s[^?]*\?>$/.test(token) && match.index === 0) continue;
      if (!token.startsWith('<')) {
        if (token.trim() && stack.at(-1)?.tag !== 'title') return null;
        continue;
      }
      const closing = token.match(/^<\/([\w:-]+)\s*>$/);
      if (closing) {
        const node = stack.pop();
        if (!node || node.tag !== closing[1]) return null;
        node.end = match.index + token.length;
        continue;
      }
      const opening = token.match(/^<([\w:-]+)([\s\S]*?)(\/?)>$/);
      if (!opening || !allowed.has(opening[1])) return null;
      const attributes = Object.create(null);
      let rest = opening[2];
      while (rest.trim()) {
        const attr = rest.match(/^\s+([\w:-]+)\s*=\s*(["'])([^<>]*?)\2/);
        if (!attr || Object.hasOwn(attributes, attr[1]) || /^(?:on\w+|style|xml:base)$/i.test(attr[1])) return null;
        attributes[attr[1]] = attr[3];
        rest = rest.slice(attr[0].length);
      }
      const node = { tag: opening[1], attributes, children: [], parent: stack.at(-1), start: match.index,
        end: opening[3] ? match.index + token.length : null };
      if (stack.length) stack.at(-1).children.push(node);
      else if (root) return null;
      else root = node;
      if (attributes.id !== undefined) {
        if (!attributes.id || ids.has(attributes.id)) return null;
        ids.set(attributes.id, node);
      }
      nodes.push(node);
      if (!opening[3]) stack.push(node);
    }
    if (cursor !== source.length || stack.length || root?.tag !== 'svg'
      || root.attributes.xmlns !== 'http://www.w3.org/2000/svg'
      || (root.attributes['xmlns:xlink'] !== undefined && root.attributes['xmlns:xlink'] !== 'http://www.w3.org/1999/xlink')
      || ['transform', 'filter', 'opacity', 'mask', 'clip-path'].some((key) => root.attributes[key] !== undefined)
      || nodes.some((node) => node !== root && (node.tag === 'svg'
        || Object.keys(node.attributes).some((key) => key === 'xmlns' || key.startsWith('xmlns:'))))) return null;
    for (const node of nodes) {
      for (const [key, value] of Object.entries(node.attributes)) {
        if (key === 'href' || key === 'xlink:href') {
          if (!value.startsWith('#') || !ids.has(value.slice(1))) return null;
        }
        if (/url\s*\(/i.test(value)) {
          const reference = value.match(/^url\(\s*(["']?)#([^\s"'()]+)\1\s*\)$/);
          if (!reference || !ids.has(reference[2])) return null;
        }
      }
    }
    return { root, nodes, ids };
  };

  const verify_in_parallel = async (layers, concurrency, verify) => {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, layers.length) }, async () => {
      while (cursor < layers.length) await verify(layers[cursor++]);
    }));
  };

  const create_asset_loader = (fetchImpl, timeoutMs) => {
    const requests = new Map();
    return (url, kind) => {
      const key = `${kind}:${url}`;
      if (!requests.has(key)) {
        requests.set(key, (async () => {
          const controller = new AbortController();
          let timer;
          try {
            return await Promise.race([
              (async () => {
                const response = await fetchImpl(url, { credentials: 'omit', signal: controller.signal });
                return response.ok ? await response[kind]() : null;
              })(),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error('Vector asset verification timed out'));
                }, timeoutMs);
              })
            ]);
          } finally {
            clearTimeout(timer);
          }
        })());
      }
      return requests.get(key);
    };
  };

  const card_path_matches = (path, width, height, radius, inset) => {
    const tokens = (value) => typeof value === 'string'
      && !value.replace(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi, '').replace(/[\s,]/g, '')
      ? value.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) : null;
    const actual = tokens(path);
    if (!actual || radius < inset) return false;
    const r = radius - inset;
    const centers = [[width - radius, radius], [width - radius, height - radius],
      [radius, height - radius], [radius, radius]];
    for (const segments of [1, 2]) {
      const expected = ['M', width - radius, inset];
      for (let corner = 0; corner < 4; corner++) {
        const [x, y] = centers[corner];
        const start = (corner - 1) * Math.PI / 2;
        if (corner) expected.push('L', x + r * Math.cos(start), y + r * Math.sin(start));
        const end = start + Math.PI / 2;
        const k = 4 / 3 * Math.tan(Math.PI / 8);
        const points = [[x + r * Math.cos(start), y + r * Math.sin(start)],
          [x + r * (Math.cos(start) - k * Math.sin(start)), y + r * (Math.sin(start) + k * Math.cos(start))],
          [x + r * (Math.cos(end) + k * Math.sin(end)), y + r * (Math.sin(end) - k * Math.cos(end))],
          [x + r * Math.cos(end), y + r * Math.sin(end)]];
        if (segments === 1) expected.push('C', ...points.slice(1).flat());
        else {
          // Sketch splits a quarter-circle cubic at t=0.5; it does not fit two new arcs.
          const middle = (a, b) => a.map((value, i) => (value + b[i]) / 2);
          const a = middle(points[0], points[1]);
          const b = middle(points[1], points[2]);
          const c = middle(points[2], points[3]);
          const d = middle(a, b);
          const e = middle(b, c);
          const center = middle(d, e);
          expected.push('C', ...a, ...d, ...center, 'C', ...e, ...c, ...points[3]);
        }
      }
      expected.push('Z');
      if (actual.length === expected.length && actual.every((value, i) => typeof expected[i] === 'string'
        ? value === expected[i] : finite(Number(value)) && Math.abs(Number(value) - expected[i]) <= 1e-5)) return true;
    }
    return false;
  };

  const svg_color_css = (value, opacity = 1) => {
    if (typeof value !== 'string' || !finite(opacity) || opacity < 0 || opacity > 1) return null;
    const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
    if (hex) {
      const code = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
      return color_css({ r: parseInt(code.slice(0, 2), 16), g: parseInt(code.slice(2, 4), 16),
        b: parseInt(code.slice(4, 6), 16), a: 1 }, opacity);
    }
    const rgb = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    return rgb ? color_css({ r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]) }, opacity) : null;
  };

  const verifyGradientCardGroups = async (index, loadAsset, concurrency) => {
    if (!index || typeof loadAsset !== 'function') return index;
    await verify_in_parallel([...new Set(Object.values(index))].filter((layer) => layer?.gradientCard), concurrency, async (layer) => {
      if (!layer?.gradientCard) return;
      try {
        let svg = await loadAsset(layer.gradientCard.svgUrl, 'text');
        if (svg === null) return;
        const parsed = parse_card_svg(svg);
        if (!parsed) return;
        const { root, nodes, ids } = parsed;
        const card = layer.gradientCard;
        const numbers = (value) => typeof value === 'string' ? value.trim().split(/[\s,]+/).map(Number) : [];
        const viewBox = numbers(root.attributes.viewBox);
        if (viewBox.length !== 4 || viewBox.some((value, i) => !finite(value)
          || Math.abs(value - [0, 0, card.width, card.height][i]) > 1e-6)
          || ['width', 'height'].some((key) => root.attributes[key] !== undefined
            && (!/^\d+(?:\.\d+)?(?:px)?$/.test(root.attributes[key])
              || Math.abs(Number(root.attributes[key].replace(/px$/, '')) - card[key]) > 1e-6))) return;
        const reference = (value) => typeof value === 'string'
          ? value.match(/^url\(\s*(["']?)#([^\s"'()]+)\1\s*\)$/)?.[2] : undefined;
        if (!nodes.some((node) => node.tag === 'g' && ids.get(reference(node.attributes.mask))?.tag === 'mask')) return;
        const plates = nodes.filter((node) => ['path', 'rect'].includes(node.tag)
          && ids.get(reference(node.attributes.fill))?.tag === 'linearGradient'
          && svg_color_css(node.attributes.stroke) === card.borderColor
          && Number(node.attributes['stroke-width']) === card.thickness);
        if (plates.length !== 1) return;
        const plate = plates[0];
        // The removed plate becomes CSS outside its original SVG ancestors. Only neutral
        // effects and translations that cancel out may be discarded without changing paint.
        let x = 0;
        let y = 0;
        let safeAncestors = true;
        for (let ancestor = plate.parent; ancestor; ancestor = ancestor.parent) {
          const attrs = ancestor.attributes;
          if (ancestor !== root && (ancestor.tag !== 'g' || Object.keys(attrs).some((key) =>
            !['id', 'transform', 'fill', 'stroke', 'stroke-width', 'fill-rule', 'opacity',
              'fill-opacity', 'stroke-opacity', 'filter', 'mask', 'clip-path', 'display', 'visibility'].includes(key)))) {
            safeAncestors = false;
            break;
          }
          if (['opacity', 'fill-opacity', 'stroke-opacity'].some((key) => attrs[key] !== undefined && Number(attrs[key]) !== 1)
            || ['filter', 'mask', 'clip-path'].some((key) => attrs[key] !== undefined && attrs[key] !== 'none')
            || (attrs.display !== undefined && attrs.display !== 'inline')
            || (attrs.visibility !== undefined && attrs.visibility !== 'visible')) {
            safeAncestors = false;
            break;
          }
          const transform = attrs.transform || '';
          const translations = [...transform.matchAll(/translate\(\s*([^()]+)\s*\)/g)];
          if (transform.replace(/translate\(\s*([^()]+)\s*\)/g, '').trim()) {
            safeAncestors = false;
            break;
          }
          for (const translation of translations) {
            const offset = numbers(translation[1]);
            if (offset.length < 1 || offset.length > 2 || !offset.every(finite)) {
              safeAncestors = false;
              break;
            }
            x += offset[0];
            y += offset[1] ?? 0;
          }
        }
        if (!safeAncestors || Math.abs(x) > 1e-6 || Math.abs(y) > 1e-6) return;
        const gradient = ids.get(reference(plate.attributes.fill));
        let safeGradient = true;
        for (let ancestor = gradient.parent; ancestor; ancestor = ancestor.parent) {
          const attrs = ancestor.attributes;
          if ((attrs['stop-opacity'] !== undefined && Number(attrs['stop-opacity']) !== 1)
            || (attrs['color-interpolation'] !== undefined && attrs['color-interpolation'] !== 'sRGB')) {
            safeGradient = false;
            break;
          }
        }
        if (!safeGradient) return;
        const percent = (value) => typeof value === 'string' && value.endsWith('%')
          ? Number(value.slice(0, -1)) / 100 : Number(value);
        if (Object.keys(gradient.attributes).some((key) =>
          !['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'spreadMethod'].includes(key))
          || (gradient.attributes.gradientUnits !== undefined && gradient.attributes.gradientUnits !== 'objectBoundingBox')
          || (gradient.attributes.spreadMethod !== undefined && gradient.attributes.spreadMethod !== 'pad')
          || ['x1', 'y1', 'x2', 'y2'].some((key, i) => !finite(percent(gradient.attributes[key]))
            || Math.abs(percent(gradient.attributes[key]) - [card.gradient.from.x, card.gradient.from.y,
              card.gradient.to.x, card.gradient.to.y][i]) > 1e-6)
          || gradient.children.length !== card.gradient.colorStops.length
          || gradient.children.some((stop, i) => stop.tag !== 'stop'
            || !finite(percent(stop.attributes.offset))
            || Math.abs(percent(stop.attributes.offset) - card.gradient.colorStops[i].position) > 1e-6
            || svg_color_css(stop.attributes['stop-color'], stop.attributes['stop-opacity'] === undefined
              ? 1 : Number(stop.attributes['stop-opacity'])) !== color_css(card.gradient.colorStops[i].color)
            || Object.keys(stop.attributes).some((key) => !['offset', 'stop-color', 'stop-opacity'].includes(key)))) return;
        const half = card.thickness / 2;
        const attrs = plate.attributes;
        if (plate.children.length || Object.keys(attrs).some((key) =>
          !['id', 'd', 'x', 'y', 'width', 'height', 'rx', 'ry', 'stroke', 'stroke-width', 'fill'].includes(key))) return;
        if (plate.tag === 'path') {
          if (!card_path_matches(attrs.d, card.width, card.height, card.radius, half)) return;
        } else {
          const geometry = { x: half, y: half, width: card.width - card.thickness,
            height: card.height - card.thickness, rx: Math.max(0, card.radius - half), ry: Math.max(0, card.radius - half) };
          if (Object.entries(geometry).some(([key, expected]) => {
            const value = attrs[key] ?? (['rx', 'ry'].includes(key) ? (attrs[key === 'rx' ? 'ry' : 'rx'] ?? 0) : undefined);
            return !finite(Number(value)) || Math.abs(Number(value) - expected) > 1e-6;
          })) return;
        }
        if (plate.attributes.id && nodes.some((node) => Object.values(node.attributes).some((value) =>
          value === `#${plate.attributes.id}` || reference(value) === plate.attributes.id))) return;
        svg = svg.slice(0, plate.start) + svg.slice(plate.end);
        const encoded = encodeURIComponent(svg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        // SVG objectBoundingBox coordinates use the stroked plate's centerline bounds.
        // Project them onto the CSS border box while retaining the full decoration SVG.
        const project = (point) => ({
          x: (half + (card.width - card.thickness) * point.x) / card.width,
          y: (half + (card.height - card.thickness) * point.y) / card.height
        });
        let from = project(card.gradient.from);
        let to = project(card.gradient.to);
        let colorStops = card.gradient.colorStops;
        if (from.x === to.x && from.y > to.y) {
          [from, to] = [to, from];
          colorStops = colorStops.slice().reverse().map((stop) => ({ ...stop, position: 1 - stop.position }));
        }
        const background = fill_css({ type: 'gradient', gradient: { type: 'linear', from, to, colorStops } },
          { width: card.width, height: card.height });
        if (!background) return;
        layer.gradientCardStyles = {
          backgroundImage: `url("data:image/svg+xml,${encoded}"), ${background}`,
          backgroundPosition: '0 0, 0 0', backgroundSize: '100% 100%, 100% 100%',
          backgroundRepeat: 'no-repeat', borderRadius: `${card.radius}px`,
          boxShadow: `inset 0 0 0 ${card.thickness}px ${card.borderColor}`
        };
      } catch (error) {
        // A failed or unrecognized SVG must leave the original bitmap untouched.
      }
    });
    return index;
  };

  const verifySolidShapeGroups = async (index, fetchImpl = globalScope.fetch, options = {}) => {
    if (!index || typeof fetchImpl !== 'function') return index;
    const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0
      ? Math.min(options.concurrency, 8) : 4;
    const timeoutMs = finite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
    const loadAsset = create_asset_loader(fetchImpl, timeoutMs);
    await verifyGradientCardGroups(index, loadAsset, concurrency);
    if (!index || !globalScope.createImageBitmap || !globalScope.OffscreenCanvas) return index;
    const aliases = new Map();
    const claim = (layer, keys) => {
      if (!aliases.has(layer)) aliases.set(layer, []);
      aliases.get(layer).push(...keys);
    };
    for (const [key, layer] of Object.entries(index)) {
      if (!layer) continue;
      const opaqueFlat = layer.ddsType === 'rectangle' && enabled(layer.fills).length === 1
        && enabled(layer.fills)[0]?.type === 'color' && enabled(layer.fills)[0].color?.a === 1
        && (enabled(layer.fills)[0].opacity ?? 1) === 1 && !enabled(layer.borders).length
        && !enabled(layer.shadow).length && !layer.hasClippingMask && !layer.blur?.isEnabled
        && ['x', 'y', 'width', 'height'].every((key) => finite(layer.layerOriginFrame?.[key])
          && finite(layer.ddsOriginFrame?.[key])
          && Math.abs(layer.layerOriginFrame[key] - layer.ddsOriginFrame[key]) <= 1e-6);
      if (!(layer.ddsType === 'shape-group' || opaqueFlat || layer.type === 'shape'
        && ['fills', 'borders', 'shadow'].every((key) => layer[key] === undefined
          || Array.isArray(layer[key]) && enabled(layer[key]).length === 0))) continue;
      claim(layer, [key]);
    }
    // Conflicted aliases keep their layers for pixel arbitration.
    for (const layers of (index[CONFLICTS] || new Map()).values()) {
      for (const layer of layers) {
        if (!layer || !layer.ddsImage?.imageUrl) continue;
        claim(layer, url_keys(layer.ddsImage.imageUrl));
      }
    }
    await verify_in_parallel([...aliases.keys()], concurrency, async (layer) => {
      const fills = enabled(layer.fills);
      const transparent = ['fills', 'borders', 'shadow'].every((key) => enabled(layer[key]).length === 0);
      // This proof compares opaque pixels. A translucent candidate would emit
      // different alpha even when its fill RGB matches the shared bitmap.
      if (!transparent && ((layer.opacity !== undefined && layer.opacity !== 100)
        || fills.length !== 1 || fills[0]?.type !== 'color' || fills[0].color?.a !== 1
        || (fills[0].opacity !== undefined && fills[0].opacity !== 1))) return;
      const url = layer.ddsImage?.imageUrl;
      const candidate = transparent ? { ...layer, verifiedTransparentBitmap: true } : { ...layer, ddsType: 'rectangle' };
      const styles = transparent ? {} : resolveVectorStyles(`url("${url}")`, { [url]: candidate });
      if (!url || !styles || !transparent && (Object.keys(styles).length !== 1 || !styles.background?.startsWith('rgba('))) return;
      let bitmap;
      try {
        const blob = await loadAsset(url, 'blob');
        if (blob === null) return;
        bitmap = await globalScope.createImageBitmap(blob);
        if (bitmap.width !== layer.ddsOriginFrame?.width || bitmap.height !== layer.ddsOriginFrame?.height) return;
        const canvas = new globalScope.OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const color = fills[0]?.color;
        let uniform = true;
        for (let i = 0; i < pixels.length; i += 4) {
          if (transparent ? pixels[i + 3] !== 0
            : pixels[i] !== color.r || pixels[i + 1] !== color.g || pixels[i + 2] !== color.b || pixels[i + 3] !== 255) {
            uniform = false;
            break;
          }
        }
        if (uniform && pixels.length > 0) {
          // The pixels are the shared truth for every alias of this url, including
          // aliases nulled by a paint conflict between layers sharing the export.
          for (const key of new Set([...aliases.get(layer), ...url_keys(url)])) {
            if (index[key] === layer || index[key] === null) index[key] = candidate;
          }
        }
      } catch (error) {
        // Keep the bitmap if it cannot be read or proven to be a uniform opaque rectangle.
      } finally {
        bitmap?.close();
      }
    });
    return index;
  };

  const resolve_line = (layer, style) => {
    if (layer.ddsType !== undefined || ![-1, 0].includes(layer.booleanOperation) || !Array.isArray(layer.points) || layer.points.length !== 2
      || layer.hasClippingMask || layer.isFlippedHorizontal || layer.isFlippedVertical
      || (layer.rotation !== undefined && (!finite(layer.rotation) || Math.abs(layer.rotation) > 0.00001))
      || (layer.opacity !== undefined && (!finite(layer.opacity) || layer.opacity < 0 || layer.opacity > 100))
      || (layer.blendMode !== undefined && layer.blendMode !== 0)
      || layer.blur?.isEnabled || layer.shouldBreakMaskChain
      || (layer.layers !== undefined && (!Array.isArray(layer.layers) || layer.layers.length))
      || ['fills', 'shadow'].some((key) => layer[key] !== undefined && (!Array.isArray(layer[key]) || enabled(layer[key]).length))
      || !Array.isArray(layer.borders) || enabled(layer.borders).length !== 1
      || (style.transform && style.transform !== 'none') || (style.filter && style.filter !== 'none')
      || (style.opacity !== undefined && Number(style.opacity) !== 1)
      || layer.borderOptions?.dashPattern?.length || layer.borderOptions?.lineCapStyle
      || layer.startMarkerType || layer.endMarkerType) return null;
    const sourceBorder = enabled(layer.borders)[0];
    const border = sourceBorder && { ...sourceBorder,
      opacity: (sourceBorder.opacity ?? 1) * (layer.opacity ?? 100) / 100 };
    const color = color_css(border?.color, border?.opacity);
    if (!supported_effect(sourceBorder) || !supported_effect(border) || border.type !== 'color' || !color || !['center', '中心边框'].includes(border.position)
      || !finite(border.thickness) || border.thickness <= 0) return null;
    const frame = layer.layerOriginFrame;
    const exported = layer.ddsOriginFrame;
    if (!frame || !exported || ['x', 'y', 'width', 'height'].some((key) => !finite(frame[key]) || !finite(exported[key]))
      || frame.width <= 0 || frame.height <= 0 || exported.width <= 0 || exported.height <= 0) return null;
    const pixels = (v) => typeof v === 'number' ? v : typeof v === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(v) ? Number(v.replace(/px$/, '')) : NaN;
    const width = style.width === undefined ? exported.width : pixels(style.width);
    const height = style.height === undefined ? exported.height : pixels(style.height);
    if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
    const points = layer.points.map((v) => {
      if (!v || v.hasCurveFrom !== false || v.hasCurveTo !== false || (v.cornerRadius !== undefined && v.cornerRadius !== 0)
        || ![v.point?.x, v.point?.y].every(finite)) return null;
      return { x: frame.x + v.point.x * frame.width - exported.x, y: frame.y + v.point.y * frame.height - exported.y };
    });
    if (points.some((p) => !p || p.x < -0.01 || p.y < -0.01 || p.x > exported.width + 0.01 || p.y > exported.height + 0.01)) return null;
    const [a, b] = points;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return null;
    // Only nearly full-span, thin dividers: no arbitrary short paths or thick icon strokes.
    const horizontal = Math.abs(dx) >= exported.width - 0.51 && Math.abs(dy) <= 1 && exported.height <= 4;
    const vertical = Math.abs(dy) >= exported.height - 0.51 && Math.abs(dx) <= 1 && exported.width <= 4;
    if ((!horizontal && !vertical) || border.thickness > 1) return null;
    // Independent union-tagged axis lines use the actual CSS box as the paint box.
    // Ignore raster half-pixel coverage and minor export color differences.
    if (layer.booleanOperation === 0) {
      // A flat CSS fill would extend a cropped union line to the full layout box.
      if ((horizontal ? frame.width - exported.width : frame.height - exported.height) > 0.01
        || Math.abs(horizontal ? dy : dx) > 1e-6 || layer.blur?.isEnabled) return null;
      return { background: color };
    }
    const upright = !horizontal && vertical;
    const across = upright ? exported.width : exported.height;
    const span = upright ? exported.height : exported.width;
    const startAlong = upright ? a.y : a.x;
    const endAlong = upright ? b.y : b.x;
    const centerAcross = upright ? a.x : a.y;
    // Axis-aligned exports contain column/row coverage, not a fully opaque 2px stroke.
    if (Math.abs(upright ? dx : dy) < 1e-6 && Math.abs(Math.min(startAlong, endAlong)) < 0.01
      && Math.abs(Math.max(startAlong, endAlong) - span) < 0.01 && Number.isInteger(across)) {
      const colors = Array.from({ length: across }, (_, row) => {
        const coverage = Math.max(0, Math.min(row + 1, centerAcross + border.thickness / 2)
          - Math.max(row, centerAcross - border.thickness / 2));
        const alpha = Math.round(border.color.a * (border.opacity ?? 1) * coverage * 255) / 255;
        return color_css({ ...border.color, a: alpha });
      });
      // A mask may crop the export across the stroke. Only the rows/columns inside
      // the CSS box may paint it; subpixel stroke padding still uses the full export.
      const boxAcross = upright ? width : height;
      const startRaw = boxAcross === across ? 0
        : (upright ? frame.x : frame.y) - (upright ? exported.x : exported.y);
      const start = Math.abs(startRaw - Math.round(startRaw)) <= 0.01 ? Math.round(startRaw) : startRaw;
      if (!Number.isInteger(boxAcross) || boxAcross < 1 || !Number.isInteger(start) || start < 0
        || start + boxAcross > across) return null;
      const sliced = colors.slice(start, start + boxAcross);
      const paint = sliced.every((c) => c === sliced[0]) ? sliced[0]
        : `linear-gradient(${upright ? 90 : 180}deg, ${sliced.map((c, i) => `${c} ${i / sliced.length * 100}%, ${c} ${(i + 1) / sliced.length * 100}%`).join(', ')})`;
      const alongBox = upright ? height : width;
      const alongExport = upright ? exported.height : exported.width;
      // A crop along the stroke keeps the visible length exact instead of stretching it.
      if (alongBox !== alongExport) {
        return { backgroundImage: paint.startsWith('linear-gradient(') ? paint : `linear-gradient(${paint}, ${paint})`,
          backgroundPosition: '0 0', backgroundRepeat: 'no-repeat',
          backgroundSize: upright ? `100% ${alongExport}px` : `${alongExport}px 100%` };
      }
      return { background: paint };
    }
    // A stroke cropped along its own axis is only reproducible from export rows;
    // stretching it back to the uncropped length would invent paint.
    if ((upright ? frame.height - exported.height : frame.width - exported.width) > 0.01) return null;
    const sx = width / exported.width;
    const sy = height / exported.height;
    const normalLength = Math.hypot(-dy / distance / sx, dx / distance / sy);
    const nx = -dy / distance / sx / normalLength;
    const ny = dx / distance / sy / normalLength;
    const length = Math.abs(width * nx) + Math.abs(height * ny);
    const center = (a.x * sx - width / 2) * nx + (a.y * sy - height / 2) * ny + length / 2;
    const half = border.thickness / normalLength / 2;
    const antialias = 0.5 / normalLength;
    const peak = color_css(border.color, (border.opacity ?? 1) * border.thickness);
    const round = (v) => Math.round(v * 1e6) / 1e6;
    const start = round((center - half - antialias) / length * 100);
    const innerStart = round((center + half - antialias) / length * 100);
    const innerEnd = round((center - half + antialias) / length * 100);
    const end = round((center + half + antialias) / length * 100);
    const angle = round(Math.atan2(nx, -ny) * 180 / Math.PI);
    return { background: `linear-gradient(${angle}deg, transparent ${start}%, ${peak} ${innerStart}%, ${peak} ${innerEnd}%, transparent ${end}%)` };
  };

  // Flattened DDS groups can export an influence frame much larger than their
  // logical image box. Retain both frames only when identity and export size agree.
  const compile_padded_image = (layer) => {
    const frame = layer.layerOriginFrame;
    const paint = layer.ddsOriginFrame;
    const influence = { x: layer.influenceLeft, y: layer.influenceTop,
      width: layer.influenceWidth, height: layer.influenceHeight };
    if (layer.type !== 'layer-group' || layer.hasExportDDSImage !== true
      || !valid_page_box(frame) || !valid_page_box(paint) || !valid_page_box(influence)
      || layer.rotation || layer.isFlippedHorizontal || layer.isFlippedVertical
      || layer.hasClippingMask || layer.shouldBreakMaskChain || layer.isVisible === false
      || ![undefined, 100].includes(layer.opacity) || ![undefined, 0].includes(layer.blendMode)
      || layer.layers !== undefined && !Array.isArray(layer.layers)
      || !/^https:\/\//.test(layer.ddsImage?.imageUrl || '')
      || paint.width !== layer.ddsImage.size?.width || paint.height !== layer.ddsImage.size?.height
      || paint.x !== Math.floor(influence.x + 1e-6) || paint.y !== Math.floor(influence.y + 1e-6)
      || paint.x + paint.width !== Math.ceil(influence.x + influence.width - 1e-6)
      || paint.y + paint.height !== Math.ceil(influence.y + influence.height - 1e-6)
      || influence.x > frame.x || influence.y > frame.y
      || influence.x + influence.width < frame.x + frame.width - 1e-6
      || influence.y + influence.height < frame.y + frame.height - 1e-6
      || influence.width <= frame.width + 1 && influence.height <= frame.height + 1) return null;
    return { frame, paint, image: layer.ddsImage.imageUrl };
  };

  const resolvePaddedImage = (node, index, style, src, parentStyle) => {
    const entry = index?.[`image:${node.layerId}`];
    const pixels = (value) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value)
        ? Number(value.replace(/px$/, '')) : NaN;
    if (!entry || src !== entry.image || node.type !== 'lanhuimage'
      || node.loopType || node.condition || node.children?.length
      || Object.keys(node.styleObj || {}).length || Object.keys(node.props?.styleObj || {}).length
      || !['flex', 'inline-flex'].includes(parentStyle?.display)
      || /baseline/.test(parentStyle.alignItems || '') || /baseline/.test(style.alignSelf || '')
      || ![undefined, 'static', 'relative'].includes(style.position)
      || ![undefined, 'block'].includes(style.display)
      || ![undefined, 'fill'].includes(style.objectFit)
      || ![undefined, '50% 50%'].includes(style.objectPosition)
      || Object.keys(style).some((key) => /^(?:padding|border|background|transform|filter|backdropFilter|boxShadow|clip|mask|overflow)/.test(key)
        && key !== 'boxSizing' && ![undefined, 0, '0', '0px', 'none', 'transparent', 'visible'].includes(style[key]))
      || ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'flexBasis'].some((key) => style[key] !== undefined)
      || !['left', 'top', 'width', 'height'].every((key, i) =>
        node.rowDims?.[key] === Math.round(entry.frame[['x', 'y', 'width', 'height'][i]]))
      || !['width', 'height'].every((key) => pixels(style[key]) > 0
        && pixels(style[key]) === node.rowDims[key])) return null;
    const main = parentStyle.flexDirection?.startsWith('column') ? 'Height' : 'Width';
    // Preserve the replaced image's automatic flex minimum when it becomes a div.
    // Both source dimensions are fixed and bounded by the verified larger bitmap.
    return { style: { position: 'relative',
      [`min${main}`]: pixels(style[main.toLowerCase()]) }, decorationNodes: [{
      position: 'absolute', left: entry.paint.x - node.rowDims.left, top: entry.paint.y - node.rowDims.top,
      width: entry.paint.width, height: entry.paint.height, pointerEvents: 'none',
      background: `url(${JSON.stringify(src)}) 0 0 / 100% 100% no-repeat`
    }] };
  };

  const resolveImageStyles = (value, index, style = {}) => {
    if (!index || typeof value !== 'string'
      || style.background || style.backgroundImage
      || (style.backgroundColor && style.backgroundColor !== 'transparent')
      || (style.objectFit && style.objectFit !== 'fill')
      || (style.objectPosition && style.objectPosition !== '50% 50%')
      || (style.border && style.border !== 'none') || (style.boxShadow && style.boxShadow !== 'none')
      || style.borderRadius
      || Object.keys(style).some((key) => /^(?:border(?:Top|Right|Bottom|Left|Width|Style)|padding)/.test(key)
        && style[key] !== undefined && ![0, '0', '0px', 'none'].includes(style[key]))) return null;
    const match = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
    const layer = match && findLayer(index, match[2]);
    const frame = layer?.ddsOriginFrame;
    const pixels = (value) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value.trim()) ? Number(value.trim().replace(/px$/, '')) : NaN;
    if (!frame || layer.isClosed === false || ['width', 'height'].some((key) =>
      !finite(frame[key]) || frame[key] <= 0 || !finite(pixels(style[key]))
      || Math.abs(pixels(style[key]) - frame[key]) > 1e-6)) return null;
    const styles = resolveVectorStyles(value, index, style);
    return styles?.background && Object.keys(styles).every((key) => ['background', 'borderRadius'].includes(key))
      ? styles : null;
  };

  const resolveDividerStyles = (value, index, style = {}) => {
    if (!index || typeof value !== 'string') return null;
    const match = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
    const layer = match && findLayer(index, match[2]);
    if (!layer || !(layer.dividerGroup || layer.type === 'shape' && layer.isClosed === false)) return null;
    return resolveVectorStyles(value, index, style);
  };

  const valid_page_box = (box) => box && ['x', 'y', 'width', 'height'].every((key) => finite(box[key]))
    && box.width > 0 && box.height > 0;

  // Recover source paint, never fabricate a blank spacer from a bounds discrepancy.
  // Unknown effects or rich text reject the entire band rather than dropping content.
  const compile_page_band = (layer, band, childrenByParent, seen, parent = band) => {
    if (!layer?.id || seen.has(layer.id) || seen.size >= 128 || layer.rotation
      || layer.isFlippedHorizontal || layer.isFlippedVertical || layer.hasClippingMask
      || layer.shouldBreakMaskChain || layer.blur?.isEnabled
      || layer.opacity !== undefined && layer.opacity !== 100
      || layer.blendMode !== undefined && layer.blendMode !== 0
      || layer.layers !== undefined && !Array.isArray(layer.layers)) return null;
    seen.add(layer.id);
    const box = layer.layerOriginFrame;
    if (!valid_page_box(box) || box.x < band.x - 1e-6 || box.y < band.y - 1e-6
      || box.x + box.width > band.x + band.width + 1e-6
      || box.y + box.height > band.y + band.height + 1e-6) return null;
    const children = [...new Set([...(layer.layers || []), ...(childrenByParent.get(layer.id) || [])])]
      .filter((child) => child.isVisible !== false);
    const style = { position: 'absolute', left: box.x - parent.x, top: box.y - parent.y,
      width: box.width, height: box.height, boxSizing: 'border-box' };
    const bounds = { left: box.x, top: box.y, width: box.width, height: box.height };
    // Exported assets already include their paint; require an exact export frame.
    const url = layer.ddsImage?.imageUrl;
    if (typeof url === 'string' && /^https:\/\//i.test(url) && valid_page_box(layer.ddsOriginFrame)
      && ['x', 'y', 'width', 'height'].every((key) => Math.abs(box[key] - layer.ddsOriginFrame[key]) < 1e-6)) {
      return { id: '', type: 'image', style, bounds, src: url, children: [] };
    }
    if (['fills', 'borders', 'shadow'].some((key) => layer[key] !== undefined && !Array.isArray(layer[key]))
      || enabled(layer.borders).length || enabled(layer.shadow).length) return null;
    if (layer.type === 'text') {
      const font = layer.font;
      const run = font?.styles?.[0];
      const color = color_css(font?.color);
      if (children.length || !font || !Array.isArray(font.styles) || font.styles.length !== 1
        || run.content !== font.content || typeof font.content !== 'string'
        || font.content.includes('\n') || font.transform || font.verticalAlignment
        || run.transform !== undefined && Number(run.transform) !== 0
        || enabled(layer.fills).length !== 1 || !supported_effect(enabled(layer.fills)[0])
        || enabled(layer.fills)[0].type !== 'color'
        || color_css(enabled(layer.fills)[0].color, enabled(layer.fills)[0].opacity) !== color
        || !finite(font.size) || font.size <= 0
        || !finite(font.line) || font.line <= 0 || !color || typeof font.font !== 'string'
        || !['left', 'center', 'right'].includes(font.align)
        || !finite(run.fontWeight) || Number(run.size) !== font.size || run.font !== font.font
        || !['0', 0, undefined].includes(run.underline) || !['0', 0, undefined].includes(run.strikethrough)) return null;
      return { id: '', type: 'text', bounds, text: font.content, children: [], style: { ...style,
        fontFamily: font.font, fontSize: font.size, fontWeight: run.fontWeight, lineHeight: font.line,
        color, textAlign: font.align, whiteSpace: 'pre', ...(finite(font.spacing) ? { letterSpacing: font.spacing } : {}) } };
    }
    if (layer.type !== 'layer-group' || enabled(layer.fills).length || !children.length) return null;
    const recovered = children.map((child) => compile_page_band(child, band, childrenByParent, seen, box));
    return recovered.every(Boolean) ? { id: '', type: 'block', style, bounds, children: recovered } : null;
  };

  const resolvePageBand = (page, index) => {
    const entry = index?.[`page:${page.layerId}`];
    const style = page.style;
    const pixels = (value) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : NaN;
    if (page.type !== 'page' || !entry || entry.candidates.length !== 1 || !page.bounds
      || style.display !== 'flex' || style.flexDirection !== 'column' || page.loopExpandedFrom || page.loopTemplate
      || ![undefined, 'normal', 'start', 'flex-start'].includes(style.justifyContent)
      || Object.keys(style).some((key) => /^(?:padding(?:Top|Left|Right)?|gap|rowGap|columnGap|transform|direction|writingMode|flexWrap)$|^border/.test(key)
        && style[key] !== undefined && ![0, '0', '0px', 'none'].includes(style[key]))
      || pixels(style.width) !== entry.frame.width || pixels(style.height) !== entry.frame.height
      || page.bounds.left !== entry.frame.x || page.bounds.top !== entry.frame.y
      || page.bounds.width !== entry.frame.width || page.bounds.height !== entry.frame.height) return null;
    const candidate = entry.candidates[0];
    if (!candidate.node) return null;
    const flow = page.children.filter((node) => !['absolute', 'fixed'].includes(node.style.position) && node.style.display !== 'none');
    const first = flow[0];
    if (!first?.bounds || first.bounds.top - page.bounds.top !== candidate.height
      || first.style.margin !== undefined || first.style.marginTop !== undefined && pixels(first.style.marginTop) !== 0
      || flow.some((node) => node.style.order || node.style.flex || node.style.flexGrow || node.style.transform
        || node.loopExpandedFrom || node.loopTemplate || ![undefined, 'static'].includes(node.style.position))
      || page.children.some((node) => !node.bounds || node.bounds.top < page.bounds.top + candidate.height)) return null;
    const represented = new Set();
    const collect = (node) => { if (node.layerId) represented.add(node.layerId); node.children.forEach(collect); };
    page.children.forEach(collect);
    if (candidate.layerIds.some((id) => represented.has(id))) return null;
    const copy = (node, path) => ({ ...node, treeKey: path, style: { ...node.style },
      children: node.children.map((child, i) => copy(child, `${path}/${i}`)) });
    const band = copy(candidate.node, `${page.treeKey}/page-band`);
    band.style = { ...band.style, position: 'relative', left: 0, top: 0, flexShrink: 0 };
    return band;
  };

  const no_source_effects = (layer) => layer && layer.isVisible !== false && !layer.rotation
    && !layer.hasClippingMask && !layer.shouldBreakMaskChain && !layer.blur?.isEnabled
    && [undefined, 100].includes(layer.opacity) && [undefined, 0].includes(layer.blendMode)
    && ['borders', 'shadow'].every((key) => layer[key] === undefined
      || Array.isArray(layer[key]) && !enabled(layer[key]).length);

  const compile_flipped_radius = (layer) => {
    if (!is_rectangle(layer) || !no_source_effects(layer)
      || !(layer.isFlippedHorizontal || layer.isFlippedVertical) || !valid_page_box(layer.layerOriginFrame)) return null;
    const fills = enabled(layer.fills);
    const radii = Array.isArray(layer.radius) ? layer.radius : [layer.radius];
    if (fills.length !== 1 || fills[0].type !== 'color' || !supported_effect(fills[0])
      || !radii.length || radii.length > 4 || !radii.every((r) => finite(r) && r >= 0)) return null;
    const [a, b = a, c = a, d = b] = radii;
    let flipped = [a, b, c, d];
    if (layer.isFlippedHorizontal) flipped = [flipped[1], flipped[0], flipped[3], flipped[2]];
    if (layer.isFlippedVertical) flipped = [flipped[3], flipped[2], flipped[1], flipped[0]];
    return { frame: layer.layerOriginFrame, radii: [a, b, c, d], flipped, color: color_css(fills[0].color, fills[0].opacity) };
  };

  const resolveSourceRadius = (raw, node, index) => {
    const source = index?.[`radius:${node.layerId}`];
    const style = node.style;
    if (!source || node.type !== 'block' || raw.condition || raw.loopType
      || Object.keys(raw.styleObj || {}).length || Object.keys(raw.props?.styleObj || {}).length
      || style.transform || style.filter || style.opacity !== undefined
      || Object.keys(style).some((key) => /^border/.test(key) && key !== 'borderRadius')
      || style.background || style.backgroundImage || !node.bounds
      || ['left', 'top', 'width', 'height'].some((key, i) =>
        node.bounds[key] !== source.frame[['x', 'y', 'width', 'height'][i]])) return null;
    const color = (value) => typeof value === 'string' && /^rgba\([\d.,\s]+\)$/.test(value)
      ? value.slice(5, -1).split(',').map(Number).join(',') : null;
    if (!color(source.color) || color(style.backgroundColor) !== color(source.color)) return null;
    const tokens = String(style.borderRadius || '').split(/\s+/);
    if (!tokens.length || tokens.length > 4 || !tokens.every((v) => /^\d+(?:\.\d+)?px$/.test(v))) return null;
    const [a, b = a, c = a, d = b] = tokens.map((v) => Number(v.slice(0, -2)));
    if ([a, b, c, d].some((r, i) => r !== source.radii[i])) return null;
    return source.flipped.map((r) => `${r}px`).join(' ');
  };

  // A card plate and its missing hairlines must be explicit siblings in one
  // neutral source group. Retain only compact ownership/geometry evidence.
  const compile_omitted_dividers = (plate, childrenByParent, idCounts, nodes) => {
    if (!is_rectangle(plate) || !no_source_effects(plate) || plate.isFlippedHorizontal || plate.isFlippedVertical
      || !valid_page_box(plate.layerOriginFrame) || plate.layerOriginFrame.height <= 2) return null;
    const fills = enabled(plate.fills);
    if (fills.length !== 1 || fills[0].type !== 'color' || color_css(fills[0].color, fills[0].opacity) !== 'rgba(255,255,255,1)') return null;
    const group = nodes.find((n) => n.id === plate.parentID);
    if (idCounts.get(group?.id) !== 1 || group.type !== 'layer-group' || !no_source_effects(group)
      || group.isFlippedHorizontal || group.isFlippedVertical || enabled(group.fills).length
      || group.layers !== undefined && !Array.isArray(group.layers)
      || !group.layerOriginFrame || ['x', 'y', 'width', 'height'].some((key) =>
        plate.layerOriginFrame[key] !== group.layerOriginFrame[key])) return null;
    const members = [...new Set([...(group.layers || []), ...(childrenByParent.get(group.id) || [])])];
    const lines = members.filter((line) => line !== plate && idCounts.get(line.id) === 1
      && is_rectangle(line) && no_source_effects(line) && !line.isFlippedHorizontal && !line.isFlippedVertical
      && valid_page_box(line.layerOriginFrame) && line.layerOriginFrame.height <= 1
      && line.layerOriginFrame.width >= 32 && !enabled(line.shadow).length
      && (line.radius === undefined || (Array.isArray(line.radius) ? line.radius : [line.radius]).every((r) => r === 0)))
      .map((line) => {
        const paint = resolveVectorStyles('url("source-divider")', { 'source-divider': line });
        return paint && Object.keys(paint).every((key) => key === 'background' || key === 'borderRadius')
          && /^rgba\(/.test(paint.background) ? { id: line.id, frame: line.layerOriginFrame, background: paint.background } : null;
      }).filter(Boolean);
    if (!lines.length) return null;
    const owned = {};
    const visit = (layer) => {
      if (!layer.id || Object.hasOwn(owned, layer.id) || idCounts.get(layer.id) !== 1
        || layer.layers !== undefined && !Array.isArray(layer.layers)) return false;
      owned[layer.id] = layer.layerOriginFrame || null;
      return [...new Set([...(layer.layers || []), ...(childrenByParent.get(layer.id) || [])])].every(visit);
    };
    if (!members.every(visit)) return null;
    return { frame: plate.layerOriginFrame, lines, owned };
  };

  const resolveOmittedDividers = (raw, node, index) => {
    const source = index?.[`dividers:${node.layerId}`];
    const style = node.style;
    const box = node.bounds;
    if (!source || !box || node.type !== 'block' || style.display !== 'flex' || style.flexDirection !== 'column'
      || style.position !== undefined && style.position !== 'static' || style.transform || style.border
      || style.background || style.backgroundImage || style.opacity !== undefined || style.filter
      || style.flexWrap || style.direction || style.writingMode
      || ![undefined, 'normal', 'start', 'flex-start'].includes(style.justifyContent)
      || Number(style.width) !== box.width || style.height !== undefined && Number(style.height) !== box.height
      || ['left', 'top', 'width', 'height'].some((key, i) =>
        Math.abs(box[key] - source.frame[['x', 'y', 'width', 'height'][i]]) > 0.5001)) return [];
    const represented = new Set();
    const safe = (n, ownedAncestor = false) => {
      if (n.loopType || n.condition || Object.keys(n.styleObj || {}).length || Object.keys(n.props?.styleObj || {}).length
        || [n.style, n.props?.style].some((s) => s && (s.transform || s.filter
          || ['absolute', 'fixed', 'sticky'].includes(s.position)))) return false;
      const f = source.owned[n.layerId];
      if (f) represented.add(n.layerId);
      else if (!ownedAncestor && n !== raw && !n.children?.length) return false;
      // Generated wrappers/text runs can change descendant boxes; ownership is
      // sufficient there. Placement uses only the card's verified empty gaps.
      return (n.children || []).every((child) => safe(child, ownedAncestor || n !== raw && Boolean(f)));
    };
    if (!safe(raw)) return [];
    return source.lines.filter((line) => {
      const f = line.frame;
      return !represented.has(line.id) && f.x >= box.left && f.x + f.width <= box.left + box.width
        && f.y > box.top && f.y + f.height < box.top + box.height
        && node.children.every((child) => child.bounds && (child.bounds.top + child.bounds.height <= f.y
          || child.bounds.top >= f.y + f.height));
    }).map((line) => ({ position: 'absolute', left: line.frame.x - box.left, top: line.frame.y - box.top,
      width: line.frame.width, height: line.frame.height,
      // Browsers may snap the background painting box to a whole CSS pixel.
      // Keep the source paint extent explicit rather than thickening a hairline.
      background: line.frame.height < 1
        ? `linear-gradient(180deg, ${line.background} ${line.frame.height}px, transparent ${line.frame.height}px)`
        : line.background,
      pointerEvents: 'none', boxSizing: 'border-box' }));
  };

  // Compact evidence for fixed inline-row slots. Neither bounds alone nor a
  // fallback glyph's intrinsic width proves the source's intended text box.
  // PS point text has no paragraph-box wrapping width. Its _orgBounds is a
  // derived ink box, not permission to introduce soft breaks between hard lines.
  const compile_ps_point_text = (layer) => {
    const info = layer.textInfo, bounds = layer._orgBounds;
    const shape = info?.textShape?.length === 1 && info.textShape[0];
    const transform = info?._orgTransform;
    const frame = { x: layer.left, y: layer.top, width: layer.width, height: layer.height };
    if (layer.type !== 'textLayer' || layer.visible === false || layer.clipped === true
      || !valid_page_box(frame) || !bounds
      || !['left', 'top', 'right', 'bottom'].every(key => finite(bounds[key]))
      || bounds.left !== frame.x || bounds.top !== frame.y
      || bounds.right - bounds.left !== frame.width || bounds.bottom - bounds.top !== frame.height
      || typeof info?.text !== 'string' || !/[\r\n]/.test(info.text)
      || !finite(info.size) || info.size <= 0 || typeof info.fontPostScriptName !== 'string'
      || shape?.char !== 'paint' || shape.orientation !== 'horizontal'
      || !['xx', 'xy', 'yx', 'yy', 'tx', 'ty'].every(key => shape.transform?.[key] === (['xx', 'yy'].includes(key) ? 1 : 0))
      || !finite(transform?.xx) || transform.xx <= 0 || transform.yy !== transform.xx
      || !['xy', 'yx', 'tx', 'ty'].every(key => transform[key] === 0)
      || !Array.isArray(info.textStyleRange) || !info.textStyleRange.length
      || !info.textStyleRange.every(run => run.textStyle?.fontPostScriptName === info.fontPostScriptName
        && run.textStyle.impliedFontSize === info.size)) return null;
    const text = info.text.replace(/\r\n?/g, '\n');
    if (text.split('\n').some(line => !line)) return null;
    return { frame, text, fontSize: info.size, fontFamily: info.fontPostScriptName };
  };

  // PS keeps a stroke-only rectangle as a 1px gradient stroke. DDS's schema drops the
  // gradient and leaves a solid fallback, so recover only that proven paint here.
  const stroke_gradient_css = (content) => {
    if (!content || typeof content !== 'object' || content.type !== 'linear') return null;
    const angle = content.angle;
    if (!angle || !finite(angle.value) || (angle.units !== undefined && angle.units !== 'angleUnit')) return null;
    const gradient = content.gradient, stops = gradient?.colors;
    if (!Array.isArray(stops) || stops.length < 2) return null;
    const transparency = gradient.transparency;
    if (Array.isArray(transparency) && transparency.length
      && !transparency.every((entry) => entry?.opacity === undefined || Number(entry.opacity.value) === 100)) return null;
    const parsed = [];
    for (const stop of stops) {
      const color = stop?.color, location = Number(stop?.location);
      if (!color || !['red', 'green', 'blue'].every((key) => finite(color[key]) && color[key] >= 0 && color[key] <= 255)
        || !finite(location) || location < 0 || location > 4096) return null;
      parsed.push({ value: `rgba(${Math.round(color.red)},${Math.round(color.green)},${Math.round(color.blue)},1)`,
        position: Math.round(location / 4096 * 100 * 1e6) / 1e6 });
    }
    // Photoshop angles run counter-clockwise from left-to-right; CSS runs clockwise from bottom.
    const cssAngle = Math.round((((90 - angle.value) % 360 + 360) % 360) * 1e6) / 1e6;
    const sorted = parsed.sort((a, b) => a.position - b.position);
    return `linear-gradient(${cssAngle}deg, ${sorted.map((stop) => `${stop.value} ${stop.position}%`).join(', ')})`;
  };

  const compile_ps_gradient_stroke = (layer) => {
    if (layer?.type !== 'shapeLayer' || layer.visible === false
      || Array.isArray(layer.layers) && layer.layers.length) return null;
    const stroke = layer.strokeStyle;
    if (!stroke || typeof stroke !== 'object' || stroke.strokeEnabled !== true || stroke.fillEnabled !== false) return null;
    const width = stroke.strokeStyleLineWidth;
    if (!finite(width) || width <= 0 || width > 8) return null;
    if (stroke.strokeStyleLineAlignment !== undefined
      && stroke.strokeStyleLineAlignment !== 'strokeStyleAlignInside') return null;
    if (stroke.strokeStyleOpacity !== undefined && Number(stroke.strokeStyleOpacity?.value) !== 100) return null;
    const components = layer.path?.pathComponents, subpaths = components?.[0]?.subpathListKey;
    if (!Array.isArray(components) || components.length !== 1 || !Array.isArray(subpaths) || subpaths.length !== 1
      || subpaths[0]?.closedSubpath !== true || !Array.isArray(subpaths[0].points)
      || subpaths[0].points.length !== 4) return null;
    const paint = stroke_gradient_css(stroke.strokeStyleContent);
    const frame = { width: layer.width, height: layer.height };
    if (!paint || !valid_page_box({ x: layer.left, y: layer.top, ...frame })) return null;
    return { width, paint, frame, signature: [width, paint, frame.width, frame.height].join('|') };
  };

  const solid_rgba = (color, opacity) => {
    const channels = effect_color(color);
    return channels && finite(opacity) && opacity > 0 && opacity <= 1
      ? `rgba(${channels[0]},${channels[1]},${channels[2]},${rounded_length(opacity)})` : null;
  };

  // Map info cards export as one bitmap: an inside-stroked rectangle path plus a square
  // rotated 45° added under its bottom edge, which PS unions into a card with a centre
  // pointer. A fixed-size slice stretches that pointer with the content, so the proven
  // silhouette becomes CSS. Only the silhouette is converted: the 2px chamfers of the
  // source octagon become square corners (sub-pixel at the 1px stroke).
  const compile_notch_card = (layer) => {
    if (!layer || layer.type !== 'shapeLayer' || layer.isVisible === false || layer.rotation
      || layer.isFlippedHorizontal || layer.isFlippedVertical || layer.hasClippingMask === true
      || Array.isArray(layer.layers) && layer.layers.length || layer.layerEffects
      || layer.blur?.isEnabled || layer.opacity !== undefined && layer.opacity !== 100
      || layer.blendMode !== undefined && layer.blendMode !== 0) return null;
    const fill = layer.fill, stroke = layer.strokeStyle;
    if (fill?.class !== 'solidColorLayer' || !stroke || typeof stroke !== 'object'
      || stroke.strokeEnabled !== true || stroke.fillEnabled !== true
      || stroke.strokeStyleLineAlignment !== 'strokeStyleAlignInside'
      || (stroke.strokeStyleOpacity?.value ?? 100) !== 100
      || (stroke.strokeStyleBlendMode ?? 'normal') !== 'normal') return null;
    const width = stroke.strokeStyleLineWidth;
    const fillAlpha = (layer.blendOptions?.fillOpacity?.value ?? 100) / 100;
    const fillPaint = solid_rgba(fill.color, fillAlpha);
    const strokePaint = solid_rgba(stroke.strokeStyleContent?.color, 1);
    const image = typeof layer.ddsImages?.orgUrl === 'string' ? layer.ddsImages.orgUrl : null;
    if (!finite(width) || width <= 0 || width > 8 || !fillPaint || !strokePaint || !image) return null;
    const components = layer.path?.pathComponents;
    if (!Array.isArray(components) || components.length !== 2) return null;
    const shapes = [];
    for (const component of components) {
      if (component?.shapeOperation !== 'add' || !Array.isArray(component.subpathListKey)
        || component.subpathListKey.length !== 1) return null;
      shapes.push(component.subpathListKey[0]);
    }
    const anchors = (subpath) => {
      if (subpath?.closedSubpath !== true || !Array.isArray(subpath.points)) return null;
      const points = subpath.points.map((point) => point?.anchor);
      return points.every((anchor) => anchor && finite(anchor.x) && finite(anchor.y)) ? points : null;
    };
    const shapesBySize = shapes.map(anchors);
    const body = shapesBySize.find((points) => points?.length === 8);
    const pointer = shapesBySize.find((points) => points?.length === 4);
    if (!body || !pointer || shapesBySize.some((points) => !points)) return null;
    const box = { minX: Math.min(...body.map((p) => p.x)), maxX: Math.max(...body.map((p) => p.x)),
      minY: Math.min(...body.map((p) => p.y)), maxY: Math.max(...body.map((p) => p.y)) };
    const close = (left, right) => Math.abs(left - right) <= 0.5;
    const onEdge = (point) => close(point.x, box.minX) || close(point.x, box.maxX)
      || close(point.y, box.minY) || close(point.y, box.maxY);
    // Axis-aligned octagon: every anchor sits on the box edge, every side is straight or 45°.
    if (!body.every(onEdge) || !body.every((point, index) => {
      const next = body[(index + 1) % body.length];
      const dx = Math.abs(next.x - point.x), dy = Math.abs(next.y - point.y);
      return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 0.02;
    })) return null;
    // The pointer is a 45° square whose lower half protrudes under the body and is centred on it.
    const pointerBox = { minX: Math.min(...pointer.map((p) => p.x)), maxX: Math.max(...pointer.map((p) => p.x)),
      minY: Math.min(...pointer.map((p) => p.y)), maxY: Math.max(...pointer.map((p) => p.y)) };
    const half = (pointerBox.maxX - pointerBox.minX) / 2;
    if (!(half > 1) || !close(half, (pointerBox.maxY - pointerBox.minY) / 2)
      || !close((pointerBox.minX + pointerBox.maxX) / 2, (box.minX + box.maxX) / 2)
      || !(pointerBox.minY < box.maxY - 1 && pointerBox.maxY > box.maxY + 1)) return null;
    const centreX = (pointerBox.minX + pointerBox.maxX) / 2, centreY = (pointerBox.minY + pointerBox.maxY) / 2;
    const corners = [[centreX, pointerBox.minY], [pointerBox.maxX, centreY],
      [centreX, pointerBox.maxY], [pointerBox.minX, centreY]];
    if (!pointer.every((point) => corners.some((corner) => close(point.x, corner[0])
      && close(point.y, corner[1])))) return null;
    // A 45° square cut by the bottom edge protrudes exactly as deep as it is wide there.
    const depth = pointerBox.maxY - box.maxY;
    if (!(depth > 1) || depth > (box.maxY - box.minY) / 2) return null;
    return { stroke: strokePaint, fill: fillPaint, border: rounded_length(width), image,
      box: { width: rounded_length(box.maxX - box.minX), height: rounded_length(pointerBox.maxY - box.minY) },
      body: rounded_length(box.maxY - box.minY),
      signature: [fillPaint, strokePaint, width, image, box.maxX - box.minX, box.maxY - box.minY,
        rounded_length(depth)].join('|') };
  };

  const compile_inline_box = (layer, nodes, idCounts) => {
    const frame = layer.layerOriginFrame, exported = layer.ddsOriginFrame;
    const parent = nodes.find(node => node.id === layer.parentID);
    if (idCounts.get(layer.parentID) !== 1 || !no_source_effects(parent)
      || parent.isFlippedHorizontal || parent.isFlippedVertical || !valid_page_box(frame) || !exported || !no_source_effects(layer)
      || layer.isFlippedHorizontal || layer.isFlippedVertical
      || ['x', 'y', 'width', 'height'].some(key => !finite(exported[key]) || Math.abs(frame[key] - exported[key]) > 1e-6)) return null;
    if (layer.type === 'text') {
      const text = layer.font?.content;
      if (typeof text !== 'string' || !text || /[\r\n]/.test(text) || !layer.font.styles?.length
        || !layer.font.styles.every(run => typeof run.content === 'string')
        || layer.font.styles.map(run => run.content).join('') !== text) return null;
      const run = layer.font.styles.length === 1 && layer.font.styles[0];
      const fixedLine = layer.textBehaviour === 0 && layer.font.line === frame.height
        && finite(layer.font.size) && run && Number(run.size) === layer.font.size
        && run.minimumLineHeight === frame.height && run.maximumLineHeight === frame.height
        ? { height: frame.height, fontSize: layer.font.size } : null;
      return { kind: 'text', frame, parentId: layer.parentID, text, ...(fixedLine ? { fixedLine } : {}) };
    }
    if (layer.type === 'shape' && is_rectangle(layer)) {
      return { kind: 'paint', frame, parentId: layer.parentID, image: layer.ddsImage?.imageUrl };
    }
    return null;
  };

  // Keep only verified rectangle box semantics, not another copy of the layer document.
  const compile_source_box = (layer) => {
    if (!is_rectangle(layer) || !valid_page_box(layer.layerOriginFrame) || layer.isVisible === false
      || layer.rotation || layer.isFlippedHorizontal || layer.isFlippedVertical || layer.shouldBreakMaskChain
      || layer.opacity !== undefined && layer.opacity !== 100
      || layer.blendMode !== undefined && layer.blendMode !== 0 || layer.blur?.isEnabled
      || layer.borderOptions?.dashPattern?.length
      || layer.borders !== undefined && !Array.isArray(layer.borders)) return null;
    const borders = enabled(layer.borders);
    const border = borders.length === 1 && borders[0];
    const outside = border && ['outside', '外边框', '外部'].includes(border.position)
      && border.type === 'color' && supported_effect(border) && (border.opacity ?? 1) === 1
      && finite(border.thickness) && border.thickness > 0 && color_css(border.color)
      ? { width: border.thickness, color: [border.color.r, border.color.g, border.color.b, border.color.a] } : null;
    const radii = Array.isArray(layer.radius) ? layer.radius : [layer.radius];
    const clip = layer.hasClippingMask === true && [undefined, 0].includes(layer.clippingMaskMode)
      && radii.length > 0 && radii.length <= 4 && radii.every((r) => finite(r) && r > 0 && r === radii[0])
      ? radii[0] : null;
    return outside || clip ? { frame: { ...layer.layerOriginFrame }, outside, clip } : null;
  };

  // A flex container can lose a source child that overflows before its box: the generated
  // margin starts at the container edge, while the design box starts above/left of it.
  // Only restore the offset when the main-axis sizes match, so centering contributes
  // nothing and the rowDims delta is the single remaining explanation.
  const resolveSourceOverflowOffset = (node) => {
    const style = { ...(node && node.props && node.props.style ? node.props.style : {}),
      ...(node && node.style ? node.style : {}),
      ...(node && node.alignJustify ? node.alignJustify : {}) };
    const box = node && node.rowDims;
    const children = node && Array.isArray(node.children) ? node.children : [];
    if (!box || !Number.isFinite(box.top) || !Number.isFinite(box.left) || !Number.isFinite(box.width)
      || !Number.isFinite(box.height) || style.display !== 'flex' || children.length === 0) return null;
    // Column-only: row main-axis margins are re-derived by flex item sizing elsewhere.
    if (style.flexDirection !== 'column' || ![undefined, 'nowrap'].includes(style.flexWrap)) return null;
    const flowChildren = children.filter((child) => {
      const childStyle = { ...child?.props?.style, ...child?.style };
      return !['absolute', 'fixed'].includes(childStyle.position);
    });
    // Other flow items contribute to centering and flex sizing; their free-space
    // equation is not established by matching only the first child's size.
    if (flowChildren.length !== 1) return null;
    const main = 'height';
    const side = 'Top';
    const origin = 'top';
    const child = children[0];
    const childStyle = { ...(child && child.props && child.props.style ? child.props.style : {}),
      ...(child && child.style ? child.style : {}) };
    const childBox = child && child.rowDims;
    if (!child || !childBox || !Number.isFinite(childBox[origin]) || !Number.isFinite(childBox[main])) return null;
    if (['absolute', 'fixed'].includes(childStyle.position)) return null;
    if (childStyle[`margin${side}`] !== undefined || childStyle.margin !== undefined) return null;
    if (style[`padding${side}`] !== undefined || style.padding !== undefined) return null;
    if (!['center', undefined, 'normal', 'flex-start', 'start'].includes(style.justifyContent)) return null;
    if (Math.abs(childBox[main] - box[main]) > 0.5) return null;
    const delta = Math.round((childBox[origin] - box[origin]) * 10000) / 10000;
    if (delta >= -0.5 || delta <= -Math.min(box[main], 64)) return null;
    // Centered containers split the negative free space around the margin box, so the
    // margin has to carry the offset twice to land the child on its source origin.
    const margin = style.justifyContent === 'center' ? delta * 2 : delta;
    return [[child, { [`margin${side}`]: margin }]];
  };

  // A placed smart object can reference a whole-canvas asset while only a sub-rectangle
  // of it is visible: the transform quad is the visible crop inside the linked frame.
  // Squeezing the full asset into the layer box paints an invisible sliver.
  const compile_placed_image = (layer) => {
    const so = layer && layer.smartObject;
    const rawFrame = layer.realFrame || (so && so.realFrame);
    const frame = rawFrame ? { x: rawFrame.x ?? rawFrame.left, y: rawFrame.y ?? rawFrame.top,
      width: rawFrame.width, height: rawFrame.height } : null;
    const quad = so && so.transform;
    let bounds = layer && layer.layerOriginFrame;
    const finiteBox = (box) => box && ['x', 'y', 'width', 'height']
      .every((key) => Number.isFinite(box[key])) && box.width > 0 && box.height > 0;
    // PS layers carry _orgBounds/left/top instead of a Sketch-style origin frame.
    const fromOrg = layer._orgBounds ? { x: layer._orgBounds.left, y: layer._orgBounds.top,
      width: layer._orgBounds.right - layer._orgBounds.left,
      height: layer._orgBounds.bottom - layer._orgBounds.top } : null;
    const fromFlat = { x: layer.left, y: layer.top, width: layer.width, height: layer.height };
    const origin = finiteBox(bounds) ? bounds : finiteBox(fromOrg) ? fromOrg
      : finiteBox(fromFlat) ? fromFlat : null;
    // The linked frame may start above the artboard origin, so allow negative offsets.
    if (!so || !frame || !Array.isArray(quad) || quad.length !== 8
      || !quad.every(Number.isFinite) || !finiteBox(frame)
      || !origin || layer.isVisible === false) return null;
    bounds = origin;
    const [x1, y1, x2, y2, x3, y3, x4, y4] = quad;
    const close = (a, b) => Math.abs(a - b) < 0.75;
    if (!close(x1, bounds.x) || !close(y1, bounds.y) || !close(x2, bounds.x + bounds.width)
      || !close(y2, bounds.y) || !close(x3, bounds.x + bounds.width)
      || !close(y3, bounds.y + bounds.height)
      || !close(x4, bounds.x) || !close(y4, bounds.y + bounds.height)) return null;
    if (frame.width < bounds.width * 4 || frame.height < bounds.height * 4) return null;
    const image = layer.ddsImage?.imageUrl || layer.image?.imageUrl || layer.ddsImages?.orgUrl;
    if (!image) return null;
    return { image, frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      offset: { x: x1 - frame.x, y: y1 - frame.y } };
  };

  // PS text layers keep the gradient fill and effect stack only in the raw layer
  // document; the generated schema drops the outer glow and reads the gradient
  // direction with a CSS angle that is flipped for vertical gradients.
  const effect_color = (color) => {
    if (!color) return null;
    const channels = ['red', 'green', 'blue'].some((key) => key in color)
      ? [color.red, color.green, color.blue] : [color.r, color.g, color.b];
    if (!channels.every((channel) => finite(channel) && channel >= 0 && channel <= 255)) return null;
    return channels.map(Math.round);
  };

  const source_text = (value) => typeof value === 'string'
    ? value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, '')
    : '';

  const compile_text_effects = (layer) => {
    if (!layer || !['text', 'textLayer'].includes(layer.type) || !layer.layerEffects) return null;
    const effects = layer.layerEffects;
    const result = {};
    const fill = effects.gradientFill;
    const gradient = fill?.gradient;
    if (fill?.enabled === true && fill.type === 'linear' && fill.align === true
      && finite(fill.angle?.value) && typeof fill.reverse === 'boolean'
      && (fill.scale?.value ?? 100) === 100
      && ['horizontal', 'vertical'].every((key) => (fill.offset?.[key]?.value ?? 0) === 0)
      && Array.isArray(gradient?.colors) && gradient.colors.length >= 2
      && (gradient.transparency ?? []).every((stop) => (stop?.opacity?.value ?? 100) === 100)) {
      const stops = gradient.colors.map((stop) => ({
        color: effect_color(stop?.color),
        position: finite(stop?.location) && stop.location >= 0 && stop.location <= 4096
          ? stop.location / 4096 : null
      }));
      if (stops.every((stop) => stop.color && stop.position !== null)) {
        result.gradient = { angle: fill.angle.value, reverse: fill.reverse,
          mode: typeof fill.mode === 'string' ? fill.mode : null,
          opacity: finite(fill.opacity?.value) && fill.opacity.value > 0 && fill.opacity.value <= 100
            ? rounded_length(fill.opacity.value / 100) : null,
          stops: stops.sort((a, b) => a.position - b.position) };
      }
    }
    const drop = effects.dropShadow;
    if (drop?.enabled === true && finite(drop.distance) && drop.distance >= 0
      && finite(drop.blur) && drop.blur >= 0 && drop.chokeMatte === 0
      && finite(drop.opacity?.value) && drop.opacity.value > 0 && drop.opacity.value <= 100
      && finite(drop.localLightingAngle?.value) && effect_color(drop.color)) {
      const radians = drop.localLightingAngle.value * Math.PI / 180;
      result.shadow = { dx: rounded_length(drop.distance * Math.cos(radians)),
        dy: rounded_length(drop.distance * Math.sin(radians)), blur: drop.blur,
        color: effect_color(drop.color), opacity: drop.opacity.value / 100 };
    }
    const glow = effects.outerGlow;
    if (glow?.enabled === true) {
      if (!finite(glow.blur) || glow.blur < 0 || glow.chokeMatte !== 0
        || !finite(glow.opacity?.value) || glow.opacity.value <= 0 || glow.opacity.value > 100
        || !effect_color(glow.color)) result.glowBlocked = true;
      else result.glow = { blur: glow.blur, color: effect_color(glow.color),
        opacity: glow.opacity.value / 100 };
    }
    const frame = effects.frameFX;
    if (frame?.enabled === true && frame.present !== false && frame.style === 'outsetFrame'
      && finite(frame.size) && frame.size > 0 && (frame.opacity?.value ?? 100) === 100
      && effect_color(frame.color)) {
      result.frame = { position: frame.style, size: rounded_length(frame.size),
        color: effect_color(frame.color) };
    }
    return Object.keys(result).length ? result : null;
  };

  const split_top_level = (value) => {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const character of String(value)) {
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (character === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += character;
    }
    parts.push(current);
    return parts;
  };

  // Only single-axis rgba/percentage gradients are compared; anything else keeps
  // the generated declaration untouched. Translucent stops are read only for the
  // proven placeholder shape, so the default rejects them.
  const parse_linear_gradient = (value, allow_alpha = false) => {
    const match = /^linear-gradient\(\s*(?:(-?\d+(?:\.\d+)?)deg\s*,\s*)?(.+)\)$/.exec(String(value).trim());
    if (!match) return null;
    const stops = [];
    for (const token of split_top_level(match[2])) {
      // Generated gradients write the first/last 0% stop as a bare zero length.
      const stop = /^\s*rgba\(([^)]*)\)\s*(-?\d+(?:\.\d+)?)(%?)\s*$/.exec(token);
      if (!stop) return null;
      const channels = stop[1].split(',').map(Number);
      const alpha = channels[3];
      if (channels.length !== 4 || !channels.every(finite) || !(alpha >= 0) || alpha > 1
        || (!allow_alpha && alpha !== 1)) return null;
      const position = stop[3] === '%' ? Number(stop[2]) : Number(stop[2]) === 0 ? 0 : null;
      if (position === null) return null;
      stops.push({ color: channels.slice(0, 3).map(Math.round), position, alpha });
    }
    if (stops.length < 2) return null;
    return { angle: match[1] === undefined ? 180 : Number(match[1]), stops };
  };

  // The generated gradient repeats the first/last color at 0%/100%.
  const same_gradient_stops = (css, stops) => {
    if (css.length !== stops.length + 2) return false;
    const same_color = (left, right) => left.every((channel, index) =>
      Math.abs(channel - right[index]) <= 1);
    const same = (left, right) => Math.abs(left.position - right.position * 100) <= 0.01
      && same_color(left.color, right.color);
    if (css[0].position !== 0 || !same_color(css[0].color, stops[0].color)) return false;
    if (!stops.every((stop, index) => same(css[index + 1], stop))) return false;
    const last = css[css.length - 1];
    return last.position === 100 && same_color(last.color, stops[stops.length - 1].color);
  };

  // PS angles run counter-clockwise from east; CSS angles clockwise from north.
  const source_gradient_angle = (gradient) => {
    const angle = 90 - gradient.angle + (gradient.reverse ? 180 : 0);
    return rounded_length(((angle % 360) + 360) % 360);
  };

  const effect_css_color = (color, opacity) => `rgba(${color[0]},${color[1]},${color[2]},${rounded_length(opacity)})`;

  const rgb_css_color = (color) => `rgba(${color[0]},${color[1]},${color[2]},1)`;

  const parse_opaque_rgba = (value) => {
    const match = /^rgba\(([^)]*)\)$/i.exec(String(value ?? '').trim());
    if (!match) return null;
    const channels = match[1].split(',').map((token) => token.trim());
    if (channels.length !== 4 || channels.some((token) => !/^\d+(?:\.\d+)?$/.test(token))) return null;
    const values = channels.map(Number);
    if (!values.every((value) => finite(value) && value >= 0 && value <= 255)
      || values[3] !== 1) return null;
    return values.slice(0, 3);
  };

  const parse_text_shadow = (value) => {
    const match = /^(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+rgba\(([^)]*)\)$/
      .exec(String(value).trim());
    if (!match) return null;
    const channels = match[4].split(',').map(Number);
    if (channels.length !== 4 || !channels.every(finite)) return null;
    return { dx: Number(match[1]), dy: Number(match[2]), blur: Number(match[3]),
      color: channels.slice(0, 3), opacity: channels[3] };
  };

  const same_text_shadow = (generated, source) => {
    const close = (left, right, epsilon) => finite(left) && Math.abs(left - right) <= epsilon;
    return Boolean(generated && source)
      && close(generated.dx, source.dx, 0.01) && close(generated.dy, source.dy, 0.01)
      && close(generated.blur, source.blur, 0.01)
      && generated.color.every((channel, index) => close(channel, source.color[index], 1))
      && close(generated.opacity, source.opacity, 0.005);
  };

  const frame_effect_record = (raw, index) => {
    const layers = index?.frameEffects;
    const bounds = raw?.rowDims;
    if (!Array.isArray(layers) || !bounds
      || !['left', 'top', 'width', 'height'].every((key) => finite(bounds[key]))) return null;
    const close = (left, right) => finite(right) && Math.abs(left - right) <= 0.01;
    const matches = layers.filter((layer) => close(bounds.left, layer.bounds.left)
      && close(bounds.top, layer.bounds.top)
      && close(bounds.left + bounds.width, layer.bounds.right)
      && close(bounds.top + bounds.height, layer.bounds.bottom))
      .map((layer) => JSON.stringify(layer));
    const unique = [...new Set(matches)];
    return unique.length === 1 ? JSON.parse(unique[0]) : null;
  };

  const text_effect_record = (raw, index) => {
    const layers = index?.textEffects;
    const bounds = raw?.rowDims;
    const text = source_text(raw?.data?.value ?? raw?.props?.text ?? raw?.value);
    if (!Array.isArray(layers) || !bounds || !text
      || !['left', 'top', 'width', 'height'].every((key) => finite(bounds[key]))) return null;
    const close = (left, right) => finite(right) && Math.abs(left - right) <= 0.01;
    const matches = layers.filter((layer) => close(bounds.left, layer.bounds.left)
      && close(bounds.top, layer.bounds.top)
      && close(bounds.left + bounds.width, layer.bounds.right)
      && close(bounds.top + bounds.height, layer.bounds.bottom)
      && layer.text === text)
      .map((layer) => JSON.stringify(layer));
    const unique = [...new Set(matches)];
    return unique.length === 1 ? JSON.parse(unique[0]) : null;
  };

  // LaHu keeps a PS gradient fill's stop colors and its opacity only as the stop
  // alpha, dropping the blend mode and the layer fill it composites onto. Overlay
  // is the only mode proven against a reference, and overlay is linear in the stop
  // color, so compositing each stop keeps the source ramp:
  // black->white at 29% over gold rgba(250,177,11,1) -> rgba(249,154,8,1)->rgba(251,200,14,1).
  const composited_overlay_fill = (style, stops, gradient) => {
    const alpha = stops[0].alpha;
    if (!gradient || gradient.mode !== 'overlay' || !finite(gradient.opacity)
      || Math.abs(gradient.opacity - alpha) > 0.005) return null;
    const base = parse_opaque_rgba(style.color);
    if (!base) return null;
    const tokens = split_top_level(String(style.backgroundImage).trim()
      .replace(/^linear-gradient\(\s*/, '').replace(/\)\s*$/, ''));
    const offset = /^-?\d+(?:\.\d+)?deg$/.test(tokens[0].trim()) ? 1 : 0;
    if (tokens.length !== stops.length + offset) return null;
    // PS overlay: hard light with the stop color as the blend color.
    const paint = stops.map((stop) => {
      const channels = stop.color.map((target, index) => {
        const channel = base[index] / 255;
        const blend = target / 255;
        const blended = channel <= 0.5 ? 2 * channel * blend : 1 - 2 * (1 - channel) * (1 - blend);
        return Math.round((1 - alpha) * base[index] + alpha * 255 * blended);
      });
      return effect_css_color(channels, 1);
    });
    const body = tokens.slice(offset)
      .map((token, index) => token.replace(/rgba?\([^)]*\)/, paint[index])).join(',');
    return `linear-gradient(${source_gradient_angle(gradient)}deg,${body})`;
  };

  const resolveTextEffects = (raw, node, index) => {
    const style = node?.style;
    if (!style || !raw || node.type !== 'text' || style.WebkitBackgroundClip !== 'text'
      || raw.condition || raw.loopType || Object.keys(raw.styleObj || {}).length
      || Object.keys(raw.props?.styleObj || {}).length) return null;
    const nextStyle = {};
    const drop = [];
    const effects = text_effect_record(raw, index);
    const generated = typeof style.backgroundImage === 'string'
      ? parse_linear_gradient(style.backgroundImage, true) : null;
    const gradient = effects?.gradient;
    const uniform = Boolean(generated)
      && generated.stops.every((stop) => stop.alpha === generated.stops[0].alpha);
    const verified = Boolean(gradient && generated && uniform
      && same_gradient_stops(generated.stops, gradient.stops));
    // A translucent generated fill is that placeholder and never stands on its own.
    const filled = verified && generated.stops[0].alpha !== 1
      ? composited_overlay_fill(style, generated.stops, gradient) : null;
    if (verified && (generated.stops[0].alpha === 1 || filled)) {
      if (filled) nextStyle.backgroundImage = filled;
      else {
        const angle = source_gradient_angle(gradient);
        if (Math.abs(angle - generated.angle) > 1e-6) {
          nextStyle.backgroundImage = style.backgroundImage.replace(
            /^linear-gradient\(\s*(?:-?\d+(?:\.\d+)?deg\s*,\s*)?/, `linear-gradient(${angle}deg, `);
        }
      }
      // PS paints effects behind the layer fill. A text shadow is painted above the
      // background, which darkens a transparent gradient fill; drop-shadow does not.
      const shadows = typeof style.textShadow === 'string' ? split_top_level(style.textShadow) : [];
      const existing = shadows.length === 1 ? parse_text_shadow(shadows[0]) : null;
      if (!effects.glowBlocked && !style.filter && existing
        && same_text_shadow(existing, effects.shadow)) {
        const filters = [];
        if (effects.glow) filters.push(`drop-shadow(0px 0px ${effects.glow.blur}px ${effect_css_color(effects.glow.color, effects.glow.opacity)})`);
        filters.push(`drop-shadow(${effects.shadow.dx}px ${effects.shadow.dy}px ${effects.shadow.blur}px ${effect_css_color(effects.shadow.color, effects.shadow.opacity)})`);
        nextStyle.filter = filters.join(' ');
        drop.push('textShadow');
      }
    }
    return Object.keys(nextStyle).length ? { style: nextStyle, drop } : null;
  };

  // CSS text strokes are centered on the glyph outline, while a PS frame stroke sits
  // outside it. LaHu writes the frame width as the stroke width, so half of the halo
  // covers the fill: a 3px white frame over 13px bold text swallows the glyph. Widen
  // the stroke to twice the source width and paint the fill above it, which keeps the
  // halo outside only. A transparent or gradient-clipped fill would show the inner
  // half, so those nodes keep the generated stroke.
  const opaque_text_fill = (style) => {
    let fill = style.WebkitTextFillColor;
    if (fill === undefined || String(fill).trim().toLowerCase() === 'currentcolor') fill = style.color;
    const value = String(fill ?? '').trim();
    const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
    if (hex) return hex[1].length === 3 || hex[1].length === 6
      || (hex[1].length === 4 ? hex[1].endsWith('f') || hex[1].endsWith('F') : /ff$/i.test(hex[1]));
    const rgb = /^(rgb|rgba)\(([^)]*)\)$/i.exec(value);
    if (!rgb) return false; // Unknown, inherited or variable colors are not proof of an opaque fill.
    const channels = rgb[2].split(',').map((token) => token.trim());
    if (channels.some((token) => !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token))) return false;
    const values = channels.map(Number);
    return values.length === (rgb[1].toLowerCase() === 'rgba' ? 4 : 3)
      && values.slice(0, 3).every((value) => finite(value) && value >= 0 && value <= 255)
      && (values.length === 3 || values[3] === 1);
  };

  const resolveOutsetTextFrame = (raw, node, index) => {
    const style = node?.style;
    const stroke = /^(\d+(?:\.\d+)?)px\s+rgba\(([^)]*)\)$/.exec(String(style?.WebkitTextStroke ?? '').trim());
    if (!style || !stroke || node.type !== 'text' || !raw || raw.condition || raw.loopType
      || Object.keys(raw.styleObj || {}).length || Object.keys(raw.props?.styleObj || {}).length
      || style.WebkitBackgroundClip === 'text' || !opaque_text_fill(style)) return null;
    const frame = text_effect_record(raw, index)?.frame;
    if (!frame || frame.position !== 'outsetFrame'
      || Math.abs(frame.size - Number(stroke[1])) > 1e-6) return null;
    const channels = stroke[2].split(',').map(Number);
    if (channels.length !== 4 || !channels.every(finite) || Math.abs(channels[3] - 1) > 1e-6
      || frame.color.some((value, i) => Math.abs(value - channels[i]) > 1)) return null;
    return { WebkitTextStroke: `${rounded_length(frame.size * 2)}px ${rgb_css_color(frame.color)}`,
      paintOrder: 'stroke fill' };
  };

  const compile_frame_effect = (layer) => {
    const frame = layer?.layerEffects?.frameFX;
    const gradient = frame?.gradient;
    if (!layer || frame?.enabled !== true || frame.present === false || frame.style !== 'insetFrame'
      || frame.paintType !== 'gradientFill' || !finite(frame.size) || frame.size <= 0
      || (frame.opacity?.value ?? 100) !== 100 || layer.strokeStyle?.strokeEnabled === true
      || !Array.isArray(gradient?.colors) || gradient.colors.length < 2
      || !(gradient.transparency ?? []).every((stop) => (stop?.opacity?.value ?? 100) === 100)
      || !effect_color(frame.color)) return null;
    const stops = gradient.colors.map((stop) => effect_color(stop?.color));
    if (!stops.every(Boolean)) return null;
    return { size: rounded_length(frame.size), color: effect_color(frame.color),
      average: [0, 1, 2].map((i) => Math.round(stops.reduce((sum, color) => sum + color[i], 0) / stops.length)) };
  };

  // LaHu writes an inset gradient frame as a solid border in the frame's default
  // color, which drops the ring to black. A 2px ring cannot show the gradient itself,
  // so repaint only that unproven default with the average stop color.
  const resolveFrameBorder = (raw, node, index) => {
    const style = node?.style;
    const border = /^(\d+(?:\.\d+)?)px\s+solid\s+rgba\(([^)]*)\)$/.exec(String(style?.border ?? '').trim());
    if (!style || !border || node.type !== 'block' || !raw || raw.condition || raw.loopType
      || style.borderImage || /(?:Top|Right|Bottom|Left)(?:Width|Color|Style)/.test(Object.keys(style).join(','))) return null;
    const frame = frame_effect_record(raw, index);
    if (!frame || Math.abs(frame.size - Number(border[1])) > 1e-6) return null;
    const channels = border[2].split(',').map(Number);
    if (channels.length !== 4 || !channels.every(finite) || Math.abs(channels[3] - 1) > 1e-6
      || frame.color.some((value, i) => Math.abs(value - channels[i]) > 1)) return null;
    if (frame.average.every((value, i) => Math.abs(value - channels[i]) <= 1)) return null;
    return { border: `${rounded_length(frame.size)}px solid ${rgb_css_color(frame.average)}` };
  };

  // A gradient-clipped fill is painted from the element box, so glyph parts outside
  // a line box that is larger (or tighter) than that box are never painted. A plain
  // single-line box also keeps a leading more than half an em taller than the box:
  // half of that leading is added above the glyph, which drops the text below its
  // source box and out of line with the icons sharing the row. Leadings within half
  // an em of the box stay as generated, because that offset is not visible. Direct
  // siblings in a non-wrapping flex row follow a clamped gradient node only when
  // source bounds prove the same row and they share the box/line-box pair.
  const clampTextLineBoxes = (roots) => {
    const followers = new WeakSet();
    const singleLine = (node) => node.type === 'text' && node.style?.whiteSpace === 'nowrap'
      && !/<br/i.test(String(node.text ?? ''));
    const metrics = (node) => {
      const height = Number(node.style?.height);
      const lineHeight = Number(node.style?.lineHeight);
      const fontSize = Number(node.style?.fontSize);
      if (!finite(height) || !finite(lineHeight) || Math.abs(lineHeight - height) <= 0.5) return null;
      return { height, lineHeight, fontSize, key: `${lineHeight}|${height}` };
    };
    const pushesDown = (box) => finite(box.fontSize) && box.lineHeight - box.height > 0.5 * box.fontSize;
    const walk = (node, visit) => {
      visit(node);
      (node.children || []).forEach((child) => walk(child, visit));
    };
    for (const root of roots) {
      walk(root, (node) => {
        if (!['flex', 'inline-flex'].includes(node.style?.display)
          || node.style.flexDirection !== 'row'
          || ![undefined, 'nowrap'].includes(node.style.flexWrap)) return;
        const texts = (node.children || []).filter((child) => singleLine(child)
          && !['absolute', 'fixed'].includes(child.style.position)
          && finite(child.bounds?.top) && finite(child.bounds?.height));
        const gradients = texts.filter((child) => child.style.WebkitBackgroundClip === 'text'
          && metrics(child));
        for (const child of texts) {
          const box = metrics(child);
          if (box && gradients.some((gradient) => metrics(gradient).key === box.key
            && Math.abs(gradient.bounds.top - child.bounds.top) <= 0.5
            && Math.abs(gradient.bounds.height - child.bounds.height) <= 0.5)) followers.add(child);
        }
      });
    }
    for (const root of roots) {
      walk(root, (node) => {
        if (!singleLine(node)) return;
        const box = metrics(node);
        if (!box) return;
        if (node.style.WebkitBackgroundClip !== 'text' && !followers.has(node) && !pushesDown(box)) return;
        node.style.lineHeight = box.height;
      });
    }
    // Stacked CJK text (one glyph per line) must fit its box: the source leading can be
    // larger than the box divided by the glyph count, which pushes the last glyph out.
    for (const root of roots) {
      walk(root, (node) => {
        const pitch = stacked_pitch(node);
        if (pitch === null) return;
        node.style.lineHeight = pitch;
      });
    }
    return roots;
  };

  // PS children keep their source sizes, so a generated flex container that overflows
  // its own fixed main size must not shrink them: shrinking keeps the first item short
  // and rolls every following sibling up/left against the source bounds. Only proven
  // overflow (source sizes plus source margins exceed the container) is restored.
  const keepFlexItemSizes = (roots) => {
    const px = (value) => {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const match = /^(-?\d+(?:\.\d+)?)(?:px)?$/.exec(String(value ?? '').trim());
      return match ? Number(match[1]) : null;
    };
    const margin = (style, side) => {
      const direct = px(style[`margin${side}`]);
      if (direct !== null) return direct;
      if (style.margin === undefined) return 0;
      const parts = String(style.margin).trim().split(/\s+/).filter(Boolean).map(px);
      if (!parts.length || parts.length > 4 || parts.some((value) => value === null)) return null;
      const [top, right = top, bottom = top, left = right] = parts;
      return { top, right, bottom, left }[String(side).toLowerCase()];
    };
    const walk = (node) => {
      const style = node.style || {};
      if (['flex', 'inline-flex'].includes(style.display)
        && [undefined, 'nowrap'].includes(style.flexWrap)
        && Array.isArray(node.children) && node.children.length) {
        const column = String(style.flexDirection ?? '').startsWith('column');
        const size = px(column ? style.height : style.width);
        if (size !== null && size > 0) {
          const items = [];
          let total = 0;
          let proven = true;
          for (const child of node.children) {
            const childStyle = child.style || {};
            // Absolutely positioned children leave the flow and are never shrunk.
            if (['absolute', 'fixed'].includes(childStyle.position)) continue;
            const item = px(column ? childStyle.height : childStyle.width);
            const before = margin(childStyle, column ? 'Top' : 'Left');
            const after = margin(childStyle, column ? 'Bottom' : 'Right');
            const constraints = column ? ['minHeight', 'maxHeight'] : ['minWidth', 'maxWidth'];
            if (['flex', 'flexGrow', 'flexShrink', 'flexBasis', ...constraints]
              .some((key) => childStyle[key] !== undefined)
              || item === null || before === null || after === null) { proven = false; break; }
            total += item + before + after;
            items.push(child);
          }
          if (proven && total > size + 0.5) for (const child of items) child.style.flexShrink = 0;
        }
      }
      (node.children || []).forEach(walk);
    };
    for (const root of roots) walk(root);
    return roots;
  };

  const STACKED_CHAR = /^[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60\u3000-\u303F]$/;

  const stacked_pitch = (node) => {
    const style = node.type === 'text' ? node.style : null;
    if (!style || style.whiteSpace === 'nowrap') return null;
    const text = String(node.text ?? '').replace(/<br\s*\/?>/gi, '').replace(/<[^>]*>/g, '');
    const chars = [...text];
    const width = Number(style.width);
    const height = Number(style.height);
    const fontSize = Number(style.fontSize);
    const lineHeight = Number(style.lineHeight);
    if (chars.length < 2 || !chars.every((char) => STACKED_CHAR.test(char))
      || !finite(width) || !finite(height) || !finite(fontSize) || !finite(lineHeight)
      || width > fontSize * 1.5) return null;
    const pitch = height / chars.length;
    if (pitch < fontSize * 0.85 || pitch > fontSize * 1.35 || Math.abs(lineHeight - pitch) <= 0.5) return null;
    return rounded_length(pitch);
  };

  const resolvePlacedImage = (node, index) => {
    const placed = node && node.layerId && index ? index[`placed:${node.layerId}`] : null;
    return placed && typeof placed === 'object' ? placed : null;
  };

  const resolveSourceBox = (node, index) => {
    const box = node.layerId && index?.[`box:${node.layerId}`];
    const style = node.style;
    const bounds = node.bounds;
    if (!box || !bounds || node.type !== 'block' || style.boxSizing !== 'border-box'
      || style.transform && style.transform !== 'none' || style.filter && style.filter !== 'none'
      || style.opacity !== undefined && Number(style.opacity) !== 1
      || Object.keys(style).some((key) => /^border(?:Top|Right|Bottom|Left|Width|Style|Color)/.test(key)
        && !key.endsWith('Radius'))
      || ['width', 'height'].some((key) => style[key] !== undefined
        && !/^(?:\d+(?:\.\d+)?)(?:px)?$/.test(String(style[key])))) return null;
    const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) < 1e-6;
    if (['width', 'height'].some((key) => style[key] !== undefined
      && !close(Number(String(style[key]).replace(/px$/, '')), bounds[key]))) return null;
    const same = close(bounds.left, box.frame.x) && close(bounds.top, box.frame.y)
      && close(bounds.width, box.frame.width) && close(bounds.height, box.frame.height);
    const width = box.outside?.width;
    // Some generated frames include an outside stroke and negative margins to
    // cancel it. Remove only that proven compensation when the stroke leaves flow.
    const expanded = width && close(bounds.left, Math.round(box.frame.x) - width)
      && close(bounds.top, Math.round(box.frame.y) - width)
      && close(bounds.width, Math.round(box.frame.width) + width * 2)
      && close(bounds.height, Math.round(box.frame.height) + width * 2);
    const result = {};
    const border = /^(\d+(?:\.\d+)?)px\s+solid\s+rgba\(([^)]+)\)$/.exec(style.border || '');
    if ((same || expanded) && box.outside && style.outline === undefined && style.outlineOffset === undefined
      && border && close(Number(border[1]), width)) {
      const tokens = border[2].split(',').map((v) => v.trim());
      const color = tokens.map(Number);
      if (tokens.every((v) => /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(v))
        && color.length === 4 && color.every((v, i) => close(v, box.outside.color[i]))) {
        result.outline = style.border;
        if (expanded) result.expandedBorder = width;
      }
    }
    if (same && box.clip && style.overflow === undefined && style.overflowX === undefined && style.overflowY === undefined
      && style.clipPath === undefined && style.maskImage === undefined && style.clip === undefined
      && Object.keys(style).every((key) => !/^border(?:Top|Bottom)(?:Left|Right)Radius$/.test(key))) {
      const radii = String(style.borderRadius ?? '').split(/\s+/);
      if (radii.length >= 1 && radii.length <= 4 && radii.every((r) => /^\d+(?:\.\d+)?(?:px)?$/.test(r)
        && close(Number(r.replace(/px$/, '')), box.clip))) result.clip = true;
    }
    return Object.keys(result).length ? result : null;
  };

  const helper = { buildLayerDataIndex, resolveClippedCardRow, resolveSourceBackground, resolveSourceRadius, resolveOmittedDividers, resolveSourceBox, resolveExportedMaskGroup, resolveVectorStyles, resolveMergedStyles, verifySolidShapeGroups, resolveDividerStyles, resolveImageStyles, resolvePaddedImage, resolvePageBand, resolveSourceOverflowOffset, resolvePlacedImage, resolveTextEffects, resolveOutsetTextFrame, resolveFrameBorder, clampTextLineBoxes, keepFlexItemSizes };
  if (typeof module !== 'undefined' && module.exports) module.exports = helper;
  globalScope.lanhuVectorStyleHelper = helper;
})(typeof globalThis !== 'undefined' ? globalThis : this);
