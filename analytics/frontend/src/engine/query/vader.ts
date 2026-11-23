/**
 * Faithful TypeScript port of Python vaderSentiment 3.3.x (SentimentIntensityAnalyzer.polarity_scores),
 * using the same lexicon and emoji lexicon. The npm `vader-sentiment` package (v1.1.3) is a port
 * of an older VADER revision (no emoji descriptions, different punctuation stripping), which
 * made scores diverge from the Python backend by up to ~1.0 per message, so the algorithm is
 * ported directly for field-for-field parity.
 */
import { VADER_EMOJI } from "./vaderEmoji";
import { VADER_LEXICON } from "./vaderLexicon";

const B_INCR = 0.293;
const B_DECR = -0.293;
const C_INCR = 0.733;
const N_SCALAR = -0.74;

const NEGATE = new Set([
  "aint", "arent", "cannot", "cant", "couldnt", "darent", "didnt", "doesnt",
  "ain't", "aren't", "can't", "couldn't", "daren't", "didn't", "doesn't",
  "dont", "hadnt", "hasnt", "havent", "isnt", "mightnt", "mustnt", "neither",
  "don't", "hadn't", "hasn't", "haven't", "isn't", "mightn't", "mustn't",
  "neednt", "needn't", "never", "none", "nope", "nor", "not", "nothing", "nowhere",
  "oughtnt", "shant", "shouldnt", "uhuh", "wasnt", "werent",
  "oughtn't", "shan't", "shouldn't", "uh-uh", "wasn't", "weren't",
  "without", "wont", "wouldnt", "won't", "wouldn't", "rarely", "seldom", "despite",
]);

const BOOSTER = new Map<string, number>();
for (const w of [
  "absolutely", "amazingly", "awfully", "completely", "considerable", "considerably", "decidedly", "deeply",
  "effing", "enormous", "enormously", "entirely", "especially", "exceptional", "exceptionally", "extreme",
  "extremely", "fabulously", "flipping", "flippin", "frackin", "fracking", "fricking", "frickin", "frigging",
  "friggin", "fully", "fuckin", "fucking", "fuggin", "fugging", "greatly", "hella", "highly", "hugely",
  "incredible", "incredibly", "intensely", "major", "majorly", "more", "most", "particularly", "purely",
  "quite", "really", "remarkably", "so", "substantially", "thoroughly", "total", "totally", "tremendous",
  "tremendously", "uber", "unbelievably", "unusually", "utter", "utterly", "very",
]) BOOSTER.set(w, B_INCR);
for (const w of [
  "almost", "barely", "hardly", "just enough", "kind of", "kinda", "kindof", "kind-of", "less", "little",
  "marginal", "marginally", "occasional", "occasionally", "partly", "scarce", "scarcely", "slight",
  "slightly", "somewhat", "sort of", "sorta", "sortof", "sort-of",
]) BOOSTER.set(w, B_DECR);

const SPECIAL_CASES: Record<string, number> = {
  "the shit": 3, "the bomb": 3, "bad ass": 1.5, badass: 1.5, "bus stop": 0.0,
  "yeah right": -2, "kiss of death": -1.5, "to die for": 3, "beating heart": 3.5,
};

