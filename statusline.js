#!/usr/bin/env node
// Claude Code Statusline
// Shows: context usage | prompt cache | rate limits
// Trimmed from https://github.com/ilia-pluzhnikov/claude-code-statusline
// (model / directory / git segments removed)
//
// Flags (append to the "command" string in settings.json):
//
//   --shared-rate-limits   Share 5h/7d rate-limit observations across sessions.
//   --cost                 Always show the session's estimated cost in USD.
//
// Rate limits are account-wide, but the payload Claude Code pipes in here only
// refreshes when THIS session gets an API response. So a session sitting idle
// while another burns quota keeps rendering numbers that have already moved.
// With the flag on, every render publishes what it observed to
//
//   <config dir>/statusline-ratelimits.json
//
// and displays the newest observation of each bucket, whoever made it. The file
// lives in the config dir (CLAUDE_CONFIG_DIR, else ~/.claude) so that separate
// accounts under separate config dirs never pool their quota readings.
//
// Off by default: without the flag no file is read or written and the payload is
// displayed as-is. Staleness is still bounded by "some live session made a
// request" -- this is a shared last-known-good, not a live feed.
//
// The cost segment renders cost.total_cost_usd, which Claude Code computes
// client-side for every session and warns may differ from the real bill. It
// is detected rather than configured, and appears only while tokens are
// actually being paid for, by either route:
//
//   * rate_limits absent once a response has landed -- the object is emitted
//     only for Claude.ai subscribers, so nothing there means API-key auth.
//   * a rate-limit bucket at 100% -- the window is spent, and further usage
//     bills as extra usage on accounts that have it enabled.
//
// The second case cannot be told apart from "limit reached, simply blocked":
// hasExtraUsageEnabled lives in .claude.json, not the payload. The adjacent
// 5h:100% makes which one it is legible. --cost overrides and always shows.

const fs = require('fs');
const path = require('path');
const os = require('os');

