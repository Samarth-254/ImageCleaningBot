import React from 'react';
import { Activity, Clock, Cpu, CheckCircle2, AlertTriangle, RotateCw, ShieldAlert, X } from 'lucide-react';

function StatusBadge({ status }) {
  const colors = {
    completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    fixed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    running: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    analyzing: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    editing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    checking: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
    retried: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    queued: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    fallback_original: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    passthrough: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    reject: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colors[status] || colors.queued}`}>
      {status}
    </span>
  );
}

export function TracePanel({ traceData, costPer1kTokens = 0, onCloseMobile }) {
  const { jobs = [], images = [], usage = [], events = [] } = traceData || {};
  const latestJob = jobs[0] || null;

  const totalTokens = usage.reduce((sum, u) => sum + Number(u.tokens || 0), 0);
  const estimatedCost = ((totalTokens / 1000) * Number(costPer1kTokens || 0)).toFixed(4);
  const totalJobLatencyMs = latestJob?.summary_json?.totalLatencyMs ?? null;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border-l border-slate-200 dark:border-slate-800">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/90">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-wa-teal dark:text-wa-green" />
          <h2 className="text-sm font-semibold">Live Trace & Telemetry</h2>
        </div>
        {onCloseMobile && (
          <button
            type="button"
            onClick={onCloseMobile}
            className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 lg:hidden"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {/* Job overview */}
        {latestJob ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-slate-50/70 dark:bg-slate-800/40 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-slate-500">
                Job {latestJob.id.slice(0, 8)}
              </span>
              <StatusBadge status={latestJob.status} />
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1">
              <div className="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200/70 dark:border-slate-800">
                <div className="text-[10px] text-slate-500 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Job Latency
                </div>
                <div className="font-semibold mt-0.5">
                  {totalJobLatencyMs != null ? `${(totalJobLatencyMs / 1000).toFixed(2)}s` : '—'}
                </div>
              </div>
              <div className="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200/70 dark:border-slate-800">
                <div className="text-[10px] text-slate-500 flex items-center gap-1">
                  <Cpu className="w-3 h-3" /> Tokens
                </div>
                <div className="font-semibold mt-0.5">{totalTokens > 0 ? totalTokens.toLocaleString() : '—'}</div>
              </div>
              <div className="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200/70 dark:border-slate-800">
                <div className="text-[10px] text-slate-500">Est. Cost</div>
                <div className="font-semibold mt-0.5">${estimatedCost}</div>
              </div>
            </div>
            {latestJob.trigger_run_id && (
              <div className="text-[10px] text-slate-500 font-mono truncate">
                Trigger Run: {latestJob.trigger_run_id}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-4 text-center text-slate-500">
            Upload car photos to see live Gemini Vision, Qwen Edit, Checker, and Trigger.dev telemetry.
          </div>
        )}

        {/* Per-image trace cards */}
        {images.map((img) => {
          const analysis = img.analysis_json || null;
          const check = img.check_json || null;
          const imgUsage = usage.filter((u) => u.image_id === img.id);
          const editEvent = events.find((e) => e.image_id === img.id && e.stage === 'edit_done');
          const checkEvents = events.filter((e) => e.image_id === img.id && e.stage === 'check_done');
          const latestCheckEvent = checkEvents[checkEvents.length - 1] || null;
          const retryEvents = events.filter((e) => e.image_id === img.id && e.stage === 'retry_decision');
          const latestRetryEvent = retryEvents[retryEvents.length - 1]?.payload_json || null;
          const promptEvents = events.filter((e) => e.image_id === img.id && e.stage === 'edit_prompt_built');
          const latestPromptEvent = promptEvents[promptEvents.length - 1]?.payload_json || null;
          const mustPreserveList = latestPromptEvent?.mustPreserve || analysis?.must_preserve || [];
          const triggerStatus = img.retry_count > 0 && img.status !== 'completed' ? 'retried' : img.status;

          return (
            <div
              key={img.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-white dark:bg-slate-900 space-y-2.5 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900 dark:text-white">
                    Photo #{img.seq_num}
                  </span>
                  <StatusBadge status={triggerStatus} />
                  {img.final_decision && <StatusBadge status={img.final_decision} />}
                </div>
                <span className="text-[11px] font-mono text-slate-500">
                  {img.total_latency_ms != null ? `${(img.total_latency_ms / 1000).toFixed(2)}s` : '—'}
                </span>
              </div>

              {img.trigger_run_id && (
                <div className="text-[10px] text-slate-500 font-mono truncate">
                  Task: {img.trigger_run_id} {img.retry_count > 0 ? `(retries: ${img.retry_count})` : ''}
                </div>
              )}

              {/* Analysis */}
              {analysis && (
                <div className="space-y-1.5 border-t border-slate-100 dark:border-slate-800 pt-2">
                  <div className="font-semibold text-[11px] text-slate-600 dark:text-slate-300">
                    1. Analysis ({analysis.action}) — Usability: {Math.round((analysis.usability?.score || 0) * 100)}%
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    {analysis.description}
                  </p>
                  {Array.isArray(analysis.tags) && analysis.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {analysis.tags.map((tag, i) => (
                        <span
                          key={i}
                          className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px]"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {Array.isArray(analysis.problems) && analysis.problems.length > 0 && (
                    <ul className="space-y-1 mt-1">
                      {analysis.problems.map((p, i) => (
                        <li key={i} className="bg-amber-50/70 dark:bg-amber-950/30 rounded p-1.5 text-[11px]">
                          <span className="font-semibold">{p.type}</span> ({p.severity}) at{' '}
                          <span className="italic">{p.where}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {mustPreserveList.length > 0 && (
                    <div className="pt-1">
                      <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                        Must Preserve ({mustPreserveList.length})
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {mustPreserveList.map((entry, i) => {
                          const label = typeof entry === 'string' ? entry : entry.item;
                          const vis = typeof entry === 'string' ? 'clear' : entry.visibility;
                          return (
                            <span
                              key={i}
                              className={`px-1.5 py-0.5 rounded text-[10px] border ${
                                vis === 'obscured_by_damage'
                                  ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200/70 dark:border-amber-800/50'
                                  : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200/70 dark:border-emerald-800/50'
                              }`}
                            >
                              {label} <span className="opacity-70">[{vis}]</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Edit instruction */}
              {(img.edit_instruction || analysis?.edit_prompt) && (
                <div className="space-y-1.5 border-t border-slate-100 dark:border-slate-800 pt-2">
                  <div className="flex items-center justify-between font-semibold text-[11px] text-slate-600 dark:text-slate-300">
                    <div className="flex items-center gap-1.5">
                      <span>2. Edit Instruction</span>
                      {latestPromptEvent?.modeUsed && (
                        <span className="px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200 text-[9px] uppercase">
                          mode: {latestPromptEvent.modeUsed}
                        </span>
                      )}
                    </div>
                    {editEvent?.latency_ms != null && (
                      <span className="font-mono text-[10px] text-slate-500">{editEvent.latency_ms} ms</span>
                    )}
                  </div>
                  {latestPromptEvent?.fallbackReason && (
                    <div className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 rounded">
                      Fallback to template: {latestPromptEvent.fallbackReason}
                    </div>
                  )}
                  {Array.isArray(latestPromptEvent?.substitutions) && latestPromptEvent.substitutions.length > 0 && (
                    <div className="text-[10px] text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/30 px-2 py-1 rounded">
                      Discouraged-verb substitutions:{' '}
                      {latestPromptEvent.substitutions.map((s) => `${s.source} (${s.verbsFound.join(', ')})`).join('; ')}
                    </div>
                  )}
                  {(latestPromptEvent?.draftEditPrompt || analysis?.edit_prompt) && (
                    <div className="space-y-0.5">
                      <div className="text-[10px] text-slate-500">Model draft edit_prompt:</div>
                      <p className="text-[10.5px] font-mono bg-slate-50 dark:bg-slate-800/40 p-1.5 rounded text-slate-600 dark:text-slate-400 break-words">
                        {latestPromptEvent?.draftEditPrompt || analysis?.edit_prompt}
                      </p>
                    </div>
                  )}
                  {img.edit_instruction && (
                    <div className="space-y-0.5">
                      <div className="text-[10px] text-slate-500">Final assembled instruction:</div>
                      <p className="text-[11px] font-mono bg-slate-50 dark:bg-slate-800/70 p-2 rounded text-slate-700 dark:text-slate-300 break-words">
                        {img.edit_instruction}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Checker */}
              {check && (
                <div className="space-y-1.5 border-t border-slate-100 dark:border-slate-800 pt-2">
                  <div className="flex items-center justify-between font-semibold text-[11px] text-slate-600 dark:text-slate-300">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span>3. Checker Verdict</span>
                      {(check.model_used || latestCheckEvent?.payload_json?.modelUsed) && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[9px] font-mono">
                          {check.model_used || latestCheckEvent?.payload_json?.modelUsed}
                          {check.thinking_level ? ` (${check.thinking_level})` : ''}
                        </span>
                      )}
                      {(check.fallback_used || latestCheckEvent?.payload_json?.fallbackUsed) && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-[9px] font-semibold">
                          FALLBACK ({check.fallback_reason || latestCheckEvent?.payload_json?.fallbackReason || 'unknown'})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {latestCheckEvent?.latency_ms != null && (
                        <span className="font-mono text-[10px] text-slate-500">
                          {latestCheckEvent.latency_ms} ms
                        </span>
                      )}
                      <StatusBadge status={check.verdict} />
                    </div>
                  </div>
                  {check.verdict_rule && (
                    <div className="text-[10px] font-mono text-slate-500">
                      Rule: {check.verdict_rule}
                    </div>
                  )}
                  {Array.isArray(check.preserved_items) && check.preserved_items.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                        Preserved Items (Original vs Output)
                      </div>
                      <div className="space-y-1">
                        {check.preserved_items.map((pi, idx) => {
                          const ok = pi.unchanged ?? pi.still_present_and_unchanged;
                          return (
                            <div
                              key={idx}
                              className={`px-2 py-1.5 rounded text-[10.5px] space-y-0.5 ${
                                ok
                                  ? 'bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
                                  : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 font-medium">
                                <span>{ok ? '✓' : '✗'} {pi.item}</span>
                                <span className="text-[10px] opacity-80">{pi.note}</span>
                              </div>
                              {pi.original_observation && (
                                <div className="text-[10px] opacity-85">
                                  <span className="font-semibold">Orig:</span> {pi.original_observation}
                                </div>
                              )}
                              {pi.output_observation && (
                                <div className="text-[10px] opacity-85">
                                  <span className="font-semibold">Out:</span> {pi.output_observation}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {Array.isArray(check.reconstructed_regions) && check.reconstructed_regions.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                        Reconstructed Regions
                      </div>
                      <div className="space-y-1">
                        {check.reconstructed_regions.map((rr, idx) => (
                          <div
                            key={idx}
                            className={`px-2 py-1.5 rounded text-[10.5px] space-y-0.5 ${
                              rr.consistent_with_visible_fragments && rr.plausible
                                ? 'bg-sky-50/70 dark:bg-sky-950/30 text-sky-900 dark:text-sky-200'
                                : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 font-medium">
                              <span>{rr.item}</span>
                              <span className="px-1.5 py-0.5 rounded bg-sky-200/70 dark:bg-sky-900 text-[9px] uppercase">
                                reconstructed
                              </span>
                            </div>
                            <div className="text-[10px] opacity-85">{rr.description}</div>
                            <div className="text-[10px] opacity-75">{rr.note}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {latestRetryEvent && (
                    <div className="text-[10px] font-mono bg-slate-50 dark:bg-slate-800/60 px-2 py-1 rounded text-slate-600 dark:text-slate-300">
                      Retry: {latestRetryEvent.shouldRetry ? 'YES' : 'NO'} ({latestRetryEvent.reason}) — budget{' '}
                      {Math.round((latestRetryEvent.elapsedMs || 0) / 1000)}s /{' '}
                      {Math.round((latestRetryEvent.budgetMs || 0) / 1000)}s
                    </div>
                  )}
                  {Array.isArray(check.unlisted_differences) && check.unlisted_differences.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                        Unlisted Differences ({check.unlisted_differences.length})
                      </div>
                      <div className="space-y-1">
                        {check.unlisted_differences.map((ud, idx) => (
                          <div
                            key={idx}
                            className="px-2 py-1 rounded bg-amber-50/70 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 text-[10.5px]"
                          >
                            <span className="font-semibold uppercase text-[9px] mr-1">[{ud.severity}]</span>
                            <span>{ud.description}</span>
                            {ud.location && <span className="italic opacity-80"> ({ud.location})</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {check.retry_guidance && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-1">
                      <RotateCw className="w-3 h-3 mt-0.5 shrink-0" />
                      <span>{check.retry_guidance}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Final note & token breakdown */}
              {(img.note || imgUsage.length > 0) && (
                <div className="border-t border-slate-100 dark:border-slate-800 pt-2 space-y-1 text-[11px]">
                  {img.note && (
                    <div className="flex items-start gap-1.5 text-slate-700 dark:text-slate-300">
                      {img.final_decision === 'fixed' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                      ) : img.final_decision === 'fallback_original' ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                      ) : (
                        <ShieldAlert className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      )}
                      <span>{img.note}</span>
                    </div>
                  )}
                  {imgUsage.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {imgUsage.map((u) => (
                        <span key={u.id} className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-mono">
                          {u.operation} ({u.model}): in {u.input_tokens || 0} / out {u.output_tokens || 0} / think{' '}
                          {u.thinking_tokens || 0} / tot {u.tokens} / {u.latency_ms}ms
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
