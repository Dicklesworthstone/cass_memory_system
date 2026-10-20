import path from "node:path";
import { addBullet, deprecateBullet, findBullet } from "./playbook.js";
import { checkForDemotion, checkForPromotion, getDecayedCounts } from "./scoring.js";
import { cosineSimilarity, type SemanticDedupIndex } from "./semantic.js";
import type {
  Config,
  CurationResult,
  DecisionLogEntry,
  InversionReport,
  Playbook,
  PlaybookBullet,
  PlaybookDelta,
} from "./types.js";
import {
  generateBulletId,
  hashContent,
  jaccardSimilarity,
  jaccardSimilaritySets,
  log,
  STOP_WORDS,
  stemToken,
  now,
  tokenize,
} from "./utils.js";
import { canonicalWorkspacePath, ruleScopeKey, sameRuleInterpretation, sameRuleScope, workspaceMatches } from "./workspace.js";

function findSimilarBulletFromMeta(
  newTokens: Set<string>,
  metaList: ConflictMeta[],
  threshold: number,
  newClauses: DirectiveClause[],
): PlaybookBullet | undefined {
  let bestDeprecated: PlaybookBullet | undefined;

  for (const meta of metaList) {
    const b = meta.bullet;
    // "Mock the database in unit tests" and "Never mock the database in unit
    // tests" share 6 of 7 tokens; word overlap alone would merge them.
    if (directivesDisagree(newClauses, meta.clauses)) continue;
    const isDeprecated =
      Boolean(b.deprecated) || b.maturity === "deprecated" || b.state === "retired";

    // Fast skip based on size difference
    // Jaccard = intersection / union.
    // Max intersection = min(A, B). Min union = max(A, B).
    // Max Jaccard = min(A, B) / max(A, B).
    const sizeA = newTokens.size;
    const sizeB = meta.tokens.size;
    if (sizeA === 0 && sizeB === 0) return b; // Both empty = match
    if (sizeA === 0 || sizeB === 0) continue; // One empty = 0 similarity

    const maxPossible = Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB);
    if (maxPossible < threshold) continue;

    const sim = jaccardSimilaritySets(newTokens, meta.tokens);
    if (sim >= threshold) {
      if (!isDeprecated) {
        return b; // Return active match immediately (priority)
      }
      if (!bestDeprecated) {
        bestDeprecated = b; // Save deprecated match as fallback
      }
    }
  }

  return bestDeprecated;
}

// --- Helper: Conflict Detection ---
//
// Topic overlap is useful for protecting deduplication, but is not evidence of
// a contradiction (#95). Reporting requires parsed instructions with the same
// actor, action, object and overlapping conditions, and opposite polarity.
// This deliberately recognizes a limited grammar: an unparsed instruction is
// unknown, not a confirmed conflict and not proof that it is safe to merge.

const NEGATIVE_MARKERS = [
  "never",
  "dont",
  "don't",
  "do not",
  "does not",
  "must not",
  "should not",
  "shouldn't",
  "mustn't",
  "avoid",
  "forbid",
  "forbidden",
  "disable",
  "prevent",
  "stop",
  "skip",
  "no longer",
];
const POSITIVE_MARKERS = ["always", "must", "required", "ensure", "use", "enable", "prefer"];
const EXCEPTION_MARKERS = ["unless", "except", "only if", "only when", "except when"];

/** Directive and filler words that say how strongly, not what about. */
const DIRECTIVE_WORDS = new Set([
  "always",
  "never",
  "must",
  "should",
  "shall",
  "required",
  "require",
  "ensure",
  "use",
  "using",
  "used",
  "prefer",
  "enable",
  "disable",
  "avoid",
  "forbid",
  "forbidden",
  "prevent",
  "stop",
  "skip",
  "dont",
  "don",
  "do",
  "does",
  "not",
  "no",
  "longer",
  "unless",
  "except",
  "only",
  "when",
  "if",
  "make",
  "sure",
]);

/** Topic overlap protects deduplication only; it cannot establish a conflict. */
const DEDUP_GUARD_MIN_SHARED = 2;
const DEDUP_GUARD_MIN_OVERLAP = 0.5;

function hasMarker(text: string, markers: string[]): boolean {
  // Use word boundaries to avoid substring matches (e.g., "use" matching "user")
  const lower = text.toLowerCase();
  return markers.some((m) => new RegExp(`\\b${m}\\b`, "i").test(lower));
}

type ClausePolarity = "negative" | "positive" | "neutral";

interface DirectiveClause {
  text: string;
  polarity: ClausePolarity;
  exception: boolean;
  topic: Set<string>;
  directive: ParsedDirective | null;
}

interface ParsedDirective {
  actor: string;
  verb: string;
  object: string;
  negative: boolean;
  universal: boolean;
  condition: string | null;
  requiresAction: boolean;
}

export interface ConflictEvidence {
  kind: "opposite-directives";
  aClause: string;
  bClause: string;
  action: string;
  condition: string | null;
}

// A bounded command vocabulary prevents descriptive prose ("The tests do not
// fail") from being mistaken for an imperative. Inflections apply to the verb
// only; retrieval stemming must never erase object qualifiers or identifiers.
const ACTION_VERBS = new Set([
  "accept", "add", "allow", "apply", "attribute", "block", "cache", "check",
  "commit", "compare", "configure", "copy", "create", "delete", "deploy",
  "disable", "document", "drop", "emit", "enable", "encrypt", "enforce",
  "establish", "exclude", "execute", "include", "inspect", "install", "keep",
  "load", "log", "merge", "mock", "omit", "pin", "preserve", "publish",
  "push", "read", "record", "reject", "release", "remove", "reproduce",
  "require", "retain", "retry", "review", "run", "sanitize", "save", "set",
  "sign", "skip", "start", "stop", "store", "supply", "test", "update",
  "use", "validate", "verify", "wait", "write",
]);

function actionVerb(word: string): string | null {
  if (ACTION_VERBS.has(word)) return word;
  for (const verb of ACTION_VERBS) {
    if (
      word === `${verb}s` || word === `${verb}ing` ||
      (verb.endsWith("e") && word === `${verb.slice(0, -1)}ing`) ||
      word === `${verb}${verb.at(-1)}ing`
    ) return verb;
  }
  return null;
}

/** Keep order, negation, prepositions, numbers and code intact. */
function instructionText(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => part.startsWith("`") ? part : part.toLowerCase().replace(/\bthe\s+/g, ""))
    .join("")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function conditionText(text: string): string {
  return instructionText(text).replace(/^when\b/, "if");
}

