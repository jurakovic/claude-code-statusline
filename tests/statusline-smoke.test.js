const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const statusline = path.join(root, 'statusline.js');
const source = fs.readFileSync(statusline, 'utf8');

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function runStatusline(input, env = {}, args = []) {
  let stdout = '';
  const stdin = new EventEmitter();
  stdin.setEncoding = () => {};
  const context = {
    require,
    process: {
      env: { ...process.env, ...env },
      argv: ['node', statusline, ...args],
      stdin,
      stdout: { write: (s) => { stdout += s; } },
      cwd: () => root,
      exit: (code) => { throw new Error(`unexpected exit ${code}`); }
    },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    Date
  };
  vm.runInNewContext(source, context, { filename: statusline });
  stdin.emit('data', JSON.stringify(input));
  stdin.emit('end');
  return { raw: stdout, text: stripAnsi(stdout) };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-test-'));
}

function inputFor(dir, overrides = {}) {
  return {
    workspace: { current_dir: dir },
    session_id: 'test-session',
    ...overrides
  };
}

function remainingForDisplayedUsed(used) {
  return 100 - used;
}

function contextSegment(text) {
  return text.split(' │ ').find(p => /^(?:💀 )?[█▌░]{5}(?: |$)/.test(p));
}

function contextBar(segment) {
  return segment.startsWith('💀 ') ? segment.split(' ')[1] : segment.split(' ')[0];
}

function slugFor(dir) {
  return dir.replace(/[:\\\/.]/g, '-');
}

function writeTranscript(claudeDir, dir, session, records) {
  const projectDir = path.join(claudeDir, 'projects', slugFor(dir));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), records.join('\n') + '\n');
}

// An API response with no cache activity: dates the payload, nothing else.
function assistantAt(msAgo) {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - msAgo).toISOString(), message: { usage: { input_tokens: 10 } } });
}

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`${name}\n${e.stack || e}`);
  }
}

check('model, directory and git segments are not rendered', () => {
  const dir = makeTempDir();
  const { text } = runStatusline(inputFor(dir, {
    model: { display_name: 'Opus 4.7 (1M context)' },
    effort: { level: 'high' },
    context_window: { remaining_percentage: 60 }
  }));
  assert.strictEqual(text, '██░░░ 40%');

  // Nothing to say → empty line.
  assert.strictEqual(runStatusline({}).text, '');
});

check('context bar width and glyphs', () => {
  const dir = makeTempDir();
  for (let used = 0; used <= 100; used += 10) {
    const { text } = runStatusline(inputFor(dir, {
      context_window: { remaining_percentage: remainingForDisplayedUsed(used) }
    }));
    const segment = contextSegment(text);
    assert(segment, `missing context segment for ${used}%: ${text}`);
    const bar = contextBar(segment);
    assert.strictEqual([...bar].length, 5, `bad width for ${used}%: ${bar}`);
    assert(/^[█▌░]{5}$/.test(bar), `bad glyphs for ${used}%: ${bar}`);
    assert.strictEqual(segment.startsWith('💀 '), used >= 80, `bad skull state for ${used}%: ${text}`);
  }

  const over = runStatusline(inputFor(dir, {
    context_window: { remaining_percentage: 0 }
  })).text;
  assert(contextSegment(over).startsWith('💀 █████'), over);
});

check('context bar null/empty/zero handling', () => {
  const dir = makeTempDir();
  for (const remaining_percentage of [null, '', 'abc']) {
    const { text } = runStatusline(inputFor(dir, {
      context_window: { remaining_percentage }
    }));
    assert(!contextSegment(text), `context bar should be hidden for ${String(remaining_percentage)}: ${text}`);
  }

  const full = runStatusline(inputFor(dir, {
    context_window: { remaining_percentage: 0 }
  })).text;
  assert(contextSegment(full).startsWith('💀 █████'), full);
});

check('context bar shows the used percentage after the absolute token counts', () => {
  const dir = makeTempDir();
  const { text } = runStatusline(inputFor(dir, {
    context_window: {
      remaining_percentage: 60,
      total_input_tokens: 480000,
      context_window_size: 1000000
    }
  }));
  const segment = contextSegment(text);
  assert(segment, text);
  assert(segment.startsWith('██░░░ 480k/1M 48%'), segment);

  // Without absolute counters only the percentage follows the bar.
  const pctOnly = runStatusline(inputFor(dir, {
    context_window: { remaining_percentage: 60 }
  })).text;
  assert.strictEqual(contextSegment(pctOnly), '██░░░ 40%', pctOnly);
});

