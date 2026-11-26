import React, { useState, useRef, useEffect } from 'react';
import { X, ZoomIn, ZoomOut, RotateCcw, Download, SlidersHorizontal } from 'lucide-react';

export function BeforeAfterModal({ modalState, onClose }) {
  const [sliderPos, setSliderPos] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const draggingSlider = useRef(false);
  const pinchStartDist = useRef(null);
  const pinchStartZoom = useRef(1);

  useEffect(() => {
    setSliderPos(50);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [modalState]);

  if (!modalState) return null;

  const isCompare = modalState.mode === 'compare' && modalState.beforeUrl && modalState.afterUrl;

  const updateSliderFromClientX = (clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSliderPos(Math.max(2, Math.min(98, pct)));
  };

  const handleTouchStart = (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDist.current = Math.hypot(dx, dy);
      pinchStartZoom.current = zoom;
    }
  };

  const handleTouchMove = (e) => {
    if (e.touches.length === 2 && pinchStartDist.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const nextZoom = Math.max(1, Math.min(4, pinchStartZoom.current * (dist / pinchStartDist.current)));
      setZoom(nextZoom);
    } else if (isCompare && draggingSlider.current && e.touches.length === 1) {
      updateSliderFromClientX(e.touches[0].clientX);
    }
  };

  const handleWheel = (e) => {
    if (isCompare) return;
    e.preventDefault();
    setZoom((z) => Math.max(1, Math.min(4, z - e.deltaY * 0.002)));
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 flex flex-col select-none"
      onClick={onClose}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 text-white bg-black/60 backdrop-blur-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 min-w-0">
          <SlidersHorizontal className="w-4 h-4 text-wa-green shrink-0" />
          <span className="text-sm font-medium truncate">
            {isCompare ? 'Before / After Comparison' : modalState.caption || 'Photo Viewer'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isCompare && (
            <>
              <button
                onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
                className="p-2 rounded-full hover:bg-white/10"
                title="Zoom out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <button
                onClick={() => setZoom((z) => Math.min(4, z + 0.5))}
                className="p-2 rounded-full hover:bg-white/10"
                title="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                className="p-2 rounded-full hover:bg-white/10"
                title="Reset zoom"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </>
          )}
          <a
            href={modalState.afterUrl || modalState.url}
            download="cardesk-photo.jpg"
            className="p-2 rounded-full hover:bg-white/10"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </a>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-white/10"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main viewport */}
      <div
        className="flex-1 flex items-center justify-center p-3 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onWheel={handleWheel}
      >
        {isCompare ? (
          <div
            ref={containerRef}
            className="relative max-w-full max-h-full aspect-[4/3] w-full max-w-2xl rounded-xl overflow-hidden shadow-2xl cursor-ew-resize bg-black"
            onMouseDown={(e) => {
              draggingSlider.current = true;
              updateSliderFromClientX(e.clientX);
            }}
            onMouseMove={(e) => {
              if (draggingSlider.current) updateSliderFromClientX(e.clientX);
            }}
            onMouseUp={() => { draggingSlider.current = false; }}
            onMouseLeave={() => { draggingSlider.current = false; }}
            onTouchStart={(e) => {
              if (e.touches.length === 1) {
                draggingSlider.current = true;
                updateSliderFromClientX(e.touches[0].clientX);
              }
            }}
            onTouchEnd={() => { draggingSlider.current = false; }}
          >
            {/* After image (full) */}
            <img
              src={modalState.afterUrl}
              alt="After"
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            />
            {/* Before image (clipped) */}
            <div
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
            >
              <img
                src={modalState.beforeUrl}
                alt="Before"
                className="w-full h-full object-contain"
              />
            </div>

            {/* Labels */}
            <span className="absolute top-3 left-3 px-2 py-0.5 rounded bg-black/70 text-white text-xs font-medium">
              Original
            </span>
            <span className="absolute top-3 right-3 px-2 py-0.5 rounded bg-wa-header/90 text-white text-xs font-medium">
              Fixed
            </span>

            {/* Divider line + handle */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg pointer-events-none"
              style={{ left: `${sliderPos}%` }}
            >
              <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white text-slate-900 shadow-xl flex items-center justify-center font-bold text-xs">
                ⇄
              </div>
            </div>
          </div>
        ) : (
          <img
            src={modalState.url || modalState.afterUrl}
            alt={modalState.caption || 'Preview'}
            className="max-w-full max-h-full object-contain transition-transform duration-100"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          />
        )}
      </div>

      {modalState.caption && (
        <div className="px-4 py-3 text-center text-xs text-slate-300 bg-black/60">
          {modalState.caption}
        </div>
      )}
    </div>
  );
}
