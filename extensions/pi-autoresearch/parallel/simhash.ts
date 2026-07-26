/**
 * SimHash for hypothesis repeat detection.
 *
 * 32-bit fingerprint where similar texts produce similar hashes (small Hamming
 * distance). Used to warn the agent when a new hypothesis closely matches an
 * already-tried one — BEFORE the experiment runs.
 *
 * Properties:
 *  - Deterministic (same text → same hash)
 *  - Lexical similarity (not semantic — "cache" and "memoize" won't match)
 *  - No ML model required — computed in microseconds
 *  - Stored as 8-char hex string (32 bits)
 */

// English stop words + common technical "filler" verbs that add noise without
// discriminating between hypotheses.
const STOP_WORDS = new Set([
  "the", "a", "an", "for", "with", "in", "of", "to", "at", "by",
  "add", "try", "use", "using", "replace", "change", "make", "get",
  "this", "that", "is", "are", "and", "or", "not", "from", "into",
  "on", "it", "we", "our", "be", "will", "would", "can", "could",
  "do", "does", "if", "then", "than", "so", "as", "but", "just",
]);

/**
 * Normalize text to significant tokens.
 * Lowercase → strip punctuation → filter stop words / short tokens → stem.
 */
function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .filter((t) => !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * Minimal Porter-style stemming: strip common English suffixes so that
 * "cache", "caching", "cached" all map to "cach".
 */
function stem(word: string): string {
  return word
    .replace(/(ing|edly|edly)$/, "")
    .replace(/(ed|es|er|ly|ment|tion|s)$/, "")
    .replace(/(.)\1{2,}/, "$1");
}

/**
 * FNV-1a 32-bit hash. Fast, good distribution for short strings.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Compute a 32-bit SimHash from text, returned as an 8-char hex string.
 *
 * Algorithm: for each token's 32-bit FNV-1a hash, add +1/-1 to a 32-element
 * vote vector (bit=1 → +1, bit=0 → -1). The final fingerprint bit is 1 where
 * the vote sum is positive.
 *
 * 32-bit SimHash is the standard configuration for near-duplicate detection.
 * Hamming distance thresholds: 0=exact, ≤3=likely dup, ≤6=maybe related.
 */
export function computeSimhash(text: string): string {
  const tokens = normalize(text);
  if (tokens.length === 0) return "00000000";

  const votes = new Int32Array(32);

  for (const token of tokens) {
    const h = fnv1a(token);
    for (let i = 0; i < 32; i++) {
      const bit = (h >>> i) & 1;
      votes[i] += bit ? 1 : -1;
    }
  }

  let result = 0;
  for (let i = 0; i < 32; i++) {
    if (votes[i] > 0) {
      result |= (1 << i) >>> 0;
    }
  }

  return (result >>> 0).toString(16).padStart(8, "0");
}

/**
 * Hamming distance between two 8-char hex SimHash strings:
 * the number of differing bits.
 */
export function hammingDistance(hexA: string, hexB: string): number {
  const a = parseInt(hexA, 16);
  const b = parseInt(hexB, 16);
  let x = (a ^ b) >>> 0;
  let count = 0;
  while (x > 0) {
    x = (x & (x - 1)) >>> 0; // >>> 0 on the AND result, not just (x-1)
    count++;
  }
  return count;
}

// Thresholds for 32-bit SimHash

/** Bit distance == 0 → identical hypothesis (near-certain duplicate). */
export const SIMHASH_EXACT = 0;
/** ≤3 differing bits → very likely a duplicate (standard near-duplicate bound). */
export const SIMHASH_LIKELY = 3;
/** ≤6 differing bits → possibly related (informational, not a strong signal). */
export const SIMHASH_MAYBE = 6;

export type SimhashMatchLevel = "exact" | "likely" | "maybe" | "different";

/** Classify a hamming distance into a match level. */
export function classifyDistance(distance: number): SimhashMatchLevel {
  if (distance <= SIMHASH_EXACT) return "exact";
  if (distance <= SIMHASH_LIKELY) return "likely";
  if (distance <= SIMHASH_MAYBE) return "maybe";
  return "different";
}
