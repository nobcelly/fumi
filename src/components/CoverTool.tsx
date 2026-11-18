import { useEffect, useRef, useState } from 'react';

type Box = { x: number; y: number; w: number; h: number };

// Without a local model, nothing personal may reach the cloud uncovered: the
// reader drags black boxes over their name, address and numbers first, and
// only the covered copy is sent.
export const CoverTool = ({
  photoUrl,
  reason,
  onCancel,
  onSend,
}: {
  photoUrl: string;
  reason: 'no-model' | 'model-failed';
  onCancel: () => void;
  onSend: (covered: Blob) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [drag, setDrag] = useState<Box | null>(null);
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    const i = new Image();
    i.onload = () => {
      img.current = i;
      draw([], null);
    };
    i.src = photoUrl;
  }, [photoUrl]);

  const draw = (list: Box[], current: Box | null) => {
    const c = canvas.current;
    const i = img.current;
    if (!c || !i) return;
    const scale = Math.min(1, 1600 / Math.max(i.width, i.height));
    c.width = Math.round(i.width * scale);
    c.height = Math.round(i.height * scale);
    const g = c.getContext('2d')!;
    g.drawImage(i, 0, 0, c.width, c.height);
    g.fillStyle = '#111';
    for (const b of [...list, ...(current ? [current] : [])]) g.fillRect(b.x, b.y, b.w, b.h);
  };

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  const normal = (b: Box): Box => ({
    x: Math.min(b.x, b.x + b.w),
    y: Math.min(b.y, b.y + b.h),
    w: Math.abs(b.w),
    h: Math.abs(b.h),
  });

  const send = () => {
    canvas.current?.toBlob((b) => b && onSend(b), 'image/jpeg', 0.9);
  };

  return (
    <section className="rise mt-6 card p-5 sm:p-6">
      <p className="mincho text-2xl font-extrabold">Cover your personal details first</p>
      <p className="mt-2 text-[15px]" style={{ color: 'var(--ink-2)' }}>
        {reason === 'model-failed'
          ? 'The on-device model couldn’t read this photo clearly, and nothing has left your device. You can try a sharper photo, or let the cloud model read a covered copy.'
          : 'This browser can’t read the letter on the device, so the cloud model will read it.'}{' '}
        Drag over your <b>name, address, My Number and any account or ID numbers</b> to black them out. Only the covered copy is sent.
      </p>
      <canvas
        ref={canvas}
        className="mt-4 w-full rounded-xl touch-none cursor-crosshair"
        style={{ border: '1px solid var(--line)' }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const p = point(e);
          const next = { ...drag, w: p.x - drag.x, h: p.y - drag.y };
          setDrag(next);
          draw(boxes, normal(next));
        }}
        onPointerUp={() => {
          if (!drag) return;
          const b = normal(drag);
          const list = b.w > 6 && b.h > 6 ? [...boxes, b] : boxes;
          setBoxes(list);
          setDrag(null);
          draw(list, null);
        }}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[14px]">
        <span style={{ color: 'var(--ink-3)' }}>{boxes.length} area{boxes.length === 1 ? '' : 's'} covered</span>
        <button
          type="button"
          className="underline underline-offset-4 cursor-pointer disabled:opacity-40"
          disabled={!boxes.length}
          onClick={() => {
            const list = boxes.slice(0, -1);
            setBoxes(list);
            draw(list, null);
          }}
        >
          Undo
        </button>
      </div>
      <label className="mt-4 flex items-start gap-3 text-[15px] cursor-pointer">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 w-5 h-5" />
        <span>I covered my personal details. Send the covered photo to the cloud model to read it.</span>
      </label>
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary" disabled={!agreed || boxes.length === 0} onClick={send}>
          Send covered photo
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
};
