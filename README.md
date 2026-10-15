# Slope (modded)

**Play it here: https://enahuel3.github.io/Slope-Game/**

A modded fork of [cgolden15/Slope-Game](https://github.com/cgolden15/Slope-Game), which is a self-hostable copy of the Slope game by Y8 Games / IDnet. This fork lives on the `mod` branch and is what GitHub Pages serves.

## What the mod changes

- **No ads, no tracking.** The page shell is a plain HTML5 document with the ad slots, analytics and promo banner removed, and `TemplateData/mod.js` blocks the game's own calls to the id.net / y8 / Unity Analytics backends before they leave the browser. A stray token at the end of `unityloader41.js` that threw a `ReferenceError` on every load is fixed.
- **HUD.** A fullscreen button (or press **F**), a session timer, a **Courses** box and a **Rainbow** toggle. The HUD hides while you play and comes back when the mouse moves. Settings persist in the browser.
- **Stacked courses, instantly.** Type a number into **Courses** and every run starts with that many random courses sitting exactly on top of each other. This is the rapid-Enter restart glitch turned into a feature, without having to die for each layer. The HUD badge shows `stack k / N` while it builds (a few frames of flicker at the start of the run) and when it is complete. Dying is a normal game over; the next run rebuilds the stack. Changing the number mid-run applies on the next run.
- **Rainbow neon.** Every fragment shader is rewritten at compile time so the green neon becomes a diagonal rainbow that scrolls across the screen and ripples with a travelling wave. Red stays red. Toggle it with the **Rainbow** checkbox.

## How the stack works

The game logic is a set of PlayMaker state machines inside the Unity WebGL build, and Unity's `SendMessage` bridge lets the page switch their states by name. A restart is the EventManager's `resetGame` state: it broadcasts `Reset Game`, which moves the ball and the spawn point back to the origin and spawns a fresh start section. Nothing on that path removes the previous course; only the `death complete` broadcast, sent three seconds after a game over, despawns the block pool. So while the ball is still falling into the start tunnel the mod asks the spawner for a run of laps (its `easy run` / `medium run` / `hard run` states, 15 laps per hidden course), forces `resetGame`, waits for the new start section to appear in the WebGL draw list, and repeats until N courses are stacked. The last course is the live one the game keeps extending as you pass its speed-up blocks; the hidden ones are static, like the leftovers the glitch used to leave behind. Overlapping courses also overlap their speed-up and score triggers, so a tall stack gets fast quickly. That is the glitch.

## Hosting your own copy

Fork this repository, open **Settings → Pages**, set the source to the `mod` branch (root), and the game will be served at `https://<your-user>.github.io/Slope-Game/` after a minute or two. If a network blocks the URL, renaming the repository changes it. There is no build step; it is static files.

## Credits

Slope is by Y8 Games / IDnet. The self-hosting copy is by [cgolden15](https://github.com/cgolden15/Slope-Game). The mod is on the `mod` branch of this fork.
