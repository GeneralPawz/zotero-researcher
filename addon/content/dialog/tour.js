/* global App, $, document, window */
"use strict";

// Guided first-run tour. Shown automatically once (pref tourSeen), replayable with the
// "?" button or from Settings.

const Tour = (window.Tour = (() => {
  const STEPS = [
    {
      target: "#target",
      title: "Welcome to Researcher 👋",
      text: "Papers you find are added to the collection you had selected in Zotero — shown here. Select a different collection in Zotero and click the Researcher button again to change it.",
    },
    {
      target: "#mode-seg",
      title: "Two ways to search",
      text: "<b>Keywords</b>: you write the query yourself — exact and reproducible. <b>Describe it (AI)</b>: explain what you need in plain words and an AI writes the query and rates the results.",
    },
    {
      target: ".query-row",
      title: "Build your query",
      text: "Add terms row by row: terms in one row are alternatives (OR), rows combine with AND, OR, NOT or XOR, and each row can target the title, abstract or authors. Prefer typing? Switch to <b>Text</b> (top right) and write e.g. <code>(\"IFC5\" OR IFCX) AND BIM</code>. Either way, the query is translated for each database.",
    },
    {
      target: "#sources-chip",
      title: "Where to search",
      text: "Pick databases here. Free ones work right away; others need a (usually free) key in Settings. You can hide whole research areas such as medicine in Settings.",
    },
    {
      target: "#options-chip",
      title: "Filters and extras",
      text: "Limit years, keep only papers with a full text, download PDFs, and hide papers you excluded before — your judgements are remembered across searches.",
    },
    {
      target: '.tab[data-tab="review"]',
      title: "Systematic reviews (PRISMA)",
      text: "Turn a collection into a review: screen titles and abstracts, then full texts — by hand with keyboard shortcuts, or with AI suggestions you confirm. The PRISMA 2020 flow diagram is built for you.",
    },
    {
      target: '.tab[data-tab="items"]',
      title: "Improve papers you already have",
      text: "Select papers in Zotero first. Then fill in missing metadata, find PDFs, compare papers with AI, or look for related work.",
    },
    {
      target: '.tab[data-tab="citations"]',
      title: "Who cites whom",
      text: "Find citation links between your papers using open citation data, link them as Zotero “Related” items, and see them as a graph.",
    },
    {
      target: "#help",
      title: "That's it!",
      text: "Replay this tour any time with <b>?</b>. Settings (⚙) hold API keys, AI providers and research areas.",
    },
  ];

  let i = 0;

  function start() {
    App.showTab("search");
    i = 0;
    $("tour-layer").hidden = false;
    $("tour-next").onclick = () => (i < STEPS.length - 1 ? show(i + 1) : end());
    $("tour-back").onclick = () => show(Math.max(0, i - 1));
    $("tour-skip").onclick = end;
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", reposition);
    show(0);
  }

  function onKey(e) {
    if ($("tour-layer").hidden) return;
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight" || e.key === "Enter") $("tour-next").click();
    else if (e.key === "ArrowLeft") $("tour-back").click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function show(n) {
    i = n;
    const s = STEPS[i];
    $("tour-step").textContent = `${i + 1} of ${STEPS.length}`;
    $("tour-title").textContent = s.title;
    $("tour-text").innerHTML = s.text;
    $("tour-back").disabled = i === 0;
    $("tour-next").textContent = i === STEPS.length - 1 ? "Done" : "Next";
    reposition();
    $("tour-next").focus();
  }

  function reposition() {
    if ($("tour-layer").hidden) return;
    const target = document.querySelector(STEPS[i].target);
    const spot = $("tour-spot");
    const bubble = $("tour-bubble");
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (!target || !target.getClientRects().length) {
      spot.style.cssText = `left:${W / 2}px;top:${H / 2}px;width:0;height:0`;
      bubble.style.left = `${(W - 340) / 2}px`;
      bubble.style.top = `${H / 3}px`;
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;
    const bh = bubble.offsetHeight || 180;
    const below = r.bottom + pad + 12;
    const top = below + bh < H ? below : Math.max(10, r.top - pad - 12 - bh);
    bubble.style.top = `${top}px`;
    bubble.style.left = `${Math.max(10, Math.min(W - 350, r.left + r.width / 2 - 170))}px`;
  }

  function end() {
    $("tour-layer").hidden = true;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", reposition);
    App.ZR.Prefs.set("tourSeen", true);
  }

  return { start, end, STEPS };
})());