check('absolute-token dot marks raw counts from 200k up', () => {
  const dir = makeTempDir();
  const at = (total_input_tokens) => runStatusline(inputFor(dir, {
    context_window: { remaining_percentage: 50, total_input_tokens, context_window_size: 1000000 }
  }));

  assert(!at(199999).text.includes('●'), `no dot below 200k: ${at(199999).text}`);
  const marks = [
    [200000, '\x1b[33m'],              // yellow
    [350000, '\x1b[38;2;240;140;0m'],  // amber
    [500000, '\x1b[38;2;255;140;0m'],  // orange
    [650000, '\x1b[38;2;255;87;34m'],  // vermilion
    [800000, '\x1b[31m'],              // red
  ];
  for (const [tokens, color] of marks) {
    const { raw } = at(tokens);
    assert(raw.endsWith(`\x1b[0m ${color}●\x1b[0m`), `${tokens}: ${JSON.stringify(raw)}`);
  }

  // Keyed on the raw count, not the bar: 250k of 1M is a calm green bar plus a dot.
  const wide = at(250000).raw;
  assert(wide.startsWith('\x1b[32m'), `bar keeps its own color: ${JSON.stringify(wide)}`);
  assert(wide.includes('\x1b[33m●'), `dot at 250k: ${JSON.stringify(wide)}`);

  // No absolute counters → no dot.
  const pctOnly = runStatusline(inputFor(dir, { context_window: { remaining_percentage: 10 } })).text;
  assert(!pctOnly.includes('●'), pctOnly);
});

check('context bar and rate limits share one color ramp', () => {
  const dir = makeTempDir();
  const ramp = [
    [0, '\x1b[38;2;34;184;207m'],  // cyan
    [14, '\x1b[38;2;34;184;207m'],
    [15, '\x1b[32m'],              // green
    [30, '\x1b[38;2;116;184;22m'], // lime
    [40, '\x1b[33m'],              // yellow
    [50, '\x1b[38;2;240;140;0m'],  // amber
    [60, '\x1b[38;2;255;140;0m'],  // orange
    [70, '\x1b[38;2;255;87;34m'],  // vermilion
    [79, '\x1b[38;2;255;87;34m'],
    [80, '\x1b[31m'],              // red
  ];
  for (const [used, color] of ramp) {
    const { raw } = runStatusline(inputFor(dir, {
      context_window: { remaining_percentage: remainingForDisplayedUsed(used) },
      rate_limits: { five_hour: { used_percentage: used } }
    }));
    assert(raw.startsWith(color), `context bar at ${used}%: ${JSON.stringify(raw)}`);
    assert(raw.includes(`5h:${color}${used}%\x1b[0m`), `5h at ${used}%: ${JSON.stringify(raw)}`);
  }
});

check('context bar prefers absolute tokens over remaining_percentage', () => {
  const dir = makeTempDir();
  // 800k/1M = 80% used → red + skull, regardless of what remaining_percentage says
  const { text } = runStatusline(inputFor(dir, {
    context_window: {
      remaining_percentage: 90,  // would render as ~10% used (cyan, empty bar)
      total_input_tokens: 800000,
      context_window_size: 1000000
    }
  }));
  const segment = contextSegment(text);
  assert(segment, text);
  assert(segment.startsWith('💀 '), `expected skull at 80% real used, got: ${segment}`);
  assert(contextBar(segment) === '████░', `expected 4 full cells, got: ${contextBar(segment)}`);
});

check('rate limits show 5h and 7d countdowns in one format', () => {
  const dir = makeTempDir();
  const now = Math.floor(Date.now() / 1000);

  // 5h shows precise h+m; 7d keeps its hours at any distance.
  const t1 = runStatusline(inputFor(dir, {
    rate_limits: {
      five_hour: { used_percentage: 35, resets_at: now + 8100 },     // 2h15m
      seven_day: { used_percentage: 42, resets_at: now + 388800 }    // 4d12h
    }
  })).text;
  assert(t1.includes('5h:35% (2h15m)'), t1);
  assert(t1.includes('7d:42% (4d12h)'), t1);

  // 7d with <2d remaining keeps hours.
  const t2 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 88, resets_at: now + 169200 }    // 1d23h → "1d23h"
    }
  })).text;
  assert(t2.includes('7d:88% (1d23h)'), t2);

  // Whole days drop the zero hour.
  const t3 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 50, resets_at: now + 172800 }    // 2d → "2d"
    }
  })).text;
  assert(t3.includes('7d:50% (2d)'), t3);

  // Exactly 1d → "24h", never bare "1d".
  const t4 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 90, resets_at: now + 86400 }     // 1d → "24h"
    }
  })).text;
  assert(t4.includes('7d:90% (24h)'), t4);
  assert(!/\(1d\)/.test(t4), `must not render bare "1d", got: ${t4}`);

  // No reset_at → no countdown; 7d still shows pct.
  const minimal = runStatusline(inputFor(dir, {
    rate_limits: { seven_day: { used_percentage: 99 } }
  })).text;
  assert(/7d:99%(?! \()/.test(minimal), minimal);
});

