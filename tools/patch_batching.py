"""Turn off dynamic batching in the build (BuildSettings.enableDynamicBatching in globalgamemanagers).
With it on, Unity merges small lane meshes that share a material (the jump gap, the thin lanes, tilted lanes, most
lane blocks) into one world-space vertex buffer per frame, so those pieces never reach WebGL as their own draw calls
with their own object matrix, which is how TemplateData/coins.js finds the pieces to put coins on. Off, every piece
is its own draw call (a few dozen more per frame; harmless). The flag is a byte in BuildSettings' bool block, found
by the typetree and patched in the raw data.
usage: patch_batching.py <in data.unity3d> <out data.unity3d>"""
import sys, UnityPy
src, dst = sys.argv[1], sys.argv[2]
env = UnityPy.load(src)
done = False
for o in env.objects:
    if o.type.name != 'BuildSettings': continue
    d = o.read_typetree(); raw = bytearray(o.get_raw_data())
    bools = ['hasPROVersion', 'isNoWatermarkBuild', 'isPrototypingBuild', 'isEducationalBuild', 'isEmbedded', 'hasPublishingRights', 'hasShadows', 'hasSoftShadows', 'hasLocalLightShadows', 'hasAdvancedVersion', 'enableDynamicBatching', 'isDebugBuild', 'usesOnMouseEvents', 'hasClusterRendering']
    pattern = bytes(int(bool(d[k])) for k in bools)
    at = raw.find(pattern); assert at >= 0 and raw.find(pattern, at + 1) < 0, 'bool block not found once'
    i = at + bools.index('enableDynamicBatching'); assert raw[i] == 1, 'already off'
    raw[i] = 0; o.set_raw_data(bytes(raw))
    print('BuildSettings: enableDynamicBatching 1 -> 0 at byte %d (bool block at %d)' % (i, at)); done = True
assert done, 'no BuildSettings object'
data = env.file.save(packer='original'); open(dst, 'wb').write(data); print('wrote', dst, len(data))
