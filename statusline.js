#!/usr/bin/env node
// Claude Code Statusline
// Shows: context usage | prompt cache | rate limits
// Trimmed from https://github.com/ilia-pluzhnikov/claude-code-statusline
// (model / directory / git segments removed)

const fs = require('fs');
const path = require('path');
const os = require('os');

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const dir = data.workspace?.current_dir || process.cwd();
    const rawSession = data.session_id || '';
    const session = /^[A-Za-z0-9_-]{1,128}$/.test(rawSession) ? rawSession : '';
    const rawRemaining = data.context_window?.remaining_percentage;
    const remaining = (rawRemaining == null || rawRemaining === '') ? NaN : Number(rawRemaining);
    const homeDir = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');

    const fmt = (n) => {
      if (n < 1000) return String(n);
      if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      if (n < 1000000) return Math.round(n / 1000) + 'k';
      return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    };

    // Shared "how full is it" ramp, highest band first. Used by the context bar and
    // the rate limits — both count up toward bad. Not by the cache ratio, which is
    // inverted (high is good).
    const bands = [
      [80, '\x1b[31m'],              // red
      [70, '\x1b[38;2;255;87;34m'],  // vermilion
      [60, '\x1b[38;2;255;140;0m'],  // orange
      [50, '\x1b[38;2;240;140;0m'],  // amber
      [40, '\x1b[33m'],              // yellow
      [30, '\x1b[38;2;116;184;22m'], // lime
      [15, '\x1b[32m'],              // green
      [0, '\x1b[38;2;34;184;207m'],  // cyan
    ];
    const bandColor = (pct) => (bands.find(([min]) => pct >= min) || bands[bands.length - 1])[1];

    // --- Context window ---
    let ctx = '';
    if (Number.isFinite(remaining)) {
      const totalInput = Number(data.context_window?.total_input_tokens) || 0;
      const ctxSize = Number(data.context_window?.context_window_size) || 0;
      const haveAbs = totalInput > 0 && ctxSize > 0;
      const used = haveAbs
        ? Math.max(0, Math.min(100, Math.round((totalInput / ctxSize) * 100)))
        : Math.max(0, Math.min(100, Math.round(100 - remaining)));

      const steps = Math.max(0, Math.min(10, Math.floor(used / 10)));
      let bar = '';
      for (let i = 0; i < 5; i++) {
        const cell = Math.max(0, Math.min(2, steps - i * 2));
        bar += cell === 2 ? '█' : cell === 1 ? '▌' : '░';
      }

      const abs = haveAbs ? ` ${fmt(totalInput)}/${fmt(ctxSize)} ${used}%` : ` ${used}%`;

      const color = bandColor(used);
      const prefix = used >= 80 ? '💀 ' : '';

      ctx = `${color}${prefix}${bar}${abs}\x1b[0m`;
    }

    // --- Prompt cache state ---
    let cacheSegment = '';
    try {
      const usage = data.context_window?.current_usage;
      const usageNull = usage === null || usage === undefined;
      const read = (usage && Number(usage.cache_read_input_tokens)) || 0;
      const write = (usage && Number(usage.cache_creation_input_tokens)) || 0;
      const freshInput = (usage && Number(usage.input_tokens)) || 0;

      let lastTouchTs = null;
      let lastWriteTtl = null;
      let hadCacheBefore = false;

      if (session && (read > 0 || write > 0 || usageNull)) {
        try {
          let transcriptPath = data.transcript_path;
          if (!transcriptPath) {
            const slugDir = data.workspace?.project_dir || dir;
            const slug = slugDir.replace(/[:\\\/.]/g, '-');
            transcriptPath = path.join(claudeDir, 'projects', slug, `${session}.jsonl`);
          }
          if (fs.existsSync(transcriptPath)) {
            const stat = fs.statSync(transcriptPath);
            const desired = Math.min(stat.size, 16384);
            const startOffset = Math.max(0, stat.size - desired - 1);
            const readBytes = stat.size - startOffset;
            const buf = Buffer.alloc(readBytes);
            const fd = fs.openSync(transcriptPath, 'r');
            try {
              fs.readSync(fd, buf, 0, readBytes, startOffset);
            } finally {
              fs.closeSync(fd);
            }
            let content = buf.toString('utf8');
            if (startOffset > 0) {
              const nl = content.indexOf('\n');
              if (nl >= 0) content = content.slice(nl + 1);
            }
            const lines = content.split('\n').filter(Boolean);

            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const rec = JSON.parse(lines[i]);
                const u = rec && rec.type === 'assistant' && rec.message ? rec.message.usage : null;
                if (!u || !rec.timestamp) continue;
                const r = u.cache_read_input_tokens || 0;
                const w = u.cache_creation_input_tokens || 0;
                if (r === 0 && w === 0) continue;

                hadCacheBefore = true;
                if (!lastTouchTs) {
                  const ts = new Date(rec.timestamp).getTime();
                  lastTouchTs = Number.isFinite(ts) ? ts : 0;
                }
                if (!lastWriteTtl && w > 0 && u.cache_creation) {
                  if (u.cache_creation.ephemeral_1h_input_tokens > 0) lastWriteTtl = '1h';
                  else if (u.cache_creation.ephemeral_5m_input_tokens > 0) lastWriteTtl = '5m';
                }
                if (lastTouchTs && lastWriteTtl) break;
              } catch (e) {}
            }
          }
        } catch (e) {}
      }

      if (read > 0 || write > 0) {
        const parts = ['\x1b[2mcache\x1b[0m'];

        const denom = read + write + freshInput;
        if (denom > 0) {
          const ratio = read > 0 ? Math.round(read / denom * 100) : 0;
          let ratioColor;
          if (ratio === 0) ratioColor = '\x1b[1;31m';
          else if (ratio >= 90) ratioColor = '\x1b[1;32m';
          else if (ratio >= 75) ratioColor = '\x1b[32m';
          else if (ratio >= 50) ratioColor = '\x1b[33m';
          else ratioColor = '\x1b[38;2;255;140;0m';
          parts.push(`${ratioColor}${ratio}%\x1b[0m`);
        }

        if (read > 0) {
          parts.push(`\x1b[1;32m↓${fmt(read)}\x1b[0m`);
        }
        if (write > 0) {
          const sym = read > 0 ? '+' : '↑';
          parts.push(`\x1b[33m${sym}${fmt(write)}\x1b[0m`);
        }
        if (lastWriteTtl && lastTouchTs) {
          const ttlMs = lastWriteTtl === '5m' ? 300000 : 3600000;
          const remainingSec = (ttlMs - (Date.now() - lastTouchTs)) / 1000;
          const bucketColor = lastWriteTtl === '5m' ? '\x1b[33m' : '\x1b[2;36m';
          let suffix = `${bucketColor}${lastWriteTtl}\x1b[0m`;
          let timeStr;
          if (remainingSec <= 0) timeStr = '0m';
          else if (remainingSec < 60) timeStr = Math.ceil(remainingSec) + 's';
          else if (remainingSec < 3600) timeStr = Math.ceil(remainingSec / 60) + 'm';
          else {
            const h = Math.floor(remainingSec / 3600);
            const m = Math.floor((remainingSec % 3600) / 60);
            timeStr = h + 'h' + (m > 0 ? m + 'm' : '');
          }
          const pct = remainingSec > 0 ? (remainingSec * 1000) / ttlMs : 0;
          let countColor;
          if (pct <= 0) countColor = '\x1b[31m';
          else if (pct < 0.1) countColor = '\x1b[38;2;255;140;0m';
          else if (pct < 0.25) countColor = '\x1b[33m';
          else countColor = '\x1b[2m';
          suffix += `${countColor}:${timeStr}\x1b[0m`;
          parts.push(suffix);
        }
        cacheSegment = parts.join(' ');
      } else if (usageNull && hadCacheBefore) {
        cacheSegment = '\x1b[2mcache:\x1b[0m\x1b[33mreset\x1b[0m';
      }
    } catch (e) {}

    // --- Rate limits (subscription) ---
    const limitParts = [];
    const rl = data.rate_limits;
    if (rl) {
      const colorPct = (pct) => `${bandColor(pct)}${pct}%\x1b[0m`;
      const formatReset = (resetTs, opts) => {
        if (!Number.isFinite(resetTs)) return null;
        const coarse = !!(opts && opts.coarse);
        const resetMin = Math.max(0, Math.ceil((resetTs * 1000 - Date.now()) / 60000));
        if (resetMin >= 1440) {
          const d = Math.floor(resetMin / 1440);
          const h = Math.floor((resetMin % 1440) / 60);
          if (coarse && d >= 2) return `${d}d`;
          if (d === 1 && h === 0) return '24h';
          return `${d}d${h}h`;
        }
        if (resetMin >= 60) {
          const h = Math.floor(resetMin / 60);
          const m = resetMin % 60;
          return m > 0 ? `${h}h${m}m` : `${h}h`;
        }
        return `${resetMin}m`;
      };
      const withReset = (label, bucket, opts) => {
        const rawUsedPct = bucket.used_percentage;
        const usedPct = (rawUsedPct == null || rawUsedPct === '') ? NaN : Number(rawUsedPct);
        if (!Number.isFinite(usedPct)) return null;
        const pct = Math.round(usedPct);
        const reset = formatReset(bucket.resets_at, opts);
        const main = `${label}:${colorPct(pct)}`;
        return reset ? `${main} \x1b[2m(${reset})\x1b[0m` : main;
      };
      if (rl.five_hour) {
        const p = withReset('5h', rl.five_hour);
        if (p) limitParts.push(p);
      }
      if (rl.seven_day) {
        const p = withReset('7d', rl.seven_day, { coarse: true });
        if (p) limitParts.push(p);
      }
    }

    // --- Output ---
    const segments = [];
    if (ctx) segments.push(ctx);
    if (cacheSegment) segments.push(cacheSegment);
    for (const lp of limitParts) segments.push(lp);

    process.stdout.write(segments.join(' │ '));
  } catch (e) {}
});
