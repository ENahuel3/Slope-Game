> **This fork (branch `mod`)** strips the ads, analytics and promo banner from the page, blocks the game's own calls to the id.net / y8 / Unity Analytics backends (`TemplateData/mod.js`), adds a fullscreen button (or press **F**), a session timer and a proper HTML5 page shell, and fixes a stray token at the end of `unityloader41.js` that threw a `ReferenceError` on every load. Hosting instructions below are unchanged. The game itself is by Y8 Games / IDnet.
>
> **Stacked courses (the rapid-Enter glitch, automated).** Type a number into the **Courses** box in the HUD. When the ball dies, the game despawns the course about 1.7 s later; a restart that lands just before that despawn keeps the old course in the world, exactly where it was, and the next run spawns a fresh random course on top of it. Humans trigger this by spamming Enter at ~700 presses per minute. The mod listens for the death (the music track is cut at that instant, with the game-over UI as a fallback signal), then presses Enter every 3 frames until it sees the run restart, and keeps pressing through the fly-in because a ball that spawns inside leftover geometry dies again instantly. It does this while fewer than N courses are stacked; the next death at N is a normal game over and the stack clears. The HUD badge shows the current stack. It is the real glitch, so it inherits the glitch's odds: a restart that only gets accepted at the game-over UI sometimes leaves the ball dead at the end of the fly-in, which clears the stack.
>
> **Rainbow neon.** Every fragment shader is rewritten at compile time: green-hued output pixels get their hue replaced by a rainbow that sweeps across the screen and cycles every 8 s; red stays red. The recolour is applied only on draws to the default framebuffer, so image-effect passes are recoloured once. Toggle with the **Rainbow** checkbox.


# Slope Game </a>![Badge](https://hitscounter.dev/api/hit?url=https%3A%2F%2Fgithub.com%2Fcgolden15%2FSlope-Game%3Ftab%3Dreadme-ov-file&label=Visits&icon=github&color=%23198754&message=&style=flat&tz=US%2FEastern)

Copy of the popular slope game designed to be hosted anywhere to bypass website restrictions! Below I will cover two free and easy methods to clone and host this yourself, however if you wish to play, use either of the following links. If you use this repo, please star it so others can find it, and so I can see if yall want more! If this helped you, consider [Buying me a coffee](https://www.buymeacoffee.com/goldenn15)

__**IMPORTANT:**__ If your fork gets blocked, simply change the name of your repository and it should work!

+ [Hosted through Github Pages](https://github.com/cgolden15/Slope-Game)
+ [Hosted through repl.it](https://replit.com/@cgolden15/Slope-Game)
## How to use:
- Using [repl.it](https://repl.it/) is the best free, easy way to host and edit this page, however takes longer to set up.
- Using github pages is probably the simplest(and free!) method, however may be blocked on some computers due to the .io ending of the default urls.

Instructions for both are provided below!

### On repl.it
Fork this Repo through repl.it and use `node unityloader41.js` as your run command. If not prompted to enter a run command, create a ".replit" file and paste `run = "node unityloader41.js"` and `language = "html"` into it. Then just run the repl and enjoy!

![image](https://user-images.githubusercontent.com/61284764/153868233-76847dcb-4544-49a8-8027-64dcff0f93c2.png)
|:--:|
| <b>Should look like this when completed.</b>|

[Stuck? Check out my version here!](https://replit.com/@cgolden15/Slope-Game)

### On Github Pages
Fork this repo, and open it. Open the repo settings menu and navigate down the the "Pages" tab. Once there, change the Source option to the main branch. A blue box will appear saying that your page is waiting to be published. After about 15-90 seconds, the game will be avalible to play at the url it displays.

![image](https://user-images.githubusercontent.com/61284764/153872774-bf18f006-422c-44da-81b9-dcdc68c2ac4a.png)
|:--:|
<b>Select your deployment branch and save!</b>

![image](https://user-images.githubusercontent.com/61284764/153871943-1e1b6274-a212-4600-9233-c5c19dc75fe3.png)
|:--:|
<b>Should look like this when completed.</b>



### Other
Fork the repo and save it to your desired location. Run it through the `unityloader41.js` file.


## Result:
![image](https://user-images.githubusercontent.com/61284764/153867222-ab42f6c8-b51b-455a-a943-adbde4dc8ee0.png)
