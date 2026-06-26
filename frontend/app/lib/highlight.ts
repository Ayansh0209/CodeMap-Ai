// Shared highlight.js setup — core engine + just the languages CodeMap
// analyzes (keeps the bundle small). Same set CodeViewer registers; hljs/lib/core
// is a singleton so registering here is safe and shared.

import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";

let registered = false;
function ensureRegistered() {
  if (registered) return;
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("tsx", typescript);
  hljs.registerLanguage("jsx", javascript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("cpp", cpp);
  registered = true;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  html: "xml", css: "css", json: "json", py: "python", go: "go",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
};

export function langFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return EXT_LANG[ext] || "typescript";
}

/** Returns highlighted HTML (hljs classes); falls back to escaped text. */
export function highlightCode(code: string, language: string): string {
  ensureRegistered();
  try {
    return hljs.highlight(code, { language }).value;
  } catch {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
