"""Cheap integrity check of every frozen version (no browser): the snapshot's files exist, every local script and
stylesheet index.html references resolves (inside the snapshot or shared from the root), the scripts parse, and the
scene bundle referenced by the loader exists. usage: version_static_check.py <repo dir>"""
import json, os, re, subprocess, sys
REPO = os.path.abspath(sys.argv[1]); man = json.load(open(os.path.join(REPO, 'versions', 'index.json')))
def check(tag):
    d = os.path.join(REPO, 'versions', tag); problems = []
    html = os.path.join(d, 'index.html')
    if not os.path.exists(html): return ['no index.html']
    h = open(html, encoding='utf8', errors='replace').read()
    refs = re.findall(r'(?:src|href)=["\']([^"\':]+)["\']', h)
    for r in refs:
        if r.startswith('#') or r.startswith('data:'): continue
        p = os.path.normpath(os.path.join(d, r))
        if not os.path.exists(p): problems.append('missing ' + r)
        elif r.endswith('.js') and not r.endswith('.unityweb'):
            res = subprocess.run(['node', '--check', p], capture_output=True, text=True)
            if res.returncode: problems.append('does not parse: ' + r)
    m = re.search(r'["\']([^"\']*Build/[^"\']*\.json)["\']', h)
    if m:
        j = os.path.normpath(os.path.join(d, m.group(1)))
        if not os.path.exists(j): problems.append('missing loader json ' + m.group(1))
        else:
            cfg = json.load(open(j))
            for k in ('dataUrl', 'wasmCodeUrl', 'wasmFrameworkUrl'):   # the asm.js fallback files were never shipped
                u = cfg.get(k)
                if u and not os.path.exists(os.path.normpath(os.path.join(os.path.dirname(j), u))): problems.append('missing ' + k + ' ' + u)
    return problems
bad = 0
for v in man['versions']:
    p = check(v['tag']); bad += bool(p)
    print('%-22s %s' % (v['tag'], 'ok' if not p else '; '.join(p)))
print('versions with problems:', bad)
