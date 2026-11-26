import React, { useState, useEffect } from 'react';
import { X, Save, ShieldCheck, AlertCircle } from 'lucide-react';

export function PolicyDrawer({ open, onClose, policy, onSave }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (policy?.policy_json) {
      setText(JSON.stringify(policy.policy_json, null, 2));
      setError('');
    }
  }, [policy, open]);

  if (!open) return null;

  const handleSave = async () => {
    setError('');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Invalid JSON: ${e.message}`);
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white dark:bg-slate-900 h-full flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 bg-wa-header dark:bg-wa-headerDark text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-wa-green" />
            <div>
              <div className="text-sm font-semibold">Policy Editor</div>
              <div className="text-[11px] text-emerald-100/80">
                Active version: v{policy?.version || 1} — Steers Gemini Analysis & Checker
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full hover:bg-white/10">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 flex-1 flex flex-col gap-3 overflow-hidden">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Edit the JSON policy below (e.g., change <code>background_style</code> or{' '}
            <code>identifier_handling</code>) and re-send a photo to see behaviour change live.
          </p>

          {error && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="flex-1 w-full font-mono text-xs p-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-wa-teal resize-none"
          />

          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="w-full py-2.5 rounded-xl bg-wa-header hover:bg-wa-teal text-white font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving Policy...' : 'Save New Policy Version'}
          </button>
        </div>
      </div>
    </div>
  );
}
