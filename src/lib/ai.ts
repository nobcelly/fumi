import {
  type GenerateContentResult,
  type GenerativeModel,
  type LanguageModelCreateOptions,
  InferenceMode,
  Schema,
  getGenerativeModel,
} from 'firebase/ai';
import { ai, settings } from './firebase';
import { appendNew, bottomStrip, joinPieces, tilesFor } from './image';
import { type Hidden, type Redaction, looksClean, plausible, redact } from './redact';
import { findDates, withDates } from './wareki';

// ---------------------------------------------------------------------------
// The routing rule at the heart of Fumi:
//   * The photo and the raw text of a letter never leave the device. Reading
//     the letter and finding personal data always run on-device
//     (ONLY_ON_DEVICE). If the device has no local model, the reader covers
//     the personal parts by hand before anything is sent (see CoverTool).
//   * Explaining the covered text runs on-device when the local model writes
//     the reader's language (PREFER_ON_DEVICE), and in the cloud otherwise.
//   * Follow-up questions are answered on-device too; "ask the cloud expert"
//     sends the covered text and the covered question (ONLY_IN_CLOUD).
//   * Nothing goes to the cloud unless it passes looksClean().
// ---------------------------------------------------------------------------

export type Engine = 'on_device' | 'in_cloud';

export type Reading = {
  transcript: string;
  personal: Redaction[];
};

export type Explanation = {
  kind: string;
  issuerJa: string;
  issuer: string;
  summary: string;
  actions: string[];
  deadlineJa: string;
  amountJa: string;
  payment: string;
  contact: string;
  terms: { ja: string; meaning: string }[];
};

export type Checked = Explanation & {
  deadlineIso: string | null;
  amountYen: number | null;
  issuerVerified: boolean;
  warnings: string[];
};

export const LANGUAGES: { code: string; name: string; native: string }[] = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'zh', name: 'Chinese', native: '中文' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'tl', name: 'Tagalog', native: 'Tagalog' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'ne', name: 'Nepali', native: 'नेपाली' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'my', name: 'Burmese', native: 'မြန်မာ' },
];

export const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? 'English';

// ---- device capability ----------------------------------------------------

export type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

type LanguageModelStatic = {
  availability: (options?: object) => Promise<Availability>;
  create: (options?: object) => Promise<{ destroy: () => void }>;
};

const languageModel = (): LanguageModelStatic | null => {
  // LanguageModel is a class, so typeof gives 'function'
  const lm: unknown = (globalThis as { LanguageModel?: unknown }).LanguageModel;
  return lm && (typeof lm === 'function' || typeof lm === 'object') && 'availability' in lm ? (lm as LanguageModelStatic) : null;
};

const imageInputs: LanguageModelCreateOptions = {
  expectedInputs: [{ type: 'image' }, { type: 'text', languages: ['ja', 'en'] }],
  expectedOutputs: [{ type: 'text', languages: ['ja'] }],
};

// Can this device read a letter by itself?
export const deviceReader = async (): Promise<Availability> => {
  const lm = languageModel();
  if (!lm) return 'unavailable';
  try {
    return await lm.availability(imageInputs);
  } catch {
    return 'unavailable';
  }
};

// Downloads the on-device model (Chrome does this once, a few GB). Must be
// called from a click. `progress` gets 0..1.
export const downloadDeviceModel = async (progress: (loaded: number) => void): Promise<Availability> => {
  const lm = languageModel();
  if (!lm) return 'unavailable';
  const session = await lm.create({
    ...imageInputs,
    monitor(m: EventTarget) {
      m.addEventListener('downloadprogress', (e) => progress((e as Event & { loaded: number }).loaded));
    },
  });
  session.destroy();
  return deviceReader();
};

// Loads the on-device model ahead of time, so the first letter does not wait
// for it. Runs a tiny prompt on the device; nothing is sent anywhere.
export const warmUp = async (): Promise<void> => {
  const lm = languageModel();
  if (!lm) return;
  try {
    const session = (await lm.create(imageInputs)) as { prompt?: (p: string) => Promise<string>; destroy: () => void };
    await session.prompt?.('Reply with: OK');
    session.destroy();
  } catch {
    // not ready yet; the first letter will load it
  }
};