const sharedRateLimits = process.argv.includes('--shared-rate-limits');
const forceCost = process.argv.includes('--cost');

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
    // the rate limits — both count up toward bad. The cache ratio runs it
    // backwards, minus the cyan band, because there high is good.
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
    const bandColor = (pct, list = bands) => (list.find(([min]) => pct >= min) || list[list.length - 1])[1];

    // The cache ratio tops out at green: cyan would read as "better than fine". The
    // two extremes get bold accents at the call site instead.
    const cacheBands = bands.slice(0, -1);

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

      // Absolute-token marker. The bar is proportional, so a wide window hides
      // how many tokens actually go over the wire on every request: 250k reads as
      // a calm 25% of 1M. This dot is keyed on the raw count instead and only
      // appears once that count is worth noticing. It carries its own color and
      // reset, so the bar's own reading is left untouched.
      //
      // Thresholds pair positionally with the ramp's five worst colors, in the
      // same order: 200k is where Claude Code's own exceeds_200k_tokens line
      // sits, then even 150k steps up to 800k. The calm end of the ramp goes
      // deliberately unused -- a dot that appears when nothing is wrong is a
      // fixture you stop reading.
      const absMarks = [800000, 650000, 500000, 350000, 200000];
      const markIdx = haveAbs ? absMarks.findIndex((min) => totalInput >= min) : -1;
      const dot = markIdx >= 0 ? ` ${bands[markIdx][1]}●\x1b[0m` : '';

      ctx = `${color}${prefix}${bar}${abs}\x1b[0m${dot}`;
    }

    // --- Prompt cache state ---
    let cacheSegment = '';
    // Timestamp of the last API response in this session; doubles as the
    // observation time of this payload's rate_limits.
    let lastAssistantTs = null;
    try {
      const usage = data.context_window?.current_usage;
      const usageNull = usage === null || usage === undefined;
      const read = (usage && Number(usage.cache_read_input_tokens)) || 0;
      const write = (usage && Number(usage.cache_creation_input_tokens)) || 0;
      const freshInput = (usage && Number(usage.input_tokens)) || 0;

      let lastTouchTs = null;
      let lastWriteTtl = null;
      let hadCacheBefore = false;

      if (session && (read > 0 || write > 0 || usageNull || sharedRateLimits)) {
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

                if (!lastAssistantTs) {
                  const ats = new Date(rec.timestamp).getTime();
                  if (Number.isFinite(ats)) lastAssistantTs = ats;
                }

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
          // Shared ramp read backwards, bold at both extremes: a hit rate this high
          // is better than the ramp's top band, and a cold cache is worse than its floor.
          let ratioColor;
          if (ratio === 0) ratioColor = '\x1b[1;31m';
          else if (ratio >= 90) ratioColor = '\x1b[1;32m';
          else ratioColor = bandColor(100 - ratio, cacheBands);
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
          let suffix = `${bucketColor}${lastWriteTtl}:\x1b[0m`;
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
          suffix += `${countColor}${timeStr}\x1b[0m`;
          parts.push(suffix);
        }
        cacheSegment = parts.join(' ');
      } else if (usageNull && hadCacheBefore) {
        cacheSegment = '\x1b[2mcache:\x1b[0m\x1b[33mreset\x1b[0m';
      }
    } catch (e) {}

    // --- Rate limits (subscription) ---
    const limitParts = [];
    // Highest bucket after expiry handling, for the cost segment's per-token check.
    let maxRlPct = -1;
    const rl = data.rate_limits;
    if (rl) {
      const colorPct = (pct) => `${bandColor(pct)}${pct}%\x1b[0m`;
      const formatReset = (resetTs) => {
        if (!Number.isFinite(resetTs)) return null;
        const resetMin = Math.max(0, Math.ceil((resetTs * 1000 - Date.now()) / 60000));
        if (resetMin >= 1440) {
          const d = Math.floor(resetMin / 1440);
          const h = Math.floor((resetMin % 1440) / 60);
          if (d === 1 && h === 0) return '24h';
          return h > 0 ? `${d}d${h}h` : `${d}d`;
        }
        if (resetMin >= 60) {
          const h = Math.floor(resetMin / 60);
          const m = resetMin % 60;
          return m > 0 ? `${h}h${m}m` : `${h}h`;
        }
        return `${resetMin}m`;
      };
      const withReset = (label, bucket) => {
        const rawUsedPct = bucket.used_percentage;
        let usedPct = (rawUsedPct == null || rawUsedPct === '') ? NaN : Number(rawUsedPct);
        if (!Number.isFinite(usedPct)) return null;

        // The payload only refreshes on an API response, so once the window has
        // rolled over the cached percentage is known-stale rather than merely old.
        const expired = Number.isFinite(bucket.resets_at) && bucket.resets_at * 1000 <= Date.now();
        if (expired) usedPct = 0;

        const pct = Math.round(usedPct);
        if (pct > maxRlPct) maxRlPct = pct;
        const reset = expired ? null : formatReset(bucket.resets_at);
        const main = `${label}:${colorPct(pct)}`;
        return reset ? `${main} \x1b[2m(${reset})\x1b[0m` : main;
      };
      const rlCachePath = path.join(claudeDir, 'statusline-ratelimits.json');
      const shared = {};
      let sharedDirty = false;

      if (sharedRateLimits) {
        try {
          const parsed = JSON.parse(fs.readFileSync(rlCachePath, 'utf8'));
          if (parsed && typeof parsed === 'object') Object.assign(shared, parsed);
        } catch (e) {}
      }

      const numOr = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
      };

      // Newer of two observations of one bucket. observed_at is wall-clock and the
      // only trustworthy recency signal, so it is ranked first: an undated record
      // (observed_at 0) always loses. Ranking resets_at first instead lets one bad
      // far-future resets_at outrank every real reading, forever.
      const newer = (a, b) => {
        if (!a) return b;
        if (!b) return a;
        if (a.observed_at !== b.observed_at) return a.observed_at > b.observed_at ? a : b;
        // Undated on both sides: a later window is newer, and within one window
        // usage only ever climbs.
        if (a.resets_at !== b.resets_at) return a.resets_at > b.resets_at ? a : b;
        return a.used_percentage >= b.used_percentage ? a : b;
      };

      const resolve = (key, bucket) => {
        if (!sharedRateLimits) return bucket;
        const rawPct = bucket.used_percentage;
        const pct = (rawPct == null || rawPct === '') ? NaN : Number(rawPct);
        if (!Number.isFinite(pct)) return bucket;

        const mine = {
          used_percentage: pct,
          resets_at: numOr(bucket.resets_at, 0),
          observed_at: numOr(lastAssistantTs, 0),
        };
        const rec = shared[key];
        const theirs = (rec && Number.isFinite(Number(rec.used_percentage))) ? {
          used_percentage: Number(rec.used_percentage),
          resets_at: numOr(rec.resets_at, 0),
          observed_at: numOr(rec.observed_at, 0),
        } : null;

        const win = newer(mine, theirs);
        // An undatable observation is fine to display but must never be published:
        // peers cannot rank it, so it would outlive every real reading.
        if (win === mine && mine.observed_at > 0 && (!theirs
            || theirs.used_percentage !== mine.used_percentage
            || theirs.resets_at !== mine.resets_at)) {
          shared[key] = mine;
          sharedDirty = true;
        }
        return win;
      };

      if (rl.five_hour) {
        const p = withReset('5h', resolve('five_hour', rl.five_hour));
        if (p) limitParts.push(p);
      }
      if (rl.seven_day) {
        const p = withReset('7d', resolve('seven_day', rl.seven_day));
        if (p) limitParts.push(p);
      }

      // Replace via rename so a concurrent reader never sees a half-written file.
      if (sharedDirty) {
        try {
          const tmp = rlCachePath + '.' + process.pid + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(shared));
          try {
            fs.renameSync(tmp, rlCachePath);
          } catch (e) {
            try { fs.unlinkSync(tmp); } catch (e2) {}
          }
        } catch (e) {}
      }
    }

    // --- Session cost ---
    let costSegment = '';
    // A populated context window means an API response has landed. Until then,
    // missing rate_limits means "not arrived yet", not "this account has none".
    const hadResponse = lastAssistantTs !== null
      || Number(data.context_window?.total_input_tokens) > 0;
    // Two routes to paying per token: no subscription buckets at all (API-key
    // auth), or a bucket driven to 100% with usage continuing past it as extra
    // usage. maxRlPct is the post-expiry figure, so a stale 100% left over from
    // a window that already rolled over cannot pin the segment on.
    const perToken = maxRlPct >= 100 || (hadResponse && !data.rate_limits);
    if (forceCost || perToken) {
      const usd = Number(data.cost?.total_cost_usd);
      // Zero is the pre-first-response state, not a reading worth a segment.
      if (Number.isFinite(usd) && usd > 0) {
        const costMarks = [
          [20, '\x1b[31m'],              // red
          [10, '\x1b[38;2;255;140;0m'],  // orange
          [5, '\x1b[33m'],               // yellow
          [1, '\x1b[32m'],               // green
          [0, '\x1b[38;2;34;184;207m'],  // cyan
        ];
        const costColor = (costMarks.find(([min]) => usd >= min) || costMarks[costMarks.length - 1])[1];
        const amount = usd >= 100 ? String(Math.round(usd)) : usd.toFixed(2);
        // Fast mode bills at a premium rate, so the same total represents less
        // work. Flag it against the number rather than as its own segment.
        const fast = data.fast_mode ? ' \x1b[33m⚡\x1b[0m' : '';
        costSegment = `${costColor}$${amount}\x1b[0m${fast}`;
      }
    }

    // --- Output ---
    const segments = [];
    if (ctx) segments.push(ctx);
    if (cacheSegment) segments.push(cacheSegment);
    if (costSegment) segments.push(costSegment);
    for (const lp of limitParts) segments.push(lp);

    process.stdout.write(segments.join(' │ '));
  } catch (e) {}
});
