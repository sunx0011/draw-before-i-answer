# DRAW BEFORE I ANSWER

*Ask the AI a question, but first draw the answer to your partner's question.*

A real-time online drawing game for exactly 2 players. Players join from any phone or laptop with a room code or link. No login or install is needed.

Built the same way as TRICK OR CUFF: one Node server (`server.js`) that serves the page and keeps every room in memory, plus a WebSocket for live updates. There is no database and no framework. The only dependency is `ws`.

## How a round works
1. **Create Room** gives a 4-letter code and a share link. The second player joins with either one. A third player is told the room is full.
2. **Ask**: each player types one question. Nobody sees the other question until both are in.
3. **Draw**: each player sees the *other* player's question and draws an answer (black pen, eraser, clear). Works with a mouse or a finger.
4. **Reveal**: when both drawings are in, the server asks the AI both questions. Each player then sees their own question, the drawing their partner made for it, and the AI's answer.
5. **Play Again** starts the next round in the same room.

## How it stays fair and in sync
- **The server decides everything.** Browsers only send "my question", "my drawing" and "play again". The server checks the stage and ignores late or duplicate submissions.
- **Each player gets their own view.** The server builds a separate state for each player. The partner's question is only sent once both have asked. Drawings are only sent at the reveal.
- **Reconnecting:** joining gives the browser a secret token (saved in localStorage). After a refresh or a dropped connection, the token gets you back your own slot and never someone else's. A half-finished drawing survives a refresh.
- **AI key stays on the server.** If no key is set, the game runs in clearly labeled **DEMO ANSWER MODE**.

## Files
```
server.js        web server + WebSocket + game rules + AI call
public/
  index.html     all screens
  style.css      look and feel
  app.js         connection, screens, drawing canvas
start-game.bat   double-click to run on Windows
.env.example     AI key template
render.yaml      one-click Render deploy settings
```

## Run locally
Double-click `start-game.bat` (Windows), or run `npm install` and then `npm start`. Then open http://localhost:3000.

To test with two players on one computer, use two different browsers, or a normal window plus a private window. Two tabs in the same browser count as the same player.

To play from a phone on the same Wi-Fi, open `http://<your computer's IP>:3000` on the phone.

## Turn on real AI answers
Copy `.env.example` to `.env` and fill in **one** of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Restart the server. The server window tells you which AI mode it is in.

## Deploy (Render, free)
1. Push this folder to a GitHub repository (`.env` is ignored, so your key is not uploaded).
2. On render.com, choose New → Web Service. Set Build Command to `npm install`, Start Command to `npm start`, and Instance Type to Free.
3. Under Environment, add your `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
4. Share the https://….onrender.com link.

Note: rooms live in server memory, so a server restart (or Render's free tier going to sleep after ~15 idle minutes) ends open rooms. That's the trade-off for having no database.
