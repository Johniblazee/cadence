# Cadence — Build It From Scratch

This is a from-zero course that builds Cadence, a text-to-speech reading app, one file at a time. Cadence has two faces — a web reader you open in a browser, and a Chrome extension that reads any webpage you are already looking at — and one small server behind both of them. You will write the server, the web pages, and the extension yourself, chapter by chapter, and run every piece as you go.

This course is written for a curious adult who has never programmed before and does not know what a terminal, a server, or a Chrome extension is. It assumes nothing is installed and nothing is known, and it defines every term the first time it appears. The promise is specific: follow every chapter in order, type or paste exactly what each chapter shows you, and you end up with the complete, working Cadence application exactly as it exists in this repository today — not a simplified version, the real thing.

## The chapters

| # | File | What it covers | Milestone after this chapter |
|---|---|---|---|
| 00 | [`00-start-here.md`](00-start-here.md) | What Cadence is, what "building software" means here, and how the course is organized. | You can explain Cadence's two faces and its one server, and you know where the glossary and troubleshooting guide live. |
| 01 | [`01-set-up-your-computer.md`](01-set-up-your-computer.md) | Installing Python, Git, VS Code, and Chrome; the terminal and its basic commands. | Every tool this course needs is installed on your computer and verified. |
| 02 | [`02-how-the-web-works.md`](02-how-the-web-works.md) | The vocabulary every later chapter leans on: request, response, URL, port, HTML, CSS, JavaScript, JSON, API, streaming. | You know the words that every later chapter uses without re-explaining them. |
| 03 | [`03-your-first-server.md`](03-your-first-server.md) | A Python virtual environment, the project's first five real files, and a running Flask server. | You open `http://127.0.0.1:5000/` and see text served by a server you started yourself. |
| 04 | [`04-make-the-computer-talk.md`](04-make-the-computer-talk.md) | Turning text into speech with `edge-tts`, and starting the real `apps/web/app.py`. | You run `python speak.py` and hear an MP3 you generated, and `/api/voices` answers with JSON. |
| 05 | [`05-the-streaming-engine.md`](05-the-streaming-engine.md) | The `ReadSession`/streaming engine class that generates audio and word-timing events in the background. | Your server can stream audio as it is generated, instead of making the browser wait for one whole file. |
| 06 | [`06-the-api-routes.md`](06-the-api-routes.md) | Every Flask route: uploads, sessions, streaming audio, streaming word-timing events. | You create a read session with one command and open a URL in Chrome to hear a page read aloud — the whole backend works with no frontend. |
| 07 | [`07-the-landing-page.md`](07-the-landing-page.md) | `landing.html`, `landing.css`, `base.css`, and `landing.js`: Cadence's real home page. | You see Cadence's real, styled landing page in your browser. |
| 08 | [`08-the-reader-page.md`](08-the-reader-page.md) | `index.html` and `app.css`: the reader page's structure and styling. | You see the fully styled reader page (its buttons do not work yet). |
| 09 | [`09-reader-brain-1-loading-documents.md`](09-reader-brain-1-loading-documents.md) | The first half of `app.js`: wiring buttons, uploading and rendering documents, building the reading map. | You upload a document and watch the reader page load and display it. |
| 10 | [`10-reader-brain-2-playing-and-highlighting.md`](10-reader-brain-2-playing-and-highlighting.md) | The second half of `app.js`: playback, streaming word timings, and synchronized highlighting. | You upload a document, press play, hear it, and watch the sentence and word highlight as it is spoken. |
| 11 | [`11-your-first-chrome-extension.md`](11-your-first-chrome-extension.md) | The extension's manifest, popup HTML/CSS/JS, and loading it unpacked into Chrome. | You load the unpacked extension and open its popup (its buttons error until Chapter 13). |
| 12 | [`12-background-worker-1-state-and-messages.md`](12-background-worker-1-state-and-messages.md) | The first half of `background.js`: tracked state, the message-handling switch, and the right-click menu. | The red "Errors" button on the extension's card disappears. |
| 13 | [`13-background-worker-2-speech-lifecycle.md`](13-background-worker-2-speech-lifecycle.md) | The second half of `background.js`: starting, pausing, resuming, stopping, and seeking a session. | The background worker can run a session end to end in code; the popup shows exactly one precise error, `Could not load file: 'content.js'.`, because the content script does not exist yet. |
| 14 | [`14-the-offscreen-audio-player.md`](14-the-offscreen-audio-player.md) | `offscreen.html` and `offscreen.js`: the hidden page that actually plays audio. | The audio player is complete and waiting; the popup still shows that same `Could not load file: 'content.js'.` error, because Chapter 15 has not yet given Chrome a content script to load. |
| 15 | [`15-content-script-1-reading-the-page.md`](15-content-script-1-reading-the-page.md) | The first third of `content.js`: reading a page's real text and mapping clicks to text positions. | `content.js` exists and Chrome can load it, but it cannot finish parsing yet — that is expected until Chapter 17 closes the file. |
| 16 | [`16-content-script-2-highlighting.md`](16-content-script-2-highlighting.md) | The second third of `content.js`: sentence and word highlighting drawn on top of the real page. | The highlighting logic exists in the file, though it is still not reachable in the browser until the file is finished in Chapter 17. |
| 17 | [`17-content-script-3-the-floating-controller.md`](17-content-script-3-the-floating-controller.md) | The last third of `content.js`: the Dock, Cadence's corner card that collapses to a pill, its paste mode, and the right-click menu's actions, plus closing the file. | The full extension works: press Ctrl+Shift+U on any article and get audio, highlighting, and the Dock, all at once. |
| 18 | [`18-ship-it-deploy-to-render.md`](18-ship-it-deploy-to-render.md) | Docker, `render.yaml`, Git/GitHub, and deploying the server to Render. | Your backend runs live on the internet, and the extension talks to it from any computer, not only yours. |
| 19 | [`19-known-limits-and-what-is-next.md`](19-known-limits-and-what-is-next.md) | An honest, source-grounded account of what Cadence does not handle yet, and a roadmap for what comes next. | You can name specific ways Cadence can stop, hang, or slow down, and why, straight from the code. |
| 20 | [`20-glossary.md`](20-glossary.md) | Every bolded term from every chapter, alphabetized, in one place. | You can look up any word you have forgotten without hunting back through chapters. |
| 21 | [`21-troubleshooting.md`](21-troubleshooting.md) | Every "If something went wrong" item from every chapter, deduplicated and grouped by area. | You can find your exact error message and its fix, whichever chapter you are in. |