function parseDirective(clause: string): ParsedDirective | null {
  let text = instructionText(clause);
  const conditions: string[] = [];

  // A leading condition must have an unambiguous boundary. Never borrow its
  // negation ("If tests do not pass, ...") as the action's polarity.
  if (/^(?:if|when|unless|before|after|while|once|until|during|in|for)\b/.test(text)) {
    const comma = text.indexOf(",");
    if (comma < 0) return null;
    conditions.push(conditionText(text.slice(0, comma)));
    text = text.slice(comma + 1).trim();
  }

  // Ignore the rationale, not restrictions such as "without expiry". These
  // purpose constructions account for many unrelated negations in long rules.
  text = text.split(/\s+(?:because|so that|in order to|to (?:avoid|prevent|improve|reduce|increase|keep|save)|for performance)\b/, 1)[0].trim();

  // Only-if/except/unless restrict applicability; they do not instruct the
  // opposite behavior in the exception. Preserve the marker in the condition.
  const only = text.startsWith("only ");
  if (only) text = text.slice(5);
  const suffix = /\s+(only if|only when|except(?: when| if)?|unless|if|when|while|until)\s+/.exec(text);
  if (suffix) {
    conditions.push(conditionText(`${only ? "only " : ""}${text.slice(suffix.index).trim()}`));
    text = text.slice(0, suffix.index).trim();
  } else if (only) {
    return null;
  }

  // Combinations, quotations and subordinate predicates are outside this
  // grammar. Guessing their scope would reintroduce the bag-of-words bug.
  if (!text || /[,;!?\n"“”()[\]{}]|\b(?:and|or|that|which|who|whether|why|how)\b/.test(text)) return null;

  let actor = "";
  let negative = false;
  let universal = false;
  const modal = /^(?:(.+?)\s+)?(must|should|shall)\s+/.exec(text);
  if (modal) {
    actor = modal[1] === "you" ? "" : (modal[1] ?? "");
    if (actor && !/^[a-z][a-z0-9 _-]*$/.test(actor)) return null;
    if (actor && actionVerb(actor.split(" ")[0])) return null;
    universal = modal[2] === "must" || modal[2] === "shall";
    text = text.slice(modal[0].length);
  }
  if (/^(?:always|never)\s+/.test(text)) {
    negative = text.startsWith("never ");
    universal = true;
    text = text.replace(/^(?:always|never)\s+/, "");
  } else {
    const negation = /^(?:do not|don't|dont|must not|mustn't|should not|shouldn't|shall not|not)\s+/.exec(text);
    if (negation) {
      negative = true;
      universal = true;
      text = text.slice(negation[0].length);
    }
  }

  const avoid = /^(?:avoid|forbid|prevent)[:\s]+/.exec(text);
  if (avoid) {
    negative = !negative;
    universal = true;
    text = text.slice(avoid[0].length);
    // Avoiding a named feature is directly opposed to enabling that feature.
    // Do not generalize this to arbitrary nouns or equate "use" with "enable".
    if (!actionVerb(text.split(" ")[0]) && /^[a-z -]+\b(?:validation|logging|caching|authentication|authorization|encryption)$/.test(text)) {
      text = `enable ${text}`;
    }
  }
  text = text.replace(/^use mocks? (?:for|of)\s+/, "mock ");
  const command = /^([a-z]+)\s+(.+)$/.exec(text);
  if (!command) return null;
  let verb = actionVerb(command[1]);
  if (!verb) return null;
  if (command[1] !== verb && !avoid) return null;
  // Only this explicit state inverse is normalized. "Skip tests" and "run
  // tests" need not mean exact opposites (e.g. skip a particular test phase).
  if (verb === "disable") {
    verb = "enable";
    negative = !negative;
  }
  return {
    actor, verb, object: command[2], negative, universal,
    condition: conditions.length > 0 ? conditions.join("; ") : null,
    // "Only do X if Y" is a prerequisite, not a requirement to do X. Never
    // infer an affirmative duty from it; not doing X can satisfy both rules.
    requiresAction: negative || !conditions.some((c) => /^only (?:if|when)\b/.test(c)),
  };
}

/** Keep punctuation inside quotations/code/nested examples out of clause splitting. */
function protectedDirectiveSpans(content: string): { spans: [number, number][]; unclosed: boolean } {
  const spans: [number, number][] = [];
  const brackets: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quote !== null) {
      if (char === "\\") { i++; continue; }
      if ((quote === "'" || quote === "’") && char === quote &&
          /\w/.test(content[i - 1] ?? "") && /\w/.test(content[i + 1] ?? "")) continue;
      if (char === quote) {
        quote = null;
        if (brackets.length === 0) spans.push([start, i + 1]);
      }
      continue;
    }
    if (char === "`" || char === '"' || char === "“" || char === "‘" ||
        (char === "'" && (i === 0 || !/\w/.test(content[i - 1])))) {
      if (brackets.length === 0) start = i;
      quote = char === "“" ? "”" : char === "‘" ? "’" : char;
    } else if ("([{".includes(char)) {
      if (brackets.length === 0) start = i;
      brackets.push(char === "(" ? ")" : char === "[" ? "]" : "}");
    } else if (brackets.length > 0 && char === brackets.at(-1)) {
      brackets.pop();
      if (brackets.length === 0) spans.push([start, i + 1]);
    }
  }
  const unclosed = quote !== null || brackets.length > 0;
  if (unclosed) spans.push([start, content.length]);
  return { spans, unclosed };
}

/** Split a rule into directive clauses: sentence ends, semicolons, and "but"/"however". */
export function splitDirectiveClauses(content: string): DirectiveClause[] {
  const { spans: protectedSpans, unclosed } = protectedDirectiveSpans(content);
  const fragments: { text: string; newSentence: boolean }[] = [];
  let start = 0;
  let newSentence = true;
  for (const match of content.matchAll(/[;!?\n]+|\.(?=\s|$)|\s[-\u2013\u2014]\s|\bbut\b|\bhowever\b/gi)) {
    const position = match.index!;
    if (protectedSpans.some(([from, to]) => position >= from && position < to)) continue;
    fragments.push({ text: content.slice(start, position), newSentence });
    newSentence = /[.!?\n]/.test(match[0]);
    start = position + match[0].length;
  }
  fragments.push({ text: content.slice(start), newSentence });

  let inheritedCondition: string | null = null;
  return fragments
    .map((fragment) => {
      const clause = fragment.text.trim();
      if (fragment.newSentence) inheritedCondition = null;
      const negative = hasMarker(clause, NEGATIVE_MARKERS);
      const positive = !negative && hasMarker(clause, POSITIVE_MARKERS);
      const topic = new Set(
        tokenize(clause)
          .filter((t) => !STOP_WORDS.has(t) && !DIRECTIVE_WORDS.has(t))
          .map(stemToken),
      );
      const directive = unclosed ? null : parseDirective(clause);
      if (directive) {
        if (directive.condition === null && inheritedCondition !== null) directive.condition = inheritedCondition;
        if (!directive.negative && /^only (?:if|when)\b/.test(directive.condition ?? "")) directive.requiresAction = false;
        inheritedCondition = directive.condition;
      } else {
        // Even an unsupported action can introduce a condition governing the
        // remaining clauses in its sentence.
        const prefix = /^(if|when|unless|before|after|while|once|until|during|in|for)\b[^,]*,/i.exec(clause);
        if (prefix) inheritedCondition = conditionText(prefix[0].slice(0, -1));
      }
      return {
        text: clause,
        polarity: negative ? "negative" : positive ? "positive" : "neutral",
        exception: hasMarker(clause, EXCEPTION_MARKERS),
        topic,
        directive,
      } as DirectiveClause;
    })
    .filter((c) => c.topic.size > 0 || c.directive !== null);
}

function sameTopic(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared >= DEDUP_GUARD_MIN_SHARED && shared / Math.min(a.size, b.size) >= DEDUP_GUARD_MIN_OVERLAP;
}

/**
 * Whether two rules point opposite ways: a negating clause on one side only,
 * or a clause-level conflict. Such rules are never duplicates, however
 * similar their words or embeddings (opposite directives score 0.88-0.98
 * cosine on all-MiniLM-L6-v2).
 */
export function directivesDisagree(a: DirectiveClause[], b: DirectiveClause[]): boolean {
  const aNeg = a.some((c) => c.polarity === "negative");
  const bNeg = b.some((c) => c.polarity === "negative");
  if (aNeg !== bNeg || clauseConflict(a, b) !== null) return true;
  // The evidence needed to *merge* is stronger than the evidence needed to
  // abstain from reporting a conflict. Preserve uncertain polarity/exception
  // differences and differently qualified versions of the same action.
  for (const ca of a) {
    for (const cb of b) {
      if (!sameTopic(ca.topic, cb.topic)) continue;
      if (ca.exception !== cb.exception || (ca.polarity === "negative") !== (cb.polarity === "negative")) return true;
      const da = ca.directive;
      const db = cb.directive;
      if (da && db && da.verb === db.verb && da.actor === db.actor) {
        if (da.negative !== db.negative || da.condition !== db.condition) return true;
        const qualifiers = (object: string) => {
          const match = /\b(?:with|without|before|after|only)\b.*$/.exec(object);
          return (match?.[0] ?? "").replace(/\b(with|without) any\b/g, "$1");
        };
        if (qualifiers(da.object) !== qualifiers(db.object)) return true;
      }
    }
  }
  return false;
}

function opposingObjects(a: ParsedDirective, b: ParsedDirective): boolean {
  if (a.object === b.object) return true;
  const prohibition = a.negative ? a : b;
  const instruction = a.negative ? b : a;
  if (!prohibition.universal) return false;
  // A prohibition on committing a lockfile also covers committing it with a
  // dependency change. The other direction would incorrectly erase limits
  // such as "without expiry" from a prohibition.
  if (instruction.object.startsWith(`${prohibition.object} `) &&
      /^(?:with|without|before|after|for|to|in|on|during|at|using)\b/.test(instruction.object.slice(prohibition.object.length + 1))) return true;
  // A blanket prohibition on a bare plural object covers an adjective-qualified
  // subset: "never drop columns" / "drop unused columns". The reverse is not
  // true: "never delete production logs" allows deleting other logs.
  return /^[a-z]+s$/.test(prohibition.object) &&
    /^[a-z -]+$/.test(instruction.object) &&
    !/\b(?:with|without|before|after|for|from|to|in|on|of|at|by|not|no|only)\b/.test(instruction.object) &&
    instruction.object.endsWith(` ${prohibition.object}`);
}

function overlappingConditions(a: ParsedDirective, b: ParsedDirective): boolean {
  if (a.condition === b.condition) return true;
  // Exact matching is intentional. Different conditions might overlap, but
  // lexical similarity cannot prove that. An explicit universal instruction
  // does cover a scoped instruction, including an explicitly scoped opposite.
  return (a.condition === null && a.universal) || (b.condition === null && b.universal);
}

/** First directly opposing clause pair between two rules, or null. */
function clauseConflict(a: DirectiveClause[], b: DirectiveClause[]): { reason: string; evidence: ConflictEvidence } | null {
  for (const ca of a) {
    const da = ca.directive;
    if (!da) continue;
    for (const cb of b) {
      const db = cb.directive;
      if (!db || !da.requiresAction || !db.requiresAction || da.negative === db.negative || da.verb !== db.verb || da.actor !== db.actor) continue;
      if (!opposingObjects(da, db) || !overlappingConditions(da, db)) continue;
      const action = `${da.verb} ${da.negative ? db.object : da.object}`;
      const condition = da.condition ?? db.condition;
      return {
        reason: `Direct instruction conflict: opposing guidance to ${action}${condition ? ` (${condition})` : ""}; review applicability`,
        evidence: { kind: "opposite-directives", aClause: ca.text, bClause: cb.text, action, condition },
      };
    }
  }
  return null;
}

/** Validate a merge before creating replacements or retiring any source. */
export function validateMergeSources(
  bullets: PlaybookBullet[],
  mergedContent: string,
  options: { allowImplicitWorkspace?: boolean } = {},
): string | null {
  if (bullets.length < 2 || new Set(bullets.map((b) => b.id)).size !== bullets.length) {
    return "A merge requires at least two distinct source rules";
  }
  if (!mergedContent.trim()) return "Merged content must not be empty";
  if (bullets.some((b) => b.deprecated || b.maturity === "deprecated" || b.state === "retired")) {
    return "A merge cannot retire or revive already inactive source rules";
  }
  const first = bullets[0];
  if (bullets.some((b) => !sameRuleScope(first, b, options))) {
    return "A merge requires source rules with the same applicability";
  }
  if (bullets.some((b) => !sameRuleInterpretation(first, b))) {
    return "A merge cannot combine rules and anti-patterns";
  }
  const replacement = splitDirectiveClauses(mergedContent);
  const clauses = bullets.map((b) => splitDirectiveClauses(b.content));
  for (let i = 0; i < clauses.length; i++) {
    if (clauseConflict(clauses[i], replacement)) return "Merged content directly opposes a source rule";
    for (let j = i + 1; j < clauses.length; j++) {
      if (clauseConflict(clauses[i], clauses[j])) return "Opposing source rules require review before merging";
    }
  }
  return null;
}

// Optimized metadata structure for conflict detection (and token-based dedup)
export interface ConflictMeta {
  bullet: PlaybookBullet;
  tokens: Set<string>;
  clauses: DirectiveClause[];
}

export function computeConflictMeta(bullet: PlaybookBullet): ConflictMeta {
  return {
    bullet,
    tokens: new Set(tokenize(bullet.content)),
    clauses: splitDirectiveClauses(bullet.content),
  };
}

type ConflictScope = Partial<Pick<PlaybookBullet, "scope" | "scopeKey" | "workspace">>;

/** Scope metadata is part of applicability, independently of the rule's words. */
function createScopeMatcher(): (a: ConflictScope, b: ConflictScope) => boolean {
  const canonicalPaths = new Map<string, string>();
  const workspacePairs = new Map<string, boolean>();
  const canonical = (workspace: string): string => {
    let resolved = canonicalPaths.get(workspace);
    if (resolved === undefined) {
      resolved = canonicalWorkspacePath(workspace);
      canonicalPaths.set(workspace, resolved);
    }
    return resolved;
  };
  const within = (child: string, parent: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };

  return (a, b) => {
    const aScope = a.scope ?? "global";
    const bScope = b.scope ?? "global";
    const aWorkspace = a.workspace?.trim();
    const bWorkspace = b.workspace?.trim();
    // A missing workspace may be implicit in a repo playbook. Its provenance
    // is unavailable here, so do not invent a scope for a confirmed match.
    if ((aScope === "workspace" && !aWorkspace) || (bScope === "workspace" && !bWorkspace)) {
      return false;
    }
    if (aScope !== bScope || aScope === "global") return true;
    if (aScope !== "workspace") {
      const aKey = a.scopeKey?.trim();
      const bKey = b.scopeKey?.trim();
      return !aKey || !bKey || aKey === bKey;
    }

    const aPath = canonical(aWorkspace!);
    const bPath = canonical(bWorkspace!);
    if (aPath === bPath) return true;
    // Most distinct projects are disjoint. Reject them without pairwise
    // filesystem work or storing an O(n^2) cache of negative comparisons.
    if (!within(aPath, bPath) && !within(bPath, aPath)) return false;
    const key = JSON.stringify([aPath, bPath].sort());
    const cached = workspacePairs.get(key);
    if (cached !== undefined) return cached;
    // Ancestor scopes can overlap, except across an independent nested repo.
    const overlaps = workspaceMatches(aWorkspace!, bWorkspace!) || workspaceMatches(bWorkspace!, aWorkspace!);
    if (workspacePairs.size >= 1024) workspacePairs.clear();
    workspacePairs.set(key, overlaps);
    return overlaps;
  };
}

export function detectConflicts(
  newContent: string,
  existingBullets: PlaybookBullet[],
  newScope: ConflictScope = {},
): { id: string; content: string; reason: string; evidence: ConflictEvidence }[] {
  const meta = existingBullets.map(computeConflictMeta);
  return detectConflictsWithMeta(newContent, meta, newScope);
}

export function detectConflictsWithMeta(
  newContent: string,
  existingMeta: ConflictMeta[],
  newScope: ConflictScope = {},
): { id: string; content: string; reason: string; evidence: ConflictEvidence }[] {
  const conflicts: { id: string; content: string; reason: string; evidence: ConflictEvidence }[] = [];
  const newClauses = splitDirectiveClauses(newContent);
  if (newClauses.length === 0) return conflicts;
  const scopesOverlap = createScopeMatcher();

  for (const m of existingMeta) {
    // Skip deprecated/retired bullets - consistent with isDeprecated helper
    if (m.bullet.deprecated || m.bullet.maturity === "deprecated" || m.bullet.state === "retired")
      continue;
    const match = clauseConflict(newClauses, m.clauses);
    if (match && scopesOverlap(newScope, m.bullet)) {
      conflicts.push({ id: m.bullet.id, content: m.bullet.content, ...match });
    }
  }

  return conflicts;
}

export interface BulletConflictPair {
  a: { id: string; content: string };
  b: { id: string; content: string };
  reason: string;
  evidence: ConflictEvidence;
}

/**
 * Directly opposing pairs among active bullets, each pair reported once.
 * Index by actor/action/object head and compare only opposite polarities. This
 * avoids all-pairs topic scans on large, mostly compatible playbooks. Dense
 * genuinely conflicting groups still require work proportional to the output.
 */
export function findBulletConflicts(bullets: PlaybookBullet[]): BulletConflictPair[] {
  const active = bullets
    .filter((b) => !(b.deprecated || b.maturity === "deprecated" || b.state === "retired"))
    .map(computeConflictMeta);
  const pairs: BulletConflictPair[] = [];
  const scopesOverlap = createScopeMatcher();
  const index = new Map<string, { positive: Set<number>; negative: Set<number> }>();
  const key = (d: ParsedDirective) => {
    const object = d.object.split(/\s+(?:with|without|before|after|for|from|to|in|on|during|at|using)\b/, 1)[0];
    return `${d.actor}\0${d.verb}\0${object.split(" ").at(-1)}`;
  };
  for (let i = 0; i < active.length; i++) {
    for (const clause of active[i].clauses) {
      const d = clause.directive;
      if (!d) continue;
      const k = key(d);
      let group = index.get(k);
      if (!group) {
        group = { positive: new Set(), negative: new Set() };
        index.set(k, group);
      }
      (d.negative ? group.negative : group.positive).add(i);
    }
  }
  for (let i = 0; i < active.length; i++) {
    const candidates = new Set<number>();
    for (const clause of active[i].clauses) {
      const d = clause.directive;
      if (!d) continue;
      const group = index.get(key(d))!;
      for (const j of d.negative ? group.positive : group.negative) {
        if (j > i) candidates.add(j);
      }
    }
    for (const j of [...candidates].sort((a, b) => a - b)) {
      if (!scopesOverlap(active[i].bullet, active[j].bullet)) continue;
      const match = clauseConflict(active[i].clauses, active[j].clauses);
      if (!match) continue;
      pairs.push({
        a: { id: active[i].bullet.id, content: active[i].bullet.content },
        b: { id: active[j].bullet.id, content: active[j].bullet.content },
        ...match,
      });
    }
  }
  return pairs;
}

// --- Helper: Decision Logging ---

function logDecision(
  decisionLog: DecisionLogEntry[],
  phase: DecisionLogEntry["phase"],
  action: DecisionLogEntry["action"],
  reason: string,
  options?: { bulletId?: string; content?: string; details?: Record<string, unknown> },
): void {
  decisionLog.push({
    timestamp: now(),
    phase,
    action,
    reason,
    bulletId: options?.bulletId,
    content: options?.content,
    details: options?.details,
  });
}

// --- Helper: Anti-Pattern Inversion ---

function invertToAntiPattern(bullet: PlaybookBullet, config: Config): PlaybookBullet {
  const reason = `Marked harmful ${bullet.harmfulCount} times`;
  const cleaned = bullet.content
    .replace(/^(always |prefer |use |try |consider |ensure )/i, "")
    .trim();
  const invertedContent = `AVOID: ${cleaned}. ${reason}`;

  return {
    id: generateBulletId(),
    content: invertedContent,
    category: bullet.category,
    kind: "anti_pattern",
    type: "anti-pattern",
    isNegative: true,
    scope: bullet.scope,
    scopeKey: bullet.scopeKey,
    workspace: bullet.workspace,
    source: "learned", // Derived from existing rule, so implicitly learned/inferred
    state: "active",
    maturity: "candidate",
    createdAt: now(),
    updatedAt: now(),
    // Copy provenance arrays to avoid aliasing mutations between bullets.
    sourceSessions: [...(bullet.sourceSessions || [])],
    sourceAgents: [...(bullet.sourceAgents || [])],
    tags: [...(bullet.tags || []), "inverted", "anti-pattern"],
    feedbackEvents: [],
    helpfulCount: 0,
    harmfulCount: 0,
    deprecated: false,
    pinned: false,
    confidenceDecayHalfLifeDays: config.scoring.decayHalfLifeDays,
  };
}

// --- Main Curator ---

/**
 * Most similar active bullet by embedding, at or above the index threshold.
 * Bullets without an embedding in the index are skipped.
 *
 * Sentence embeddings barely register negation ("Always commit lockfiles" and
 * "Never commit lockfiles" sit close together), so a candidate whose
 * directives disagree with the new rule (any negating clause on one side
 * only, or a clause-level conflict) is never treated as a duplicate:
 * reinforcing it would credit the opposite advice.
 */
function findSemanticDuplicateFromMeta(
  content: string,
  metaList: ConflictMeta[],
  index: SemanticDedupIndex,
): { bullet: PlaybookBullet; similarity: number } | undefined {
  const query = index.embeddings.get(hashContent(content));
  if (!query) return undefined;
  const clauses = splitDirectiveClauses(content);
  let best: { bullet: PlaybookBullet; similarity: number } | undefined;
  for (const meta of metaList) {
    const b = meta.bullet;
    if (b.deprecated || b.maturity === "deprecated" || b.state === "retired") continue;
    if (directivesDisagree(clauses, meta.clauses)) continue;
    const vector = index.embeddings.get(hashContent(b.content));
    if (!vector) continue;
    const similarity = cosineSimilarity(query, vector);
    if (similarity >= index.threshold && (!best || similarity > best.similarity)) {
      best = { bullet: b, similarity };
    }
  }
  return best;
}

export function curatePlaybook(
  targetPlaybook: Playbook,
  deltas: PlaybookDelta[],
  config: Config,
  contextPlaybook?: Playbook,
  options: {
    /** Embeddings for reworded-duplicate detection (see buildSemanticDedupIndex). */
    semanticIndex?: SemanticDedupIndex;
    /** Only a known repo target can give pathless workspace rules one owner. */
    allowImplicitWorkspace?: boolean;
  } = {},
): CurationResult {
  // Use context playbook (merged) for dedup checks if available, otherwise target
  const referencePlaybook = contextPlaybook || targetPlaybook;

  // Optimization: Pre-compute maps for O(1) lookups and conflict detection.
  // This map tracks content hashes from BOTH the reference playbook AND newly added bullets in this batch.
  const bulletContentMap = new Map<string, PlaybookBullet[]>();
  const indexedHashes = new Map<string, string>();
  const conflictMeta: ConflictMeta[] = [];
  const metadataById = new Map<string, ConflictMeta>();
  const targetBulletIds = new Set(targetPlaybook.bullets.map((b) => b.id));
  const scopeKeys = new Map<PlaybookBullet, string | undefined>();
  const scopeKeyFor = (bullet: PlaybookBullet): string | undefined => {
    if (!scopeKeys.has(bullet)) scopeKeys.set(bullet, ruleScopeKey(bullet));
    return scopeKeys.get(bullet);
  };
  const inScope = (bullet: PlaybookBullet, incomingKey: string | undefined): boolean => {
    const existingKey = scopeKeyFor(bullet);
    if (existingKey === undefined || incomingKey === undefined) {
      // Portable repo rules have no absolute workspace. Their shared owner is
      // established only for the target layer, never an arbitrary merged layer.
      return options.allowImplicitWorkspace === true && existingKey === undefined && incomingKey === undefined
        && targetBulletIds.has(bullet.id);
    }
    return existingKey === incomingKey;
  };
  const indexBullet = (bullet: PlaybookBullet): void => {
    const oldHash = indexedHashes.get(bullet.id);
    if (oldHash !== undefined) {
      const remaining = (bulletContentMap.get(oldHash) ?? []).filter((b) => b.id !== bullet.id);
      if (remaining.length > 0) bulletContentMap.set(oldHash, remaining);
      else bulletContentMap.delete(oldHash);
    }
    const hash = hashContent(bullet.content);
    const bucket = bulletContentMap.get(hash) ?? [];
    bucket.push(bullet);
    bulletContentMap.set(hash, bucket);
    indexedHashes.set(bullet.id, hash);
    const next = computeConflictMeta(bullet);
    const previous = metadataById.get(bullet.id);
    if (previous) Object.assign(previous, next);
    else {
      conflictMeta.push(next);
      metadataById.set(bullet.id, next);
    }
  };
  for (const bullet of referencePlaybook.bullets) indexBullet(bullet);
  // A merged context can shadow an id with a different rule from another
  // layer. Writes and feedback must use the target's actual object/content.
  if (referencePlaybook !== targetPlaybook) {
    for (const bullet of targetPlaybook.bullets) indexBullet(bullet);
  }

  const decisionLog: DecisionLogEntry[] = [];

  const result: CurationResult = {
    playbook: targetPlaybook, // Mutating target
    applied: 0,
    skipped: 0,
    conflicts: [],
    promotions: [],
    inversions: [],
    pruned: 0,
    decisionLog,
  };

  // Consolidation must see the final edits and feedback from this batch. In
  // particular, a harmful/retired replacement must not retire healthy sources.
  const orderedDeltas = [...deltas.filter((d) => d.type !== "merge"), ...deltas.filter((d) => d.type === "merge")];
  for (const delta of orderedDeltas) {
    let applied = false;

    switch (delta.type) {
      case "add": {
        if (!delta.bullet?.content || !delta.bullet?.category) {
          logDecision(decisionLog, "add", "rejected", "Missing required content or category", {
            content: delta.bullet?.content?.slice(0, 100),
          });
          break;
        }

        const content = delta.bullet.content;
        const hash = hashContent(content);
        const incomingScope = ruleScopeKey(delta.bullet);
        const matchesIncoming = (bullet: PlaybookBullet): boolean => inScope(bullet, incomingScope)
          && sameRuleInterpretation(bullet, delta.bullet);

        // Conflict detection (warnings only)
        // Checks against reference AND newly added bullets (via updated conflictMeta)
        // Use optimized version with pre-computed meta
        const newTokens = tokenize(content);
        const newTokenSet = new Set(newTokens);

        // Note: detectConflictsWithMeta re-tokenizes internally if we pass string.
        // But we need newTokenSet for dedup anyway.
        // We can't easily pass Set to detectConflictsWithMeta without changing its signature or logic duplication.
        // For now, letting it re-tokenize is fine (it's fast), or we can refactor.
        // To be safe and minimal diff, we'll let it re-tokenize or just pass string.
        const conflicts = detectConflictsWithMeta(content, conflictMeta, delta.bullet);

        for (const c of conflicts) {
          result.conflicts.push({
            newBulletContent: content,
            conflictingBulletId: c.id,
            conflictingContent: c.content,
            reason: c.reason,
          });
          logDecision(decisionLog, "conflict", "skipped", c.reason, {
            content: content.slice(0, 100),
            bulletId: c.id,
            details: { conflictingContent: c.content.slice(0, 100) },
          });
        }

        // 1. Exact duplicate check (O(1) using map)
        const exactCandidates = (bulletContentMap.get(hash) ?? []).filter(matchesIncoming);
        const exactMatch = exactCandidates.find((b) => !b.deprecated && b.maturity !== "deprecated" && b.state !== "retired")
          ?? exactCandidates[0];

        if (exactMatch) {
          const isDeprecated =
            Boolean(exactMatch.deprecated) ||
            exactMatch.maturity === "deprecated" ||
            exactMatch.state === "retired";

          if (isDeprecated) {
            logDecision(
              decisionLog,
              "dedup",
              "skipped",
              "Exact duplicate exists but is deprecated",
              {
                content: content.slice(0, 100),
                bulletId: exactMatch.id,
              },
            );
            break;
          }

          // Try to find it in the target playbook (the one we are writing to)
          const targetBullet = findBullet(targetPlaybook, exactMatch.id);

          if (targetBullet) {
            targetBullet.feedbackEvents.push({
              type: "helpful",
              timestamp: now(),
              sessionPath: delta.sourceSession,
              context: "Reinforced by exact duplicate insight",
            });
            targetBullet.helpfulCount++;
            targetBullet.updatedAt = now();
            applied = true;
            logDecision(decisionLog, "dedup", "modified", "Reinforced existing exact duplicate", {
              bulletId: targetBullet.id,
              content: content.slice(0, 100),
            });
          } else {
            // It exists in the context (other layer) but not target. Skip to avoid duplication.
            logDecision(
              decisionLog,
              "dedup",
              "skipped",
              "Exact duplicate exists in other playbook layer",
              {
                content: content.slice(0, 100),
                bulletId: exactMatch.id,
              },
            );
          }
          break;
        }

        // 2. Semantic duplicate check (Optimized)
        // Uses pre-computed tokens from conflictMeta (which includes newly added bullets)
        const sameScopeMeta = conflictMeta.filter((meta) => matchesIncoming(meta.bullet));
        const lexicalSimilar = findSimilarBulletFromMeta(
          newTokenSet,
          sameScopeMeta,
          config.dedupSimilarityThreshold,
          splitDirectiveClauses(content),
        );
        // Word overlap misses rewordings ("Run tests before you push" vs
        // "Always execute the test suite prior to pushing"); embeddings catch them.
        const semanticMatch =
          !lexicalSimilar && options.semanticIndex
            ? findSemanticDuplicateFromMeta(content, sameScopeMeta, options.semanticIndex)
            : undefined;
        if (semanticMatch) {
          logDecision(decisionLog, "dedup", "modified", "Semantic duplicate of an existing rule", {
            bulletId: semanticMatch.bullet.id,
            content: content.slice(0, 100),
            details: {
              similarity: Math.round(semanticMatch.similarity * 1000) / 1000,
              similarTo: semanticMatch.bullet.content.slice(0, 100),
            },
          });
        }
        const similar = lexicalSimilar ?? semanticMatch?.bullet;

        if (similar) {
          const similarIsDeprecated =
            Boolean(similar.deprecated) ||
            similar.maturity === "deprecated" ||
            similar.state === "retired";

          // Never reinforce deprecated/blocked bullets; treat as a skip to prevent zombie rules.
          if (similarIsDeprecated) {
            logDecision(
              decisionLog,
              "dedup",
              "skipped",
              "Similar bullet exists but is deprecated; skipping to avoid resurrecting blocked content",
              {
                content: content.slice(0, 100),
                bulletId: similar.id,
                details: { similarTo: similar.content.slice(0, 100) },
              },
            );
            break;
          }

          const targetSimilar = findBullet(targetPlaybook, similar.id);
          if (targetSimilar) {
            const targetIsDeprecated =
              Boolean(targetSimilar.deprecated) ||
              targetSimilar.maturity === "deprecated" ||
              targetSimilar.state === "retired";

            if (targetIsDeprecated) {
              logDecision(
                decisionLog,
                "dedup",
                "skipped",
                "Similar bullet exists but is deprecated in target; not reinforcing",
                {
                  bulletId: targetSimilar.id,
                  content: content.slice(0, 100),
                  details: { similarTo: similar.content.slice(0, 100) },
                },
              );
              break;
            }

            targetSimilar.feedbackEvents.push({
              type: "helpful",
              timestamp: now(),
              sessionPath: delta.sourceSession,
              context: "Reinforced by similar insight",
            });
            targetSimilar.helpfulCount++;
            targetSimilar.updatedAt = now();
            applied = true;
            logDecision(decisionLog, "dedup", "modified", "Reinforced existing similar bullet", {
              bulletId: targetSimilar.id,
              content: content.slice(0, 100),
              details: {
                similarTo: similar.content.slice(0, 100),
                similarity: config.dedupSimilarityThreshold,
              },
            });
          } else {
            logDecision(
              decisionLog,
              "dedup",
              "skipped",
              "Similar bullet exists in repo playbook (or just added)",
              {
                content: content.slice(0, 100),
                details: { similarTo: similar.content.slice(0, 100) },
              },
            );
          }
          break;
        }

        // 3. Add new (to TARGET)
        // Preserve safe, schema-validated metadata from the delta where possible.
        const newBullet = addBullet(
          targetPlaybook,
          {
            id: delta.bullet.id,
            content,
            category: delta.bullet.category,
            tags: delta.bullet.tags,
            kind: delta.bullet.kind,
            type: delta.bullet.type,
            isNegative: delta.bullet.isNegative,
            scope: delta.bullet.scope,
            scopeKey: delta.bullet.scopeKey,
            workspace: delta.bullet.workspace,
            searchPointer: delta.bullet.searchPointer,
          },
          delta.sourceSession,
          config.scoring.decayHalfLifeDays,
        );

        if (typeof delta.reason === "string" && delta.reason.trim()) {
          newBullet.reasoning = delta.reason.trim();
        }

        // Update caches to catch duplicates later in this batch
        targetBulletIds.add(newBullet.id);
        indexBullet(newBullet);

        applied = true;
        logDecision(decisionLog, "add", "accepted", "New bullet added to playbook", {
          bulletId: newBullet.id,
          content: content.slice(0, 100),
          details: { category: delta.bullet.category, tags: delta.bullet.tags },
        });
        break;
      }

      case "helpful": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(
            decisionLog,
            "feedback",
            "rejected",
            "Bullet not found for helpful feedback",
            {
              bulletId: delta.bulletId,
            },
          );
          break;
        }

        // Idempotency check
        const alreadyRecorded = bullet.feedbackEvents.some(
          (e) =>
            e.type === "helpful" &&
            e.sessionPath &&
            delta.sourceSession &&
            e.sessionPath === delta.sourceSession,
        );

        if (alreadyRecorded) {
          logDecision(
            decisionLog,
            "feedback",
            "skipped",
            "Helpful feedback already recorded for this session",
            {
              bulletId: delta.bulletId,
            },
          );
          break;
        }

        bullet.feedbackEvents.push({
          type: "helpful",
          timestamp: now(),
          sessionPath: delta.sourceSession,
          context: delta.context,
        });
        bullet.helpfulCount++;
        bullet.lastValidatedAt = now();
        bullet.updatedAt = now();
        applied = true;
        logDecision(decisionLog, "feedback", "accepted", "Helpful feedback recorded", {
          bulletId: delta.bulletId,
          content: bullet.content.slice(0, 100),
          details: { helpfulCount: bullet.helpfulCount, context: delta.context },
        });
        break;
      }

      case "harmful": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(
            decisionLog,
            "feedback",
            "rejected",
            "Bullet not found for harmful feedback",
            {
              bulletId: delta.bulletId,
            },
          );
          break;
        }

        // Idempotency check
        const alreadyRecorded = bullet.feedbackEvents.some(
          (e) =>
            e.type === "harmful" &&
            e.sessionPath &&
            delta.sourceSession &&
            e.sessionPath === delta.sourceSession,
        );

        if (alreadyRecorded) {
          logDecision(
            decisionLog,
            "feedback",
            "skipped",
            "Harmful feedback already recorded for this session",
            {
              bulletId: delta.bulletId,
            },
          );
          break;
        }

        bullet.feedbackEvents.push({
          type: "harmful",
          timestamp: now(),
          sessionPath: delta.sourceSession,
          reason: delta.reason,
          context: delta.context,
        });
        bullet.harmfulCount++;
        bullet.updatedAt = now();
        applied = true;
        logDecision(decisionLog, "feedback", "accepted", "Harmful feedback recorded", {
          bulletId: delta.bulletId,
          content: bullet.content.slice(0, 100),
          details: { harmfulCount: bullet.harmfulCount, reason: delta.reason },
        });
        break;
      }

      case "replace": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(decisionLog, "add", "rejected", "Bullet not found for replacement", {
            bulletId: delta.bulletId,
          });
          break;
        }
        const oldContent = bullet.content;
        bullet.content = delta.newContent;
        bullet.updatedAt = now();
        indexBullet(bullet);
        applied = true;
        logDecision(decisionLog, "add", "modified", "Bullet content replaced", {
          bulletId: delta.bulletId,
          content: delta.newContent.slice(0, 100),
          details: { previousContent: oldContent.slice(0, 100) },
        });
        break;
      }

      case "deprecate": {
        if (deprecateBullet(targetPlaybook, delta.bulletId, delta.reason, delta.replacedBy)) {
          applied = true;
          logDecision(decisionLog, "demotion", "accepted", "Bullet deprecated", {
            bulletId: delta.bulletId,
            details: { reason: delta.reason, replacedBy: delta.replacedBy },
          });
        } else {
          logDecision(decisionLog, "demotion", "rejected", "Failed to deprecate bullet", {
            bulletId: delta.bulletId,
          });
        }
        break;
      }

      case "merge": {
        applyCurationLifecycle(targetPlaybook, config, result);
        for (const bullet of targetPlaybook.bullets) {
          if (!metadataById.has(bullet.id)) {
            targetBulletIds.add(bullet.id);
            indexBullet(bullet);
          }
        }
        // Only merge if all bullets exist in target
        const bulletsToMerge = delta.bulletIds
          .map((id) => findBullet(targetPlaybook, id))
          .filter((b) => b !== undefined) as PlaybookBullet[];

        if (bulletsToMerge.length !== delta.bulletIds.length || bulletsToMerge.length < 2) {
          logDecision(
            decisionLog,
            "add",
            "rejected",
            "Cannot merge: missing bullets or insufficient count",
            {
              details: { requested: delta.bulletIds.length, found: bulletsToMerge.length },
            },
          );
          break;
        }
        const invalid = validateMergeSources(bulletsToMerge, delta.mergedContent, { allowImplicitWorkspace: options.allowImplicitWorkspace });
        if (invalid) {
          logDecision(decisionLog, "add", "rejected", invalid, { details: { sourceIds: delta.bulletIds } });
          break;
        }

        const source = bulletsToMerge[0];
        const mergeScope = scopeKeyFor(source);
        const compatible = (bullet: PlaybookBullet): boolean => inScope(bullet, mergeScope)
          && sameRuleInterpretation(bullet, source);
        const candidates = conflictMeta.filter((meta) => compatible(meta.bullet));
        const exact = (bulletContentMap.get(hashContent(delta.mergedContent)) ?? [])
          .filter(compatible);
        const existing = exact.find((b) => !b.deprecated && b.maturity !== "deprecated" && b.state !== "retired")
          ?? exact[0]
          ?? findSimilarBulletFromMeta(
            new Set(tokenize(delta.mergedContent)), candidates, config.dedupSimilarityThreshold,
            splitDirectiveClauses(delta.mergedContent),
          )
          ?? (options.semanticIndex
            ? findSemanticDuplicateFromMeta(delta.mergedContent, candidates, options.semanticIndex)?.bullet
            : undefined);
        let merged: PlaybookBullet;
        if (existing) {
          const local = findBullet(targetPlaybook, existing.id);
          const unsafeReplacement = validateMergeSources(bulletsToMerge, existing.content, { allowImplicitWorkspace: options.allowImplicitWorkspace });
          if (!local || local.deprecated || local.maturity === "deprecated" || local.state === "retired" || unsafeReplacement) {
            logDecision(decisionLog, "add", "rejected", unsafeReplacement ?? "Merge replacement is inactive or belongs to another playbook layer", {
              bulletId: existing.id, details: { sourceIds: delta.bulletIds },
            });
            break;
          }
          merged = local;
        } else {
          merged = addBullet(
            targetPlaybook,
            {
              content: delta.mergedContent,
              category: source.category,
              kind: source.kind,
              type: source.type,
              isNegative: source.isNegative,
              scope: source.scope,
              scopeKey: source.scopeKey,
              workspace: source.workspace,
              tags: [...new Set(bulletsToMerge.flatMap((b) => b.tags))],
            },
            "merged",
            config.scoring?.decayHalfLifeDays ?? config.defaultDecayHalfLife ?? 90,
          );
          merged.sourceSessions = [];
          merged.sourceAgents = [];
          merged.reasoning = delta.reason;
          targetBulletIds.add(merged.id);
          indexBullet(merged);
        }
        merged.sourceSessions = [...new Set([...merged.sourceSessions, ...bulletsToMerge.flatMap((b) => b.sourceSessions)])];
        merged.sourceAgents = [...new Set([...merged.sourceAgents, ...bulletsToMerge.flatMap((b) => b.sourceAgents)])];
        merged.tags = [...new Set([...merged.tags, ...bulletsToMerge.flatMap((b) => b.tags)])];
        merged.updatedAt = now();

        // A replacement must be active in the target before any source can be
        // retired. An existing source can itself be the surviving replacement.
        for (const bullet of bulletsToMerge) {
          if (bullet.id !== merged.id) deprecateBullet(targetPlaybook, bullet.id, `Merged into ${merged.id}`, merged.id);
        }

        applied = true;
        logDecision(decisionLog, "add", "accepted", "Bullets merged into new combined bullet", {
          bulletId: merged.id,
          content: delta.mergedContent.slice(0, 100),
          details: { mergedFrom: delta.bulletIds },
        });
        break;
      }
    }

    if (applied) result.applied++;
    else result.skipped++;
  }

  applyCurationLifecycle(targetPlaybook, config, result);
  return result;
}

