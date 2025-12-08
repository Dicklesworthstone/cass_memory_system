// Back-compat re-export shim. The main implementation lives in sanitize.ts.
export {
  sanitize,
  compileExtraPatterns,
  SECRET_PATTERNS,
  type SanitizationConfig,
  verifySanitization,
} from "./sanitize.js";
