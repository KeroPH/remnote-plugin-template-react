// AutoCloze selected text widget

import React, { useState, useEffect } from "react";
import { renderWidget, usePlugin } from "@remnote/plugin-sdk";

export const SelectedCloze = () => {
  const plugin = usePlugin();
  const [apiKeyFromSettings, setApiKeyFromSettings] = useState<string | null>(null);
  const [maxClozesFromSettings, setMaxClozesFromSettings] = useState<number>(3);

  // Local editable API key state (fallback if RemNote settings aren't available)
  const [localKey, setLocalKey] = useState<string>(() => {
    try {
      return window.localStorage.getItem('autocloze_openai_key') || '';
    } catch (e) { return ''; }
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inlineMode, setInlineMode] = useState<boolean>(true); // replace selection inline
  const [sensitivity, setSensitivity] = useState<number>(() => {
    try { return parseInt(window.localStorage.getItem('autocloze_sensitivity') || '60', 10); } catch { return 60; }
  });

  // Read settings once on mount
  useEffect(() => {
    (async () => {
      try {
        const k = await (plugin as any).settings.getSetting('openai_api_key');
        if (k) setApiKeyFromSettings(k as string);
      } catch {}
      try {
        const m = await (plugin as any).settings.getSetting('max_clozes');
        if (typeof m === 'number') setMaxClozesFromSettings(m as number);
      } catch {}
    })();
  }, []);

  async function generateClozes() {
      // Scoring helpers for sensitivity filtering
      const maxScore = 5; // keep in sync with termScore components
      function termScore(t: string): number {
        if (!t) return 0;
        const cleanLen = (t.replace(/[^A-Za-z0-9]/g, '')).length; // length weight capped
        let score = Math.min(10, cleanLen) / 5; // 0..2
        if (t.includes(' ')) score += 2; // multi-word bonus
        if (/^[A-Z]/.test(t)) score += 1; // leading capital
        return score; // 0..~5
      }
      const thresholdScore = (sensitivity / 100) * maxScore; // dynamic threshold
    setError(null);
    setLoading(true);
    try {
      // Helper to flatten a rem.text rich array into styled segments & plain
      interface Segment { text: string; bold?: boolean; italic?: boolean; }
      function flattenRemText(rich: any): { segments: Segment[]; plain: string } {
        const segs: Segment[] = [];
        if (!Array.isArray(rich)) return { segments: [], plain: '' };
        for (const part of rich) {
          if (typeof part === 'string') segs.push({ text: part });
          else if (part && typeof part === 'object') {
            const t = (part as any).text;
            if (typeof t === 'string') segs.push({ text: t, bold: !!(part as any).b, italic: !!(part as any).it });
          }
        }
        const merged: Segment[] = [];
        for (const s of segs) {
          const prev = merged[merged.length - 1];
          if (prev && prev.bold === s.bold && prev.italic === s.italic) prev.text += s.text; else merged.push({ ...s });
        }
        return { segments: merged, plain: merged.map(s => s.text).join('') };
      }

      // Check for multi-rem selection first
      let multiRemIds: string[] = [];
      try {
        const selRems = await (plugin as any).editor?.getSelectedRem?.();
        console.log('AutoCloze getSelectedRem raw ->', selRems);
        if (Array.isArray(selRems)) {
          multiRemIds = selRems.map((r: any) => (typeof r === 'string' ? r : r?._id || r?.id || r?.remId)).filter(Boolean);
        } else if (selRems && typeof selRems === 'object' && Array.isArray((selRems as any).remIds)) {
          multiRemIds = (selRems as any).remIds.filter(Boolean);
        }
        // Try alternate API if available
        try {
          const selIds = await (plugin as any).editor?.getSelectedRemIds?.();
          console.log('AutoCloze getSelectedRemIds raw ->', selIds);
          if (Array.isArray(selIds)) multiRemIds = Array.from(new Set([...multiRemIds, ...selIds.filter(Boolean)]));
        } catch {}
        // We keep single selection as single-rem flow; multi path only when >1
      } catch {}

      const keyToUseEarly = apiKeyFromSettings || localKey;
      if (!keyToUseEarly) throw new Error('Missing OpenAI API key. Paste it and press Save first.');
console.log(multiRemIds.length)
      if (multiRemIds.length > 1) {
        // Multi-rem flow: build single OpenAI request describing each block
        const remObjs: any[] = [];
        for (const id of multiRemIds) {
          try { const r = await (plugin as any).rem.findOne?.(id); if (r) remObjs.push(r); } catch {}
        }
        if (!remObjs.length) throw new Error('Could not load selected rems.');
        const blocks: { id: string; segments: Segment[]; plain: string }[] = remObjs.map(r => {
          const { segments, plain } = flattenRemText((r as any).text);
            return { id: (r as any)._id || (r as any).id, segments, plain };
        }).filter(b => b.plain.trim());
        if (!blocks.length) throw new Error('Selected rems contain no text.');
        // Truncate extremely long plain strings to keep token usage sane
        const MAX_PER = 2000; // chars
        for (const b of blocks) { if (b.plain.length > MAX_PER) b.plain = b.plain.slice(0, MAX_PER); }
        const prompt = `You will receive several numbered blocks of text. For EACH block, choose up to ${maxClozesFromSettings} DISTINCT key terms or short multi-word phrases from ONLY that block. Return STRICT JSON: {"blocks":[{"i":<block_number>,"terms":["term1","term2", ...]}, ...]}. Rules per block: terms must be exact substrings (case & spacing preserved); no duplicates; avoid substrings of a longer chosen term; prefer technical nouns / critical concepts; omit trivial words. Do NOT add commentary.\nBlocks:\n` +
          blocks.map((b, idx) => `#${idx+1}: """${b.plain}"""`).join('\n');
        console.log('AutoCloze multi-rem prompt', prompt);
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyToUseEarly}` },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 800 })
        });
        if (!resp.ok) throw new Error('LLM error ' + resp.status);
        const body = await resp.json();
        let content = body?.choices?.[0]?.message?.content || '';
        if (content.startsWith('```')) content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
        let parsed: any = null;
        try { parsed = JSON.parse(content); } catch (e) {
          // attempt to locate JSON substring
          const s = content.indexOf('{'); const eIdx = content.lastIndexOf('}');
          if (s !== -1 && eIdx !== -1) { try { parsed = JSON.parse(content.slice(s, eIdx+1)); } catch {} }
        }
        if (!parsed || !Array.isArray(parsed.blocks)) throw new Error('Failed to parse multi-rem JSON. Raw: ' + content.slice(0,200));
        // Create a map index -> terms array
        const termsMap = new Map<number,string[]>();
        parsed.blocks.forEach((b:any) => { if (typeof b.i === 'number' && Array.isArray(b.terms)) {
          const rawTerms = b.terms.filter((t:any)=> typeof t === 'string');
          // Sensitivity filter
          let filtered = rawTerms.filter((t: string) => termScore(t) >= thresholdScore);
          if (!filtered.length && rawTerms.length) { // ensure at least one
            filtered = [ rawTerms.sort((a:string,b:string)=> termScore(b)-termScore(a))[0] ];
          }
          termsMap.set(b.i, filtered);
        }});

        // Core wrapping logic reused per rem
        interface Range { start:number; end:number; term:string; orig:string; }
        function processOne(plainText:string, segments: Segment[], terms: string[]): { rich:any[], count:number } {
          terms = (terms||[]).map(t=>t.trim()).filter(Boolean);
          const seen = new Set<string>(); terms = terms.filter(t=>{ if(seen.has(t)) return false; seen.add(t); return true; });
          // Already filtered by sensitivity; safeguard fallback
          if (!terms.length) return { rich: segments.map(s=> s.bold||s.italic ? { text:s.text, i:'m', b:s.bold||undefined, it:s.italic||undefined } : s.text ), count:0 };
          const occupied: [number,number][] = []; const ranges: Range[] = []; const lower = plainText.toLowerCase();
          function isOverlap(s:number,e:number){return occupied.some(([a,b]) => !(e <= a || s >= b));}
          function tryAdd(term:string){
            if(!term||term.length<2) return; let variants=[term, term.replace(/^['"`]+|['"`]+$/g,''), term.replace(/[.,;:]+$/,'')]; if(term.endsWith('s')) variants.push(term.slice(0,-1));
            variants = Array.from(new Set(variants.map(v=>v.trim()).filter(v=>v.length>1)));
            for(const v of variants){
              let idx = plainText.indexOf(v); if(idx===-1){ const low=v.toLowerCase(); idx = lower.indexOf(low); if(idx===-1) continue; }
              if(!isOverlap(idx, idx+v.length)) { const slice=plainText.slice(idx, idx+v.length); occupied.push([idx, idx+v.length]); ranges.push({ start:idx,end:idx+v.length,term:slice,orig:term }); return; }
            }
          }
            const sorted=[...terms].sort((a,b)=>b.length-a.length);
            for(const t of sorted){ tryAdd(t); }
            if(!ranges.length) return { rich: segments.map(s=> s.bold||s.italic ? { text:s.text, i:'m', b:s.bold||undefined, it:s.italic||undefined } : s.text ), count:0 };
            ranges.sort((a,b)=>a.start-b.start);
            // Build boundaries
            const boundaries: { start:number; end:number; seg:Segment }[] = []; let p=0; for(const seg of segments){ const start=p; const end=p+seg.text.length; boundaries.push({start,end,seg}); p=end; }
            function within(r:Range){ return boundaries.some(b=> r.start>=b.start && r.end<=b.end); }
            const filtered = ranges.filter(within);
            const rich: any[] = []; function id(){return Date.now().toString()+Math.floor(Math.random()*1e6);} 
            for(const b of boundaries){ const seg=b.seg; const segRanges= filtered.filter(r=> r.start>=b.start && r.end<=b.end); if(!segRanges.length){ rich.push(seg.bold||seg.italic? { text:seg.text, i:'m', b:seg.bold||undefined, it:seg.italic||undefined }: seg.text); continue; }
              let cursor=0; const localStart=b.start; for(const r of segRanges){ const rs=r.start-localStart; const re=r.end-localStart; const before=seg.text.slice(cursor, rs); if(before){ rich.push(seg.bold||seg.italic? { text:before, i:'m', b:seg.bold||undefined, it:seg.italic||undefined }: before); }
                const inner=seg.text.slice(rs,re); rich.push({ text: inner, i:'m', cId: id(), b: seg.bold||undefined, it: seg.italic||undefined }); cursor=re; }
              const tail=seg.text.slice(cursor); if(tail){ rich.push(seg.bold||seg.italic? { text:tail, i:'m', b:seg.bold||undefined, it:seg.italic||undefined }: tail); }
            }
            return { rich, count: filtered.length };
        }
        let totalClozes=0; let processed=0;
        for (let idx=0; idx<blocks.length; idx++) {
          const b = blocks[idx];
          const terms = termsMap.get(idx+1) || [];
          const { rich, count } = processOne(b.plain, b.segments, terms.slice(0, maxClozesFromSettings));
          totalClozes += count; processed++;
          try { const rem = await (plugin as any).rem.findOne?.(b.id); if (rem && typeof rem.setText === 'function') await rem.setText(rich); } catch(e){ console.warn('Failed to set rem', b.id, e); }
        }
        try { await (plugin as any).app.toast(`AutoCloze processed ${processed} rems (${totalClozes} clozes)`); } catch {}
        setLoading(false); return;
      }

      // Attempt to gather rich selection (may be array of styled spans) to preserve **bold** etc.
      let rawSelection: any = null;
      try { rawSelection = await (plugin as any).editor?.getSelectedText?.(); } catch {}
      if (!rawSelection) {
        // fallback to focused editor text
        try { rawSelection = await (plugin as any).editor?.getFocusedEditorText?.(); } catch {}
      }
      if (!rawSelection) {
        // final fallback: entire focused rem text object
        try {
          const f = await (plugin as any).focus?.getFocusedRem?.();
      console.log('AutoCloze focused rem (for fallback)', f);
          if (f) {
            const remObj = await (plugin as any).rem.findOne?.(f._id || f.id);
            if (remObj && remObj.text) rawSelection = remObj.text;
          }
        } catch {}
      }
    console.log('AutoCloze rawSelection value ->', rawSelection);

      if (!rawSelection) {
        setError('No text selected (highlight some text in an editor first).');
        setLoading(false);
        return;
      }

  interface Segment { text: string; bold?: boolean; italic?: boolean; }
      function normalizeSelection(sel: any): { segments: Segment[]; plain: string } {
        const segments: Segment[] = [];
        const visited = new WeakSet<object>();
        const MAX_NODES = 5000;
        let count = 0;
        const pushText = (text: string, style: { bold?: boolean; italic?: boolean }) => {
          if (!text) return;
          segments.push({ text, bold: style.bold, italic: style.italic });
        };
        const visit = (node: any, inherited: { bold?: boolean; italic?: boolean } = {}) => {
          if (node == null) return;
          if (count++ > MAX_NODES) return;
          if (typeof node === 'string') { pushText(node, inherited); return; }
          if (typeof node !== 'object') { return; }
          if (visited.has(node)) return; visited.add(node);
          const bold = inherited.bold || !!(node as any).bold;
          const italic = inherited.italic || !!(node as any).italic;
          if (typeof (node as any).text === 'string') {
            pushText((node as any).text, { bold, italic });
          }
          // Traverse known array containers
          const candidateArrays: any[] = [];
          if (Array.isArray((node as any).children)) candidateArrays.push((node as any).children);
          if (Array.isArray((node as any).content)) candidateArrays.push((node as any).content);
          if (Array.isArray((node as any).nodes)) candidateArrays.push((node as any).nodes);
          // Generic: traverse any enumerable array property (shallow) if not already added
          for (const key of Object.keys(node)) {
            const val = (node as any)[key];
            if (Array.isArray(val) && !candidateArrays.includes(val)) candidateArrays.push(val);
          }
          if (candidateArrays.length) {
            for (const arr of candidateArrays) {
              for (const child of arr) visit(child, { bold, italic });
            }
          } else if (!(node as any).text) {
            // Last resort: stringify meaningful primitive leaf fields (e.g., value)
            for (const key of Object.keys(node)) {
              const val = (node as any)[key];
              if (typeof val === 'string' && val && key.toLowerCase() !== 'type') {
                pushText(val, { bold, italic });
              }
            }
          }
        };
        try { visit(sel); } catch (e) { console.warn('AutoCloze visit error', e); }
        // Merge adjacent segments with same style to simplify downstream indexing
        const merged: Segment[] = [];
        for (const seg of segments) {
          const prev = merged[merged.length - 1];
          if (prev && prev.bold === seg.bold && prev.italic === seg.italic) prev.text += seg.text; else merged.push({ ...seg });
        }
        const plain = merged.map(s => s.text).join('');
        return { segments: merged, plain };
      }

      const { segments, plain: plainText } = normalizeSelection(rawSelection);
      if (!plainText.trim()) {
        setError('Selection appears empty.');
        setLoading(false);
        return;
      }

      const keyToUse = apiKeyFromSettings || localKey;
      if (!keyToUse) {
        setError('Missing OpenAI API key. Paste it and press Save first.');
        setLoading(false);
        return;
      }

      if (inlineMode) {
        // Prompt to only list exact substrings to wrap, no alteration of original text.
  const prompt = `List up to ${maxClozesFromSettings} DISTINCT key terms or short multi-word phrases from the text.
Return ONLY a JSON array of strings (no prose, no objects).
Rules:
- Each string MUST be an EXACT substring of the text (case/spaces preserved).
- Do NOT include punctuation at ends unless part of the term (e.g., hyphenated word).
- Prefer technical nouns, proper names, critical concepts.
- Avoid duplicates and substrings of a longer already-chosen term.
- Maximum ${maxClozesFromSettings} items.
Text: """${plainText}"""`;
console.log('AutoCloze prompt', prompt);
console.log('AutoCloze plainText length/type', plainText.length, typeof plainText);
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${keyToUse}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 400,
          }),
        });
        if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
        const body = await resp.json();
        let content = body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text;
        console.log(content)
        if (!content) throw new Error('Empty LLM response');
        content = content.trim();
        if (content.startsWith('```')) content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
        const s = content.indexOf('['), eIdx = content.lastIndexOf(']');
        if (s === -1 || eIdx === -1) throw new Error('No JSON array in model output');
        const arrStr = content.slice(s, eIdx + 1);
        let terms: string[] = [];
        try { terms = JSON.parse(arrStr); } catch { throw new Error('Failed to parse JSON array of terms'); }
        if (!Array.isArray(terms) || !terms.length) throw new Error('No terms returned');
        // Cleanup & dedupe
        terms = terms.map(t => (t || '').trim()).filter(Boolean);
        // Remove duplicates (case-sensitive) while preserving first.
        const seen = new Set<string>();
        terms = terms.filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
        // Sensitivity filtering
  let filteredBySensitivity = terms.filter((t: string) => termScore(t) >= thresholdScore);
        if (!filteredBySensitivity.length && terms.length) {
          filteredBySensitivity = [ terms.sort((a,b)=> termScore(b)-termScore(a))[0] ];
        }
        terms = filteredBySensitivity;

  // Helper to find non-overlapping best match for a term with fallback strategies.
  interface Range { start:number; end:number; term:string; orig:string; }
        const occupied: [number, number][] = [];
        const ranges: Range[] = [];
        const max = maxClozesFromSettings;
  const lower = (plainText as string).toLowerCase();

        function isOverlap(start:number,end:number){
          return occupied.some(([a,b]) => !(end <= a || start >= b));
        }
        function tryAdd(term:string){
          if (!term || term.length < 2) return;
          let variants: string[] = [term];
          // Strip enclosing quotes/backticks
            variants.push(term.replace(/^['"`]+|['"`]+$/g,''));
          // Strip trailing punctuation
            variants.push(term.replace(/[.,;:]+$/,''));
          // Singular naive
          if (term.endsWith('s')) variants.push(term.slice(0,-1));
          // Deduplicate variants
          variants = Array.from(new Set(variants.map(v=>v.trim()).filter(v=>v.length>1)));
          for (const v of variants){
            // Direct case-sensitive
      let idx = plainText.indexOf(v);
            if (idx === -1){
              // Case-insensitive
              const low = v.toLowerCase();
              idx = lower.indexOf(low);
              if (idx !== -1){
                // Use original slice from selectedText
        const originalSlice = plainText.slice(idx, idx+v.length);
                if (!isOverlap(idx, idx+v.length)){
                  occupied.push([idx, idx+v.length]);
                  ranges.push({ start: idx, end: idx+v.length, term: originalSlice, orig: term });
                  return;
                } else continue;
              }
            } else {
              if (!isOverlap(idx, idx+v.length)){
        const originalSlice = plainText.slice(idx, idx+v.length);
                occupied.push([idx, idx+v.length]);
                ranges.push({ start: idx, end: idx+v.length, term: originalSlice, orig: term });
                return;
              }
            }
          }
        }

        // Prioritize longer terms first to reduce internal overlaps.
        const sorted = [...terms].sort((a,b)=> b.length - a.length);
        for (const t of sorted){
          if (ranges.length >= max) break;
          tryAdd(t);
        }

        if (!ranges.length) throw new Error('No terms found in selection. (Model returned: ' + terms.slice(0,10).join(', ') + ')');
        // Sort ranges in ascending order for reconstruction
        ranges.sort((a,b) => a.start - b.start);
        // Remove ranges that span across formatting segment boundaries (to avoid corruption)
        const segmentBoundaries: { start: number; end: number; seg: Segment }[] = [];
        let pos = 0;
        for (const seg of segments) {
          const start = pos;
          const end = pos + seg.text.length;
          segmentBoundaries.push({ start, end, seg });
          pos = end;
        }
        function rangeWithinSingleSegment(r: Range) {
          return segmentBoundaries.some(b => r.start >= b.start && r.end <= b.end);
        }
        const filteredRanges = ranges.filter(rangeWithinSingleSegment);
        if (!filteredRanges.length) throw new Error('No terms aligned cleanly with formatting segments. (Model returned: ' + ranges.map(r=>r.term).join(', ') + ')');
        // Build RichText array directly so RemNote interprets clozes (objects with cId)
        function genClozeId(){ return Date.now().toString() + Math.floor(Math.random()*1e6).toString(); }
        const richParts: any[] = [];
        let clozeCounter = 1; // kept in case we later want numbering logic elsewhere
        for (const boundary of segmentBoundaries) {
          const seg = boundary.seg;
            const segRanges = filteredRanges.filter(r => r.start >= boundary.start && r.end <= boundary.end);
            if (!segRanges.length) {
              // Entire segment unchanged
              if (seg.bold || seg.italic) {
                richParts.push({ text: seg.text, i: 'm', b: seg.bold || undefined, it: seg.italic || undefined });
              } else {
                richParts.push(seg.text);
              }
              continue;
            }
            // Segment with clozes; walk through local pieces
            let cursorLocal = 0;
            const localStart = boundary.start;
            for (const r of segRanges) {
              const relStart = r.start - localStart;
              const relEnd = r.end - localStart;
              const before = seg.text.slice(cursorLocal, relStart);
              if (before) {
                if (seg.bold || seg.italic) richParts.push({ text: before, i: 'm', b: seg.bold || undefined, it: seg.italic || undefined });
                else richParts.push(before);
              }
              const clozeText = seg.text.slice(relStart, relEnd);
              richParts.push({ text: clozeText, i: 'm', cId: genClozeId(), b: seg.bold || undefined, it: seg.italic || undefined });
              cursorLocal = relEnd;
              clozeCounter++;
            }
            const tail = seg.text.slice(cursorLocal);
            if (tail) {
              if (seg.bold || seg.italic) richParts.push({ text: tail, i: 'm', b: seg.bold || undefined, it: seg.italic || undefined });
              else richParts.push(tail);
            }
        }
        // Also build markdown string (fallback only)
        const out = filteredRanges.reduce((acc,r,i)=> acc.replace(r.term, `{{c${i+1}::${r.term}}}`), plainText);
        console.log('AutoCloze richParts preview', JSON.stringify(richParts));
        try {
          const focused = await (plugin as any).focus?.getFocusedRem?.();
          const oldId = focused?._id || focused?.id;
          if (!oldId) throw new Error('No focused rem id');
          const oldRem = await (plugin as any).rem.findOne?.(oldId);
          if (!oldRem) throw new Error('Focused rem object not found');
          // Direct rich text set
          if (typeof oldRem.setText === 'function') {
            await oldRem.setText(richParts);
          } else if (typeof oldRem.setMarkdown === 'function') {
            await oldRem.setMarkdown(out);
          } else if (typeof oldRem.setText === 'function') {
            await oldRem.setText([out]);
          } else {
            throw new Error('No suitable text setter on rem');
          }
          try { await (plugin as any).app.toast(`Updated rem with ${filteredRanges.length} clozes`); } catch {}
        } catch (e) {
          console.error('setText path failed, fallback to create new', e);
          // Fallback: create new rem so user still gets result
          try {
            let parentId: any = null;
            try { const f = await (plugin as any).focus?.getFocusedRem?.(); parentId = f?.parent || f?.parentId; } catch {}
            if (!parentId) { const roots = await (plugin as any).rem.getRoots?.(); if (Array.isArray(roots) && roots.length) parentId = roots[0]; }
            let rich2 = null; try { rich2 = await (plugin as any).richText?.fromMarkdown?.(out); } catch {}
            const payload: any = { parentId, text: rich2 || out };
            await (plugin as any).rem.createRem(payload);
            try { await (plugin as any).app.toast('Created new clozed rem (fallback)'); } catch {}
          } catch (e2) { console.error('Fallback createRem failed', e2); throw new Error('Could not set or create rem'); }
        }
        setLoading(false);
        return;
      }

      // Sentence mode (non-inline) currently disabled for simplicity: inform user.
      setError('Sentence mode disabled. Enable "Replace selection inline" to tag terms.');
      setLoading(false);
    } catch (e: any) {
      setError(e.message || String(e));
      setLoading(false);
    }
  }

  async function saveKey() {
    try {
      // attempt to persist via SDK if available
      if ((plugin as any).settings && typeof (plugin as any).settings.setSetting === 'function') {
        await (plugin as any).settings.setSetting('openai_api_key', localKey);
      }
      // always write to localStorage as fallback
      window.localStorage.setItem('autocloze_openai_key', localKey || '');
      // If SDK register succeeded, notify user via toast if available
      try { await (plugin as any).app.toast('API key saved locally'); } catch {}
    } catch (e) {
      // ignore
    }
  }

  return (
    <div className="p-2 m-2 rounded-lg rn-clr-background-light-positive rn-clr-content-positive">
      {error && <div className="text-red-500">{error}</div>}
      <div className="mt-2">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span style={{ minWidth: 70 }}>Sensitivity</span>
          <input
            type="range"
            min={0}
            max={100}
            value={sensitivity}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setSensitivity(v);
              try { window.localStorage.setItem('autocloze_sensitivity', String(v)); } catch {}
            }}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 11 }}>{sensitivity}%</span>
        </label>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>Higher = stricter (fewer, stronger terms). Lower = more clozes.</div>
        <div style={{ marginTop: 8 }}>
          <button className="rn-btn" onClick={generateClozes} disabled={loading}>
            {loading ? "Generating..." : "Generate Clozes"}
          </button>
        </div>
      </div>
    </div>
  );
};

renderWidget(SelectedCloze);