const PUNCT = new Set([..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"]);

function isUpper(s: string): boolean {
  return s !== s.toLowerCase() && s === s.toUpperCase();
}

function negated(words: string[], includeNt = true): boolean {
  const lower = words.map((w) => w.toLowerCase());
  for (const w of lower) if (NEGATE.has(w)) return true;
  if (includeNt) for (const w of lower) if (w.includes("n't")) return true;
  return false;
}

function normalize(score: number, alpha = 15): number {
  const n = score / Math.sqrt(score * score + alpha);
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

function allcapDifferential(words: string[]): boolean {
  let allcap = 0;
  for (const w of words) if (isUpper(w)) allcap++;
  const diff = words.length - allcap;
  return diff > 0 && diff < words.length;
}

function scalarIncDec(word: string, valence: number, isCapDiff: boolean): number {
  let scalar = 0;
  const lower = word.toLowerCase();
  const b = BOOSTER.get(lower);
  if (b !== undefined) {
    scalar = b;
    if (valence < 0) scalar *= -1;
    if (isUpper(word) && isCapDiff) scalar += valence > 0 ? C_INCR : -C_INCR;
  }
  return scalar;
}

function stripPuncIfWord(token: string): string {
  let a = 0;
  let b = token.length;
  while (a < b && PUNCT.has(token[a])) a++;
  while (b > a && PUNCT.has(token[b - 1])) b--;
  const stripped = token.slice(a, b);
  return [...stripped].length <= 2 ? token : stripped;
}

const lex = (w: string): number | undefined => Object.prototype.hasOwnProperty.call(VADER_LEXICON, w) ? VADER_LEXICON[w] : undefined;
const inLex = (w: string) => lex(w) !== undefined;

function negationCheck(valence: number, wl: string[], startI: number, i: number): number {
  if (startI === 0) {
    if (negated([wl[i - 1]])) valence *= N_SCALAR;
  } else if (startI === 1) {
    if (wl[i - 2] === "never" && (wl[i - 1] === "so" || wl[i - 1] === "this")) valence *= 1.25;
    else if (wl[i - 2] === "without" && wl[i - 1] === "doubt") valence = valence;
    else if (negated([wl[i - 2]])) valence *= N_SCALAR;
  } else if (startI === 2) {
    if ((wl[i - 3] === "never" && (wl[i - 2] === "so" || wl[i - 2] === "this")) || wl[i - 1] === "so" || wl[i - 1] === "this") {
      valence *= 1.25;
    } else if (wl[i - 3] === "without" && (wl[i - 2] === "doubt" || wl[i - 1] === "doubt")) valence = valence;
    else if (negated([wl[i - 3]])) valence *= N_SCALAR;
  }
  return valence;
}

function specialIdiomsCheck(valence: number, wl: string[], i: number): number {
  const sequences = [
    `${wl[i - 1]} ${wl[i]}`,
    `${wl[i - 2]} ${wl[i - 1]} ${wl[i]}`,
    `${wl[i - 2]} ${wl[i - 1]}`,
    `${wl[i - 3]} ${wl[i - 2]} ${wl[i - 1]}`,
    `${wl[i - 3]} ${wl[i - 2]}`,
  ];
  for (const seq of sequences) {
    if (Object.prototype.hasOwnProperty.call(SPECIAL_CASES, seq)) {
      valence = SPECIAL_CASES[seq];
      break;
    }
  }
  if (wl.length - 1 > i) {
    const zo = `${wl[i]} ${wl[i + 1]}`;
    if (Object.prototype.hasOwnProperty.call(SPECIAL_CASES, zo)) valence = SPECIAL_CASES[zo];
  }
  if (wl.length - 1 > i + 1) {
    const zot = `${wl[i]} ${wl[i + 1]} ${wl[i + 2]}`;
    if (Object.prototype.hasOwnProperty.call(SPECIAL_CASES, zot)) valence = SPECIAL_CASES[zot];
  }
  for (const ng of [sequences[3], sequences[4], sequences[2]]) {
    const b = BOOSTER.get(ng);
    if (b !== undefined) valence += b;
  }
  return valence;
}

function leastCheck(valence: number, w: string[], i: number): number {
  if (i > 1 && !inLex(w[i - 1].toLowerCase()) && w[i - 1].toLowerCase() === "least") {
    if (w[i - 2].toLowerCase() !== "at" && w[i - 2].toLowerCase() !== "very") valence *= N_SCALAR;
  } else if (i > 0 && !inLex(w[i - 1].toLowerCase()) && w[i - 1].toLowerCase() === "least") {
    valence *= N_SCALAR;
  }
  return valence;
}

function sentimentValence(item: string, i: number, w: string[], isCapDiff: boolean): number {
  let valence = 0;
  const lower = item.toLowerCase();
  const base = lex(lower);
  if (base === undefined) return valence;
  valence = base;
  if (lower === "no" && i !== w.length - 1 && inLex(w[i + 1].toLowerCase())) valence = 0;
  if (
    (i > 0 && w[i - 1].toLowerCase() === "no") ||
    (i > 1 && w[i - 2].toLowerCase() === "no") ||
    (i > 2 && w[i - 3].toLowerCase() === "no" && ["or", "nor"].includes(w[i - 1].toLowerCase()))
  ) {
    valence = base * N_SCALAR;
  }
  if (isUpper(item) && isCapDiff) valence += valence > 0 ? C_INCR : -C_INCR;

  const wl = w.map((x) => x.toLowerCase());
  for (let startI = 0; startI < 3; startI++) {
    if (i > startI && !inLex(w[i - (startI + 1)].toLowerCase())) {
      let s = scalarIncDec(w[i - (startI + 1)], valence, isCapDiff);
      if (startI === 1 && s !== 0) s *= 0.95;
      if (startI === 2 && s !== 0) s *= 0.9;
      valence += s;
      valence = negationCheck(valence, wl, startI, i);
      if (startI === 2) valence = specialIdiomsCheck(valence, wl, i);
    }
  }
  return leastCheck(valence, w, i);
}

/** Replicates the Python quirk of locating each score with list.index() (first equal value). */
function butCheck(w: string[], sentiments: number[]): number[] {
  const wl = w.map((x) => x.toLowerCase());
  const bi = wl.indexOf("but");
  if (bi >= 0) {
    for (let k = 0; k < sentiments.length; k++) {
      const s = sentiments[k];
      const si = sentiments.indexOf(s);
      if (si < bi) sentiments[si] = s * 0.5;
      else if (si > bi) sentiments[si] = s * 1.5;
    }
  }
  return sentiments;
}

function pyRound(x: number, d: number): number {
  const m = 10 ** d;
  const s = x * m;
  const f = Math.floor(s);
  if (s - f === 0.5) return (f % 2 === 0 ? f : f + 1) / m;
  return Math.round(s) / m;
}

const count = (t: string, ch: string) => t.split(ch).length - 1;

export interface VaderScores {
  neg: number;
  neu: number;
  pos: number;
  compound: number;
}

export function polarityScores(input: string): VaderScores {
  let text = "";
  let prevSpace = true;
  for (const ch of input) {
    const desc = Object.prototype.hasOwnProperty.call(VADER_EMOJI, ch) ? VADER_EMOJI[ch] : undefined;
    if (desc !== undefined) {
      if (!prevSpace) text += " ";
      text += desc;
      prevSpace = false;
    } else {
      text += ch;
      prevSpace = ch === " ";
    }
  }
  text = text.trim();

  const tokens = text.split(/\s+/).filter(Boolean).map(stripPuncIfWord);
  const isCapDiff = allcapDifferential(tokens);

  const sentiments: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const item = tokens[i];
    const lower = item.toLowerCase();
    if (BOOSTER.has(lower)) {
      sentiments.push(0);
      continue;
    }
    if (i < tokens.length - 1 && lower === "kind" && tokens[i + 1].toLowerCase() === "of") {
      sentiments.push(0);
      continue;
    }
    sentiments.push(sentimentValence(item, i, tokens, isCapDiff));
  }
  butCheck(tokens, sentiments);

  if (!sentiments.length) return { neg: 0, neu: 0, pos: 0, compound: 0 };

  let sumS = sentiments.reduce((a, b) => a + b, 0);
  const ep = Math.min(count(text, "!"), 4) * 0.292;
  const qm = count(text, "?");
  const qmAmp = qm > 1 ? (qm <= 3 ? qm * 0.18 : 0.96) : 0;
  const punct = ep + qmAmp;
  if (sumS > 0) sumS += punct;
  else if (sumS < 0) sumS -= punct;
  const compound = normalize(sumS);

  let pos = 0, neg = 0, neu = 0;
  for (const s of sentiments) {
    if (s > 0) pos += s + 1;
    if (s < 0) neg += s - 1;
    if (s === 0) neu++;
  }
  if (pos > Math.abs(neg)) pos += punct;
  else if (pos < Math.abs(neg)) neg -= punct;
  const total = pos + Math.abs(neg) + neu;
  return {
    neg: pyRound(Math.abs(neg / total), 3),
    neu: pyRound(Math.abs(neu / total), 3),
    pos: pyRound(Math.abs(pos / total), 3),
    compound: pyRound(compound, 4),
  };
}
