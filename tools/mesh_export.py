"""Export the track-piece meshes (vertices and triangles, local coordinates) from the scene bundle for
tools/coin_layout. usage: mesh_export.py <data.unity3d (tools/unpack_webdata.py)> <out.json>"""
import json, sys, UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler
NAMES = {"Slope": "slope", "Thin": "thin", "ThinNoJump": "thinNoJump", "ThinS": "dogleg", "Jump": "jump", "JumpGapMid": "jumpGapMid",
         "DeathTunnel": "deathTunnel", "TunnelRoof": "tunnelRoof", "TunnelNarrow": "tunnelArc", "TunnelNarrowLong": "tunnelArcLong",
         "slopeWideTiltLeft": "tiltLeft", "slopeWideTiltRight": "tiltRight"}
env = UnityPy.load(sys.argv[1]); out = {}
for o in env.objects:
    if o.type.name != "Mesh": continue
    m = o.read()
    if m.m_Name not in NAMES: continue
    h = MeshHandler(m); h.process()
    verts = [list(map(float, v)) for v in h.m_Vertices]
    idx = [int(i) for i in (h.m_Indices if getattr(h, 'm_Indices', None) is not None else h.m_IndexBuffer)]
    out[NAMES[m.m_Name]] = {"name": m.m_Name, "v": verts, "t": [idx[i:i + 3] for i in range(0, len(idx) - 2, 3)]}
    print(m.m_Name, "->", NAMES[m.m_Name], len(verts), "vertices")
json.dump(out, open(sys.argv[2], "w"))
