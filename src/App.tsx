import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Availability,
  type Checked,
  DeviceReadFailed,
  type Engine,
  LANGUAGES,
  coverPersonal,
  deviceReader,
  deviceSpeaks,
  downloadDeviceModel,
  explain,
  findPersonalOnDevice,
  languageName,
  readCoveredInCloud,
  type Reading,
  transcribeOnDevice,
  warmUp,
} from './lib/ai';
import { startFirebase } from './lib/firebase';
import { type Hidden, TAG, describeHidden, restore } from './lib/redact';
import { daysUntil } from './lib/wareki';
import { icsFor } from './lib/ics';
import { CoverTool } from './components/CoverTool';
import { Chat } from './components/Chat';
import { EngineBadge, Local } from './components/bits';

type Stage = 'home' | 'working' | 'cover' | 'confirm' | 'result' | 'error';
type StepState = 'todo' | 'doing' | 'done';
type Steps = { read: StepState; cover: StepState; explain: StepState };
type Timings = { read?: number; cover?: number; explain?: number };

const SAMPLES = [
  { file: 'resident-tax.jpg', title: 'Resident tax bill', ja: '住民税 納税通知書' },
  { file: 'health-insurance.jpg', title: 'Health insurance notice', ja: '国民健康保険料のお知らせ' },
  { file: 'pension-reminder.jpg', title: 'Pension reminder', ja: '国民年金保険料 督促状' },
];

// Errors from the SDK are technical; say what happened and what still works.
const friendly = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  if (/Personal data is still visible/i.test(m)) return 'Some personal details could not be covered for sure, so nothing was sent.';
  if (/app.?check|recaptcha|403|PERMISSION_DENIED/i.test(m)) return 'The cloud service did not accept the request (security check). Please try again in a moment.';
  if (/Failed to fetch|NetworkError|network|offline|ERR_INTERNET/i.test(m))
    return 'Fumi could not reach the cloud. Check your connection; explaining in English, Spanish or Japanese also works on this device.';
  if (/429|RESOURCE_EXHAUSTED|quota|500|503|UNAVAILABLE|overloaded|high demand|timeout|abort/i.test(m))
    return 'The cloud model is busy right now. Please try again in a minute.';
  return m || 'Something went wrong.';
};

const yen = (n: number) => `¥${n.toLocaleString('en-US')}`;

const prettyDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const savedLang = () => {
  try {
    return localStorage.getItem('fumi:lang') ?? 'en';
  } catch {
    return 'en';
  }
};

