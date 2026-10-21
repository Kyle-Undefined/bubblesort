# Bubblesort

Can you put five GitHub repositories in the right order?

[Play Bubblesort](https://bubblesort.lakebed.app)

Bubblesort is a daily browser game about the open-source projects we think we
know. Each puzzle gives you five repositories and one statistic—stars,
contributors, open issues, commits, or age. Reorder the repositories from
highest to lowest and submit your guess.

Correct positions lock in place. The rest stay movable until you solve the
puzzle or run out of guesses.

## How to play

1. Drag one repository onto another to swap them, or select two repositories.
2. Submit the order you think is correct.
3. Keep the positions that lock and rearrange the rest.

Easy mode gives you five guesses. Hard mode gives you three. The mode locks
after your first submission.

There is one new puzzle globally at midnight UTC. Past puzzles remain playable
in the monthly archive, but archive games do not affect your daily streak.

Keyboard controls are available too: use `1`–`5` to select a row, the arrow
keys to move it, and `Enter` to submit.

## Design

The interface is deliberately quiet: a cool-grey page, one earned blue, and a
single ledger-like spine through the ranking. Correct rows become bold and
still. When the game ends, the distance between results reflects the distance
between their real values.

Results use plain text instead of a Wordle-style square grid:

```text
Bubblesort #8
ordered 5 repos by contributors · 3/5 easy
bubblesort.lakebed.app
```

## Development

Bubblesort runs on [Lakebed](https://lakebed.dev) and requires Node.js 23.6 or
newer. Node.js 24 is the tested and recommended version for this checkout.

To check a public clone without the private puzzle files:

```sh
npm ci
npx playwright install chromium --only-shell
npm run verify:public
```

These checks run the real server suite against synthetic puzzle data for all
five stat types, build a production artifact in an isolated temporary checkout,
and test the real client/SDK in Chromium against a fixture server. They do not
contact the live game or require GitHub Actions, Lakebed credentials, or private
calendar files. Test data is never written into the production checkout.

`npm run verify` validates the actual calendar once private puzzle data is
available. `npm run dev` starts the local game with that data.

### Puzzle data

The canonical dataset and calendar are intentionally absent from Git because
they contain future answers. A public clone includes the game and its generator,
but not the production puzzle material.

To build a new, independent calendar:

1. Run `npm run fetch` and `npm run dataset`.
2. Copy `.env.calendar.example` to `.env.calendar.local` and supply two private
   unsigned 32-bit seeds.
3. Run `npm run calendar` and review `data/calendar-audit.txt`.
4. Run `npm run verify`, then `npm run dev`.

Lakebed deploys from the working tree, so ignored generated files are included
in a deployment from the production checkout. A fresh clone cannot deploy the
canonical game unless its private puzzle material and seeds are supplied
separately.

### Updating a deployed game

This revision pins Lakebed **0.0.40**, checked on October 20, 2026. It supports
both the guest session supplied in the initial HTML and the session-request
fallback. The client waits for a valid session before loading puzzles; players
do not need to sign in.

The hosted runtime can change independently of the client bundle. When ready
to redeploy, check `npm view lakebed version` again. If a newer stable SDK has
shipped, review its changes and rerun the local checks before updating the pin.
Keep the committed lockfile for the version being tested.

Run these commands from the production checkout, which contains the canonical
puzzle data, after pulling the update:

```sh
npm ci
npm run deploy
```

`npm run deploy` first checks that the private files and existing deployment
binding are present, runs the real calendar verification, and builds the claimed
production artifact with Lakebed's deployment source checks. Only then does it
run `lakebed deploy`. Use `npm run check:deploy` to run the local preflight alone.

Reuse the existing `lakebed.json` binding, Lakebed credentials, and canonical
calendar. The session key, streak keys, and `sessions`/`results` schemas are
unchanged, so this update does not require a player-data migration or table
deletion. Do not replace the calendar to fix a client connection problem.

After deploying, open the game in the same browser that has your saved progress,
check the archive, submit a guess, and reload to confirm the guess remains. Also
check a private window to confirm a new guest can load the game.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run fetch` | Fetch candidate repository data from GitHub |
| `npm run dataset` | Filter and compile the playable repository set |
| `npm run calendar` | Generate a private puzzle calendar |
| `npm run sim` | Simulate puzzle-solving difficulty |
| `npm run verify` | Run the game and secrecy verification suite |
| `npm run verify:fixture` | Run server assertions for all stats with synthetic data |
| `npm run verify:build` | Build and validate a production artifact with synthetic data |
| `npm run verify:client` | Run Chromium startup, persistence, and recovery checks |
| `npm run verify:public` | Run all public-clone checks locally |
| `npm run check:deploy` | Verify the canonical calendar and build without deploying |
| `npm run deploy` | Run the production preflight, then update the bound deployment |
| `npm run dev` | Start the local Lakebed app |
