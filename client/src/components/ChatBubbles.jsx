import React from 'react';
import { Check, CheckCheck, SlidersHorizontal, Wrench } from 'lucide-react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

function resolveMediaUrl(url) {
  if (!url) return url;
  if (url.startsWith('/api/') && API_BASE) {
    return `${API_BASE}${url}`;
  }
  return url;
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function DateSeparator({ label }) {
  return (
    <div className="flex justify-center my-2">
      <span className="px-3 py-1 rounded-lg text-[11px] font-medium bg-white/85 dark:bg-wa-inDark/90 text-slate-600 dark:text-slate-300 shadow-sm">
        {label}
      </span>
    </div>
  );
}

export function SystemPill({ text }) {
  return (
    <div className="flex justify-center my-1.5 px-4">
      <span className="px-3 py-1 rounded-full text-[11px] text-center bg-amber-100/90 dark:bg-slate-800/90 text-slate-700 dark:text-slate-300 shadow-sm max-w-[90%]">
        {text}
      </span>
    </div>
  );
}

export function TypingIndicator({ label = 'CarDesk is checking your photos...' }) {
  return (
    <div className="flex justify-start mb-2 pl-2 animate-msgIn">
      <div className="relative bg-wa-in dark:bg-wa-inDark text-slate-800 dark:text-slate-100 rounded-xl rounded-tl-none px-3.5 py-2.5 shadow-sm bubble-tail-in max-w-[80%]">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="typing-dot w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-400 inline-block" />
            <span className="typing-dot w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-400 inline-block" />
            <span className="typing-dot w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-400 inline-block" />
          </div>
          {label && <span className="text-[11px] text-slate-500 dark:text-slate-400">{label}</span>}
        </div>
      </div>
    </div>
  );
}

function DeliveryTicks({ status }) {
  if (status === 'sending') {
    return <Check className="w-3.5 h-3.5 text-slate-400 inline-block ml-1" />;
  }
  if (status === 'read') {
    return <CheckCheck className="w-3.5 h-3.5 text-wa-tickBlue inline-block ml-1" />;
  }
  return <CheckCheck className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 inline-block ml-1" />;
}

function ImageGrid({ images, onOpenImage }) {
  if (!images || images.length === 0) return null;
  const visible = images.slice(0, 4);
  const extraCount = images.length - 4;

  if (visible.length === 1) {
    const img = visible[0];
    const imgUrl = resolveMediaUrl(img.url);
    return (
      <div
        className="relative rounded-lg overflow-hidden cursor-pointer mb-1 bg-black/10"
        onClick={() => onOpenImage({ mode: 'view', url: imgUrl, caption: img.caption })}
      >
        <img
          src={imgUrl}
          alt={img.caption || 'Uploaded car photo'}
          className="w-full max-h-64 object-cover"
        />
        {typeof img.progress === 'number' && img.progress < 100 && (
          <div className="absolute inset-0 bg-black/45 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full border-4 border-white/30 border-t-wa-green animate-spin flex items-center justify-center" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-1 mb-1 rounded-lg overflow-hidden">
      {visible.map((img, idx) => {
        const showPlusN = idx === 3 && extraCount > 0;
        const imgUrl = resolveMediaUrl(img.url);
        return (
          <div
            key={img.id || idx}
            className="relative aspect-square bg-black/10 cursor-pointer overflow-hidden"
            onClick={() => onOpenImage({ mode: 'view', url: imgUrl, caption: img.caption })}
          >
            <img src={imgUrl} alt="" className="w-full h-full object-cover" />
            {showPlusN && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-xl font-bold">
                +{extraCount}
              </div>
            )}
            {typeof img.progress === 'number' && img.progress < 100 && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                <div className="w-7 h-7 rounded-full border-2 border-white/40 border-t-wa-green animate-spin" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MessageBubble({ msg, onOpenModal, onQuickReply }) {
  if (msg.msg_type === 'system') {
    return <SystemPill text={msg.text} />;
  }

  const isOut = msg.role === 'dealer';
  const payload = msg.payload_json || {};
  const images = payload.images || [];
  const repairedChips = payload.repairedChips || [];
  const quickReplies = payload.quickReplies || [];
  const beforeUrl = resolveMediaUrl(payload.beforeUrl);
  const afterUrl = resolveMediaUrl(payload.afterUrl);
  const hasCompare = Boolean(beforeUrl && afterUrl);

  return (
    <div className={`flex flex-col ${isOut ? 'items-end pr-2' : 'items-start pl-2'} mb-2 animate-msgIn`}>
      <div
        className={`relative max-w-[84%] sm:max-w-[78%] rounded-xl px-2.5 pt-2 pb-1.5 shadow-sm text-[13.5px] leading-snug ${
          isOut
            ? 'bg-wa-out dark:bg-wa-outDark text-slate-900 dark:text-slate-100 rounded-tr-none bubble-tail-out'
            : 'bg-wa-in dark:bg-wa-inDark text-slate-900 dark:text-slate-100 rounded-tl-none bubble-tail-in'
        }`}
      >
        {/* Multi-image or single-image attachment */}
        {images.length > 0 && <ImageGrid images={images} onOpenImage={onOpenModal} />}

        {/* Result image with Before/After */}
        {afterUrl && (
          <div className="relative rounded-lg overflow-hidden mb-1.5 bg-black/10">
            <img
              src={afterUrl}
              alt="Processed photo"
              className="w-full max-h-64 object-cover cursor-pointer"
              onClick={() =>
                onOpenModal(
                  hasCompare
                    ? {
                        mode: 'compare',
                        beforeUrl,
                        afterUrl,
                        caption: msg.text,
                      }
                    : { mode: 'view', url: afterUrl, caption: msg.text }
                )
              }
            />
            {hasCompare && (
              <button
                type="button"
                onClick={() =>
                  onOpenModal({
                    mode: 'compare',
                    beforeUrl,
                    afterUrl,
                    caption: msg.text,
                  })
                }
                className="absolute bottom-2 right-2 px-2.5 py-1 rounded-full bg-black/75 hover:bg-black/90 text-white text-[11px] font-medium flex items-center gap-1 shadow"
              >
                <SlidersHorizontal className="w-3 h-3 text-wa-green" />
                Before / After
              </button>
            )}
          </div>
        )}

        {/* Repair chips */}
        {repairedChips.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {repairedChips.map((chip, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200"
              >
                <Wrench className="w-2.5 h-2.5" />
                {chip}
              </span>
            ))}
          </div>
        )}

        {/* Message text + inline timestamp */}
        {msg.text && (
          <div className="whitespace-pre-wrap break-words pr-12">
            {msg.text}
          </div>
        )}

        <div className="flex items-center justify-end gap-0.5 text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 -mb-0.5 select-none">
          <span>{formatTime(msg.created_at)}</span>
          {isOut && <DeliveryTicks status={msg.delivery_status} />}
        </div>
      </div>

      {/* WhatsApp-style quick-reply buttons under bot messages */}
      {!isOut && quickReplies.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5 max-w-[85%]">
          {quickReplies.map((qr, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => onQuickReply(qr)}
              className="px-3 py-1.5 rounded-full bg-white dark:bg-wa-inDark hover:bg-emerald-50 dark:hover:bg-slate-700 text-wa-teal dark:text-wa-green text-xs font-medium shadow-sm border border-emerald-200/70 dark:border-slate-700 transition-colors"
            >
              {qr.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
