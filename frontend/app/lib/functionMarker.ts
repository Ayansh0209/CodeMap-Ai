// app/lib/functionMarker.ts
// ─────────────────────────────────────────────────────────────────────────────
// Language-aware "marker" badge for a function row.
//
// The backend stores isExported with language-correct semantics, but "exported"
// is a JS/TS concept. Rendering the same "exp" badge for every language is wrong:
//   - Go      : exported == capitalized identifier (a real Go concept) → "exported"
//   - Python  : no exports; convention is _underscore = non-public        → "private"
//   - C / C++ : linkage — `static` == file-local; otherwise global        → "static"
//               header prototypes (no body)                               → "decl"
//   - JS / TS : ES module export                                          → "exp"
//
// We derive the language from the file extension so the badge works anywhere a
// function is rendered (details panel, function graph) without threading the
// parent file through. .h is treated as C-family; "static"/"decl" are identical
// for C and C++ so the c/cpp ambiguity does not matter here.
// ─────────────────────────────────────────────────────────────────────────────

export interface FunctionMarker {
  label: string;
  bg: string;
  color: string;
  title: string;
}

type Family = "ts" | "js" | "python" | "go" | "c" | "cpp" | "other";

const BLUE = { bg: "rgba(56,139,253,0.15)", color: "#58a6ff" };
const MUTED = { bg: "rgba(139,148,158,0.15)", color: "#8b949e" };
const PURPLE = { bg: "rgba(163,113,247,0.15)", color: "#a371f7" };

function familyFromPath(filePath: string): Family {
  const m = filePath.toLowerCase().match(/\.([a-z0-9+]+)$/);
  const ext = m ? m[1] : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "ts";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "py":
    case "pyi":
      return "python";
    case "go":
      return "go";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "c++":
    case "hpp":
    case "hh":
    case "hxx":
      return "cpp";
    default:
      return "other";
  }
}

interface MarkerInput {
  isExported: boolean;
  isDeclaration?: boolean;
  filePath: string;
}

/**
 * Returns the single most relevant marker for a function, or null when there is
 * nothing meaningful to show (e.g. a plain global C function, a public Python
 * function, an unexported Go func).
 */
export function functionMarker(fn: MarkerInput): FunctionMarker | null {
  const family = familyFromPath(fn.filePath);

  // C/C++ header prototype takes precedence — it is the most informative tag.
  if (fn.isDeclaration && (family === "c" || family === "cpp")) {
    return { label: "decl", ...PURPLE, title: "Forward declaration / prototype (no body)" };
  }

  switch (family) {
    case "ts":
    case "js":
      return fn.isExported
        ? { label: "exp", ...BLUE, title: "Exported from its module" }
        : null;

    case "go":
      // Go: capitalized identifier == exported (package-public).
      return fn.isExported
        ? { label: "exported", ...BLUE, title: "Exported (capitalized) — visible outside its package" }
        : null;

    case "python":
      // Python: leading underscore == non-public by convention.
      return fn.isExported
        ? null
        : { label: "private", ...MUTED, title: "Underscore-prefixed — non-public by convention" };

    case "c":
    case "cpp":
      // C/C++: `static` == internal linkage (file-local). Global is the norm, so
      // only the file-local case is worth a badge.
      return fn.isExported
        ? null
        : { label: "static", ...MUTED, title: "static — internal linkage (file-local)" };

    default:
      // Unknown language: fall back to the generic exported flag if set.
      return fn.isExported ? { label: "exp", ...BLUE, title: "Exported" } : null;
  }
}
