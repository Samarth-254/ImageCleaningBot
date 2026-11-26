import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  Camera,
  Paperclip,
  Smile,
  Send,
  Mic,
  Activity,
  Image as ImageIcon,
  Car,
  X,
} from 'lucide-react';
import { DateSeparator, MessageBubble, TypingIndicator } from './components/ChatBubbles.jsx';
import { BeforeAfterModal } from './components/BeforeAfterModal.jsx';
import { TracePanel } from './components/TracePanel.jsx';

const API_BASE = import.meta.env.VITE_API_URL || '';

const QUICK_EMOJIS = ['👍', '🚗', '✨', '🙏', '📸', '✅', '🔧', '💯'];

function getOrCreateDealerId() {
  const key = 'cardesk_dealer_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export default function App() {
  const [dealerId, setDealerId] = useState(getOrCreateDealerId);
  const [messages, setMessages] = useState([]);
  const [traceData, setTraceData] = useState({ jobs: [], images: [], usage: [], events: [] });
  const [policy, setPolicy] = useState(null);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [modalState, setModalState] = useState(null);
  const [showAttachSheet, setShowAttachSheet] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showMobileTrace, setShowMobileTrace] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [serverOnline, setServerOnline] = useState(true);

  const chatEndRef = useRef(null);
  const galleryInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const lastEventIdRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, scrollToBottom]);

  // Initialize session, load history, policy, and connect SSE
  useEffect(() => {
    let es = null;
    let cancelled = false;

    async function init() {
      try {
        const sessResp = await fetch(`${API_BASE}/api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dealerId }),
        });
        if (!sessResp.ok) throw new Error('Session failed');
        const sess = await sessResp.json();
        if (sess.dealerId && sess.dealerId !== dealerId) {
          localStorage.setItem('cardesk_dealer_id', sess.dealerId);
          setDealerId(sess.dealerId);
        }

        const [histResp, polResp, traceResp] = await Promise.all([
          fetch(`${API_BASE}/api/messages?dealerId=${encodeURIComponent(sess.dealerId)}`),
          fetch(`${API_BASE}/api/policy`),
          fetch(`${API_BASE}/api/trace?dealerId=${encodeURIComponent(sess.dealerId)}`),
        ]);

        if (cancelled) return;

        if (histResp.ok) {
          const hist = await histResp.json();
          if (hist.messages?.length > 0) {
            setMessages(hist.messages);
            lastEventIdRef.current = hist.messages[hist.messages.length - 1].id;
          } else {
            setMessages([
              {
                id: 'welcome-1',
                role: 'assistant',
                msg_type: 'text',
                text: 'Welcome to CarDesk Assistant! Upload photos of your car (dents, scratches, dirt, cracked glass) and I will return listing-ready photos very soon.',
                created_at: new Date().toISOString(),
                payload_json: {
                  quickReplies: [{ label: 'Upload photos', action: 'open_upload' }],
                },
              },
            ]);
          }
        }
        if (polResp.ok) setPolicy(await polResp.json());
        if (traceResp.ok) setTraceData(await traceResp.json());

        // SSE stream with Last-Event-ID support via query cursor
        es = new EventSource(
          `${API_BASE}/api/stream?dealerId=${encodeURIComponent(sess.dealerId)}&lastId=${lastEventIdRef.current}`
        );

        es.addEventListener('message', (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            lastEventIdRef.current = Math.max(lastEventIdRef.current, Number(msg.id || 0));
            setMessages((prev) => {
              if (prev.some((m) => String(m.id) === String(msg.id))) return prev;
              // Replace optimistic message if matching clientMsgId
              if (msg.payload_json?.clientMsgId) {
                const idx = prev.findIndex((m) => m.id === msg.payload_json.clientMsgId);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = msg;
                  return next;
                }
              }
              return [...prev, msg];
            });
            if (msg.role === 'assistant') {
              setIsTyping(false);
            }
          } catch {
            // ignore malformed SSE event
          }
        });

        es.addEventListener('trace', (ev) => {
          try {
            const data = JSON.parse(ev.data);
            setTraceData(data);
            const activeJob = data.jobs?.find((j) => j.status === 'processing');
            setIsTyping(Boolean(activeJob));
          } catch {
            // ignore
          }
        });

        es.onerror = () => {
          // EventSource auto-reconnects; keep quiet unless offline
        };
      } catch {
        setServerOnline(false);
        setMessages((prev) =>
          prev.length > 0
            ? prev
            : [
                {
                  id: 'offline-welcome',
                  role: 'assistant',
                  msg_type: 'text',
                  text: 'CarDesk UI is running in preview mode (server/DB not connected yet). You can test the WhatsApp-style interface, attachments, and Before/After slider!',
                  created_at: new Date().toISOString(),
                },
              ]
        );
      }
    }

    init();
    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, [dealerId]);

  const handleUploadFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setShowAttachSheet(false);

    const clientMsgId = `opt-${Date.now()}`;
    const optimisticImages = files.map((f, i) => ({
      id: `${clientMsgId}-${i}`,
      url: URL.createObjectURL(f),
      progress: 15,
    }));

    setMessages((prev) => [
      ...prev,
      {
        id: clientMsgId,
        role: 'dealer',
        msg_type: 'image',
        text: files.length === 1 ? 'Uploaded 1 photo' : `Uploaded ${files.length} photos`,
        delivery_status: 'sending',
        created_at: new Date().toISOString(),
        payload_json: { images: optimisticImages },
      },
    ]);
    setIsTyping(true);

    if (!serverOnline) {
      setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === clientMsgId
              ? {
                  ...m,
                  delivery_status: 'read',
                  payload_json: {
                    images: optimisticImages.map((im) => ({ ...im, progress: 100 })),
                  },
                }
              : m
          )
        );
        setIsTyping(false);
        setMessages((prev) => [
          ...prev,
          {
            id: `mock-reply-${Date.now()}`,
            role: 'assistant',
            msg_type: 'result',
            text: 'Preview mode: fixed photo ready! Tap Before / After to compare.',
            created_at: new Date().toISOString(),
            payload_json: {
              beforeUrl: optimisticImages[0].url,
              afterUrl: optimisticImages[0].url,
              repairedChips: ['Demo dent fix', 'Demo wash'],
            },
          },
        ]);
      }, 900);
      return;
    }

    const formData = new FormData();
    formData.append('dealerId', dealerId);
    formData.append('clientMsgId', clientMsgId);
    for (const file of files) {
      formData.append('photos', file);
    }

    try {
      const resp = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        headers: { 'x-dealer-id': dealerId },
        body: formData,
      });
      const data = await resp.json();
      if (!resp.ok) {
        setIsTyping(false);
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            msg_type: 'text',
            text: data.error || 'Could not upload those photos. Please try JPEG, PNG, or WebP.',
            created_at: new Date().toISOString(),
          },
        ]);
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === clientMsgId
              ? {
                  ...m,
                  delivery_status: 'delivered',
                  payload_json: {
                    images: optimisticImages.map((im) => ({ ...im, progress: 100 })),
                  },
                }
              : m
          )
        );
      }
    } catch {
      setIsTyping(false);
    }
  };

  const sendTextMessage = async (textOverride) => {
    const text = (textOverride ?? inputText).trim();
    if (!text) return;
    if (!textOverride) setInputText('');
    setShowEmojiPicker(false);

    const clientMsgId = `opt-txt-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: clientMsgId,
        role: 'dealer',
        msg_type: 'text',
        text,
        delivery_status: 'sending',
        created_at: new Date().toISOString(),
      },
    ]);

    if (!serverOnline) {
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: `mock-txt-${Date.now()}`,
            role: 'assistant',
            msg_type: 'text',
            text: 'Server is offline in preview mode. Start the backend + DB to process real messages.',
            created_at: new Date().toISOString(),
          },
        ]);
      }, 400);
      return;
    }

    setIsTyping(true);
    try {
      await fetch(`${API_BASE}/api/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dealer-id': dealerId,
        },
        body: JSON.stringify({ dealerId, text, clientMsgId }),
      });
    } catch {
      setIsTyping(false);
    }
  };

  const handleQuickReply = (qr) => {
    if (qr.action === 'open_upload') {
      galleryInputRef.current?.click();
      return;
    }
    if (qr.action === 'download_all') {
      const urls = messages
        .filter((m) => m.payload_json?.afterUrl)
        .map((m) => m.payload_json.afterUrl);
      urls.forEach((u, idx) => {
        const a = document.createElement('a');
        a.href = u;
        a.download = `cardesk-fixed-${idx + 1}.jpg`;
        a.click();
      });
      return;
    }
    sendTextMessage(qr.text || qr.label);
  };

  const handleSavePolicy = async (newPolicyJson) => {
    const resp = await fetch(`${API_BASE}/api/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy_json: newPolicyJson }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to update policy');
    setPolicy(data);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files?.length) {
      handleUploadFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="h-[100dvh] w-full bg-stone-950 flex items-center justify-center overflow-hidden">
      <div className="w-full h-full lg:max-w-7xl lg:h-[94dvh] lg:rounded-2xl lg:overflow-hidden lg:shadow-2xl flex bg-black">
        {/* Phone frame (full-screen on mobile, centered/left phone frame on desktop) */}
        <div
          className="relative flex-1 lg:max-w-[440px] lg:mx-auto lg:border-r lg:border-slate-800 h-full flex flex-col wa-wallpaper overflow-hidden"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {/* Top WhatsApp-style Header */}
          <header className="bg-wa-header dark:bg-wa-headerDark text-white px-3 py-2.5 flex items-center justify-between shadow-md z-20 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="p-1 rounded-full hover:bg-white/10"
                title="Refresh"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="w-9 h-9 rounded-full bg-wa-green flex items-center justify-center text-wa-header font-bold shadow-inner shrink-0">
                <Car className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-[15px] leading-tight truncate">
                  CarDesk Assistant
                </div>
                <div className="text-[11px] text-emerald-100/90 leading-tight">
                  {isTyping ? 'typing...' : serverOnline ? 'online' : 'preview mode'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowMobileTrace(true)}
                className="p-2 rounded-full hover:bg-white/10 lg:hidden"
                title="Trace Panel"
              >
                <Activity className="w-5 h-5" />
              </button>
            </div>
          </header>

          {/* Chat Message Stream */}
          <main className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
            <DateSeparator label="Today" />
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                onOpenModal={setModalState}
                onQuickReply={handleQuickReply}
              />
            ))}
            {isTyping && <TypingIndicator />}
            <div ref={chatEndRef} />
          </main>

          {/* Emoji Picker Popover */}
          {showEmojiPicker && (
            <div className="mx-3 mb-2 p-2 rounded-2xl bg-white dark:bg-wa-inDark shadow-lg flex items-center justify-around z-20">
              {QUICK_EMOJIS.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => setInputText((t) => t + em)}
                  className="text-xl p-1 hover:scale-125 transition-transform"
                >
                  {em}
                </button>
              ))}
            </div>
          )}

          {/* Bottom Input Bar */}
          <footer className="px-2 py-2 safe-bottom bg-transparent flex items-end gap-2 z-20 shrink-0">
            <div className="flex-1 bg-white dark:bg-wa-inDark rounded-3xl px-3 py-1.5 flex items-center gap-2 shadow-sm">
              <button
                type="button"
                onClick={() => setShowEmojiPicker((s) => !s)}
                className="text-slate-500 dark:text-slate-400 hover:text-slate-700 p-1"
                title="Emoji"
              >
                <Smile className="w-5 h-5" />
              </button>
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendTextMessage();
                  }
                }}
                placeholder="Message or type 'done'..."
                className="flex-1 bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none py-1"
              />
              <button
                type="button"
                onClick={() => setShowAttachSheet(true)}
                className="text-slate-500 dark:text-slate-400 hover:text-slate-700 p-1"
                title="Attach photos"
              >
                <Paperclip className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="text-slate-500 dark:text-slate-400 hover:text-slate-700 p-1"
                title="Camera"
              >
                <Camera className="w-5 h-5" />
              </button>
            </div>

            {inputText.trim() ? (
              <button
                type="button"
                onClick={() => sendTextMessage()}
                className="w-11 h-11 rounded-full bg-wa-teal hover:bg-wa-header text-white flex items-center justify-center shadow-md shrink-0 transition-transform active:scale-95"
                title="Send"
              >
                <Send className="w-5 h-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: `voice-note-${Date.now()}`,
                      role: 'assistant',
                      msg_type: 'text',
                      text: 'Voice notes are coming soon! For now, upload car photos or type a quick message.',
                      created_at: new Date().toISOString(),
                    },
                  ])
                }
                className="w-11 h-11 rounded-full bg-wa-teal hover:bg-wa-header text-white flex items-center justify-center shadow-md shrink-0 transition-transform active:scale-95"
                title="Voice note (coming soon)"
              >
                <Mic className="w-5 h-5" />
              </button>
            )}
          </footer>

          {/* Hidden file inputs */}
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple
            className="hidden"
            onChange={(e) => {
              handleUploadFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              handleUploadFiles(e.target.files);
              e.target.value = '';
            }}
          />

          {/* Attachment Bottom Sheet */}
          {showAttachSheet && (
            <div
              className="absolute inset-0 z-30 bg-black/40 flex items-end"
              onClick={() => setShowAttachSheet(false)}
            >
              <div
                className="w-full bg-white dark:bg-wa-inDark rounded-t-2xl p-5 flex justify-around shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex flex-col items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200"
                >
                  <div className="w-14 h-14 rounded-full bg-rose-500 text-white flex items-center justify-center shadow">
                    <Camera className="w-6 h-6" />
                  </div>
                  Camera
                </button>
                <button
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                  className="flex flex-col items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200"
                >
                  <div className="w-14 h-14 rounded-full bg-purple-600 text-white flex items-center justify-center shadow">
                    <ImageIcon className="w-6 h-6" />
                  </div>
                  Gallery
                </button>
                <button
                  type="button"
                  onClick={() => setShowAttachSheet(false)}
                  className="flex flex-col items-center gap-2 text-xs font-medium text-slate-500"
                >
                  <div className="w-14 h-14 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
                    <X className="w-6 h-6" />
                  </div>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Drag-and-drop overlay */}
          {isDragging && (
            <div className="absolute inset-0 z-40 bg-wa-header/85 backdrop-blur-sm flex flex-col items-center justify-center text-white p-6 text-center pointer-events-none">
              <ImageIcon className="w-14 h-14 mb-3 text-wa-green" />
              <div className="text-lg font-semibold">Drop car photos here</div>
              <div className="text-xs text-emerald-100 mt-1">JPEG, PNG, WebP or HEIC — up to 12 photos</div>
            </div>
          )}
        </div>

        {/* Desktop Side Trace Panel */}
        <aside className="hidden lg:block lg:flex-1 h-full overflow-hidden">
          <TracePanel traceData={traceData} />
        </aside>
      </div>

      {/* Mobile Slide-Up Trace Drawer */}
      {showMobileTrace && (
        <div
          className="fixed inset-0 z-40 bg-black/60 flex items-end lg:hidden"
          onClick={() => setShowMobileTrace(false)}
        >
          <div
            className="w-full h-[82dvh] rounded-t-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <TracePanel traceData={traceData} onCloseMobile={() => setShowMobileTrace(false)} />
          </div>
        </div>
      )}

      {/* Before/After & Fullscreen Image Modal */}
      <BeforeAfterModal modalState={modalState} onClose={() => setModalState(null)} />
    </div>
  );
}
