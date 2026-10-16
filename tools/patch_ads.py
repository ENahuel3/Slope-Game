"""Disable the app-store ad and Y8 branding objects in the scene bundle.
usage: patch_ads.py <in data.unity3d> <out data.unity3d>"""
import UnityPy, sys, struct
src, dst = sys.argv[1], sys.argv[2]
env = UnityPy.load(src)
objs = {o.path_id: o for o in env.objects}
scripts = {o.path_id: o.read().m_ClassName for o in env.objects if o.type.name == "MonoScript"}
KILL = {'AndroidAppButton', 'androidAppIcon', 'availableLabel', 'downloadLabel', 'MoreGamesText', 'Y8logo', 'iFrameLinkButton'}
RENDER = {'Image', 'Text', 'Button', 'PressHandler', 'SimpleResizeButtonScript', 'SimpleImageToggleButtonScript', 'Y8Branding', 'Outline', 'RawImage'}
n_go = n_comp = 0
for o in list(env.objects):
    if o.type.name != "GameObject": continue
    d = o.read()
    if d.m_Name not in KILL: continue
    comps = []
    for c in d.m_Components:
        pp = c.component if hasattr(c, 'component') else c
        co = objs.get(pp.path_id)
        if not co: continue
        if co.type.name == 'MonoBehaviour':
            raw = bytearray(co.get_raw_data()); cls = scripts.get(struct.unpack_from('<q', raw, 20)[0], '?')
            if cls in RENDER and raw[12] != 0:
                raw[12] = 0; co.set_raw_data(bytes(raw)); n_comp += 1; comps.append(cls)
        elif co.type.name == 'CanvasRenderer':
            pass
    d.m_IsActive = False
    d.save(); n_go += 1
    print(f"disabled {d.m_Name} (go#{o.path_id}): components off: {comps}")
print("gameobjects:", n_go, "components:", n_comp)
data = env.file.save(packer="original")
open(dst, 'wb').write(data)
print("wrote", dst, len(data), "bytes (was", len(open(src,'rb').read()), ")")
