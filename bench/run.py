import json, os, subprocess, time, re
from pathlib import Path

OUTDIR = Path('/tmp/pi-bench-runs')
OUTDIR.mkdir(parents=True, exist_ok=True)
Path('/tmp/pi-bench').mkdir(parents=True, exist_ok=True)

TASKS = [
    {'id': 't01_ytdlp_version', 'prompt': 'Give me the usable yt-dlp version on this machine. Return one short line only.'},
    {'id': 't02_ffmpeg_version', 'prompt': 'Give me the usable ffmpeg version on this machine. Return one short line only.'},
    {'id': 't03_node_version', 'prompt': 'Give me the usable node version on this machine. Return one short line only.'},
    {'id': 't04_npm_react', 'prompt': 'Use npm to print the latest react version. Return one short line only.'},
    {'id': 't05_npm_vite', 'prompt': 'Use npm to print the latest vite version. Return one short line only.'},
    {'id': 't06_python_requests_title', 'prompt': 'Use Python requests to fetch https://example.com and return only the HTML <title> text.'},
    {'id': 't07_bun_version', 'prompt': 'Use bun to print the bun version only.'},
    {'id': 't08_jq_extract', 'prompt': 'Use jq to extract key b from this JSON literal: {"a":1,"b":2}. Return only the value.'},
    {'id': 't09_download_subtitle', 'prompt': 'Download only the English subtitle file for https://youtu.be/<video-id> into /tmp/pi-bench and return only the saved file path.'},
    {'id': 't10_rg_version', 'prompt': 'Give me the usable rg version on this machine. Return one short line only.'},
]


def parse_events(lines):
    events = []
    for line in lines.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            pass
    return events


def extract_summary(events):
    tool_calls = []
    final_text = None
    usage = None
    for ev in events:
        if ev.get('type') == 'message_end':
            msg = ev.get('message', {})
            if msg.get('role') == 'assistant':
                texts = [c.get('text', '') for c in msg.get('content', []) if c.get('type') == 'text']
                if texts:
                    final_text = ''.join(texts)
                usage = msg.get('usage') or usage
        if ev.get('type') == 'turn_end':
            msg = ev.get('message', {})
            usage = msg.get('usage') or usage
            texts = [c.get('text', '') for c in msg.get('content', []) if c.get('type') == 'text']
            if texts:
                final_text = ''.join(texts)
        if ev.get('type') == 'agent_end':
            for msg in ev.get('messages', []):
                if msg.get('role') == 'assistant':
                    for c in msg.get('content', []):
                        if c.get('type') == 'toolCall':
                            tc = {'name': c.get('name'), 'arguments': c.get('arguments')}
                            if tc not in tool_calls:
                                tool_calls.append(tc)
    bash_cmds = [tc['arguments'].get('command', '') for tc in tool_calls if tc['name'] == 'bash' and isinstance(tc.get('arguments'), dict)]
    ensure_calls = [tc['arguments'] for tc in tool_calls if tc['name'] == 'ensure_dev_shell']
    return {
        'final_text': final_text,
        'usage': usage,
        'tool_calls': tool_calls,
        'bash_commands': bash_cmds,
        'ensure_dev_shell_calls': ensure_calls,
        'used_nix_develop': any('nix develop ' in cmd for cmd in bash_cmds),
        'used_python': any(re.search(r'(^|\W)python3?(\W|$)', cmd) for cmd in bash_cmds),
        'used_bun': any(re.search(r'(^|\W)bun(\W|$)', cmd) for cmd in bash_cmds),
        'used_node': any(re.search(r'(^|\W)node(\W|$)', cmd) for cmd in bash_cmds),
        'used_npm': any(re.search(r'(^|\W)npm(\W|$)', cmd) for cmd in bash_cmds),
        'used_jq': any(re.search(r'(^|\W)jq(\W|$)', cmd) for cmd in bash_cmds),
        'used_ytdlp': any('yt-dlp' in cmd or 'ytdlp' in cmd for cmd in bash_cmds),
    }


results = []
for task in TASKS:
    print(f'RUN {task["id"]} ...', flush=True)
    cmd = ['pi', '--mode', 'json', '--no-session', '--thinking', 'minimal', task['prompt']]
    start = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    elapsed = time.time() - start
    raw_path = OUTDIR / f'{task["id"]}.jsonl'
    raw_path.write_text(proc.stdout)
    err_path = OUTDIR / f'{task["id"]}.stderr.txt'
    err_path.write_text(proc.stderr)
    events = parse_events(proc.stdout)
    result = {
        'id': task['id'],
        'prompt': task['prompt'],
        'elapsed_sec': round(elapsed, 2),
        'returncode': proc.returncode,
        **extract_summary(events),
        'raw_path': str(raw_path),
        'stderr_path': str(err_path),
    }
    results.append(result)

summary_path = OUTDIR / 'summary.json'
summary_path.write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
print(f'\nWrote {summary_path}')