export const App = () => {
  const [stage, setStage] = useState<Stage>('home');
  const [lang, setLang] = useState(savedLang);
  const [reader, setReader] = useState<Availability | 'checking'>('checking');
  const [download, setDownload] = useState<number | null>(null);
  const [speaks, setSpeaks] = useState<boolean | null>(null);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [steps, setSteps] = useState<Steps>({ read: 'todo', cover: 'todo', explain: 'todo' });
  const [detail, setDetail] = useState('');
  const [readEngine, setReadEngine] = useState<Engine>('on_device');
  const [explainEngine, setExplainEngine] = useState<Engine>('on_device');
  const [removed, setRemoved] = useState<Hidden[]>([]);
  const [coverReason, setCoverReason] = useState<'no-model' | 'model-failed'>('no-model');
  const [redacted, setRedacted] = useState('');
  const [result, setResult] = useState<{ explanation: Checked; engine: Engine } | null>(null);
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [timings, setTimings] = useState<Timings>({});
  const mark = useRef(0);
  // seconds since the last mark, then move the mark
  const lap = () => {
    const now = Date.now();
    const s = Math.max(1, Math.round((now - mark.current) / 1000));
    mark.current = now;
    return s;
  };

  useEffect(() => {
    void startFirebase().catch(() => undefined);
    void deviceReader().then((a) => {
      setReader(a);
      if (a === 'available') void warmUp();
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('fumi:lang', lang);
    } catch {
      // storage unavailable
    }
    setSpeaks(null);
    void deviceSpeaks(lang).then(setSpeaks);
  }, [lang]);

  useEffect(() => {
    if (stage !== 'working') return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [stage, startedAt]);

  const reset = () => {
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto(null);
    setResult(null);
    setRemoved([]);
    setRedacted('');
    setError('');
    setDetail('');
    setStage('home');
  };

  const fail = (e: unknown) => {
    setError(friendly(e));
    setStage('error');
  };

  // Step 3: explain the covered text.
  const explainNow = useCallback(async (text: string, language: string) => {
    const local = await deviceSpeaks(language);
    setExplainEngine(local ? 'on_device' : 'in_cloud');
    setStage('working');
    setSteps((s) => ({ ...s, read: 'done', cover: 'done', explain: 'doing' }));
    mark.current = Date.now();
    try {
      const r = await explain(text, language, true);
      const seconds = lap();
      setTimings((t) => ({ ...t, explain: seconds }));
      setResult(r);
      setSteps((s) => ({ ...s, explain: 'done' }));
      setStage('result');
    } catch (e) {
      fail(e);
    }
  }, []);

  // Step 2, shared by both reading paths: cover everything personal. Text that
  // was read on this device goes to the cloud only after the reader has seen it.
  const coverAndExplain = useCallback(
    async (reading: Reading, engine: Engine) => {
      setSteps((s) => ({ ...s, read: 'done', cover: 'doing' }));
      const covered = coverPersonal(reading);
      setRemoved(covered.removed);
      setRedacted(covered.text);
      setSteps((s) => ({ ...s, cover: 'done' }));
      if (engine === 'on_device' && !(await deviceSpeaks(lang))) {
        setStage('confirm');
        return;
      }
      await explainNow(covered.text, lang);
    },
    [lang, explainNow]
  );

  const begin = (engine: Engine) => {
    mark.current = Date.now();
    setTimings({});
    setReadEngine(engine);
    setExplainEngine(speaks ? 'on_device' : 'in_cloud');
    setSteps({ read: 'doing', cover: 'todo', explain: 'todo' });
    setDetail('');
    setStartedAt(Date.now());
    setElapsed(0);
    setStage('working');
  };

  const start = async (blob: Blob) => {
    await startFirebase();
    const url = URL.createObjectURL(blob);
    setPhoto({ blob, url });
    setResult(null);
    setError('');
    if (reader !== 'available') {
      // No local model: the reader covers personal details by hand first.
      setCoverReason('no-model');
      setStage('cover');
      return;
    }
    begin('on_device');
    let transcript: string;
    try {
      transcript = await transcribeOnDevice(blob, setDetail);
      const seconds = lap();
      setTimings({ read: seconds });
    } catch (e) {
      if (e instanceof DeviceReadFailed) {
        // Nothing left the device. Offer the cover-by-hand path instead.
        setCoverReason('model-failed');
        setStage('cover');
        return;
      }
      return fail(e);
    }
    setSteps((s) => ({ ...s, read: 'done', cover: 'doing' }));
    setDetail('');
    // If the model can't list them, the patterns in redact.ts still apply.
    const personal = await findPersonalOnDevice(transcript).catch(() => []);
    const coverSeconds = lap();
    setTimings((t) => ({ ...t, cover: coverSeconds }));
    await coverAndExplain({ transcript, personal }, 'on_device');
  };

  const sendCovered = async (covered: Blob) => {
    // from here on, show the covered copy: it is the only one that was sent
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto({ blob: covered, url: URL.createObjectURL(covered) });
    begin('in_cloud');
    try {
      const reading = await readCoveredInCloud(covered);
      const seconds = lap();
      setTimings({ read: seconds });
      await coverAndExplain(reading, 'in_cloud');
    } catch (e) {
      fail(e);
    }
  };

  const getModel = async () => {
    setDownload(0);
    setReader('downloading');
    try {
      setReader(await downloadDeviceModel(setDownload));
    } catch {
      setReader(await deviceReader());
    } finally {
      setDownload(null);
      void deviceSpeaks(lang).then(setSpeaks);
    }
  };

  const loadSample = async (file: string) => {
    const res = await fetch(`/samples/${file}`);
    await start(await res.blob());
  };

  const onFile = (f: File | undefined) => {
    if (f) void start(f);
  };

  return (
    <div className="min-h-dvh">
      <header className={`mx-auto ${stage === 'home' ? 'max-w-5xl' : 'max-w-3xl'} px-5 pt-5 pb-3 flex items-center justify-between gap-3`}>
        <button type="button" onClick={reset} className="flex items-center gap-2.5 cursor-pointer" aria-label="Fumi home">
          <img src="/fumi.svg" alt="" className="w-9 h-9" />
          <span className="text-left leading-none">
            <span className="mincho block text-[26px] font-extrabold tracking-tight">Fumi</span>
            <span className="block text-[11.5px] mt-1" style={{ color: 'var(--ink-3)' }}>
              letters, explained privately
            </span>
          </span>
        </button>
        <label className="flex items-center gap-2 text-sm">
          <span className="hidden sm:inline" style={{ color: 'var(--ink-3)' }}>
            Explain in
          </span>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            disabled={stage === 'working'}
            className="rounded-full px-3 py-2 font-semibold cursor-pointer"
            style={{ background: 'var(--card)', border: '1.5px solid var(--line)' }}
            aria-label="Language for explanations"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.native}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main className={`mx-auto ${stage === 'home' ? 'max-w-5xl' : 'max-w-3xl'} px-5 pb-16`}>
        {stage === 'home' && (
          <Home reader={reader} speaks={speaks} lang={lang} download={download} onGetModel={() => void getModel()} onFile={onFile} onSample={loadSample} />
        )}
        {stage === 'cover' && photo && (
          <CoverTool photoUrl={photo.url} reason={coverReason} onCancel={reset} onSend={(b) => void sendCovered(b)} />
        )}
        {stage === 'working' && photo && (
          <Working
            photoUrl={photo.url}
            steps={steps}
            detail={detail}
            lang={lang}
            readEngine={readEngine}
            explainEngine={explainEngine}
            elapsed={elapsed}
            removed={removed.length}
          />
        )}
        {stage === 'confirm' && (
          <Confirm
            redacted={redacted}
            removed={removed}
            lang={lang}
            onSend={() => void explainNow(redacted, lang)}
            onEnglish={() => {
              setLang('en');
              void explainNow(redacted, 'en');
            }}
            onCancel={reset}
          />
        )}
        {stage === 'result' && result && (
          <Result
            result={result}
            readEngine={readEngine}
            removed={removed}
            redacted={redacted}
            lang={lang}
            timings={timings}
            photoUrl={photo?.url ?? ''}
            onAgain={reset}
          />
        )}
        {stage === 'error' && (
          <div className="card p-6 rise">
            <p className="mincho text-2xl font-extrabold">Fumi couldn’t finish this letter.</p>
            <p className="mt-2 text-[15px]" style={{ color: 'var(--ink-2)' }}>
              {error || 'Something went wrong.'} Nothing uncovered was sent anywhere. Try again, or try a sharper photo with the whole page in view.
            </p>
            <button type="button" className="btn btn-primary mt-5" onClick={reset}>
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  );
};

// ---------------------------------------------------------------------------

const Home = ({
  reader,
  speaks,
  lang,
  download,
  onGetModel,
  onFile,
  onSample,
}: {
  reader: string;
  speaks: boolean | null;
  lang: string;
  download: number | null;
  onGetModel: () => void;
  onFile: (f: File | undefined) => void;
  onSample: (file: string) => void;
}) => (
  <section className="rise">
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-12 lg:items-center">
      <div>
        <div className="mt-6 sm:mt-10">
          <h1 className="mincho text-[38px] sm:text-[52px] leading-[1.05] font-extrabold">
            A letter from the city office?
            <br />
            <span style={{ color: 'var(--seal)' }}>Know what it says.</span>
          </h1>
          <p className="mt-4 text-[17px] leading-relaxed max-w-xl" style={{ color: 'var(--ink-2)' }}>
            Take a photo of a Japanese letter: tax, health insurance, pension, school. Fumi reads it <b>on your device</b>, covers your name, address and My Number, and tells you what it is, what to do and by when, in your language.
          </p>
        </div>

        <div className="mt-7 flex flex-wrap gap-3">
          <label className="btn btn-primary">
            <CameraIcon />
            Take a photo
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <label className="btn btn-ghost">
            Choose a photo
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
        </div>

        <DeviceStatus reader={reader} speaks={speaks} lang={lang} download={download} onGetModel={onGetModel} />
      </div>
      <HeroArt />
    </div>

    <h2 className="mt-10 text-[13px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--ink-3)' }}>
      No letter at hand? Try a sample
    </h2>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      {SAMPLES.map((s) => (
        <button key={s.file} type="button" onClick={() => onSample(s.file)} className="card p-3 text-left cursor-pointer hover:-translate-y-0.5 transition-transform">
          <img src={`/samples/${s.file}`} alt="" className="w-full h-28 object-cover object-top rounded-lg" style={{ border: '1px solid var(--line)' }} />
          <span className="block mt-2 font-semibold">{s.title}</span>
          <span className="jp block text-[13px]" style={{ color: 'var(--ink-3)' }}>
            {s.ja}
          </span>
        </button>
      ))}
    </div>

    <div className="mt-10 grid gap-3 sm:grid-cols-3 text-[14px]">
      <Pledge title="Stays on your device" text="The photo and the full text are read by Gemini Nano on your own device." />
      <Pledge title="Personal details covered" text="Names, addresses, My Number and account numbers are swapped for labels before anything else happens." />
      <Pledge title="Cloud only when needed" text="Languages your device can’t write, and expert questions, use the cloud, with the covered text only." />
    </div>
  </section>
);

// A letter with its personal lines blacked out, and what Fumi makes of it.
const Bar = ({ label, width }: { label: string; width: number }) => (
  <span
    className="block rounded-[3px] px-1.5 py-[1px] font-bold tracking-[0.06em]"
    style={{ width, background: 'var(--ink)', color: 'var(--paper)', fontSize: 8.5 }}
  >
    {label}
  </span>
);

const HeroArt = () => (
  <div className="hidden lg:block relative h-[450px] mt-8 select-none" aria-hidden>
    <div className="card absolute left-0 top-0 w-[275px] p-5 -rotate-3" style={{ background: '#fffefa' }}>
      <p className="jp text-[10px] text-right" style={{ color: 'var(--ink-3)' }}>
        令和8年11月10日
      </p>
      <p className="jp mt-1 text-[13px] font-bold text-center">市民税・県民税 納税通知書</p>
      <div className="mt-3 grid gap-1.5">
        <Bar label="POSTAL CODE 1" width={92} />
        <Bar label="ADDRESS 1" width={170} />
        <Bar label="NAME 1" width={80} />
      </div>
      <div className="jp mt-3 grid grid-cols-[60px_1fr] text-[11px] border" style={{ borderColor: 'var(--line)' }}>
        <span className="px-1.5 py-1" style={{ background: 'var(--paper-2)' }}>個人番号</span>
        <span className="px-1.5 py-1">
          <Bar label="MY NUMBER 1" width={86} />
        </span>
        <span className="px-1.5 py-1" style={{ background: 'var(--paper-2)' }}>納期限</span>
        <span className="px-1.5 py-1 font-bold">令和8年12月28日</span>
        <span className="px-1.5 py-1" style={{ background: 'var(--paper-2)' }}>納付額</span>
        <span className="px-1.5 py-1 font-bold">18,600円</span>
      </div>
      <div className="mt-3 grid gap-1">
        <span className="h-1.5 rounded-full w-full" style={{ background: 'var(--paper-2)' }} />
        <span className="h-1.5 rounded-full w-4/6" style={{ background: 'var(--paper-2)' }} />
      </div>
    </div>
    <div className="card absolute right-0 bottom-0 w-[228px] p-4 rotate-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--ink-3)' }}>
        City Hall · Resident tax
      </p>
      <p className="display mt-1 text-[19px] font-bold leading-tight">Resident tax bill</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <span className="rounded-xl p-2" style={{ background: 'var(--seal-bg)' }}>
          <span className="block text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--seal)' }}>
            Pay by
          </span>
          <span className="block text-[14px] font-bold">Dec 28</span>
        </span>
        <span className="rounded-xl p-2" style={{ background: 'var(--paper-2)' }}>
          <span className="block text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--ink-3)' }}>
            Amount
          </span>
          <span className="block text-[14px] font-bold">¥18,600</span>
        </span>
      </div>
      <p className="mt-2 text-[12px]" style={{ color: 'var(--ink-2)' }}>
        ☐ Pay the enclosed slip at a bank or convenience store.
      </p>
      <span className="chip chip-device mt-2.5">● Read on this device</span>
    </div>
  </div>
);

const Pledge = ({ title, text }: { title: string; text: string }) => (
  <div className="rounded-2xl p-4" style={{ background: 'var(--paper-2)' }}>
    <p className="font-bold">{title}</p>
    <p className="mt-1" style={{ color: 'var(--ink-2)' }}>
      {text}
    </p>
  </div>
);

const DeviceStatus = ({
  reader,
  speaks,
  lang,
  download,
  onGetModel,
}: {
  reader: string;
  speaks: boolean | null;
  lang: string;
  download: number | null;
  onGetModel: () => void;
}) => {
  if (reader === 'checking') return null;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2 text-[13px]">
      {reader === 'available' ? (
        <span className="chip chip-device">● On-device AI ready: letters are read privately on this device</span>
      ) : reader === 'downloadable' ? (
        <>
          <span className="chip chip-warn">● Chrome can read letters on this device after a one-time model download.</span>
          <button type="button" className="btn btn-ghost !py-1.5 !px-3 text-[13px]" onClick={onGetModel}>
            Download the on-device model
          </button>
        </>
      ) : reader === 'downloading' ? (
        <span className="chip chip-warn grow max-w-md">
          <span className="shrink-0">● Downloading the on-device model{download !== null ? ` · ${Math.round(download * 100)}%` : ''}</span>
          <span className="progress grow" aria-hidden>
            <span style={{ width: `${Math.round((download ?? 0) * 100)}%` }} />
          </span>
        </span>
      ) : (
        <span className="chip chip-warn">● This browser has no on-device model. You’ll cover personal details by hand before using the cloud.</span>
      )}
      {speaks === false && (
        <span className="chip chip-cloud">☁ {languageName(lang)} explanations use the cloud, with the covered text only</span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

const Working = ({
  photoUrl,
  steps,
  detail,
  lang,
  readEngine,
  explainEngine,
  elapsed,
  removed,
}: {
  photoUrl: string;
  steps: Steps;
  detail: string;
  lang: string;
  readEngine: Engine;
  explainEngine: Engine;
  elapsed: number;
  removed: number;
}) => (
  <section className="rise mt-6 grid grid-cols-1 gap-5 sm:grid-cols-[220px_minmax(0,1fr)]">
    <img src={photoUrl} alt="Your letter" className="w-full max-h-72 object-contain rounded-xl card" />
    <div className="card p-5">
      <p className="mincho text-2xl font-extrabold">Reading your letter…</p>
      <ol className="mt-4 grid gap-3">
        <Step
          state={steps.read}
          title={readEngine === 'on_device' ? 'Reading the letter on this device' : 'Reading the covered photo in the cloud'}
          note={
            readEngine === 'on_device'
              ? ['Gemini Nano', detail, steps.read === 'doing' ? `${elapsed}s` : ''].filter(Boolean).join(' · ')
              : `Only the covered photo was sent${steps.read === 'doing' ? ` · ${elapsed}s` : ''}`
          }
          engine={readEngine}
        />
        <Step
          state={steps.cover}
          title="Covering personal details"
          note={
            steps.cover === 'done'
              ? `${removed} item${removed === 1 ? '' : 's'} covered`
              : readEngine === 'on_device'
                ? 'Gemini Nano finds them, fixed patterns double-check'
                : 'Names, addresses, My Number, account numbers'
          }
          engine="on_device"
        />
        <Step
          state={steps.explain}
          title={`Explaining in ${languageName(lang)}`}
          note={
            (explainEngine === 'on_device' ? 'On this device' : 'Cloud model, covered text only') +
            (steps.explain === 'doing' ? ` · ${elapsed}s` : '')
          }
          engine={explainEngine}
        />
      </ol>
    </div>
  </section>
);

// Before text read on this device goes to the cloud, the reader sees exactly
// what would be sent, and can keep everything on the device instead.
const Confirm = ({
  redacted,
  removed,
  lang,
  onSend,
  onEnglish,
  onCancel,
}: {
  redacted: string;
  removed: Hidden[];
  lang: string;
  onSend: () => void;
  onEnglish: () => void;
  onCancel: () => void;
}) => (
  <section className="rise mt-6 card p-5 sm:p-6">
    <p className="mincho text-2xl font-extrabold">Send the covered text to the cloud?</p>
    <p className="mt-2 text-[15px]" style={{ color: 'var(--ink-2)' }}>
      The on-device model can’t write {languageName(lang)} yet, so a cloud model would write the explanation. This is everything it would get.
      {removed.length > 0 && ` Already covered: ${describeHidden(removed)}.`}
    </p>
    <pre className="jp mt-4 max-h-80 overflow-auto whitespace-pre-wrap text-[13.5px] leading-relaxed rounded-xl p-3" style={{ background: 'var(--paper-2)' }}>
      <Covered text={redacted} />
    </pre>
    <div className="mt-5 flex flex-wrap gap-3">
      <button type="button" className="btn btn-primary" onClick={onSend}>
        Send and explain in {languageName(lang)}
      </button>
      {lang !== 'en' && (
        <button type="button" className="btn btn-ghost" onClick={onEnglish}>
          Explain in English on this device
        </button>
      )}
      <button type="button" className="underline underline-offset-4 cursor-pointer px-2" onClick={onCancel}>
        Cancel
      </button>
    </div>
  </section>
);

const Step = ({ state, title, note, engine }: { state: StepState; title: string; note: string; engine: Engine }) => (
  <li className="flex items-start gap-3">
    <span
      className={`mt-0.5 w-6 h-6 shrink-0 rounded-full grid place-items-center text-[13px] font-bold ${state === 'doing' ? 'pulse' : ''}`}
      style={{
        background: state === 'done' ? 'var(--ok)' : state === 'doing' ? 'var(--ink)' : 'var(--paper-2)',
        color: state === 'todo' ? 'var(--ink-3)' : 'white',
      }}
      aria-hidden
    >
      {state === 'done' ? '✓' : '•'}
    </span>
    <span>
      <span className="font-semibold">{title}</span>
      <span className="ml-2 align-middle">
        <EngineBadge engine={engine} />
      </span>
      <span className="block text-[13px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
        {note}
      </span>
    </span>
  </li>
);

// ---------------------------------------------------------------------------

const Result = ({
  result,
  readEngine,
  removed,
  redacted,
  lang,
  timings,
  photoUrl,
  onAgain,
}: {
  result: { explanation: Checked; engine: Engine };
  readEngine: Engine;
  removed: Hidden[];
  redacted: string;
  lang: string;
  timings: Timings;
  photoUrl: string;
  onAgain: () => void;
}) => {
  const e = result.explanation;
  const [done, setDone] = useState<boolean[]>(() => e.actions.map(() => false));
  const [showText, setShowText] = useState(false);
  const days = e.deadlineIso ? daysUntil(e.deadlineIso) : null;
  const sentToCloud = readEngine === 'in_cloud' || result.engine === 'in_cloud';

  const calendarUrl = useMemo(() => {
    if (!e.deadlineIso) return '';
    const body = `${e.summary}\n\n${e.actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}${e.contact ? `\n\n${e.contact}` : ''}`;
    const text = icsFor(`${e.kind}: deadline`, e.deadlineIso, restore(body, removed));
    return URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
  }, [e, removed]);

  return (
    <section className="rise mt-6 grid grid-cols-1 gap-4 break-words">
      <div className="card p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12.5px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--ink-3)' }}>
              {e.issuer || 'Official letter'}
              {e.issuerJa && (
                <span className="jp normal-case tracking-normal font-medium ml-2">
                  {e.issuerJa}
                  {e.issuerVerified ? ' ✓' : ''}
                </span>
              )}
            </p>
            <h2 className="display mt-1 text-[28px] leading-tight font-bold">{e.kind}</h2>
          </div>
          {photoUrl && <img src={photoUrl} alt="" className="w-16 h-20 object-cover object-top rounded-md shrink-0" style={{ border: '1px solid var(--line)' }} />}
        </div>
        <p className="mt-3 text-[17px] leading-relaxed">
          <Local text={e.summary} hidden={removed} />
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Fact
            label="Deadline"
            value={e.deadlineIso ? prettyDate(e.deadlineIso) : e.deadlineJa || 'None in this letter'}
            sub={
              days === null
                ? e.deadlineJa
                : days < 0
                  ? `${-days} days overdue · ${e.deadlineJa}`
                  : days === 0
                    ? `Today · ${e.deadlineJa}`
                    : `in ${days} day${days === 1 ? '' : 's'} · ${e.deadlineJa}`
            }
            urgent={days !== null && days <= 7}
          />
          <Fact label="Amount" value={e.amountYen !== null ? yen(e.amountYen) : e.amountJa || 'No payment in this letter'} sub={e.amountJa} />
        </div>

        {e.warnings.some((w) => w !== 'language') && (
          <p className="mt-4 chip chip-warn !rounded-xl !py-2 !px-3 leading-snug">
            Double-check the {e.warnings.filter((w) => w !== 'language').join(', ')} against the letter: Fumi couldn’t match it to the printed text.
          </p>
        )}
        {e.warnings.includes('language') && (
          <p className="mt-4 chip chip-warn !rounded-xl !py-2 !px-3 leading-snug">
            The models couldn’t write this one in {languageName(lang)}, so parts may be in another language.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2.5">
          {calendarUrl && (
            <a className="btn btn-primary" href={calendarUrl} download="fumi-deadline.ics">
              Add deadline to calendar
            </a>
          )}
          <button type="button" className="btn btn-ghost" onClick={onAgain}>
            Read another letter
          </button>
        </div>
      </div>

      <div className="card p-5 sm:p-6">
        <h3 className="text-[13px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--ink-3)' }}>
          What to do
        </h3>
        <ol className="mt-3 grid gap-2">
          {e.actions.map((a, i) => (
            <li key={i}>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={done[i] ?? false}
                  onChange={() => setDone((d) => d.map((v, j) => (j === i ? !v : v)))}
                  className="mt-1 w-5 h-5 shrink-0 accent-[var(--ink)]"
                />
                <span className={done[i] ? 'line-through opacity-60' : ''}>
                  <Local text={a} hidden={removed} />
                </span>
              </label>
            </li>
          ))}
        </ol>
        {e.payment && <Detail title="How to pay or respond" text={e.payment} hidden={removed} />}
        {e.contact && <Detail title="Who to contact" text={e.contact} hidden={removed} />}
      </div>

      {e.terms.length > 0 && (
        <div className="card p-5 sm:p-6">
          <h3 className="text-[13px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--ink-3)' }}>
            Words in this letter
          </h3>
          <dl className="mt-3 grid gap-2.5">
            {e.terms.map((t, i) => (
              <div key={i}>
                <dt className="jp font-bold">{t.ja}</dt>
                <dd className="text-[15px]" style={{ color: 'var(--ink-2)' }}>
                  {t.meaning}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <Chat redacted={redacted} hidden={removed} lang={lang} />

      <div className="card p-5 sm:p-6" style={{ background: 'var(--paper-2)' }}>
        <h3 className="font-bold flex items-center gap-2">
          <span className="seal text-[13px]">私</span> Your privacy on this letter
        </h3>
        <ul className="mt-3 grid gap-1.5 text-[15px]">
          <li>
            {readEngine === 'on_device'
              ? '✓ The photo and the full text never left this device.'
              : '✓ You covered personal details before the photo was sent to the cloud.'}
          </li>
          {timings.read && (
            <li style={{ color: 'var(--ink-3)' }}>
              ⏱ Read {readEngine === 'on_device' ? 'on this device' : 'in the cloud'} in {timings.read} s
              {timings.cover ? `, details found in ${timings.cover} s` : ''}
              {timings.explain ? `, explained ${result.engine === 'on_device' ? 'on this device' : 'in the cloud'} in ${timings.explain} s` : ''}.
            </li>
          )}
          <li>
            ✓ {removed.length ? `Covered on this device before anything else: ${describeHidden(removed)}.` : 'No personal details were found to cover.'}
          </li>
          <li>
            {result.engine === 'on_device' ? '✓ The explanation was written on this device.' : '☁ The explanation was written in the cloud from the covered text below.'}
          </li>
          {removed.length > 0 && (
            <li>
              ✓ Where the explanation needs one of them, like a phone number to call, Fumi fills it back in <span className="local">on your screen only</span>.
            </li>
          )}
        </ul>
        {sentToCloud && (
          <button type="button" onClick={() => setShowText((v) => !v)} className="mt-3 underline underline-offset-4 text-[14px] cursor-pointer">
            {showText ? 'Hide' : 'Show'} exactly what was sent
          </button>
        )}
        {sentToCloud && showText && (
          <pre className="jp mt-3 whitespace-pre-wrap text-[13.5px] leading-relaxed rounded-xl p-3" style={{ background: 'var(--card)' }}>
            <Covered text={redacted} />
          </pre>
        )}
        {!sentToCloud && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[14px]">See the covered text</summary>
            <pre className="jp mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed rounded-xl p-3" style={{ background: 'var(--card)' }}>
              <Covered text={redacted} />
            </pre>
          </details>
        )}
      </div>
    </section>
  );
};

const Covered = ({ text }: { text: string }) => (
  <>
    {text.split(new RegExp(`(${TAG.source})`, 'g')).map((part, i) =>
      new RegExp(`^${TAG.source}$`).test(part) ? (
        <span key={i} className="redacted">
          {part.slice(1, -1)}
        </span>
      ) : (
        <span key={i}>{part}</span>
      )
    )}
  </>
);

const Fact = ({ label, value, sub, urgent }: { label: string; value: string; sub?: string; urgent?: boolean }) => (
  <div className="rounded-2xl p-4" style={{ background: urgent ? 'var(--seal-bg)' : 'var(--paper-2)' }}>
    <p className="text-[12px] font-bold uppercase tracking-[0.14em]" style={{ color: urgent ? 'var(--seal)' : 'var(--ink-3)' }}>
      {label}
    </p>
    <p className="mt-1 text-[24px] font-bold leading-tight">{value}</p>
    {sub && (
      <p className="jp mt-1 text-[13px]" style={{ color: 'var(--ink-2)' }}>
        {sub}
      </p>
    )}
  </div>
);

const Detail = ({ title, text, hidden }: { title: string; text: string; hidden: Hidden[] }) => (
  <div className="mt-4">
    <p className="font-bold">{title}</p>
    <p className="mt-1" style={{ color: 'var(--ink-2)' }}>
      <Local text={text} hidden={hidden} />
    </p>
  </div>
);

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" strokeLinejoin="round" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);
