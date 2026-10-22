"""Re-express the trigger prefabs' box colliders for the rolled spawn transform, correctly this time.
ScorePoint, SpeedUp and SpeedUpNoSpawning have no rotation action, so a spawned instance takes the spawn
transform's rotation: +45 degrees about x in the vanilla scene, -90 after patch_spawner.py. Their boxes
therefore have to be rotated by Rx(135) in the prefab's local frame. The prefabs are scaled non-uniformly
(ScorePoint 100 x 40 x 3), and BoxCollider center/size are in unscaled local units, so the rotation has
to happen in scaled space: box' = S^-1 * AABB(Rx(135) * S * box). patch_spawner.py rotated the unscaled
values and put the score trigger ~113 units under the course: no score, no next lap, a void after the
start tunnel. The tall triggers are clipped to +-CLIP_Y around the lane before rotating so the bounding
box of the diagonal slab does not reach dozens of units early.
usage: patch_triggers.py <vanilla data.unity3d> <patched data.unity3d> <out data.unity3d>"""
import UnityPy, sys, math, itertools
van, src, dst = sys.argv[1:4]
TRIGGERS = ('ScorePoint', 'SpeedUp', 'SpeedUpNoSpawning'); CLIP_Y = 30.0
C, S_ = math.cos(math.radians(135)), math.sin(math.radians(135))
def rot135(v): x, y, z = v; return (x, C * y - S_ * z, S_ * y + C * z)
def rotated_box(center, size, scale):
    """vanilla (center, size, scale) -> (center', size') for the -90 spawn frame"""
    cw = [center[i] * scale[i] for i in range(3)]; hw = [abs(size[i] * scale[i]) / 2 for i in range(3)]
    hw[1] = min(hw[1], CLIP_Y)
    pts = [rot135((cw[0] + dx * hw[0], cw[1] + dy * hw[1], cw[2] + dz * hw[2])) for dx, dy, dz in itertools.product((-1, 1), repeat=3)]
    lo = [min(p[i] for p in pts) for i in range(3)]; hi = [max(p[i] for p in pts) for i in range(3)]
    return [(lo[i] + hi[i]) / 2 / scale[i] for i in range(3)], [max(1e-3, (hi[i] - lo[i])) / abs(scale[i]) for i in range(3)]
def boxes(env):
    out = {}
    for o in env.objects:
        if o.type.name != 'GameObject' or not o.assets_file.name.endswith('sharedassets0.assets'): continue
        go = o.read()
        if go.m_Name not in TRIGGERS: continue
        rec = {'go': o.path_id}
        for c in go.m_Components:
            pp = c.component if hasattr(c, 'component') else c; co = o.assets_file.objects[pp.path_id]
            if co.type.name == 'Transform': t = co.read(); rec['scale'] = (t.m_LocalScale.x, t.m_LocalScale.y, t.m_LocalScale.z)
            if co.type.name == 'BoxCollider': rec['box'] = co
        out[go.m_Name] = rec
    return out
vb = boxes(UnityPy.load(van)); env = UnityPy.load(src); pb = boxes(env)
for name in TRIGGERS:
    v = vb[name]['box'].read(); center = (v.m_Center.x, v.m_Center.y, v.m_Center.z); size = (v.m_Size.x, v.m_Size.y, v.m_Size.z); scale = vb[name]['scale']
    assert scale == pb[name]['scale'], (name, scale, pb[name]['scale'])
    c2, s2 = rotated_box(center, size, scale)
    b = pb[name]['box'].read(); b.m_Center.x, b.m_Center.y, b.m_Center.z = c2; b.m_Size.x, b.m_Size.y, b.m_Size.z = s2; b.save()
    print('%s: vanilla center %s size %s scale %s -> center %s size %s (world center %s, world size %s)' % (name, center, size, scale, tuple(round(x, 3) for x in c2), tuple(round(x, 3) for x in s2), tuple(round(c2[i] * scale[i], 1) for i in range(3)), tuple(round(s2[i] * scale[i], 1) for i in range(3))))
data = env.file.save(packer="original"); open(dst, 'wb').write(data); print('wrote', dst, len(data))
