"""Let the score and speed-up triggers count a ball that is far above the lane (e.g. launched by a super ramp).
In the spawn frame (tools/twist_mesh.py) the course runs along f = (0, -1, -1)/sqrt2 and the lane's up is
n = (0, -1, 1)/sqrt2, so a trigger's box, square in scaled (y, z), is a diamond in (f, n): half-diagonal W
about (f_c, n_c). Its bottom tip stays where it is and its top is raised to REACH units above the lane;
the diamond's width at the lane (n = 0) is W - |n_c| before and after, so on the lane nothing changes.
SpeedUp boxes are also widened sideways (the lane is x 0..10) by SIDE units each way.
usage: patch_trigger_reach.py <in data.unity3d> <out data.unity3d>"""
import UnityPy, sys, math
src, dst = sys.argv[1:3]
TRIGGERS = ('ScorePoint', 'SpeedUp', 'SpeedUpNoSpawning'); REACH = 200.0; SIDE = 15.0; R2 = math.sqrt(2)
env = UnityPy.load(src)
for o in env.objects:
    if o.type.name != 'GameObject' or not o.assets_file.name.endswith('sharedassets0.assets'): continue
    go = o.read()
    if go.m_Name not in TRIGGERS: continue
    scale = box = None
    for c in go.m_Components:
        pp = c.component if hasattr(c, 'component') else c; co = o.assets_file.objects[pp.path_id]
        if co.type.name == 'Transform': t = co.read(); scale = (t.m_LocalScale.x, t.m_LocalScale.y, t.m_LocalScale.z)
        if co.type.name == 'BoxCollider': box = co
    b = box.read()
    y, z = b.m_Center.y * scale[1], b.m_Center.z * scale[2]
    a = min(abs(b.m_Size.y * scale[1]), abs(b.m_Size.z * scale[2]))
    f_c, n_c, w = (-y - z) / R2, (z - y) / R2, a / R2
    lo = n_c - w
    assert REACH > n_c + w, (go.m_Name, n_c + w)
    n2, w2 = (REACH + lo) / 2, (REACH - lo) / 2
    y2, z2, a2 = -(f_c + n2) / R2, (n2 - f_c) / R2, w2 * R2
    b.m_Center.y, b.m_Center.z = y2 / scale[1], z2 / scale[2]
    b.m_Size.y, b.m_Size.z = a2 / abs(scale[1]), a2 / abs(scale[2])
    if go.m_Name != 'ScorePoint': b.m_Size.x += 2 * SIDE / abs(scale[0])
    b.save()
    print('%s: lane up %.1f..%.1f -> %.1f..%.1f, ahead %.1f, width at lane %.1f (unchanged), x size %.1f' % (
        go.m_Name, lo, n_c + w, lo, REACH, f_c, w - abs(n_c), b.m_Size.x * abs(scale[0])))
data = env.file.save(packer="original"); open(dst, 'wb').write(data); print('wrote', dst, len(data))
