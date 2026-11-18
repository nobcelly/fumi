import type { Engine } from '../lib/ai';
import { type Hidden, labelName, restoreParts } from '../lib/redact';

export const EngineBadge = ({ engine }: { engine: Engine }) =>
  engine === 'on_device' ? <span className="chip chip-device">On device</span> : <span className="chip chip-cloud">☁ Cloud</span>;

// Text from a model, with labels like [PHONE 1] filled back in from this
// device. Filled-in values are marked, because the model never saw them.
export const Local = ({ text, hidden }: { text: string; hidden: Hidden[] }) => (
  <>
    {restoreParts(text, hidden).map((part, i) =>
      part.hidden ? (
        <span key={i} className="local" title={`${labelName(part.hidden.label)}: hidden from the AI, filled in on this device`}>
          {part.text}
        </span>
      ) : (
        <span key={i}>{part.text}</span>
      )
    )}
  </>
);