// Can the local model write in this language?
export const deviceSpeaks = async (lang: string): Promise<boolean> => {
  const lm = languageModel();
  if (!lm) return false;
  try {
    const a = await lm.availability({
      expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
      expectedOutputs: [{ type: 'text', languages: [lang] }],
    });
    return a === 'available';
  } catch {
    return false;
  }
};

// ---- models -----------------------------------------------------------------

// Cloud calls give up after this long and move on to the fallback model.
const CLOUD_TIMEOUT = 45_000;

const personalSchema = {
  type: 'object',
  properties: {
    personal: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, text: { type: 'string' } },
        required: ['label', 'text'],
      },
    },
  },
  required: ['personal'],
};

const explanationProps = {
  kind: { type: 'string' },
  issuerJa: { type: 'string' },
  issuer: { type: 'string' },
  summary: { type: 'string' },
  actions: { type: 'array', items: { type: 'string' } },
  deadlineJa: { type: 'string' },
  amountJa: { type: 'string' },
  payment: { type: 'string' },
  contact: { type: 'string' },
  terms: {
    type: 'array',
    items: {
      type: 'object',
      properties: { ja: { type: 'string' }, meaning: { type: 'string' } },
      required: ['ja', 'meaning'],
    },
  },
};
const explanationJson = { type: 'object', properties: explanationProps, required: Object.keys(explanationProps) };

const cloudExplanationSchema = Schema.object({
  properties: {
    kind: Schema.string(),
    issuerJa: Schema.string(),
    issuer: Schema.string(),
    summary: Schema.string(),
    actions: Schema.array({ items: Schema.string() }),
    deadlineJa: Schema.string(),
    amountJa: Schema.string(),
    payment: Schema.string(),
    contact: Schema.string(),
    terms: Schema.array({
      items: Schema.object({ properties: { ja: Schema.string(), meaning: Schema.string() } }),
    }),
  },
});

const cloudReadingSchema = Schema.object({
  properties: {
    lines: Schema.array({ items: Schema.string() }),
    personal: Schema.array({
      items: Schema.object({ properties: { label: Schema.string(), text: Schema.string() } }),
    }),
  },
});

// The configured cloud model first, then the fallback (both from Remote Config).
const cloudModels = (): string[] => [...new Set([settings().cloudModel, settings().fallbackModel].filter(Boolean))];

// Cloud models are sometimes busy or slow. Try each configured model in turn.
const inCloud = async <T>(run: (model: string) => Promise<T>): Promise<T> => {
  let last: unknown = new Error('No cloud model is configured.');
  for (const model of cloudModels()) {
    try {
      return await run(model);
    } catch (e) {
      last = e;
    }
  }
  throw last;
};

// On the device, reading is two small jobs: copy the text (plain output is
// much faster and more complete than JSON), then find the personal parts.
const transcriberModel = (): GenerativeModel =>
  getGenerativeModel(ai(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: { createOptions: imageInputs },
  });

const personalModel = (): GenerativeModel =>
  getGenerativeModel(ai(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
        expectedOutputs: [{ type: 'text', languages: ['ja'] }],
      },
      promptOptions: { responseConstraint: personalSchema },
    },
  });

const cloudReaderModel = (model: string): GenerativeModel =>
  getGenerativeModel(ai(), {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model,
      generationConfig: { responseMimeType: 'application/json', responseSchema: cloudReadingSchema, temperature: 0 },
    },
  });

const explainerModel = (lang: string, mode: InferenceMode, model: string): GenerativeModel =>
  getGenerativeModel(ai(), {
    mode,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
        expectedOutputs: [{ type: 'text', languages: [lang] }],
      },
      promptOptions: { responseConstraint: explanationJson },
    },
    inCloudParams: {
      model,
      generationConfig: { responseMimeType: 'application/json', responseSchema: cloudExplanationSchema, temperature: 0.2 },
    },
  });

const chatModel = (lang: string, mode: InferenceMode, model: string): GenerativeModel =>
  getGenerativeModel(ai(), {
    mode,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
        expectedOutputs: [{ type: 'text', languages: [lang] }],
      },
    },
    inCloudParams: { model, generationConfig: { temperature: 0.3 } },
  });

// ---- prompts ----------------------------------------------------------------

