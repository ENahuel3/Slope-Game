# Coin placement, derived

`layout.py <folder>` prints the `LAYOUTS` table of `TemplateData/coins.js` and checks every coin against the
reachable set of the ball's centre. Inputs in the folder:

- `meshes.json`: vertices and triangles of the track-piece meshes, from the scene bundle
  (`python tools/mesh_export.py <data.unity3d> meshes.json`, UnityPy; `tools/unpack_webdata.py` unpacks the bundle).
- `matrices.json`: one object-to-world matrix per piece kind, `{"matrices": SlopeCoins.matrices()}` taken from a
  run with track shaping off (this folder holds the capture used for the current table).

`geometry.py` transforms each mesh with its matrix into the lane frame (x across, s along, n up, origin at the
piece's origin) and ray-casts it; `floors.py` finds the walkable floor under every (x, s): the lowest upward face
(Unity winds clockwise) with the ball's diameter of headroom above it, and the lateral span the ball's centre can
occupy (floor under a 0.45 footprint). `layout.py` places the coins:

- floor coins 1.0 above the walkable floor (the centre rides at +0.5, the pick radius is 1.25);
- tunnel coins on the walkable top: the ridge of the arch (4.92) and the centre beam of the stepped death-tunnel
  roof (4.45), where a ball lands after a gap lip (a jumpGapMid lip at 20+ u/s peaks about 4.9 high). Nothing inside
  the tunnels (the arch meets the floor near x 0.5 and the death tunnel's side bays are 1.46 high, so a coin of radius
  0.8 there is in the wall or the roof), nothing at all in the start tunnel, and coins.js hides the lane-block edge
  coins that fall under any tunnel's span;
- tilted lanes: the uphill side of the regular lane width. Holding higher needs a lateral acceleration of
  a_n sin 22.9 deg, which exceeds the 16 u/s^2 of steering (480 N / 30 kg) once zforce passes about 94;
- jumps: one coin on the lip the ball always crosses and one in the air d past it, with d chosen so that the band
  of trajectories over every speed (8..40 u/s) and push (zforce 24..110, a_n = R2 (9.81 + 0.3 zforce)) is narrower
  than the pick radius.