function applyCurationLifecycle(targetPlaybook: Playbook, config: Config, result: CurationResult): void {
  const decisionLog = result.decisionLog ?? (result.decisionLog = []);
  // --- Post-Processing on TARGET ---

  // 1. Anti-Pattern Inversion (must run BEFORE auto-deprecation)
  const inversions: InversionReport[] = [];
  const invertedBulletIds = new Set<string>();

  // Iterate over a copy to safely mutate the array (adding anti-patterns) during iteration
  for (const bullet of [...targetPlaybook.bullets]) {
    if (bullet.deprecated || bullet.pinned || bullet.kind === "anti_pattern") continue;

    const { decayedHarmful, decayedHelpful } = getDecayedCounts(bullet, config);
    const pruneThreshold = config.pruneHarmfulThreshold ?? 3;
    // Use epsilon for floating point comparison robustness
    const epsilon = 0.01;

    if (decayedHarmful >= pruneThreshold - epsilon && decayedHarmful > decayedHelpful * 2) {
      if (bullet.isNegative) {
        deprecateBullet(
          targetPlaybook,
          bullet.id,
          "Negative rule marked harmful (likely incorrect restriction)",
        );
        result.pruned++;
        logDecision(
          decisionLog,
          "inversion",
          "rejected",
          "Negative rule deprecated (not inverted) due to harmful feedback",
          {
            bulletId: bullet.id,
            content: bullet.content.slice(0, 100),
            details: { decayedHarmful, decayedHelpful },
          },
        );
      } else {
        const antiPattern = invertToAntiPattern(bullet, config);
        targetPlaybook.bullets.push(antiPattern);

        deprecateBullet(
          targetPlaybook,
          bullet.id,
          `Inverted to anti-pattern: ${antiPattern.id}`,
          antiPattern.id,
        );
        invertedBulletIds.add(bullet.id);

        inversions.push({
          originalId: bullet.id,
          originalContent: bullet.content,
          antiPatternId: antiPattern.id,
          antiPatternContent: antiPattern.content,
          bulletId: bullet.id,
          reason: `Marked as blocked/anti-pattern`,
        });

        logDecision(
          decisionLog,
          "inversion",
          "accepted",
          "Positive rule inverted to anti-pattern due to harmful feedback",
          {
            bulletId: bullet.id,
            content: bullet.content.slice(0, 100),
            details: { antiPatternId: antiPattern.id, decayedHarmful, decayedHelpful },
          },
        );
      }
    }
  }
  result.inversions.push(...inversions);

  // 2. Promotions & Demotions (after inversion so we don't double-deprecate)
  // Iterate over a copy to avoid issues if we were to modify the array structure (though we currently don't remove)
  for (const bullet of [...targetPlaybook.bullets]) {
    if (bullet.deprecated || invertedBulletIds.has(bullet.id)) continue;

    const oldMaturity = bullet.maturity;
    const promoted = checkForPromotion(bullet, config);

    if (promoted !== oldMaturity) {
      bullet.maturity = promoted;
      result.promotions.push({
        bulletId: bullet.id,
        from: oldMaturity,
        to: promoted,
        reason: `Auto-promoted based on feedback`,
      });

      logDecision(
        decisionLog,
        "promotion",
        "accepted",
        `Maturity promoted from ${oldMaturity} to ${promoted}`,
        {
          bulletId: bullet.id,
          content: bullet.content.slice(0, 100),
          details: { from: oldMaturity, to: promoted },
        },
      );
    }

    const demotionCheck = checkForDemotion(bullet, config);
    if (demotionCheck === "auto-deprecate") {
      deprecateBullet(targetPlaybook, bullet.id, "Auto-deprecated due to negative score");
      result.pruned++;
      logDecision(
        decisionLog,
        "demotion",
        "accepted",
        "Bullet auto-deprecated due to negative effective score",
        {
          bulletId: bullet.id,
          content: bullet.content.slice(0, 100),
        },
      );
    } else if (demotionCheck !== bullet.maturity) {
      const prevMaturity = bullet.maturity;
      bullet.maturity = demotionCheck;
      logDecision(
        decisionLog,
        "demotion",
        "accepted",
        `Maturity demoted from ${prevMaturity} to ${demotionCheck}`,
        {
          bulletId: bullet.id,
          content: bullet.content.slice(0, 100),
          details: { from: prevMaturity, to: demotionCheck },
        },
      );
    }
  }

}
