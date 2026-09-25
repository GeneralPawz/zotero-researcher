/* exported ZRDropdown */
"use strict";

// Replacement popup for <select> elements. Native <select> popups do not render (and
// cannot be clicked) in Zotero's chrome HTML windows, so every <select> is kept as the
// hidden source of truth (value, options, "change" events) and shown as a button plus
// an in-document menu. Existing code keeps using select.value / "change" unchanged.
//
//   ZRDropdown.observe(document)   enhance all current and future <select>s
//   select.zrContextMenu = (value, event) => {}   right-click on the button or an entry

var ZRDropdown = (() => {
  const HTML = "http://www.w3.org/1999/xhtml";
  const CSS = `
    .zr-dd { display: inline-flex; position: relative; max-width: 100%; vertical-align: middle; }
    .zr-dd-btn {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      font: inherit; color: inherit; cursor: pointer; text-align: left;
      border: 1px solid var(--line, color-mix(in srgb, CanvasText 22%, transparent));
      border-radius: var(--radius, 6px); padding: 4px 8px;
      background: var(--bg, Canvas);
    }
    .zr-dd-btn:hover:not(:disabled) { background: var(--bg-3, color-mix(in srgb, CanvasText 8%, Canvas)); }
    .zr-dd-btn:disabled { opacity: 0.5; cursor: default; }
    .zr-dd-btn:focus-visible { outline: 2px solid var(--accent, Highlight); outline-offset: 1px; }
    .zr-dd-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .zr-dd-chev { opacity: 0.6; font-size: 0.8em; flex: none; }
    .zr-dd-menu {
      position: fixed; z-index: 2000; min-width: 120px; max-height: 320px; overflow: auto;
      background: var(--bg, Canvas); color: var(--fg, CanvasText);
      border: 1px solid var(--line, color-mix(in srgb, CanvasText 22%, transparent));
      border-radius: 8px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28); padding: 4px;
      font: message-box; font-size: 13px;
    }
    .zr-dd-item { padding: 5px 10px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
    .zr-dd-item.active { background: var(--accent-soft, color-mix(in srgb, Highlight 22%, transparent)); }
    .zr-dd-item.selected { font-weight: 600; }
    .zr-dd-item.disabled { opacity: 0.45; cursor: default; }
  `;

  let openMenu = null; // {menu, select, button, items, index}

  function ensureStyle(doc) {
    if (doc.getElementById("zr-dd-style")) return;
    const style = doc.createElementNS(HTML, "style");
    style.id = "zr-dd-style";
    style.textContent = CSS;
    (doc.head || doc.documentElement).append(style);
  }

  function findDescriptor(obj, prop) {
    for (let p = Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, prop);
      if (d) return d;
    }
    return null;
  }

  function enhance(select) {
    if (select.dataset.zrDd || select.multiple) return;
    select.dataset.zrDd = "1";
    const doc = select.ownerDocument;
    ensureStyle(doc);
    const wrap = doc.createElementNS(HTML, "span");
    wrap.className = "zr-dd " + select.className;
    const button = doc.createElementNS(HTML, "button");
    button.type = "button";
    button.className = "zr-dd-btn";
    button.setAttribute("aria-haspopup", "listbox");
    if (select.title) button.title = select.title;
    const label = doc.createElementNS(HTML, "span");
    label.className = "zr-dd-label";
    const chev = doc.createElementNS(HTML, "span");
    chev.className = "zr-dd-chev";
    chev.textContent = "▾";
    button.append(label, chev);
    wrap.append(button);
    select.after(wrap);
    select.style.display = "none";

    const sync = () => {
      const opt = select.options[select.selectedIndex];
      label.textContent = opt ? opt.textContent : "";
      button.disabled = select.disabled;
      if (select.title) button.title = select.title;
      if (select.id) button.dataset.for = select.id;
    };
    // Programmatic value changes don't fire events, so hook the setters on this instance.
    for (const prop of ["value", "selectedIndex"]) {
      const d = findDescriptor(select, prop);
      if (!d) continue;
      Object.defineProperty(select, prop, {
        configurable: true,
        get() {
          return d.get.call(this);
        },
        set(v) {
          d.set.call(this, v);
          sync();
        },
      });
    }
    new doc.defaultView.MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "selected", "hidden", "title"] });
    select.addEventListener("change", sync);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openMenu?.select === select) close();
      else open(select, button);
    });
    button.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key) && openMenu?.select !== select) {
        e.preventDefault();
        open(select, button);
      }
    });
    button.addEventListener("contextmenu", (e) => {
      if (!select.zrContextMenu) return;
      e.preventDefault();
      close();
      select.zrContextMenu(select.value, e);
    });
    select.zrDropdownButton = button;
    sync();
  }

  function open(select, button) {
    close();
    const doc = select.ownerDocument;
    const menu = doc.createElementNS(HTML, "div");
    menu.className = "zr-dd-menu";
    menu.setAttribute("role", "listbox");
    const items = [];
    [...select.options].forEach((opt, i) => {
      if (opt.hidden) return;
      const item = doc.createElementNS(HTML, "div");
      item.className = "zr-dd-item" + (i === select.selectedIndex ? " selected active" : "") + (opt.disabled ? " disabled" : "");
      item.setAttribute("role", "option");
      item.textContent = opt.textContent;
      item.dataset.value = opt.value;
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!opt.disabled) choose(select, i);
      });
      item.addEventListener("mouseenter", () => setActive(items.findIndex((x) => x.i === i)));
      item.addEventListener("contextmenu", (e) => {
        if (!select.zrContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        select.zrContextMenu(opt.value, e);
      });
      menu.append(item);
      items.push({ el: item, i });
    });
    (doc.body || doc.documentElement).append(menu);
    const win = doc.defaultView;
    const place = (scrolled = false) => {
      const r = button.getBoundingClientRect();
      if (scrolled && (r.bottom < 0 || r.top > win.innerHeight)) return close(); // button scrolled away
      menu.style.minWidth = `${Math.max(r.width, 120)}px`;
      const h = menu.offsetHeight;
      const below = win.innerHeight - r.bottom;
      menu.style.top = `${below >= h + 6 || below > r.top ? r.bottom + 3 : Math.max(4, r.top - h - 3)}px`;
      menu.style.left = `${Math.max(4, Math.min(r.left, win.innerWidth - menu.offsetWidth - 4))}px`;
    };
    openMenu = { menu, select, button, items, place, index: Math.max(0, items.findIndex((x) => x.i === select.selectedIndex)) };
    place();
    button.setAttribute("aria-expanded", "true");
    items[openMenu.index]?.el.scrollIntoView({ block: "nearest" });
    doc.addEventListener("mousedown", onOutside, true);
    doc.addEventListener("keydown", onKey, true);
    win.addEventListener("blur", close);
    win.addEventListener("resize", close);
  }

  function setActive(n) {
    if (!openMenu || n < 0) return;
    openMenu.items.forEach((x, k) => x.el.classList.toggle("active", k === n));
    openMenu.index = n;
    openMenu.items[n]?.el.scrollIntoView({ block: "nearest" });
  }

  function choose(select, i) {
    const changed = select.selectedIndex !== i;
    select.selectedIndex = i;
    const button = openMenu?.button;
    close();
    button?.focus();
    if (changed) select.dispatchEvent(new select.ownerDocument.defaultView.Event("change", { bubbles: true }));
  }

  function onOutside(e) {
    if (openMenu && !openMenu.menu.contains(e.target) && e.target !== openMenu.button && !openMenu.button.contains(e.target)) close();
  }

  function onKey(e) {
    if (!openMenu) return;
    const { items, index, select } = openMenu;
    if (e.key === "Escape" || e.key === "Tab") {
      const b = openMenu.button;
      close();
      if (e.key === "Escape") {
        b.focus();
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === "ArrowDown") setActive(Math.min(items.length - 1, index + 1));
    else if (e.key === "ArrowUp") setActive(Math.max(0, index - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(items.length - 1);
    else if (e.key === "Enter" || e.key === " ") {
      const it = items[index];
      if (it && !select.options[it.i].disabled) choose(select, it.i);
    } else if (e.key.length === 1) {
      const k = items.findIndex((x, n) => n > index && x.el.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
      setActive(k >= 0 ? k : items.findIndex((x) => x.el.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function close() {
    if (!openMenu) return;
    const { menu, button } = openMenu;
    const doc = menu.ownerDocument;
    const win = doc.defaultView;
    doc.removeEventListener("mousedown", onOutside, true);
    doc.removeEventListener("keydown", onKey, true);
    win?.removeEventListener("blur", close);
    win?.removeEventListener("resize", close);
    button.setAttribute("aria-expanded", "false");
    menu.remove();
    openMenu = null;
  }

  function enhanceAll(root) {
    for (const s of root.querySelectorAll("select")) enhance(s);
  }

  /** Enhance every <select> under root now and whenever new ones are added. */
  function observe(doc, root = doc.documentElement) {
    enhanceAll(root);
    new doc.defaultView.MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.localName === "select") enhance(n);
          else if (n.querySelectorAll) enhanceAll(n);
        }
      }
    }).observe(root, { childList: true, subtree: true });
    // The menu is position: fixed - keep it attached to its button when anything scrolls
    doc.addEventListener("scroll", (e) => openMenu && !openMenu.menu.contains(e.target) && openMenu.place(true), true);
  }

  return { observe, enhance, close, isOpen: () => !!openMenu };
})();
