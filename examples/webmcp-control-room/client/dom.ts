// Tiny DOM helpers. No framework. Escapes text by default; use rawHtml with care.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  children: Array<Node | string | number | null | undefined | false> = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class" || k === "className") {
      el.className = String(v);
    } else if (k === "style" && typeof v === "object") {
      Object.assign(el.style, v as Record<string, string>);
    } else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "data" && typeof v === "object") {
      for (const [dk, dv] of Object.entries(v as Record<string, string>)) {
        el.dataset[dk] = String(dv);
      }
    } else if (typeof v === "boolean") {
      if (v) el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

export function text(s: string | number | null | undefined): Text {
  return document.createTextNode(String(s ?? ""));
}

export function frag(...children: Array<Node | string | null | undefined | false>): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of children) {
    if (c == null || c === false) continue;
    f.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return f;
}

export function replace(target: Element, next: Node): void {
  target.replaceChildren(next);
}
