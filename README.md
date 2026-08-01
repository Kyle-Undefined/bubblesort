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

1. Select two repositories to swap them.
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

Bubblesort runs on [Lakebed](https://lakebed.app) and requires Node.js 23.6 or
newer.

```sh
npm install
npm run verify
npm run dev
```

The development server starts once local puzzle data is available.

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

### Commands

| Command | Purpose |
| --- | --- |
| `npm run fetch` | Fetch candidate repository data from GitHub |
| `npm run dataset` | Filter and compile the playable repository set |
| `npm run calendar` | Generate a private puzzle calendar |
| `npm run sim` | Simulate puzzle-solving difficulty |
| `npm run verify` | Run the game and secrecy verification suite |
| `npm run dev` | Start the local Lakebed app |