check('expired rate-limit window renders 0% with no countdown', () => {
  const dir = makeTempDir();
  const now = Math.floor(Date.now() / 1000);
  const { text } = runStatusline(inputFor(dir, {
    rate_limits: {
      five_hour: { used_percentage: 87, resets_at: now - 60 },  // rolled over a minute ago
      seven_day: { used_percentage: 40, resets_at: now + 7200 }
    }
  }));
  assert(/5h:0%(?! \()/.test(text), `expired 5h: ${text}`);
  assert(text.includes('7d:40% (2h)'), `live 7d untouched: ${text}`);
});

check('--shared-rate-limits publishes the reading and shows the newest one', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const cache = path.join(claude, 'statusline-ratelimits.json');
  const resets_at = Math.floor(Date.now() / 1000) + 3600;
  writeTranscript(claude, dir, 'fresh', [assistantAt(60 * 1000)]);
  writeTranscript(claude, dir, 'idle', [assistantAt(30 * 60 * 1000)]);
  const run = (session, used_percentage) => runStatusline(inputFor(dir, {
    session_id: session,
    rate_limits: { five_hour: { used_percentage, resets_at } }
  }), { CLAUDE_CONFIG_DIR: claude }, ['--shared-rate-limits']).text;

  // The session that heard from the API most recently publishes its reading.
  const fresh = run('fresh', 40);
  assert(fresh.includes('5h:40%'), fresh);
  const published = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.strictEqual(published.five_hour.used_percentage, 40);
  assert.strictEqual(published.five_hour.resets_at, resets_at);

  // An idle session holding an older reading shows the newer shared one
  // and leaves the file alone.
  const idle = run('idle', 10);
  assert(idle.includes('5h:40%'), `idle session shows the shared reading: ${idle}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).five_hour.used_percentage, 40);
});

check('--shared-rate-limits is off by default and never publishes undated readings', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const cache = path.join(claude, 'statusline-ratelimits.json');
  const resets_at = Math.floor(Date.now() / 1000) + 3600;
  writeTranscript(claude, dir, 'dated', [assistantAt(60 * 1000)]);
  const input = (session) => inputFor(dir, {
    session_id: session,
    rate_limits: { five_hour: { used_percentage: 25, resets_at } }
  });

  // Without the flag nothing is written...
  const plain = runStatusline(input('dated'), { CLAUDE_CONFIG_DIR: claude }).text;
  assert(plain.includes('5h:25%'), plain);
  assert(!fs.existsSync(cache), 'no file without the flag');

  // ...a reading with no transcript to date it is shown but not published...
  const undated = runStatusline(input('undated'), { CLAUDE_CONFIG_DIR: claude }, ['--shared-rate-limits']).text;
  assert(undated.includes('5h:25%'), undated);
  assert(!fs.existsSync(cache), 'undated reading must not be published');

  // ...and without the flag a newer shared reading is ignored.
  fs.writeFileSync(cache, JSON.stringify({ five_hour: { used_percentage: 90, resets_at, observed_at: Date.now() } }));
  const ignored = runStatusline(input('dated'), { CLAUDE_CONFIG_DIR: claude }).text;
  assert(ignored.includes('5h:25%'), `shared file ignored without the flag: ${ignored}`);
});

check('cost segment appears only while tokens are paid per use', () => {
  const dir = makeTempDir();
  const now = Math.floor(Date.now() / 1000);
  const responded = { remaining_percentage: 90, total_input_tokens: 1000, context_window_size: 200000 };
  const cost = { total_cost_usd: 3.456 };
  const run = (overrides, args) => runStatusline(inputFor(dir, overrides), {}, args).text;
  const fiveHour = (used_percentage, resets_at) => ({ five_hour: { used_percentage, resets_at } });

  // API-key auth: no rate_limits once a response has landed.
  const api = run({ context_window: responded, cost });
  assert(api.endsWith(' │ $3.46'), api);

  // Before the first response, missing rate_limits means "not arrived yet".
  const early = run({ cost });
  assert(!early.includes('$'), early);

  // Subscription under its limits: hidden, unless --cost forces it.
  const sub = { context_window: responded, cost, rate_limits: fiveHour(99, now + 3600) };
  assert(!run(sub).includes('$'), run(sub));
  assert(run(sub, ['--cost']).includes('$3.46 │ 5h:99% (1h)'), run(sub, ['--cost']));

  // A spent bucket bills further usage as extra usage.
  const spent = run({ context_window: responded, cost, rate_limits: fiveHour(100, now + 3600) });
  assert(spent.includes('$3.46 │ 5h:100% (1h)'), spent);

  // A stale 100% from a window that already rolled over does not count.
  const rolled = run({ context_window: responded, cost, rate_limits: fiveHour(100, now - 60) });
  assert(!rolled.includes('$'), rolled);

  // Zero is the pre-first-response state, not a reading.
  const zero = run({ context_window: responded, cost: { total_cost_usd: 0 } }, ['--cost']);
  assert(!zero.includes('$'), zero);
});

check('cost segment is colored by amount and flags fast mode', () => {
  const dir = makeTempDir();
  const at = (usd, extra = {}) => runStatusline(inputFor(dir, { cost: { total_cost_usd: usd }, ...extra }), {}, ['--cost']).raw;
  const cases = [
    [0.5, '\x1b[38;2;34;184;207m$0.50'],  // cyan
    [1, '\x1b[32m$1.00'],                 // green
    [5, '\x1b[33m$5.00'],                 // yellow
    [10, '\x1b[38;2;255;140;0m$10.00'],   // orange
    [20, '\x1b[31m$20.00'],               // red
    [123.4, '\x1b[31m$123'],              // whole dollars from $100
  ];
  for (const [usd, expected] of cases) {
    const raw = at(usd);
    assert(raw.includes(`${expected}\x1b[0m`), `${usd}: ${JSON.stringify(raw)}`);
  }
  const fast = at(2, { fast_mode: true });
  assert(fast.includes('$2.00\x1b[0m \x1b[33m⚡\x1b[0m'), JSON.stringify(fast));
});

check('cache TTL and JSONL parsing', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const session = 'cache-session';
  const now = Date.now();

  writeTranscript(claude, dir, session, [
    '{bad json',
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - 6 * 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10 } } } })
  ]);

  let out = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: {
      current_usage: {
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
        input_tokens: 0
      }
    }
  }), { CLAUDE_CONFIG_DIR: claude }).text;
  assert(out.includes('cache 99% ↓1k +10 5m:0m'), out);

  writeTranscript(claude, dir, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - 61 * 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 2000, cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 20 } } } })
  ]);

  out = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: {
      current_usage: {
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 20,
        input_tokens: 0
      }
    }
  }), { CLAUDE_CONFIG_DIR: claude }).text;
  assert(out.includes('cache 99% ↓2k +20 1h:0m'), out);
});

check('cache TTL colon takes the bucket color, not the countdown color', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const session = 'ttl-color-session';
  writeTranscript(claude, dir, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10 } } } })
  ]);

  const { raw } = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: {
      current_usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, input_tokens: 0 }
    }
  }), { CLAUDE_CONFIG_DIR: claude });
  // Expired 5m bucket: yellow "5m:" label, red "0m" countdown.
  assert(raw.includes('\x1b[33m5m:\x1b[0m\x1b[31m0m\x1b[0m'), JSON.stringify(raw));
});

check('cache miss renders bold red zero-percent hit ratio', () => {
  const dir = makeTempDir();
  const { raw, text } = runStatusline(inputFor(dir, {
    context_window: {
      current_usage: {
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 75000,
        input_tokens: 5000
      }
    }
  }));
  assert(raw.includes('\x1b[1;31m0%\x1b[0m'), raw);
  assert(text.includes('cache 0% ↑75k'), text);
});

check('cache hit ratio reads the shared ramp backwards, bold at both extremes', () => {
  const dir = makeTempDir();
  const cases = [
    [95, '\x1b[1;32m'],             // bold green: better than the ramp's top band
    [90, '\x1b[1;32m'],
    [89, '\x1b[32m'],               // green — the ramp minus its cyan band tops out here
    [85, '\x1b[32m'],
    [70, '\x1b[38;2;116;184;22m'],  // lime
    [60, '\x1b[33m'],               // yellow
    [50, '\x1b[38;2;240;140;0m'],   // amber
    [40, '\x1b[38;2;255;140;0m'],   // orange
    [30, '\x1b[38;2;255;87;34m'],   // vermilion
    [20, '\x1b[31m'],               // red
    [5, '\x1b[31m'],
  ];
  for (const [ratio, color] of cases) {
    const { raw } = runStatusline(inputFor(dir, {
      context_window: {
        current_usage: { cache_read_input_tokens: ratio, cache_creation_input_tokens: 0, input_tokens: 100 - ratio }
      }
    }));
    assert(raw.includes(`\x1b[2mcache\x1b[0m ${color}${ratio}%\x1b[0m`), `${ratio}%: ${JSON.stringify(raw)}`);
  }
});

check('cache reset renders after compact when current_usage is null', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const session = 'compact-session';
  writeTranscript(claude, dir, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } })
  ]);

  const { text } = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: { current_usage: null }
  }), { CLAUDE_CONFIG_DIR: claude });
  assert(text.includes('cache:reset'), text);
});

check('malformed session_id is rejected before being used in paths', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const slugDir = path.join(claude, 'projects', slugFor(dir));
  fs.mkdirSync(slugDir, { recursive: true });

  // Plant a transcript at the path that '../valid' would resolve to when
  // joined under the project slug dir. Unguarded code would read this file
  // and render the TTL countdown; the validation should keep it untouched.
  const traversedPath = path.join(claude, 'projects', 'valid.jsonl');
  fs.writeFileSync(traversedPath, JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } }
  }) + '\n');

  const { text } = runStatusline(inputFor(dir, {
    session_id: '../valid',
    context_window: {
      current_usage: {
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
        input_tokens: 0
      }
    }
  }), { CLAUDE_CONFIG_DIR: claude });

  // Cache counters from stdin still render (they don't need a session_id),
  // but the TTL bucket/countdown — which comes from the transcript — must not.
  assert(text.includes('cache 99% ↓1k +10'), text);
  assert(!/\b(?:1h|5m):/.test(text), 'transcript at traversed path must not be read: ' + text);
});

check('transcript slug encoding replaces dots in directory paths', () => {
  const parent = makeTempDir();
  const dir = path.join(parent, 'dotted.proj');
  fs.mkdirSync(dir);
  const claude = makeTempDir();
  const session = 'dotted-session';
  writeTranscript(claude, dir, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } } })
  ]);

  const { text } = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: {
      current_usage: {
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
        input_tokens: 0
      }
    }
  }), { CLAUDE_CONFIG_DIR: claude });
  assert(text.includes('cache 99% ↓1k +10 1h:'), text);
});

check('cache TTL reads transcript_path from stdin, ignoring the current_dir slug', () => {
  const current = makeTempDir(); // current_dir — no transcript lives under its slug
  const claude = makeTempDir();
  const session = 'tp-session';
  // Plant the transcript at an arbitrary path and hand it to the script via
  // stdin. If the script still rebuilt a slug from current_dir it would miss it.
  const tpath = path.join(claude, 'elsewhere', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } }
  }) + '\n');

  const { text } = runStatusline(inputFor(current, {
    session_id: session,
    transcript_path: tpath,
    context_window: {
      current_usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, input_tokens: 0 }
    }
  }), { CLAUDE_CONFIG_DIR: claude });
  assert(text.includes('cache 99% ↓1k +10 1h:'), text);
});

check('cache TTL falls back to project_dir slug (not current_dir) when transcript_path absent', () => {
  const parent = makeTempDir();
  const launch = path.join(parent, 'launchdir'); // project_dir — transcript anchored here
  const current = path.join(parent, 'workdir');  // current_dir — moved here, nothing under its slug
  fs.mkdirSync(launch);
  fs.mkdirSync(current);
  const claude = makeTempDir();
  const session = 'fallback-session';
  writeTranscript(claude, launch, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } } })
  ]);

  const { text } = runStatusline({
    model: { display_name: 'Claude' },
    session_id: session,
    workspace: { current_dir: current, project_dir: launch },
    context_window: {
      current_usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, input_tokens: 0 }
    }
  }, { CLAUDE_CONFIG_DIR: claude });
  assert(text.includes('cache 99% ↓1k +10 1h:'), text);
});

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
}
