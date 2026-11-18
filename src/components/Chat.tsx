import { useState } from 'react';
import { type Engine, ask } from '../lib/ai';
import type { Hidden } from '../lib/redact';
import { EngineBadge, Local } from './bits';

type Message = { from: 'me' | 'fumi'; text: string; engine?: Engine };

const SUGGESTIONS = [
  'Can I pay this at a convenience store?',
  'What happens if I pay late?',
  'Do I need to go to the office in person?',
];

// Follow-up questions about the letter. Answers come from the on-device model
// by default; "Ask the cloud expert" sends the covered text and the covered
// question to the cloud model.
export const Chat = ({ redacted, hidden, lang }: { redacted: string; hidden: Hidden[]; lang: string }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [known, setKnown] = useState<Hidden[]>(hidden);
  const [text, setText] = useState('');
  const [expert, setExpert] = useState(false);
  const [busy, setBusy] = useState(false);

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setText('');
    setBusy(true);
    setMessages((m) => [...m, { from: 'me', text: question }]);
    try {
      const r = await ask(question, redacted, known, lang, expert);
      setKnown(r.hidden);
      setMessages((m) => [...m, { from: 'fumi', text: r.answer, engine: r.engine }]);
    } catch (e) {
      setMessages((m) => [...m, { from: 'fumi', text: e instanceof Error ? e.message : 'Something went wrong.' }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5 sm:p-6">
      <h3 className="text-[13px] font-bold uppercase tracking-[0.14em]" style={{ color: 'var(--ink-3)' }}>
        Ask about this letter
      </h3>
      {messages.length === 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => void send(s)} className="rounded-full px-3 py-1.5 text-[14px] cursor-pointer" style={{ border: '1.5px solid var(--line)' }}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 grid gap-2.5" aria-live="polite">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${m.from === 'me' ? 'justify-self-end' : ''}`}
            style={{ background: m.from === 'me' ? 'var(--ink)' : 'var(--paper-2)', color: m.from === 'me' ? 'var(--paper)' : 'var(--ink)', maxWidth: '92%' }}
          >
            {m.from === 'fumi' ? <Local text={m.text} hidden={known} /> : m.text}
            {m.engine && (
              <span className="block mt-1.5">
                <EngineBadge engine={m.engine} />
              </span>
            )}
          </div>
        ))}
        {busy && <p className="pulse text-[14px]" style={{ color: 'var(--ink-3)' }}>Thinking…</p>}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a question"
          className="flex-1 min-w-0 rounded-full px-4 py-2.5"
          style={{ background: 'var(--paper)', border: '1.5px solid var(--line)' }}
        />
        <button type="submit" className="btn btn-primary !py-2.5" disabled={busy || !text.trim()}>
          Ask
        </button>
      </form>
      <label className="mt-3 flex items-start gap-2.5 text-[14px] cursor-pointer">
        <input type="checkbox" checked={expert} onChange={(e) => setExpert(e.target.checked)} className="mt-0.5 w-4.5 h-4.5" />
        <span>
          Ask the cloud model instead <span style={{ color: 'var(--ink-3)' }}>(it gets the covered letter and your question with personal details covered)</span>
        </span>
      </label>
    </div>
  );
};