const TRANSCRIBE_PROMPT =
  "Transcribe all of the Japanese text in this image exactly as printed, one printed line per output line, from top to bottom. Include small print, such as the sender's office name and phone number. Output only the text.";

const PERSONAL_PROMPT = (transcript: string) => `Below is the text of a letter from a Japanese office to one person.
List every piece of personal data about that person, each as {"label", "text"} with "text" copied exactly from the letter. Labels: NAME, ADDRESS, POSTAL CODE, MY NUMBER, BIRTH DATE, PHONE, ACCOUNT NO., ID NO.
Do not list the sender's office name, office address or office phone number. Do not list amounts of money, deadlines, months or other dates (only a birth date is personal).

LETTER:
${transcript}`;

const READ_PROMPT = `This image is a letter from a Japanese government office, company or school.
Return JSON with:
- "lines": the Japanese text of the letter, copied exactly as printed, one item per printed line, from top to bottom. Do not translate. Do not summarise.
- "personal": every piece of personal data about the person the letter is addressed to, each as {"label", "text"} with "text" copied exactly as printed. Labels: NAME, ADDRESS, POSTAL CODE, MY NUMBER, BIRTH DATE, PHONE, ACCOUNT NO., ID NO.
Do not list the sender's office name, office address or office phone number as personal data.
Where a black box covers part of the photo, write ■■■ in its place and do not list it as personal data.`;

const glossaryLines = () =>
  settings()
    .glossary.map((g) => `- ${g.ja}: ${g.en}`)
    .join('\n');

const LABEL_NOTE = `Personal data in the letter has been replaced with numbered labels like [NAME 1] or [PHONE 1]. When you need one of them (for example a phone number to call), write the label exactly as it appears; the app fills in the real value on the reader's screen.`;

const languageLabel = (lang: string) => {
  const l = LANGUAGES.find((x) => x.code === lang);
  return l && l.native !== l.name ? `${l.name} (${l.native})` : languageName(lang);
};

const explainPrompt = (redacted: string, lang: string) => `You help people who cannot read Japanese understand official letters they received in Japan.
${LABEL_NOTE}
Return JSON with these fields:
- "kind": what this letter is, in a few words.
- "issuerJa": the name of the office that sent the letter, copied exactly from the Japanese text. Empty if it is not printed.
- "issuer": that office's name, translated.
- "summary": two or three sentences on what the letter is about and what it asks the reader to do.
- "actions": the things the reader must do, in order, each one short sentence.
- "deadlineJa": the deadline to pay or reply, copied exactly from the Japanese text. Empty if there is none.
- "amountJa": the amount to pay, copied exactly from the Japanese text. Empty if there is none.
- "payment": how and where to pay or respond.
- "contact": who to contact and how. If the phone number is a label such as [PHONE 1], write the label.
- "terms": up to six official Japanese terms from the letter, each with a short meaning.
Use plain words a newcomer would understand. These definitions are reliable; use them when they apply:
${glossaryLines()}

LETTER:
${redacted}

Write "kind", "issuer", "summary", "actions", "payment", "contact" and every "meaning" in ${languageLabel(lang)}.`;

const askPrompt = (question: string, redacted: string, lang: string) => `You help a person living in Japan understand an official letter. Answer their question in ${languageLabel(lang)}, briefly and practically, in plain text without Markdown (at most five short sentences). If you are not sure, say so and tell them who to ask (the office in the letter).
${LABEL_NOTE}

LETTER:
${redacted}

QUESTION: ${question}`;

// ---- steps ------------------------------------------------------------------

const parseJson = <T>(raw: string): T => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) as T;
};

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const sourceOf = (result: GenerateContentResult): Engine =>
  result.response.inferenceSource === 'in_cloud' ? 'in_cloud' : 'on_device';

const toReading = (raw: string): Reading => {
  const r = parseJson<Partial<Reading> & { lines?: unknown }>(raw);
  const lines = Array.isArray(r.lines) ? r.lines.filter((l): l is string => typeof l === 'string') : [];
  const transcript = (lines.length ? lines.join('\n') : typeof r.transcript === 'string' ? r.transcript : '').trim();
  const personal = Array.isArray(r.personal)
    ? r.personal.filter((p): p is Redaction => !!p && typeof p.text === 'string' && typeof p.label === 'string')
    : [];
  if (transcript.length < 20) throw new Error('No letter text was found in this photo.');
  return { transcript, personal };
};

