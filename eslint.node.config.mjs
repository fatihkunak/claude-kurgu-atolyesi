// Node betikleri için lint (src/ Remotion/React kodu eslint.config.mjs ile kontrol edilir).
//   npm run lint:node
// Amaç: tanımsız değişken, kullanılmayan değişken ve açık mantık hatalarını yakalamak; stil dayatmaz.
const nodeGlobals = Object.fromEntries(
  [
    "process", "Buffer", "console", "fetch", "URL", "URLSearchParams", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "setImmediate", "structuredClone", "AbortController", "AbortSignal", "TextDecoder", "TextEncoder", "performance", "queueMicrotask",
    "Blob", "FormData", "Headers", "Request", "Response", "WebSocket", "crypto", "globalThis", "__dirname", "__filename",
  ].map((n) => [n, "readonly"]),
);

export default [
  { ignores: ["node_modules/**", "out/**", "projects/**", "public/**", "work/**", "studio/desktop/**", "studio/app.jsx", "src/**"] },
  {
    files: ["scripts/**/*.mjs", "studio/**/*.mjs", "tests/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: nodeGlobals },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-dupe-else-if": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-unsafe-finally": "error",
      "no-cond-assign": ["error", "except-parens"],
      "no-fallthrough": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "use-isnan": "error",
      "valid-typeof": "error",
    },
  },
];