## How to use this course

- **Do not skip chapters.** Each one assumes every earlier chapter is already done — files, running services, and vocabulary alike.
- **Do every "Check your work" section.** It is how you catch a small mistake before it grows into three more, ten chapters later.
- **Expect roughly 20 to 30 hours** from Chapter 01 to the end, spread across several sessions. Some chapters take ten minutes; the ones that build hundreds of lines of a real file take an hour or more, mostly because you are reading and understanding, not only typing.
- **The chapters build the project's files in a fixed order.** Within a chapter, every code block is something you append to the end of the named file — this course never has you insert code in the middle of a file. A few files (`apps/web/app.py`, `app.js`, `background.js`, `content.js`) are large enough that building them is split across two or three consecutive chapters; each one picks up exactly where the last chunk left off.
- **When you get stuck**, open `21-troubleshooting.md` and look for your exact error text. **When you forget a word**, open `20-glossary.md`.

## Verifying your work against this repository

Every real-file code block in this course (marked with a `<!-- cadence-file: ... -->` comment right before the code fence) is a byte-exact copy of the corresponding file in this repository, split into ordered chunks. If you type or paste every chunk correctly, in order, your finished files are identical to the ones already sitting in this project.

`notebooks/CHECKSUMS.md` lists the final line count of every file this course builds, straight from this repository's own `wc -l`. If your file's line count matches the table, you have all of it, in order, with nothing missing and nothing duplicated. A one-line mismatch is almost always a missing trailing blank line or a chunk pasted twice; a larger mismatch usually means a whole chunk was skipped.
