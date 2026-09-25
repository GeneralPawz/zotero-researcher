/* global ZR, Zotero */
// Nested tags in Zotero's tag pane, like Obsidian: "#review/BIM-in-der-Bauausführung"
// sits under "#review". A tab strip above the tag selector switches between Zotero's
// list ("Tags") and the tree ("Tag tree"). The tree shows the same tags as Zotero's list
// (the current collection, its filter box) and selects them through Zotero, so filtering
// the items works as usual.

ZR.TagTree = (() => {
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  /**
   * Tags → tree. "#a/b/c" becomes #a › b › c; a tag that is also a group ("#a" and "#a/b")
   * is both selectable and expandable. Groups first, then by name (case-insensitive).
   * @param {string[]} tags
   * @returns {{name, path, tag: string|null, children: object[], leaves: number}[]}
   */
  function build(tags) {
    const root = { children: new Map() };
    for (const tag of new Set(tags)) {
      const parts = String(tag).split("/").filter(Boolean);
      if (!parts.length) continue;
      let node = root;
      let path = "";
      parts.forEach((part, i) => {
        path = i ? `${path}/${part}` : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, path, tag: null, children: new Map() });
        node = node.children.get(part);
      });
      node.tag = tag;
    }
    const finish = (map) =>
      [...map.values()]
        .map((n) => {
          const children = finish(n.children);
          return { name: n.name, path: n.path, tag: n.tag, children, leaves: (n.tag ? 1 : 0) + children.reduce((a, c) => a + c.leaves, 0) };
        })
        .sort((a, b) => Number(!!b.children.length) - Number(!!a.children.length) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return finish(root.children);
  }

  // ------------------------------------------------------------------ DOM ----
  const pref = (k, d) => ZR.Prefs.get(k, d);
  const openPaths = () => new Set(ZR.Prefs.getJSON("tagTreeOpen", []));

  function h(doc, tag, props = {}, children = []) {
    const el = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children)) if (c) el.append(c);
    return el;
  }

  function selector(win) {
    return win.ZoteroPane?.tagSelector || null;
  }

  /** The tags Zotero's list shows right now (view, filter box). */
  function visibleTags(win) {
    const ts = selector(win);
    const tags = (ts?.state?.tags || []).map((t) => t.tag);
    const q = String(ts?.state?.searchString || "").toLowerCase();
    return q ? tags.filter((t) => t.toLowerCase().includes(q)) : tags;
  }

  function render(win) {
    const doc = win.document;
    const box = doc.getElementById("zr-tagtree");
    if (!box || box.hidden) return;
    const ts = selector(win);
    const selected = ts?.getTagSelection?.() || new Set();
    const open = openPaths();
    const nodes = build(visibleTags(win));
    // groups holding a selected tag stay open
    for (const t of selected) {
      const parts = t.split("/");
      for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join("/"));
    }
    const rows = [];
    const walk = (list, depth) => {
      for (const n of list) {
        const group = n.children.length > 0;
        const isOpen = group && open.has(n.path);
        const toggle = () => {
          const o = openPaths();
          if (o.has(n.path)) o.delete(n.path);
          else o.add(n.path);
          ZR.Prefs.setJSON("tagTreeOpen", [...o]);
          render(win);
        };
        rows.push(
          h(doc, "div", { class: "zr-tt-row" + (n.tag && selected.has(n.tag) ? " selected" : "") + (group ? " group" : ""), role: "treeitem", "aria-expanded": group ? String(isOpen) : null, "data-path": n.path, style: `padding-inline-start: ${4 + depth * 14}px` }, [
            h(doc, "span", { class: "zr-tt-twisty", text: group ? (isOpen ? "▾" : "▸") : "", onclick: (e) => (e.stopPropagation(), group && toggle()) }),
            h(doc, "span", {
              class: "zr-tt-label" + (n.tag ? "" : " virtual"),
              text: n.name,
              title: n.tag ? `${n.tag}: click to filter the items by this tag` : `${n.path}/…`,
              onclick: () => (n.tag ? ts?.handleTagSelected?.(n.tag) : toggle()),
            }),
            group ? h(doc, "span", { class: "zr-tt-count", text: String(n.leaves) }) : null,
          ])
        );
        if (isOpen) walk(n.children, depth + 1);
      }
    };
    walk(nodes, 0);
    box.replaceChildren(...(rows.length ? rows : [h(doc, "div", { class: "zr-tt-empty", text: "No tags in this view." })]));
  }

  function setMode(win, mode) {
    const doc = win.document;
    const container = doc.getElementById("zotero-tag-selector-container");
    const tree = mode === "tree";
    ZR.Prefs.set("tagView", mode);
    container?.classList.toggle("zr-tree-on", tree);
    doc.getElementById("zr-tagtree").hidden = !tree;
    for (const b of doc.querySelectorAll("#zr-tagtabs button")) b.classList.toggle("on", b.dataset.mode === mode);
    if (tree) render(win);
    else selector(win)?.handleResize?.();
  }

  /** Add the tabs and the tree to a main window's tag pane. */
  function mount(win) {
    const doc = win.document;
    const container = doc.getElementById("zotero-tag-selector-container");
    const list = doc.getElementById("zotero-tag-selector");
    if (!container || !list || doc.getElementById("zr-tagtabs")) return;
    const tabs = h(doc, "div", { id: "zr-tagtabs", class: "zr-tagtabs", role: "tablist" }, [
      h(doc, "button", { "data-mode": "list", role: "tab", text: "Tags", title: "Zotero's tag list", onclick: () => setMode(win, "list") }),
      h(doc, "button", { "data-mode": "tree", role: "tab", text: "Tag tree", title: "Nested tags (#parent/child) as a tree", onclick: () => setMode(win, "tree") }),
    ]);
    const tree = h(doc, "div", { id: "zr-tagtree", class: "zr-tagtree", role: "tree", hidden: true });
    container.insertBefore(tabs, list);
    container.insertBefore(tree, list);
    // Zotero redraws its list whenever the view, the tags or the selection change: follow it
    let queued = false;
    const observer = new win.MutationObserver(() => {
      if (queued || tree.hidden) return;
      queued = true;
      win.setTimeout(() => ((queued = false), render(win)), 120);
    });
    observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    win.ZoteroResearcherTagTree = { observer };
    setMode(win, pref("tagView", "list"));
  }

  function unmount(win) {
    const doc = win.document;
    win.ZoteroResearcherTagTree?.observer.disconnect();
    delete win.ZoteroResearcherTagTree;
    doc.getElementById("zr-tagtabs")?.remove();
    doc.getElementById("zr-tagtree")?.remove();
    doc.getElementById("zotero-tag-selector-container")?.classList.remove("zr-tree-on");
    selector(win)?.handleResize?.();
  }

  return { build, mount, unmount, render, setMode, visibleTags };
})();