// The local model could not read this photo; the screen offers the
// cover-by-hand path instead.
export class DeviceReadFailed extends Error {
  constructor() {
    super('The on-device model could not read this photo.');
  }
}

// Step 1, on the device: copy the text of the photo, one half at a time for a
// tall page. If the sender (office name, phone) did not come through, the
// bottom of the page gets a second, closer look. `onStep` reports progress.
export const transcribeOnDevice = async (photo: Blob, onStep?: (note: string) => void): Promise<string> => {
  const read = async (image: Blob) => {
    const result = await transcriberModel().generateContent([
      { type: 'text', text: TRANSCRIBE_PROMPT },
      { type: 'inlineData', inlineData: { mimeType: 'image/jpeg', data: await toBase64(image) } },
    ]);
    return result.response.text().replace(/```[a-z]*\n?/g, '').trim();
  };
  try {
    const tiles = await tilesFor(photo);
    let text = '';
    for (const [i, tile] of tiles.entries()) {
      onStep?.(tiles.length > 1 ? `part ${i + 1} of ${tiles.length}` : '');
      const piece = await read(tile);
      text = i === 0 ? piece : joinPieces(text, piece);
    }
    if (text.replace(/\s+/g, '').length < 20) throw new Error('No letter text was found in this photo.');
    const tail = text.split('\n').slice(-6).join(' ');
    const office = /(役所|役場|課|係|事務所|機構|センター|学校)/.test(tail);
    const phone = /0\d{1,4}[-(（]\d{1,4}[-)）]\d{3,4}|電話|TEL|℡/.test(tail);
    if (!office || !phone) {
      onStep?.('a closer look at the small print');
      text = appendNew(text, await read(await bottomStrip(photo)));
    }
    return text;
  } catch {
    throw new DeviceReadFailed();
  }
};

// Step 2, on the device: point out the personal data in the text. The
// patterns in redact.ts cover numbers, names before 様 and addresses even if
// the model misses them.
export const findPersonalOnDevice = async (transcript: string): Promise<Redaction[]> => {
  const result = await personalModel().generateContent(PERSONAL_PROMPT(transcript));
  const r = parseJson<{ personal?: unknown }>(result.response.text());
  return Array.isArray(r.personal)
    ? r.personal.filter((p): p is Redaction => !!p && typeof p.text === 'string' && typeof p.label === 'string')
    : [];
};

// Step 1 without a local model: the reader has already covered the personal
// parts of the photo by hand, and agreed to send the covered photo.
export const readCoveredInCloud = async (coveredPhoto: Blob): Promise<Reading> => {
  const data = await toBase64(coveredPhoto);
  return inCloud(async (model) => {
    const result = await cloudReaderModel(model).generateContent(
      [
        { type: 'text', text: READ_PROMPT },
        { type: 'inlineData', inlineData: { mimeType: coveredPhoto.type || 'image/jpeg', data } },
      ],
      { timeout: CLOUD_TIMEOUT + 15_000 }
    );
    return toReading(result.response.text());
  });
};

// Step 2, on the device: cover everything personal, and write the Western
// date next to each Japanese era date (models get eras wrong).
export const coverPersonal = (reading: Reading) => {
  const covered = redact(
    reading.transcript,
    reading.personal.filter((p) => plausible(p, reading.transcript))
  );
  return { ...covered, text: withDates(covered.text) };
};

const asText = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// Models sometimes leave fields out; the screen expects every field.
const normalize = (e: Partial<Explanation>): Explanation => ({
  kind: asText(e.kind) || 'Official letter',
  issuerJa: asText(e.issuerJa),
  issuer: asText(e.issuer),
  summary: asText(e.summary),
  actions: Array.isArray(e.actions) ? e.actions.map(asText).filter(Boolean) : [],
  deadlineJa: asText(e.deadlineJa),
  amountJa: asText(e.amountJa),
  payment: asText(e.payment),
  contact: asText(e.contact),
  terms: Array.isArray(e.terms)
    ? e.terms
        .map((t) => ({ ja: asText(t?.ja), meaning: asText(t?.meaning) }))
        .filter((t) => t.ja && t.meaning)
    : [],
});

const explanationFrom = (result: GenerateContentResult, redacted: string) => {
  const e = normalize(parseJson<Partial<Explanation>>(result.response.text()));
  if (!e.summary && !e.actions.length) throw new Error('The explanation came back empty.');
  return check(e, redacted);
};

// Models sometimes answer in English when asked for another language. For
// languages with their own script (or Vietnamese letters) that is easy to see.
const SCRIPTS: Record<string, RegExp> = {
  zh: /\p{Script=Han}/gu,
  ko: /\p{Script=Hangul}/gu,
  ne: /\p{Script=Devanagari}/gu,
  my: /\p{Script=Myanmar}/gu,
  vi: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu,
};

export const writtenIn = (text: string, lang: string): boolean => {
  const re = SCRIPTS[lang];
  if (!re) return true;
  // quoted Japanese terms and labels do not count
  const bare = text.replace(/[(（「『【][^)）」』】]*[)）」』】]/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const own = bare.match(re)?.length ?? 0;
  const latin = bare.match(/[A-Za-z]/g)?.length ?? 0;
  if (lang === 'vi') return own >= 3;
  if (lang === 'zh' && (bare.match(/[\u3040-\u30ff]/g)?.length ?? 0) > own / 5) return false; // Japanese, not Chinese
  return own > 0 && own >= latin / 2;
};

type Explained = { explanation: Checked; engine: Engine };

// Step 3: explain the covered text in the reader's language.
export const explain = async (
  redacted: string,
  lang: string,
  allowCloud: boolean
): Promise<{ explanation: Checked; engine: Engine }> => {
  const local = await deviceSpeaks(lang);
  const cloudOk = allowCloud && looksClean(redacted);
  if (!local && !allowCloud) throw new NeedsCloud();
  if (!local && !cloudOk) throw new Error('Personal data is still visible, so nothing was sent.');
  const prompt = explainPrompt(redacted, lang);
  // An answer in the wrong language is kept as a last resort.
  let wrongLanguage: Explained | null = null;
  const accept = (r: Explained): Explained => {
    if (writtenIn(`${r.explanation.summary} ${r.explanation.actions.join(' ')}`, lang)) return r;
    wrongLanguage ??= { ...r, explanation: { ...r.explanation, warnings: [...r.explanation.warnings, 'language'] } };
    throw new Error(`The explanation was not written in ${languageName(lang)}.`);
  };
  if (local) {
    try {
      // Hybrid inference: on this device while the local model is ready, and
      // the cloud model only if it is not (and only for clean text).
      const mode = cloudOk ? InferenceMode.PREFER_ON_DEVICE : InferenceMode.ONLY_ON_DEVICE;
      const result = await explainerModel(lang, mode, cloudModels()[0]).generateContent(prompt, { timeout: CLOUD_TIMEOUT });
      return accept({ explanation: explanationFrom(result, redacted), engine: sourceOf(result) });
    } catch (e) {
      if (!cloudOk) {
        if (wrongLanguage) return wrongLanguage;
        throw e;
      }
      // The local model failed on this letter: the cloud model takes over.
    }
  }
  try {
    return await inCloud(async (model) => {
      const result = await explainerModel(lang, InferenceMode.ONLY_IN_CLOUD, model).generateContent(prompt, {
        timeout: CLOUD_TIMEOUT,
      });
      return accept({ explanation: explanationFrom(result, redacted), engine: 'in_cloud' });
    });
  } catch (e) {
    if (wrongLanguage) return wrongLanguage;
    throw e;
  }
};

// Chat answers are shown as plain text; drop Markdown the model may add anyway.
export const plain = (s: string): string =>
  s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[*-]\s+/gm, '• ')
    .trim();

// Follow-up questions. On the device when it writes the reader's language;
// the cloud model when it does not, or when the reader asks the expert. The
// question is covered with the same labels as the letter before it is sent.
export const ask = async (
  question: string,
  redacted: string,
  hidden: Hidden[],
  lang: string,
  expert: boolean
): Promise<{ answer: string; engine: Engine; hidden: Hidden[] }> => {
  const covered = redact(question, [], hidden);
  const prompt = askPrompt(covered.text, redacted, lang);
  if (!expert && (await deviceSpeaks(lang))) {
    const result = await chatModel(lang, InferenceMode.ONLY_ON_DEVICE, cloudModels()[0]).generateContent(prompt);
    return { answer: plain(result.response.text()), engine: 'on_device', hidden: covered.removed };
  }
  if (!looksClean(redacted) || !looksClean(covered.text)) throw new Error('Personal data is still visible, so nothing was sent.');
  return inCloud(async (model) => {
    const result = await chatModel(lang, InferenceMode.ONLY_IN_CLOUD, model).generateContent(prompt, { timeout: CLOUD_TIMEOUT });
    return { answer: plain(result.response.text()), engine: 'in_cloud' as Engine, hidden: covered.removed };
  });
};

export class NeedsCloud extends Error {
  constructor() {
    super('This language needs the cloud model.');
  }
}

// ---- checks -----------------------------------------------------------------

const halfWidth = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// The date printed next to a deadline word (納期限 令和8年12月28日).
export const deadlineIn = (text: string) => {
  for (const m of text.matchAll(/(納期限|納付期限|支払期限|提出期限|申請期限|期限|締切|締め切り|期日)[^\n]{0,30}(?:\n[^\n]{0,30})?/g)) {
    const d = findDates(m[0])[0];
    if (d) return d;
  }
  return undefined;
};

// The amount printed next to an amount word (納付額 18,600円).
export const amountIn = (text: string) => {
  const m = /(納付額|納付金額|請求額|請求金額|合計額|合計|金額|税額|保険料額|保険料|お支払い額|お支払額)[^\n\d]{0,12}(?:\n[^\n\d]{0,12})?([\d,]{2,})\s*円/.exec(halfWidth(text));
  if (!m) return undefined;
  const yen = Number(m[2]!.replace(/,/g, ''));
  return yen > 0 ? { yen, source: `${m[2]}円` } : undefined;
};

// The sending office, read from the bottom of the letter up: the last line
// that names an office (市役所, 年金事務所, 税務課 ...).
export const issuerIn = (text: string) =>
  text
    .split('\n')
    .map((l) => l.split(/電話|TEL|Tel|℡|☎|\[|（|\(/)[0]!.trim())
    .reverse()
    .find((l) => /(役所|役場|機構|税務署|事務所|保健所|センター|学校|株式会社|課|係)$/.test(l) && !/\d{2,}|様|殿|^[・●]/.test(l) && l.length <= 30);

// Small models invent things. Every key fact is checked against the letter's
// own text, and dates are converted by code, not by the model. A fact printed
// next to its label (納期限, 納付額) wins over the model's answer.
export const check = (e: Explanation, redacted: string): Checked => {
  const warnings: string[] = [];
  const flat = redacted.replace(/\s+/g, '');
  const inLetter = (s: string) => !!s && flat.includes(s.replace(/\s+/g, ''));

  let issuerJa = e.issuerJa;
  let issuerVerified = inLetter(issuerJa);
  if (!issuerVerified) {
    const found = issuerIn(redacted);
    if (found) {
      issuerJa = found;
      issuerVerified = true;
    } else if (e.issuerJa) warnings.push('sender');
  }

  let deadlineIso: string | null = null;
  let deadlineJa = e.deadlineJa;
  const labelled = deadlineIn(redacted);
  const fromModel = e.deadlineJa ? findDates(e.deadlineJa)[0] : undefined;
  if (labelled) {
    deadlineIso = labelled.iso;
    deadlineJa = labelled.source;
  } else if (fromModel && inLetter(fromModel.source)) deadlineIso = fromModel.iso;
  else if (e.deadlineJa) warnings.push('deadline');

  let amountYen: number | null = null;
  let amountJa = e.amountJa;
  const printed = amountIn(redacted);
  const n = halfWidth(e.amountJa).replace(/[^\d]/g, '');
  const plain = halfWidth(redacted).replace(/(\d),(?=\d{3})/g, '$1');
  if (printed) {
    amountYen = printed.yen;
    amountJa = printed.source;
  } else if (n && new RegExp(`(?<!\\d)${n}(?!\\d)`).test(plain)) amountYen = Number(n);
  else if (e.amountJa) warnings.push('amount');

  return { ...e, issuerJa, deadlineJa, amountJa, deadlineIso, amountYen, issuerVerified, warnings };
};
