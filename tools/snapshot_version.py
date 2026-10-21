"""Freeze a version of the mod under versions/<tag>/ so players can pick it from the HUD's Version selector
(TemplateData/versions.js) if a newer version breaks or they prefer it. The snapshot is a complete page
(index.html, TemplateData, Build/slope.json, Build/slope_data.unityweb); the engine files, the loader and the
music tracks are referenced from the site root when they are byte-identical to the root's current copies
(those files never change), and copied into the snapshot otherwise. The copied versions.js is the current one.
usage: snapshot_version.py <tag> --from <commit> --title "..." [--notes "..."] [--force]
       snapshot_version.py --latest --title "..." [--notes "..."]        (describe the root version in the manifest)"""
import sys, os, json, subprocess, shutil, re, argparse, tempfile
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARED_ENGINE = ['slope_wasmcode.unityweb', 'slope_wasmframework.unityweb', 'slope_memory.unityweb', 'slope_framework.unityweb', 'slope_code.unityweb']
ap = argparse.ArgumentParser(); ap.add_argument('tag', nargs='?'); ap.add_argument('--from', dest='src'); ap.add_argument('--title', required=True); ap.add_argument('--notes', default='')
ap.add_argument('--force', action='store_true'); ap.add_argument('--latest', action='store_true'); A = ap.parse_args()
def git(*a): return subprocess.check_output(['git', '-C', REPO] + list(a), stderr=subprocess.DEVNULL).decode().strip()
man_path = os.path.join(REPO, 'versions', 'index.json'); os.makedirs(os.path.dirname(man_path), exist_ok=True)
man = json.load(open(man_path)) if os.path.exists(man_path) else {'latest': {}, 'versions': []}
if A.latest:
    man['latest'] = {'title': A.title, 'notes': A.notes, 'date': __import__('datetime').date.today().isoformat()}   # no commit hash: the root is whatever HEAD is
    json.dump(man, open(man_path, 'w'), indent=1); print('manifest: latest =', man['latest']); sys.exit()
if not A.tag or not A.src: sys.exit('tag and --from are required')
if not re.match(r'^[A-Za-z0-9._-]+$', A.tag): sys.exit('tag: letters, digits, . _ - only')
dst = os.path.join(REPO, 'versions', A.tag)
if os.path.exists(dst) and not A.force: sys.exit(dst + ' exists (--force to replace)')
commit = git('rev-parse', '--short', A.src); date = git('show', '-s', '--format=%cs', A.src)
tmp = tempfile.mkdtemp()
subprocess.check_call('git -C %s archive %s index.html TemplateData Build/slope.json Build/slope_data.unityweb | tar -x -C %s' % (REPO, A.src, tmp), shell=True)
def same_as_root(rel):
    """the file at <commit>:rel is byte-identical to the root's current copy"""
    try: return git('rev-parse', '%s:%s' % (A.src, rel)) == git('rev-parse', 'HEAD:%s' % rel) and os.path.exists(os.path.join(REPO, rel))
    except subprocess.CalledProcessError: return False
shared = []
# engine files: slope.json urls -> ../../../Build/<file> for the shared ones
cfg = json.load(open(os.path.join(tmp, 'Build', 'slope.json')))
for k, v in list(cfg.items()):
    if isinstance(v, str) and v in SHARED_ENGINE:
        rel = 'Build/' + v
        if same_as_root(rel): cfg[k] = '../../../' + rel; shared.append(rel)
        elif os.path.exists(os.path.join(REPO, rel)) or git('ls-tree', A.src, rel): subprocess.check_call('git -C %s archive %s %s | tar -x -C %s' % (REPO, A.src, rel, tmp), shell=True)
json.dump(cfg, open(os.path.join(tmp, 'Build', 'slope.json'), 'w'), indent=0)
# the loader
html = open(os.path.join(tmp, 'index.html')).read()
if same_as_root('TemplateData/unityloader41.js'):
    html = html.replace('"TemplateData/unityloader41.js"', '"../../TemplateData/unityloader41.js"'); os.remove(os.path.join(tmp, 'TemplateData', 'unityloader41.js')); shared.append('TemplateData/unityloader41.js')
# music tracks referenced by the snapshot's mod.js
mod_path = os.path.join(tmp, 'TemplateData', 'mod.js'); mod = open(mod_path).read()
for rel in sorted(set(re.findall(r'"(TemplateData/music/[^"]+)"', mod))):
    if same_as_root(rel): mod = mod.replace('"%s"' % rel, '"../../%s"' % rel); shared.append(rel); p = os.path.join(tmp, rel); os.path.exists(p) and os.remove(p)
open(mod_path, 'w').write(mod)
mdir = os.path.join(tmp, 'TemplateData', 'music')
if os.path.isdir(mdir) and not os.listdir(mdir): os.rmdir(mdir)
# the version picker: the current script, loaded by the snapshot's page
shutil.copy(os.path.join(REPO, 'TemplateData', 'versions.js'), os.path.join(tmp, 'TemplateData', 'versions.js'))
if 'TemplateData/versions.js' not in html: html = html.replace('</head>', '    <script src="TemplateData/versions.js"></script>\n</head>', 1)
css_path = os.path.join(tmp, 'TemplateData', 'mod.css'); css = open(css_path).read() if os.path.exists(css_path) else ''
if '.version-box' not in css:
    cur = open(os.path.join(REPO, 'TemplateData', 'mod.css')).read(); i = cur.find('/* version picker')
    css += '\n' + cur[i:] if i >= 0 else ''
open(css_path, 'w').write(css); open(os.path.join(tmp, 'index.html'), 'w').write(html)
if os.path.exists(dst): shutil.rmtree(dst)
shutil.move(tmp, dst)
man['versions'] = [v for v in man['versions'] if v['tag'] != A.tag] + [{'tag': A.tag, 'title': A.title, 'notes': A.notes, 'date': date, 'commit': commit}]
man['versions'].sort(key=lambda v: v['date'])
json.dump(man, open(man_path, 'w'), indent=1)
size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(dst) for f in fs)
print('versions/%s from %s (%s): %.1f MB on disk, shared from the root: %s' % (A.tag, commit, date, size / 1e6, ', '.join(shared)))
